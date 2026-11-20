// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and
// pull requests over the shared store. Every reply is JSON with a {message} error body; the
// surfaces GraphQL and MCP reuse the serializers and creation helpers exported here.

import { isOid, parseCommit, parseTree } from './gitobj.ts';
import {
  Forge,
  PathConflictError,
  Repo,
  commitFileChange,
  diffCommits,
  mergePullRequest,
  type Issue,
  type IssueComment,
  type Pull,
} from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const err = (status: number, message: string): RestResult => ({ status, body: { message } });
const notFound = (): RestResult => err(404, 'Not Found');

// ---------------------------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------------------------

export function userJson(forge: Forge): Record<string, unknown> {
  const viewer = forge.viewer;
  return { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User', site_admin: false };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: forge.viewer.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.iso(repo.createdSeq),
    updated_at: forge.iso(repo.createdSeq),
    html_url: `https://forge.local/${repo.fullName}`,
  };
}

export function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: null, default: false };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: forge.iso(issue.seq),
    updated_at: forge.iso(issue.updatedSeq),
    html_url: `https://forge.local/${repo.fullName}/issues/${issue.number}`,
  };
}

export function commentJson(forge: Forge, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: forge.iso(comment.seq),
    updated_at: forge.iso(comment.seq),
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.tipOf(pull.head) ?? pull.headShaFallback;
  const baseSha = repo.tipOf(pull.base) ?? pull.baseShaFallback;
  return {
    id: pull.id,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: false,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : forge.iso(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    created_at: forge.iso(pull.seq),
    updated_at: forge.iso(pull.seq),
    html_url: `https://forge.local/${repo.fullName}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// shared creation helpers (GraphQL and MCP call these too)
// ---------------------------------------------------------------------------------------------

export function createIssue(forge: Forge, repo: Repo, fields: { title: string; body: string; labels?: string[] }): Issue {
  const seq = forge.tick();
  const issue: Issue = {
    number: repo.nextNumber,
    id: forge.entityId(),
    title: fields.title,
    body: fields.body,
    state: 'open',
    labels: [...(fields.labels ?? [])],
    seq,
    updatedSeq: seq,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(forge: Forge, repo: Repo, fields: { title: string; body: string; head: string; base: string }): Pull {
  const pull: Pull = {
    number: repo.nextNumber,
    id: forge.entityId(),
    title: fields.title,
    body: fields.body,
    state: 'open',
    merged: false,
    head: fields.head,
    base: fields.base,
    headShaFallback: repo.tipOf(fields.head) ?? '',
    baseShaFallback: repo.tipOf(fields.base) ?? '',
    mergeCommitSha: null,
    mergedSeq: null,
    seq: forge.tick(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function addComment(forge: Forge, repo: Repo, issueNumber: number, body: string): IssueComment {
  const comment: IssueComment = { id: forge.entityId(), body, seq: forge.tick() };
  const list = repo.comments.get(issueNumber) ?? [];
  list.push(comment);
  repo.comments.set(issueNumber, list);
  return comment;
}

/** Strip an `owner:` prefix from a head/base ref the way the API accepts it. */
export function normalizeRefName(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

// ---------------------------------------------------------------------------------------------
// plumbing helpers
// ---------------------------------------------------------------------------------------------

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(items: readonly T[], query: URLSearchParams, url: string): Page<T> {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const withPage = (n: number): string => `${url}?per_page=${perPage}&page=${n}`;
  const parts: string[] = [];
  if (page < lastPage) {
    parts.push(`<${withPage(page + 1)}>; rel="next"`);
    parts.push(`<${withPage(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    parts.push(`<${withPage(1)}>; rel="first"`);
    parts.push(`<${withPage(page - 1)}>; rel="prev"`);
  }
  return { items: slice, link: parts.length > 0 ? parts.join(', ') : null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------------------------

/** The repository-name rule every creation surface (REST, MCP) enforces identically. */
export function isValidRepoName(name: string): boolean {
  return name !== '' && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

function createRepo(forge: Forge, body: Record<string, unknown>): RestResult {
  const name = stringField(body, 'name');
  if (name === undefined || !isValidRepoName(name)) {
    return err(422, 'name is invalid');
  }
  if (forge.repo(forge.viewer.login, name) !== null) {
    return {
      status: 422,
      body: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    };
  }
  const repo = forge.createRepo(name, stringField(body, 'description') ?? '', body.private === true);
  return { status: 201, body: repoJson(forge, repo) };
}

function listViewerRepos(forge: Forge, query: URLSearchParams, url: string): RestResult {
  const page = paginate(forge.viewerRepos(), query, url);
  return {
    status: 200,
    body: page.items.map((repo) => repoJson(forge, repo)),
    headers: page.link === null ? {} : { link: page.link },
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.get(oid)!;
  const view = parseCommit(object.data);
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
    return { name: match[1], email: match[2], date: new Date(Number.parseInt(match[3]!, 10) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: {
      author: person(view.author),
      committer: person(view.committer),
      message: view.message,
      tree: { sha: view.tree },
    },
    author: null,
    committer: null,
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

function listCommits(repo: Repo, query: URLSearchParams, url: string): RestResult {
  const shaParam = query.get('sha');
  let tip: string | null = null;
  if (shaParam === null || shaParam === '') {
    tip = repo.tipOf(repo.defaultBranch);
  } else if (repo.refs.has(shaParam)) {
    tip = repo.refs.get(shaParam)!;
  } else if (repo.tipOf(shaParam) !== null) {
    tip = repo.tipOf(shaParam);
  } else if (isOid(shaParam) && repo.get(shaParam)?.type === 'commit') {
    tip = shaParam;
  }
  if (tip === null) return { status: 200, body: [] };
  const commit = repo.peelToCommit(tip);
  if (commit === null) return { status: 200, body: [] };
  const depths = repo.ancestors(commit);
  const ordered = [...depths.entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
  const page = paginate(ordered, query, url);
  return {
    status: 200,
    body: page.items.map((oid) => commitJson(repo, oid)),
    headers: page.link === null ? {} : { link: page.link },
  };
}

/** The tree object id at a directory path under a root tree, or null. */
function treeAtPath(repo: Repo, rootTree: string, dirPath: string): string | null {
  if (dirPath === '') return rootTree;
  let current = rootTree;
  for (const segment of dirPath.split('/')) {
    const object = repo.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function resolveRefCommit(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.tipOf(repo.defaultBranch) === null ? null : repo.peelToCommit(repo.tipOf(repo.defaultBranch)!);
  const byRef = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
  if (byRef !== undefined) return repo.peelToCommit(byRef);
  if (isOid(ref) && repo.get(ref)?.type === 'commit') return ref;
  return null;
}

function getContents(forge: Forge, repo: Repo, path: string, query: URLSearchParams): RestResult {
  const commit = resolveRefCommit(repo, query.get('ref'));
  if (commit === null) return notFound();
  const rootTree = repo.treeOfCommit(commit);
  if (rootTree === null) return notFound();
  const flat = repo.flattenTree(rootTree);
  const file = flat.get(path);
  if (file !== undefined && path !== '') {
    const blob = repo.get(file.oid);
    if (!blob) return notFound();
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop(),
        path,
        sha: file.oid,
        size: blob.data.length,
        content: blob.data.toString('base64'),
      },
    };
  }
  const dirTree = treeAtPath(repo, rootTree, path);
  if (dirTree === null) return notFound();
  const object = repo.get(dirTree);
  if (!object || object.type !== 'tree') return notFound();
  const entries = parseTree(object.data).map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const child = repo.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      size: isDir ? 0 : (child?.data.length ?? 0),
    };
  });
  return { status: 200, body: entries };
}

function putContents(forge: Forge, repo: Repo, path: string, body: Record<string, unknown>): RestResult {
  const content = stringField(body, 'content');
  if (content === undefined) return err(422, 'content is required');
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const message = stringField(body, 'message') ?? `Update ${path}`;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const tipCommit = tip === undefined ? null : repo.peelToCommit(tip);
  const existing = tipCommit === null ? undefined : repo.flattenTree(repo.treeOfCommit(tipCommit)).get(path);
  const sha = stringField(body, 'sha');
  if (existing !== undefined) {
    if (sha === undefined) return err(422, 'sha wasn\'t supplied');
    if (sha !== existing.oid) return err(409, `${path} does not match ${sha}`);
  }
  const bytes = Buffer.from(content, 'base64');
  let commitOid: string;
  let blobOid: string | null;
  try {
    ({ commitOid, blobOid } = commitFileChange(forge, repo, { branch, path, content: bytes, message }));
  } catch (error) {
    if (error instanceof PathConflictError) return err(422, `Validation Failed: ${error.message}`);
    throw error;
  }
  return {
    status: existing !== undefined ? 200 : 201,
    body: {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitOid, message },
    },
  };
}

function deleteContents(forge: Forge, repo: Repo, path: string, body: Record<string, unknown>): RestResult {
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const message = stringField(body, 'message') ?? `Delete ${path}`;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const tipCommit = tip === undefined ? null : repo.peelToCommit(tip);
  const existing = tipCommit === null ? undefined : repo.flattenTree(repo.treeOfCommit(tipCommit)).get(path);
  if (existing === undefined) return notFound();
  const sha = stringField(body, 'sha');
  if (sha !== undefined && sha !== existing.oid) return err(409, `${path} does not match ${sha}`);
  const { commitOid } = commitFileChange(forge, repo, { branch, path, content: null, message });
  return { status: 200, body: { content: null, commit: { sha: commitOid, message } } };
}

function createLabel(repo: Repo, body: Record<string, unknown>): RestResult {
  const name = stringField(body, 'name');
  if (name === undefined || name === '') return err(422, 'name is required');
  if (repo.labels.has(name)) return err(422, 'Validation Failed: label already exists');
  const label = { name, color: stringField(body, 'color') ?? 'ededed' };
  repo.labels.set(name, label);
  return { status: 201, body: labelJson(label) };
}

function postIssue(forge: Forge, repo: Repo, body: Record<string, unknown>): RestResult {
  const title = stringField(body, 'title');
  if (title === undefined || title === '') return err(422, 'title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
  }
  const issue = createIssue(forge, repo, { title, body: stringField(body, 'body') ?? '', labels });
  return { status: 201, body: issueJson(forge, repo, issue) };
}

function listIssues(forge: Forge, repo: Repo, query: URLSearchParams, url: string): RestResult {
  const state = query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const direction = query.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const page = paginate(issues, query, url);
  return {
    status: 200,
    body: page.items.map((issue) => issueJson(forge, repo, issue)),
    headers: page.link === null ? {} : { link: page.link },
  };
}

function patchIssue(forge: Forge, repo: Repo, issue: Issue, body: Record<string, unknown>): RestResult {
  // Validate everything before mutating anything: a rejected PATCH must not partially apply.
  let labels: string[] | undefined;
  if (Array.isArray(body.labels)) {
    labels = body.labels.filter((l): l is string => typeof l === 'string');
    for (const label of labels) if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
  }
  const state = stringField(body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = stringField(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== undefined) issue.body = text;
  if (labels !== undefined) issue.labels = labels;
  issue.updatedSeq = forge.tick();
  return { status: 200, body: issueJson(forge, repo, issue) };
}

function postPull(forge: Forge, repo: Repo, body: Record<string, unknown>): RestResult {
  const title = stringField(body, 'title');
  const headRaw = stringField(body, 'head');
  const baseRaw = stringField(body, 'base');
  if (title === undefined || headRaw === undefined || baseRaw === undefined) return err(422, 'title, head and base are required');
  const head = normalizeRefName(headRaw);
  const base = normalizeRefName(baseRaw);
  if (repo.tipOf(base) === null) return err(422, `base branch "${base}" does not exist`);
  if (repo.tipOf(head) === null) return err(422, `head branch "${head}" does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      return err(422, `A pull request already exists for ${repo.owner}:${head} -> ${repo.owner}:${base}`);
    }
  }
  const pull = createPull(forge, repo, { title, body: stringField(body, 'body') ?? '', head, base });
  return { status: 201, body: pullJson(forge, repo, pull) };
}

function listPulls(forge: Forge, repo: Repo, query: URLSearchParams, url: string): RestResult {
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  const page = paginate(pulls, query, url);
  return {
    status: 200,
    body: page.items.map((pull) => pullJson(forge, repo, pull)),
    headers: page.link === null ? {} : { link: page.link },
  };
}

function pullFiles(repo: Repo, pull: Pull): RestResult {
  const baseTip = repo.tipOf(pull.base);
  const headTip = repo.tipOf(pull.head);
  if (baseTip === null || headTip === null) return { status: 200, body: [] };
  const baseCommit = repo.peelToCommit(baseTip);
  const headCommit = repo.peelToCommit(headTip);
  if (baseCommit === null || headCommit === null) return { status: 200, body: [] };
  const changes = diffCommits(repo, baseCommit, headCommit);
  return {
    status: 200,
    body: changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })),
  };
}

function mergePull(forge: Forge, repo: Repo, pull: Pull): RestResult {
  const outcome = mergePullRequest(forge, repo, pull);
  if (outcome.ok) return { status: 200, body: { sha: outcome.commitOid, merged: true, message: 'Pull Request successfully merged' } };
  if (outcome.reason === 'not-open') return err(405, 'Pull Request has already been merged');
  return err(405, 'Pull Request is not mergeable');
}

// ---------------------------------------------------------------------------------------------
// dispatch: segments are the decoded path parts after /api/v3
// ---------------------------------------------------------------------------------------------

export function handleRest(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  bodyValue: unknown,
  selfUrl: string,
): RestResult {
  const body = asRecord(bodyValue);
  const [head, ...tail] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (head === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }
  if (head === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: userJson(forge) };
  }
  if (head === 'user' && tail[0] === 'repos' && segments.length === 2) {
    if (method === 'POST') return createRepo(forge, body);
    if (method === 'GET') return listViewerRepos(forge, query, selfUrl);
    return notFound();
  }
  if (head !== 'repos' || tail.length < 2) return notFound();

  const owner = tail[0]!;
  const name = tail[1]!;
  const repo = forge.repo(owner, name);
  if (repo === null) return notFound();
  const rest = tail.slice(2);
  const path = rest.join('/');

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(forge, repo) };
    if (method === 'PATCH') {
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      return { status: 200, body: repoJson(forge, repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204 };
    }
    return notFound();
  }

  if (path === 'branches' && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`)! }, protected: false }));
    return { status: 200, body: branches };
  }
  if (rest[0] === 'branches' && rest.length >= 2 && method === 'GET') {
    const branch = rest.slice(1).join('/');
    const tip = repo.tipOf(branch);
    if (tip === null) return notFound();
    return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
  }
  if (path === 'commits' && method === 'GET') return listCommits(repo, query, selfUrl);

  if (path === 'git/refs' && method === 'POST') {
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return err(422, 'ref and sha are required');
    if (repo.get(sha)?.type !== 'commit') return err(422, 'sha is not a commit');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length >= 4 && method === 'GET') {
    const branch = rest.slice(3).join('/');
    const tip = repo.tipOf(branch);
    if (tip === null) return notFound();
    return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } } };
  }

  if (rest[0] === 'contents') {
    const contentPath = rest.slice(1).join('/');
    if (method === 'GET') return getContents(forge, repo, contentPath, query);
    if (method === 'PUT') return putContents(forge, repo, contentPath, body);
    if (method === 'DELETE') return deleteContents(forge, repo, contentPath, body);
    return notFound();
  }

  if (path === 'labels') {
    if (method === 'POST') return createLabel(repo, body);
    if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map(labelJson) };
    return notFound();
  }

  if (path === 'issues') {
    if (method === 'POST') return postIssue(forge, repo, body);
    if (method === 'GET') return listIssues(forge, repo, query, selfUrl);
    return notFound();
  }
  if (rest[0] === 'issues' && rest.length >= 2) {
    const number = Number.parseInt(rest[1]!, 10);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return { status: 200, body: issueJson(forge, repo, issue) };
      if (method === 'PATCH') return patchIssue(forge, repo, issue, body);
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'POST') {
        const comment = addComment(forge, repo, issue.number, stringField(body, 'body') ?? '');
        return { status: 201, body: commentJson(forge, comment) };
      }
      if (method === 'GET') {
        const comments = repo.comments.get(issue.number) ?? [];
        const page = paginate(comments, query, selfUrl);
        return {
          status: 200,
          body: page.items.map((comment) => commentJson(forge, comment)),
          headers: page.link === null ? {} : { link: page.link },
        };
      }
      return notFound();
    }
    return notFound();
  }

  if (path === 'pulls') {
    if (method === 'POST') return postPull(forge, repo, body);
    if (method === 'GET') return listPulls(forge, repo, query, selfUrl);
    return notFound();
  }
  if (rest[0] === 'pulls' && rest.length >= 2) {
    const number = Number.parseInt(rest[1]!, 10);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2 && method === 'GET') {
      if (pull === undefined) return notFound();
      return { status: 200, body: pullJson(forge, repo, pull) };
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      return pullFiles(repo, pull);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      return mergePull(forge, repo, pull);
    }
    return notFound();
  }

  return notFound();
}
