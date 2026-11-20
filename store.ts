// The forge's state and the service logic every surface (git smart HTTP, REST, GraphQL, MCP)
// shares, so an object created on one surface is the same object on all the others.
//
// Determinism: nothing here reads the wall clock or a random source. Every timestamp comes
// from a logical sequence counter (EPOCH + seq), ids are sequential, and iteration order is
// insertion order, so two runs that receive the same requests build the same state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObj,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';

/** Logical-clock epoch: 2025-01-01T00:00:00Z. Timestamps are EPOCH + seq seconds. */
export const EPOCH_SEC = 1735689600;

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The one login the trial's token names (wire.ts's seeded scenario viewer; the scenario is seed-fixed). */
export const VIEWER: Viewer = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  updatedSeq: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  headShaFallback: string;
  baseShaFallback: string;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  seq: number;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  readonly isPrivate: boolean;
  readonly createdSeq: number;
  readonly objects = new Map<string, GitObj>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, { name: string; color: string }>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  readonly comments = new Map<number, IssueComment[]>();
  nextNumber = 1;
  nextCommentId = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdSeq = createdSeq;
  }

  get defaultBranch(): string {
    return 'main';
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  // ---- object store ----

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  /** Follow tag objects to the commit they name; null when the chain does not end at a commit. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  commitOf(oid: string): { tree: string; parents: string[]; message: string } | null {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const view = parseCommit(object.data);
    return { tree: view.tree, parents: view.parents, message: view.message };
  }

  // ---- trees ----

  /** Flatten a tree (recursively) to path -> {mode, oid}; a null tree is the empty tree. */
  flattenTree(treeOid: string | null): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    if (treeOid !== null) walk(treeOid, '');
    return out;
  }

  /** Build (and store) nested tree objects from a flattened path map; returns the root tree id. */
  buildFromFlat(flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      // Invariant: a name may be a file or a directory, never both — git rejects such trees
      // (duplicateEntries), so refuse to build one instead of emitting an invalid object.
      for (const name of node.files.keys()) {
        if (node.dirs.has(name)) throw new Error(`tree build collision at "${name}": path is both a file and a directory`);
      }
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  treeOfCommit(commitOid: string): string | null {
    const commit = this.commitOf(commitOid);
    return commit === null ? null : commit.tree;
  }

  /** The flattened tree at a branch's tip (empty when the branch is unborn). */
  flatAtRef(refName: string): Map<string, { mode: string; oid: string }> {
    const tip = this.refs.get(refName);
    if (!tip) return new Map();
    const commit = this.peelToCommit(tip);
    if (commit === null) return new Map();
    return this.flattenTree(this.treeOfCommit(commit));
  }

  // ---- ancestry ----

  /** Every commit reachable from `tip`, with its BFS depth (tip = 0). */
  ancestors(tip: string): Map<string, number> {
    const depths = new Map<string, number>();
    const queue: Array<{ oid: string; depth: number }> = [{ oid: tip, depth: 0 }];
    while (queue.length > 0) {
      const { oid, depth } = queue.shift()!;
      if (depths.has(oid)) continue;
      const commit = this.commitOf(oid);
      if (commit === null) continue;
      depths.set(oid, depth);
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    return depths;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestors(descendant).has(ancestor);
  }

  /** The best common ancestor of two commits (least total depth), or null when unrelated. */
  mergeBase(a: string, b: string): string | null {
    const fromA = this.ancestors(a);
    const fromB = this.ancestors(b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, depthA] of fromA) {
      const depthB = fromB.get(oid);
      if (depthB === undefined) continue;
      const score = depthA + depthB;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }

  tipOf(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }
}

export class Forge {
  readonly viewer: Viewer = VIEWER;
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextEntityId = 1;
  private seq = 0;

  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  /** The next logical timestamp (seconds since the epoch), strictly increasing. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  iso(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString();
  }

  entityId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoId, this.viewer.login, name, description, isPrivate, this.tick());
    this.nextRepoId += 1;
    this.repos.set(repo.fullName, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  repo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
    this.reposById.delete(repo.id);
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewer.login).sort((a, b) => a.id - b.id);
  }

  /** A commit authored by the viewer at the next logical instant, stored in `repo`. */
  makeCommit(repo: Repo, fields: { tree: string; parents: readonly string[]; message: string }): { oid: string; seq: number } {
    const seq = this.tick();
    const identity = `${this.viewer.name} <${this.viewer.email}>`;
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents,
      author: identity,
      committer: identity,
      timestamp: EPOCH_SEC + seq,
      message: fields.message,
    });
    return { oid: repo.put('commit', data), seq };
  }
}

// ---------------------------------------------------------------------------------------------
// cross-surface operations
// ---------------------------------------------------------------------------------------------

/** Thrown when a contents write would make one path both a file and a directory. */
export class PathConflictError extends Error {
  constructor(path: string) {
    super(`path "${path}" conflicts with an existing file or directory`);
    this.name = 'PathConflictError';
  }
}

/**
 * True when placing a file at `path` inside `flat` would collide with the tree's shape:
 * a leading segment of `path` is already a file, or existing files live under `path`.
 */
export function pathConflicts(flat: ReadonlyMap<string, { mode: string; oid: string }>, path: string): boolean {
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    if (flat.has(segments.slice(0, i).join('/'))) return true;
  }
  const prefix = `${path}/`;
  for (const key of flat.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/** True when a flattened path map cannot form a tree: some path is a file and a directory prefix at once. */
export function flatHasCollision(flat: ReadonlyMap<string, { mode: string; oid: string }>): boolean {
  for (const key of flat.keys()) {
    const segments = key.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      if (flat.has(segments.slice(0, i).join('/'))) return true;
    }
  }
  return false;
}

/**
 * Commit a file change (create/update/delete) on a branch through the contents model.
 * `branch` must already exist as a ref or be the default branch; a missing non-default branch
 * is created at the default branch's tip. Returns the new commit id and the blob id involved.
 */
export function commitFileChange(
  forge: Forge,
  repo: Repo,
  fields: { branch: string; path: string; content: Buffer | null; message: string },
): { commitOid: string; blobOid: string | null } {
  const refName = `refs/heads/${fields.branch}`;
  let tip = repo.refs.get(refName) ?? null;
  if (tip === null && fields.branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const tipCommit = tip === null ? null : repo.peelToCommit(tip);
  const flat = tipCommit === null ? new Map<string, { mode: string; oid: string }>() : repo.flattenTree(repo.treeOfCommit(tipCommit));
  let blobOid: string | null = null;
  if (fields.content === null) {
    flat.delete(fields.path);
  } else {
    if (pathConflicts(flat, fields.path)) throw new PathConflictError(fields.path);
    blobOid = repo.put('blob', fields.content);
    flat.set(fields.path, { mode: '100644', oid: blobOid });
  }
  const tree = repo.buildFromFlat(flat);
  const { oid } = forge.makeCommit(repo, {
    tree,
    parents: tipCommit === null ? [] : [tipCommit],
    message: fields.message,
  });
  repo.refs.set(refName, oid);
  return { commitOid: oid, blobOid };
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Line-level add/delete counts between two blob bodies (LCS over lines). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) return { additions: lineCount(newData!), deletions: 0 };
  if (newData === null) return { additions: 0, deletions: lineCount(oldData) };
  const a = oldData.toString('utf8').split('\n');
  const b = newData.toString('utf8').split('\n');
  // LCS length via dynamic programming over lines (files in this forge are small).
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j]!;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const common = dp[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changed files between two commits' trees (three-dot: diffed from their merge base). */
export function diffCommits(repo: Repo, baseTip: string, headTip: string): FileChange[] {
  const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
  const baseFlat = repo.flattenTree(repo.treeOfCommit(base));
  const headFlat = repo.flattenTree(repo.treeOfCommit(headTip));
  const changes: FileChange[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before && after && before.oid === after.oid && before.mode === after.mode) continue;
    const oldData = before ? (repo.get(before.oid)?.data ?? null) : null;
    const newData = after ? (repo.get(after.oid)?.data ?? null) : null;
    const { additions, deletions } = lineDiff(oldData, newData);
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
      additions,
      deletions,
    });
  }
  return changes;
}

export type MergeOutcome =
  | { ok: true; commitOid: string }
  | { ok: false; reason: 'conflict' | 'not-open' | 'missing' };

/**
 * Squash-merge a pull request: one commit on the base branch whose tree is the three-way
 * merge of the merge-base, base tip and head tip trees. A path both sides changed
 * differently is a conflict. On success the pull is closed and marked merged.
 */
export function mergePullRequest(forge: Forge, repo: Repo, pull: Pull): MergeOutcome {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'not-open' };
  const baseTip = repo.tipOf(pull.base);
  const headTip = repo.tipOf(pull.head);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'missing' };
  const baseCommit = repo.peelToCommit(baseTip);
  const headCommit = repo.peelToCommit(headTip);
  if (baseCommit === null || headCommit === null) return { ok: false, reason: 'missing' };
  const ancestor = repo.mergeBase(baseCommit, headCommit);
  if (ancestor === null || ancestor === headCommit) return { ok: false, reason: 'conflict' };
  const ancestorFlat = repo.flattenTree(repo.treeOfCommit(ancestor));
  const baseFlat = repo.flattenTree(repo.treeOfCommit(baseCommit));
  const headFlat = repo.flattenTree(repo.treeOfCommit(headCommit));
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const inAncestor = ancestorFlat.get(path);
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    const baseChanged = inBase?.oid !== inAncestor?.oid || inBase?.mode !== inAncestor?.mode || (inBase === undefined) !== (inAncestor === undefined);
    const headChanged = inHead?.oid !== inAncestor?.oid || inHead?.mode !== inAncestor?.mode || (inHead === undefined) !== (inAncestor === undefined);
    if (baseChanged && headChanged) {
      if (inBase?.oid === inHead?.oid && inBase?.mode === inHead?.mode) {
        if (inBase) merged.set(path, inBase);
        continue;
      }
      return { ok: false, reason: 'conflict' };
    }
    const winner = headChanged ? inHead : inBase;
    if (winner) merged.set(path, winner);
  }
  // A file/directory type change split across the two sides cannot form a tree: a conflict.
  if (flatHasCollision(merged)) return { ok: false, reason: 'conflict' };
  const tree = repo.buildFromFlat(merged);
  const message = pull.body === '' ? `${pull.title} (#${pull.number})\n` : `${pull.title} (#${pull.number})\n\n${pull.body}\n`;
  const { oid, seq } = forge.makeCommit(repo, { tree, parents: [baseCommit], message });
  repo.refs.set(`refs/heads/${pull.base}`, oid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = oid;
  pull.mergedSeq = seq;
  return { ok: true, commitOid: oid };
}

/** Whether a pull request would merge cleanly right now (GraphQL's `mergeable`). */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged) return 'MERGEABLE';
  const baseTip = repo.tipOf(pull.base);
  const headTip = repo.tipOf(pull.head);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const baseCommit = repo.peelToCommit(baseTip);
  const headCommit = repo.peelToCommit(headTip);
  if (baseCommit === null || headCommit === null) return 'UNKNOWN';
  const ancestor = repo.mergeBase(baseCommit, headCommit);
  if (ancestor === null || ancestor === headCommit) return 'CONFLICTING';
  const ancestorFlat = repo.flattenTree(repo.treeOfCommit(ancestor));
  const baseFlat = repo.flattenTree(repo.treeOfCommit(baseCommit));
  const headFlat = repo.flattenTree(repo.treeOfCommit(headCommit));
  // Mirror mergePullRequest exactly, so `mergeable` never promises a merge that then fails.
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const inAncestor = ancestorFlat.get(path);
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    const baseChanged = inBase?.oid !== inAncestor?.oid || inBase?.mode !== inAncestor?.mode || (inBase === undefined) !== (inAncestor === undefined);
    const headChanged = inHead?.oid !== inAncestor?.oid || inHead?.mode !== inAncestor?.mode || (inHead === undefined) !== (inAncestor === undefined);
    if (baseChanged && headChanged) {
      if (inBase?.oid === inHead?.oid && inBase?.mode === inHead?.mode) {
        if (inBase) merged.set(path, inBase);
        continue;
      }
      return 'CONFLICTING';
    }
    const winner = headChanged ? inHead : inBase;
    if (winner) merged.set(path, winner);
  }
  if (flatHasCollision(merged)) return 'CONFLICTING';
  return 'MERGEABLE';
}

export { ZERO_OID };
