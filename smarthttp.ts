// Git smart HTTP: info/refs advertisements (protocol v2 for upload-pack when the client asks,
// v0 otherwise and always for receive-pack), ls-refs, fetch (v2 sections / v0 sideband) and
// receive-pack pushes with report-status. Repositories live in the shared store; a repo that
// does not exist answers 404 and the server keeps serving.

import {
  PKT_DELIM,
  PKT_FLUSH,
  PktReader,
  ZERO_OID,
  encodePkt,
  isOid,
  readPack,
  sidebandChunks,
  writePack,
  type GitObj,
} from './gitobj.ts';
import { Forge, Repo } from './store.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'makefun-forge/1.0.0';

function text(status: number, body: string): HttpResult {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(body, 'utf8') };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function advertisementV0(repo: Repo, service: string): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:${headTarget(repo)} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    if (headOid) lines.push(`${headOid} HEAD`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}`);
      const peeled = repo.peelToCommit(oid);
      if (peeled !== null && peeled !== oid) lines.push(`${peeled} ${name}^{}`);
    }
  }
  lines.forEach((line, index) => {
    parts.push(encodePkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  const lines = ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
  return Buffer.concat([...lines.map((line) => encodePkt(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------------------------

function lsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = repo.peelToCommit(oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => encodePkt(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: Array<{ oid: string; obj: GitObj }>;
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

/** Every object reachable from `roots`, with commit traversal stopping at `stopCommits`. */
function closure(repo: Repo, roots: readonly string[], stopCommits: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = repo.commitOf(oid)!;
      queue.push(commit.tree);
      if (stopCommits.has(oid)) continue;
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(tagTarget(repo, oid));
    } else if (object.type === 'tree') {
      // Trees are walked through flatten-like expansion via parseTree on demand.
      for (const entry of treeEntries(repo, oid)) queue.push(entry.oid);
    }
  }
  return seen;
}

function tagTarget(repo: Repo, oid: string): string {
  const object = repo.get(oid);
  if (!object || object.type !== 'tag') return oid;
  const text = object.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})/m.exec(text);
  return match ? match[1]! : oid;
}

function treeEntries(repo: Repo, oid: string): Array<{ oid: string }> {
  const object = repo.get(oid);
  if (!object || object.type !== 'tree') return [];
  const out: Array<{ oid: string }> = [];
  const data = object.data;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    out.push({ oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return out;
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[],
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // What the client already holds: the closure of its haves, but a shallow boundary
  // commit's ancestors are NOT held (the client never received them).
  const heldCommits = new Set<string>();
  {
    const queue = haves.map((have) => repo.peelToCommit(have)).filter((c): c is string => c !== null);
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      heldCommits.add(oid);
      if (shallowSet.has(oid)) continue;
      const commit = repo.commitOf(oid);
      if (commit) for (const parent of commit.parents) queue.push(parent);
    }
  }
  const heldObjects = closure(repo, haves, shallowSet);

  // BFS levels from the wants (peeled to commits), honouring depth and held commits.
  const levels = new Map<string, number>();
  const queue: Array<{ oid: string; level: number }> = [];
  for (const want of wants) {
    const commit = repo.peelToCommit(want);
    if (commit !== null && !levels.has(commit)) {
      levels.set(commit, 1);
      queue.push({ oid: commit, level: 1 });
    }
  }
  const wantCommits = new Set(levels.keys());
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    if (depth !== null && level >= depth) continue;
    if (heldCommits.has(oid) && !wantCommits.has(oid)) continue;
    const commit = repo.commitOf(oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (!levels.has(parent)) {
        levels.set(parent, level + 1);
        queue.push({ oid: parent, level: level + 1 });
      }
    }
  }
  const sendCommits = new Set<string>();
  for (const oid of levels.keys()) if (!heldCommits.has(oid)) sendCommits.add(oid);

  // Objects: the wants' own closure, but commit traversal limited to sendCommits, minus held.
  const objectIds = new Set<string>();
  const walkQueue = [...wants];
  const walked = new Set<string>();
  while (walkQueue.length > 0) {
    const oid = walkQueue.pop()!;
    if (walked.has(oid)) continue;
    walked.add(oid);
    const object = repo.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const commit = repo.commitOf(oid)!;
      // Parents are always enqueued: the sendCommits guard below decides inclusion, and a
      // held or boundary commit's unsent ancestors must still be reached through it.
      for (const parent of commit.parents) walkQueue.push(parent);
      if (!sendCommits.has(oid)) continue;
      objectIds.add(oid);
      walkQueue.push(commit.tree);
    } else if (object.type === 'tag') {
      objectIds.add(oid);
      walkQueue.push(tagTarget(repo, oid));
    } else {
      objectIds.add(oid);
      if (object.type === 'tree') for (const entry of treeEntries(repo, oid)) walkQueue.push(entry.oid);
    }
  }
  for (const oid of heldObjects) objectIds.delete(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of sendCommits) {
      const commit = repo.commitOf(oid);
      if (!commit) continue;
      const hasUnsentParent = commit.parents.some((parent) => !sendCommits.has(parent) && !heldCommits.has(parent));
      if (hasUnsentParent) shallow.push(oid);
    }
    for (const oid of clientShallow) {
      const commit = repo.commitOf(oid);
      if (!commit) continue;
      if (commit.parents.some((parent) => sendCommits.has(parent) || levels.has(parent))) unshallow.push(oid);
    }
  }

  const commonHaves = haves.filter((have) => repo.get(have) !== undefined);
  const objects = [...objectIds].sort().map((oid) => ({ oid, obj: repo.get(oid)! }));
  return { objects, shallow, unshallow, commonHaves };
}

// Built packs are pure functions of (repo state, wants, haves, depth, client shallow):
// objects are content-addressed and immutable, and the key carries a fingerprint of every
// ref plus the object count, so a cached pack can never go stale. The clone workload asks
// for the same pack dozens of times concurrently; building it once is the whole win. The
// cache is process-local scratch, never exported state.
const packCache = new Map<string, Buffer>();

function packFor(repo: Repo, plan: FetchPlan, keyParts: readonly string[]): Buffer {
  const fingerprint = [...repo.refs.entries()]
    .map(([ref, oid]) => `${ref}=${oid}`)
    .sort()
    .join(';');
  const key = `${repo.fullName}|${repo.objects.size}|${fingerprint}|${keyParts.join('|')}`;
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = writePack(plan.objects.map(({ obj }) => obj));
  if (packCache.size >= 64) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function fetchResponseV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
  }
  const plan = planFetch(repo, wants.filter(isOid), haves.filter(isOid), depth, clientShallow);
  const parts: Buffer[] = [];
  parts.push(encodePkt('acknowledgments\n'));
  if (plan.commonHaves.length === 0) {
    parts.push(encodePkt('NAK\n'));
  } else {
    for (const have of plan.commonHaves) parts.push(encodePkt(`ACK ${have} common\n`));
  }
  parts.push(PKT_FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(encodePkt('packfile\n'));
  const pack = packFor(repo, plan, ['v2', ...wants, '/', ...haves, '/', String(depth), '/', ...clientShallow]);
  parts.push(...sidebandChunks(pack, 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, wants: string[], haves: string[], depth: number | null, clientShallow: string[]): Buffer {
  const plan = planFetch(repo, wants.filter(isOid), haves.filter(isOid), depth, clientShallow);
  const parts: Buffer[] = [];
  if (plan.commonHaves.length === 0) parts.push(encodePkt('NAK\n'));
  else for (const have of plan.commonHaves) parts.push(encodePkt(`ACK ${have}\n`));
  for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  const pack = packFor(repo, plan, ['v0', ...wants, '/', ...haves, '/', String(depth), '/', ...clientShallow]);
  parts.push(...sidebandChunks(pack, 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let first = true;
  for (;;) {
    const pkt = reader.next();
    if (pkt === null || pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean));
        line = line.slice(0, nul);
      }
    }
    const oldOid = line.slice(0, 40);
    const newOid = line.slice(41, 81);
    const ref = line.slice(82).trim();
    if (isOid(oldOid) && isOid(newOid) && ref.startsWith('refs/')) commands.push({ oldOid, newOid, ref });
  }
  const pack = reader.rest();
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.get(oid));
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }

  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      reports.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      const current = repo.refs.get(command.ref);
      if (current === undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'reference not found' });
      } else if (current !== command.oldOid) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const object = repo.get(command.newOid);
    if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
      reports.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    let ok = command.oldOid === current;
    if (ok && current !== ZERO_OID) {
      const newCommit = repo.peelToCommit(command.newOid);
      const currentCommit = repo.peelToCommit(current);
      ok = newCommit !== null && currentCommit !== null && repo.isAncestor(currentCommit, newCommit);
    }
    if (ok) {
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }

  const reportLines = [`unpack ${unpackDetail}`];
  for (const report of reports) reportLines.push(report.ok ? `ok ${report.ref}` : `ng ${report.ref} ${report.reason}`);
  const reportBody = Buffer.concat([...reportLines.map((line) => encodePkt(`${line}\n`)), PKT_FLUSH]);
  if (capabilities.has('side-band-64k')) {
    return Buffer.concat([...sidebandChunks(reportBody, 1), PKT_FLUSH]);
  }
  return Buffer.concat([reportBody, PKT_FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

export function handleGit(
  forge: Forge,
  method: string,
  owner: string,
  repoName: string,
  action: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): HttpResult {
  const repo = forge.repo(owner, repoName);
  if (action === 'info/refs') {
    if (method !== 'GET') return text(405, 'method not allowed');
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return text(400, 'bad service');
    if (repo === null) return text(404, 'repository not found');
    const wantsV2 = (headers['git-protocol'] ?? '').includes('version=2');
    const advertisement = service === 'git-upload-pack' && wantsV2 ? advertisementV2() : advertisementV0(repo, service);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body: advertisement };
  }
  if (repo === null) return text(404, 'repository not found');
  if (method !== 'POST') return text(405, 'method not allowed');

  if (action === 'git-upload-pack') {
    let reader: PktReader;
    try {
      reader = new PktReader(body);
    } catch {
      return text(400, 'bad request');
    }
    // Header section up to the delim, then arguments up to the flush.
    let command = '';
    const args: string[] = [];
    try {
      let sawDelim = false;
      for (;;) {
        const pkt = reader.next();
        if (pkt === null || pkt.kind === 'flush' || pkt.kind === 'response-end') break;
        if (pkt.kind === 'delim') {
          sawDelim = true;
          continue;
        }
        const line = pkt.payload.toString('utf8').replace(/\n$/, '');
        if (!sawDelim && line.startsWith('command=')) command = line.slice('command='.length);
        else args.push(line);
      }
    } catch {
      return text(400, 'bad pkt-line');
    }
    if (command === 'ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
    }
    if (command === 'fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV2(repo, args) };
    }
    if (command === '') {
      // No command header: a protocol v0 fetch request (want lines, flush, have lines, flush).
      const wants: string[] = [];
      const haves: string[] = [];
      const clientShallow: string[] = [];
      let depth: number | null = null;
      let section = 0;
      try {
        const reader2 = new PktReader(body);
        for (;;) {
          const pkt = reader2.next();
          if (pkt === null) break;
          if (pkt.kind === 'flush') {
            section += 1;
            if (section >= 2) break;
            continue;
          }
          if (pkt.kind !== 'data') continue;
          const line = pkt.payload.toString('utf8').replace(/\n$/, '');
          const bare = line.split(' ')[0]!;
          if (bare === 'want') wants.push(line.slice(5, 45));
          else if (bare === 'have') haves.push(line.slice(5, 45));
          else if (bare === 'shallow') clientShallow.push(line.slice(8, 48));
          else if (bare === 'deepen') depth = Number.parseInt(line.slice(7), 10);
        }
      } catch {
        return text(400, 'bad pkt-line');
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV0(repo, wants, haves, depth, clientShallow) };
    }
    return text(400, 'unknown command');
  }

  if (action === 'git-receive-pack') {
    try {
      return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(repo, body) };
    } catch {
      return text(400, 'bad receive-pack request');
    }
  }
  return text(404, 'not found');
}
