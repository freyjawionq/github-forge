// A small GraphQL executor for the documents gh and github-mcp-server send: operations with
// variables, aliases, inline fragments, input objects, enum lists, Relay node(id:), the
// __type introspection probes, cursor connections and operation batching. It executes over
// the same store as REST, so ids and objects agree across surfaces.

import { Forge, Repo, diffCommits, mergePullRequest, pullMergeable, type Issue, type Pull } from './store.ts';
import { addComment, createIssue, createPull } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// global ids: base64 of "Type:part:part", opaque and stable across reads
// ---------------------------------------------------------------------------------------------

export function gid(type: string, ...parts: Array<string | number>): string {
  return Buffer.from([type, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function parseGid(id: unknown): { type: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { type: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// lexer / parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { t: 'var'; name: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'enum'; v: string }
  | { t: 'null' }
  | { t: 'list'; items: ValueNode[] }
  | { t: 'obj'; fields: Array<[string, ValueNode]> };

type Sel =
  | { kind: 'field'; name: string; alias?: string; args: Map<string, ValueNode>; sels: Sel[] }
  | { kind: 'inline'; typeCond?: string; sels: Sel[] }
  | { kind: 'spread'; name: string };

interface Operation {
  op: 'query' | 'mutation';
  name?: string;
  varDefaults: Map<string, ValueNode>;
  sels: Sel[];
}

interface Fragment {
  typeCond?: string;
  sels: Sel[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private readonly tokens: Array<{ kind: string; value: string }>;
  private pos = 0;

  constructor(tokens: Array<{ kind: string; value: string }>) {
    this.tokens = tokens;
  }

  private peek(): { kind: string; value: string } {
    return this.tokens[this.pos]!;
  }

  private next(): { kind: string; value: string } {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expect(kind: string, value?: string): { kind: string; value: string } {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new GqlSyntaxError(`expected ${value ?? kind}, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ op: 'query', varDefaults: new Map(), sels: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new GqlSyntaxError(`unexpected ${token.kind}`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefaults = this.parseVariableDefinitions();
        this.skipDirectives();
        const sels = this.parseSelectionSet();
        operations.push({ op: token.value === 'mutation' ? 'mutation' : 'query', name, varDefaults, sels });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name', 'on');
        const typeCond = this.expect('name').value;
        this.skipDirectives();
        fragments.set(fragName, { typeCond, sels: this.parseSelectionSet() });
        continue;
      }
      throw new GqlSyntaxError(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Map<string, ValueNode> {
    const defaults = new Map<string, ValueNode>();
    if (!this.atPunct('(')) return defaults;
    this.next();
    while (!this.atPunct(')')) {
      this.expect('punct', '$');
      const name = this.expect('name').value;
      this.expect('punct', ':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        defaults.set(name, this.parseValue(true));
      }
      this.skipDirectives();
    }
    this.next();
    return defaults;
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expect('punct', ']');
    } else {
      this.expect('name');
    }
    if (this.atPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expect('name');
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    if (!this.atPunct('(')) return args;
    this.next();
    while (!this.atPunct(')')) {
      const name = this.expect('name').value;
      this.expect('punct', ':');
      args.set(name, this.parseValue(false));
    }
    this.next();
    return args;
  }

  private parseValue(constant: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (constant) throw new GqlSyntaxError('variable in constant value');
      return { t: 'var', name: this.expect('name').value };
    }
    if (token.kind === 'string') return { t: 'str', v: token.value };
    if (token.kind === 'number') return { t: 'num', v: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { t: 'bool', v: true };
      if (token.value === 'false') return { t: 'bool', v: false };
      if (token.value === 'null') return { t: 'null' };
      return { t: 'enum', v: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue(constant));
      this.next();
      return { t: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (!this.atPunct('}')) {
        const name = this.expect('name').value;
        this.expect('punct', ':');
        fields.push([name, this.parseValue(constant)]);
      }
      this.next();
      return { t: 'obj', fields };
    }
    throw new GqlSyntaxError(`unexpected value token ${token.kind} ${token.value}`);
  }

  private parseSelectionSet(): Sel[] {
    this.expect('punct', '{');
    const sels: Sel[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCond = this.expect('name').value;
          this.skipDirectives();
          sels.push({ kind: 'inline', typeCond, sels: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          sels.push({ kind: 'spread', name: this.next().value });
        } else {
          sels.push({ kind: 'inline', sels: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.expect('name').value;
      let alias: string | undefined;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.expect('name').value;
      }
      const args = this.parseArguments();
      this.skipDirectives();
      let sub: Sel[] = [];
      if (this.atPunct('{')) sub = this.parseSelectionSet();
      sels.push({ kind: 'field', name, alias, args, sels: sub });
    }
    this.next();
    return sels;
  }
}

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.t) {
    case 'var':
      return vars[node.name];
    case 'str':
    case 'num':
    case 'bool':
    case 'enum':
      return node.v;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, vars));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------------------------

type Parent = { __typename: string; [key: string]: unknown };
type Resolver = (parent: Parent, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface Ctx {
  forge: Forge;
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, Fragment>;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'databaseId', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'labels', 'comments', 'author', 'repository', 'closed'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'createdAt', 'updatedAt', 'url', 'headRef', 'baseRef', 'mergeCommit', 'additions',
    'deletions', 'changedFiles', 'author',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'id', 'message', 'committedDate'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description', 'possibleTypes'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
  __Schema: ['types', 'queryType', 'mutationType', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function userParent(forge: Forge): Parent {
  return { __typename: 'User' };
}

function repoParent(repo: Repo): Parent {
  return { __typename: 'Repository', repo };
}

function issueParent(repo: Repo, issue: Issue): Parent {
  return { __typename: 'Issue', repo, issue };
}

function pullParent(repo: Repo, pull: Pull): Parent {
  return { __typename: 'PullRequest', repo, pull };
}

function pageInfoParent(hasNextPage: boolean, endCursor: string | null): Parent {
  return { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: null };
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Parent {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map(String));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'DESC' ? -1 : 1;
  const keyOf = (issue: Issue): number => {
    if (orderBy.field === 'UPDATED_AT') return issue.updatedSeq;
    if (orderBy.field === 'COMMENTS') return (repo.comments.get(issue.number) ?? []).length;
    return issue.seq;
  };
  list.sort((a, b) => {
    const byKey = keyOf(a) - keyOf(b);
    return (byKey !== 0 ? byKey : a.number - b.number) * direction;
  });
  let start = 0;
  if (args.after !== undefined && args.after !== null) {
    const decoded = decodeCursor(args.after);
    if (decoded !== null) start = decoded;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
  const slice = list.slice(start, start + first);
  const end = start + slice.length;
  return {
    __typename: 'IssueConnection',
    nodes: slice.map((issue) => issueParent(repo, issue)),
    pageInfo: pageInfoParent(end < list.length, encodeCursor(end)),
    totalCount: list.length,
  };
}

function pullRequestsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Parent {
  let list = [...repo.pulls.values()];
  const states = args.states;
  const stateOf = (pull: Pull): string => (pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
  if (Array.isArray(states)) {
    const wanted = new Set(states.map(String));
    list = list.filter((pull) => wanted.has(stateOf(pull)));
  } else {
    list = list.filter((pull) => pull.state === 'open');
  }
  list.sort((a, b) => b.seq - a.seq);
  let start = 0;
  if (args.after !== undefined && args.after !== null) {
    const decoded = decodeCursor(args.after);
    if (decoded !== null) start = decoded;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
  const slice = list.slice(start, start + first);
  const end = start + slice.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: slice.map((pull) => pullParent(repo, pull)),
    pageInfo: pageInfoParent(end < list.length, encodeCursor(end)),
    totalCount: list.length,
  };
}

function nodeForId(forge: Forge, id: unknown): Parent | null {
  const parsed = parseGid(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = forge.reposById.get(Number.parseInt(parsed.parts[0]!, 10));
    return repo ? repoParent(repo) : null;
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const repo = forge.reposById.get(Number.parseInt(parsed.parts[0]!, 10));
    if (!repo) return null;
    const number = Number.parseInt(parsed.parts[1]!, 10);
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue ? issueParent(repo, issue) : null;
    }
    const pull = repo.pulls.get(number);
    return pull ? pullParent(repo, pull) : null;
  }
  if (parsed.type === 'User') return userParent(forge);
  return null;
}

function repoFromGid(forge: Forge, id: unknown): Repo | null {
  const parsed = parseGid(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  return forge.reposById.get(Number.parseInt(parsed.parts[0]!, 10)) ?? null;
}

const SCHEMA: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_p, _a, ctx) => userParent(ctx.forge),
    repository: (_p, args, ctx) => {
      const repo = ctx.forge.repo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : repoParent(repo);
    },
    node: (_p, args, ctx) => nodeForId(ctx.forge, args.id),
    nodes: (_p, args, ctx) => (Array.isArray(args.ids) ? args.ids.map((id) => nodeForId(ctx.forge, id)) : []),
    __type: (_p, args) => {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) return { __typename: '__Type', name };
      return null;
    },
    __schema: () => ({ __typename: '__Schema' }),
  },
  Mutation: {
    createIssue: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGid(ctx.forge, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const issue = createIssue(ctx.forge, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __typename: 'CreateIssuePayload', issue: issueParent(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(input.issueId);
      const repo = parsed && parsed.type === 'Issue' ? ctx.forge.reposById.get(Number.parseInt(parsed.parts[0]!, 10)) : undefined;
      const issue = repo?.issues.get(Number.parseInt(parsed?.parts[1] ?? '', 10));
      if (!repo || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedSeq = ctx.forge.tick();
      return { __typename: 'CloseIssuePayload', issue: issueParent(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGid(ctx.forge, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (repo.tipOf(base) === null) throw new Error(`base ref ${base} does not exist`);
      if (repo.tipOf(head) === null) throw new Error(`head ref ${head} does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullParent(repo, existing), clientMutationId: input.clientMutationId ?? null };
        }
      }
      const pull = createPull(ctx.forge, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head,
        base,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullParent(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(input.pullRequestId);
      const repo = parsed && parsed.type === 'PullRequest' ? ctx.forge.reposById.get(Number.parseInt(parsed.parts[0]!, 10)) : undefined;
      const pull = repo?.pulls.get(Number.parseInt(parsed?.parts[1] ?? '', 10));
      if (!repo || !pull) throw new Error('pull request not found');
      const outcome = mergePullRequest(ctx.forge, repo, pull);
      if (!outcome.ok) throw new Error(outcome.reason === 'conflict' ? 'pull request is not mergeable: conflicts' : 'pull request is not mergeable');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullParent(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_p, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(input.subjectId);
      const repo = parsed && parsed.type === 'Issue' ? ctx.forge.reposById.get(Number.parseInt(parsed.parts[0]!, 10)) : undefined;
      const issue = repo?.issues.get(Number.parseInt(parsed?.parts[1] ?? '', 10));
      if (!repo || !issue) throw new Error('subject not found');
      const comment = addComment(ctx.forge, repo, issue.number, String(input.body ?? ''));
      const node: Parent = { __typename: 'IssueComment', repo, comment };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(comment.id) },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    login: (_p, _a, ctx) => ctx.forge.viewer.login,
    id: (_p, _a, ctx) => gid('User', ctx.forge.viewer.id),
    databaseId: (_p, _a, ctx) => ctx.forge.viewer.id,
    name: (_p, _a, ctx) => ctx.forge.viewer.name,
    email: (_p, _a, ctx) => ctx.forge.viewer.email,
    url: (_p, _a, ctx) => `https://forge.local/${ctx.forge.viewer.login}`,
    createdAt: (_p, _a, ctx) => ctx.forge.iso(0),
    updatedAt: (_p, _a, ctx) => ctx.forge.iso(0),
  },
  Repository: {
    id: (p) => gid('Repository', (p.repo as Repo).id),
    databaseId: (p) => (p.repo as Repo).id,
    name: (p) => (p.repo as Repo).name,
    nameWithOwner: (p) => (p.repo as Repo).fullName,
    description: (p) => (p.repo as Repo).description,
    isPrivate: (p) => (p.repo as Repo).isPrivate,
    owner: (_p, _a, ctx) => userParent(ctx.forge),
    defaultBranchRef: (p) => {
      const repo = p.repo as Repo;
      return repo.tipOf(repo.defaultBranch) === null ? null : { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (p) => `https://forge.local/${(p.repo as Repo).fullName}`,
    createdAt: (p, _a, ctx) => ctx.forge.iso((p.repo as Repo).createdSeq),
    updatedAt: (p, _a, ctx) => ctx.forge.iso((p.repo as Repo).createdSeq),
    issue: (p, args) => {
      const repo = p.repo as Repo;
      const issue = repo.issues.get(typeof args.number === 'number' ? args.number : Number.parseInt(String(args.number), 10));
      return issue ? issueParent(repo, issue) : null;
    },
    issues: (p, args, ctx) => issuesConnection(ctx, p.repo as Repo, args),
    pullRequest: (p, args) => {
      const repo = p.repo as Repo;
      const pull = repo.pulls.get(typeof args.number === 'number' ? args.number : Number.parseInt(String(args.number), 10));
      return pull ? pullParent(repo, pull) : null;
    },
    pullRequests: (p, args, ctx) => pullRequestsConnection(ctx, p.repo as Repo, args),
  },
  Issue: {
    id: (p) => gid('Issue', (p.repo as Repo).id, (p.issue as Issue).number),
    number: (p) => (p.issue as Issue).number,
    title: (p) => (p.issue as Issue).title,
    body: (p) => (p.issue as Issue).body,
    state: (p) => ((p.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    closed: (p) => (p.issue as Issue).state === 'closed',
    createdAt: (p, _a, ctx) => ctx.forge.iso((p.issue as Issue).seq),
    updatedAt: (p, _a, ctx) => ctx.forge.iso((p.issue as Issue).updatedSeq),
    url: (p) => `https://forge.local/${(p.repo as Repo).fullName}/issues/${(p.issue as Issue).number}`,
    author: (_p, _a, ctx) => userParent(ctx.forge),
    repository: (p) => repoParent(p.repo as Repo),
    labels: (p) => {
      const repo = p.repo as Repo;
      const issue = p.issue as Issue;
      return {
        __typename: 'LabelConnection',
        nodes: issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' })),
        pageInfo: pageInfoParent(false, null),
        totalCount: issue.labels.length,
      };
    },
    comments: (p) => {
      const repo = p.repo as Repo;
      const issue = p.issue as Issue;
      const comments = repo.comments.get(issue.number) ?? [];
      return {
        __typename: 'IssueCommentConnection',
        nodes: comments.map((comment) => ({ __typename: 'IssueComment', repo, comment })),
        pageInfo: pageInfoParent(false, null),
        totalCount: comments.length,
      };
    },
  },
  PullRequest: {
    id: (p) => gid('PullRequest', (p.repo as Repo).id, (p.pull as Pull).number),
    number: (p) => (p.pull as Pull).number,
    title: (p) => (p.pull as Pull).title,
    body: (p) => (p.pull as Pull).body,
    state: (p) => {
      const pull = p.pull as Pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (p) => (p.pull as Pull).merged,
    mergeable: (p) => pullMergeable(p.repo as Repo, p.pull as Pull),
    headRefName: (p) => (p.pull as Pull).head,
    baseRefName: (p) => (p.pull as Pull).base,
    headRef: (p) => {
      const repo = p.repo as Repo;
      const pull = p.pull as Pull;
      return repo.tipOf(pull.head) === null ? null : { __typename: 'Ref', name: pull.head };
    },
    baseRef: (p) => {
      const repo = p.repo as Repo;
      const pull = p.pull as Pull;
      return repo.tipOf(pull.base) === null ? null : { __typename: 'Ref', name: pull.base };
    },
    mergeCommit: (p) => {
      const pull = p.pull as Pull;
      return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha };
    },
    createdAt: (p, _a, ctx) => ctx.forge.iso((p.pull as Pull).seq),
    updatedAt: (p, _a, ctx) => ctx.forge.iso((p.pull as Pull).seq),
    url: (p) => `https://forge.local/${(p.repo as Repo).fullName}/pull/${(p.pull as Pull).number}`,
    author: (_p, _a, ctx) => userParent(ctx.forge),
    files: (p, args) => {
      const repo = p.repo as Repo;
      const pull = p.pull as Pull;
      const baseTip = repo.tipOf(pull.base);
      const headTip = repo.tipOf(pull.head);
      let nodes: Parent[] = [];
      if (baseTip !== null && headTip !== null) {
        const baseCommit = repo.peelToCommit(baseTip);
        const headCommit = repo.peelToCommit(headTip);
        if (baseCommit !== null && headCommit !== null) {
          nodes = diffCommits(repo, baseCommit, headCommit).map((change) => ({
            __typename: 'PullRequestChangedFile',
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
            changeType: change.status === 'added' ? 'ADDED' : change.status === 'deleted' ? 'DELETED' : 'MODIFIED',
          }));
        }
      }
      let start = 0;
      if (args.after !== undefined && args.after !== null) {
        const decoded = decodeCursor(args.after);
        if (decoded !== null) start = decoded;
      }
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : nodes.length;
      const slice = nodes.slice(start, start + first);
      const end = start + slice.length;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: slice,
        pageInfo: pageInfoParent(end < nodes.length, encodeCursor(end)),
        totalCount: nodes.length,
      };
    },
    additions: (p, _a, ctx) => {
      const files = SCHEMA.PullRequest!.files!(p, { first: 1000 }, ctx) as Parent;
      return (files.nodes as Parent[]).reduce((sum, node) => sum + (node.additions as number), 0);
    },
    deletions: (p, _a, ctx) => {
      const files = SCHEMA.PullRequest!.files!(p, { first: 1000 }, ctx) as Parent;
      return (files.nodes as Parent[]).reduce((sum, node) => sum + (node.deletions as number), 0);
    },
    changedFiles: (p, _a, ctx) => {
      const files = SCHEMA.PullRequest!.files!(p, { first: 1000 }, ctx) as Parent;
      return (files.nodes as Parent[]).length;
    },
  },
  IssueConnection: {
    nodes: (p) => p.nodes,
    pageInfo: (p) => p.pageInfo,
    totalCount: (p) => p.totalCount,
  },
  PullRequestConnection: {
    nodes: (p) => p.nodes,
    pageInfo: (p) => p.pageInfo,
    totalCount: (p) => p.totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (p) => p.nodes,
    pageInfo: (p) => p.pageInfo,
    totalCount: (p) => p.totalCount,
  },
  IssueCommentConnection: {
    nodes: (p) => p.nodes,
    pageInfo: (p) => p.pageInfo,
    totalCount: (p) => p.totalCount,
  },
  LabelConnection: {
    nodes: (p) => p.nodes,
    pageInfo: (p) => p.pageInfo,
    totalCount: (p) => p.totalCount,
  },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage,
    endCursor: (p) => p.endCursor,
    hasPreviousPage: (p) => p.hasPreviousPage,
    startCursor: (p) => p.startCursor,
  },
  PullRequestChangedFile: {
    path: (p) => p.path,
    additions: (p) => p.additions,
    deletions: (p) => p.deletions,
    changeType: (p) => p.changeType,
  },
  IssueComment: {
    id: (p) => gid('IssueComment', (p.repo as Repo).id, (p.comment as { id: number }).id),
    body: (p) => (p.comment as { body: string }).body,
    createdAt: (p, _a, ctx) => ctx.forge.iso((p.comment as { seq: number }).seq),
    updatedAt: (p, _a, ctx) => ctx.forge.iso((p.comment as { seq: number }).seq),
    author: (_p, _a, ctx) => userParent(ctx.forge),
    url: (p) => `https://forge.local/${(p.repo as Repo).fullName}`,
  },
  Label: {
    id: (p) => gid('Label', String(p.name)),
    name: (p) => p.name,
    color: (p) => p.color,
  },
  Ref: {
    name: (p) => p.name,
    prefix: () => 'refs/heads/',
    target: () => null,
  },
  Commit: {
    oid: (p) => p.oid,
    id: (p) => gid('Commit', String(p.oid)),
    message: () => '',
    committedDate: (_p, _a, ctx) => ctx.forge.iso(0),
  },
  CreateIssuePayload: { issue: (p) => p.issue, clientMutationId: (p) => p.clientMutationId },
  CloseIssuePayload: { issue: (p) => p.issue, clientMutationId: (p) => p.clientMutationId },
  CreatePullRequestPayload: { pullRequest: (p) => p.pullRequest, clientMutationId: (p) => p.clientMutationId },
  MergePullRequestPayload: { pullRequest: (p) => p.pullRequest, clientMutationId: (p) => p.clientMutationId },
  AddCommentPayload: {
    commentEdge: (p) => p.commentEdge,
    subject: () => null,
    clientMutationId: (p) => p.clientMutationId,
  },
  IssueCommentEdge: { node: (p) => p.node, cursor: (p) => p.cursor },
  __Type: {
    name: (p) => p.name,
    kind: (p) => (ENUM_VALUES[String(p.name)] !== undefined ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (p) => {
      const fields = TYPE_FIELDS[String(p.name)];
      if (fields === undefined) return null;
      return fields.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (p) => {
      const values = ENUM_VALUES[String(p.name)];
      if (values === undefined) return null;
      return values.map((name) => ({ __typename: '__EnumValue', name }));
    },
    possibleTypes: () => null,
  },
  __Field: {
    name: (p) => p.name,
    description: () => null,
    type: () => null,
    args: () => [],
    isDeprecated: () => false,
  },
  __EnumValue: {
    name: (p) => p.name,
    description: () => null,
    isDeprecated: () => false,
  },
  __Schema: {
    types: () => Object.keys(TYPE_FIELDS).map((name) => ({ __typename: '__Type', name })),
    queryType: () => ({ __typename: '__Type', name: 'Query' }),
    mutationType: () => ({ __typename: '__Type', name: 'Mutation' }),
    description: () => null,
  },
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

function isParent(value: unknown): value is Parent {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Parent).__typename === 'string';
}

function completeValue(value: unknown, sels: Sel[], ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, sels, ctx));
  if (isParent(value)) {
    if (sels.length === 0) return value;
    return execSelectionSet(value.__typename, value, sels, ctx);
  }
  return value;
}

function execSelectionSet(typeName: string, parent: Parent, sels: Sel[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeResolvers = SCHEMA[typeName] ?? {};
  for (const sel of sels) {
    if (sel.kind === 'inline') {
      if (sel.typeCond === undefined || sel.typeCond === typeName) {
        Object.assign(out, execSelectionSet(typeName, parent, sel.sels, ctx));
      }
      continue;
    }
    if (sel.kind === 'spread') {
      const fragment = ctx.fragments.get(sel.name);
      if (fragment && (fragment.typeCond === undefined || fragment.typeCond === typeName)) {
        Object.assign(out, execSelectionSet(typeName, parent, fragment.sels, ctx));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = typeResolvers[sel.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of sel.args) args[argName] = evalValue(argValue, ctx.vars);
    try {
      const value = resolver(parent, args, ctx);
      out[key] = completeValue(value, sel.sels, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

export interface GqlEnvelope {
  data: unknown;
  errors?: Array<{ message: string }>;
}

function executeOne(forge: Forge, body: Record<string, unknown>): GqlEnvelope {
  const query = body.query;
  if (typeof query !== 'string' || query === '') return { data: null, errors: [{ message: 'query is required' }] };
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  let operation: Operation | undefined;
  if (operationName !== undefined) operation = document.operations.find((op) => op.name === operationName);
  else if (document.operations.length === 1) operation = document.operations[0];
  else {
    // The GraphQL spec: a document with several operations and no operationName is an
    // error — never silently execute the first one.
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'operation not found' }] };
  const vars: Record<string, unknown> = {};
  const given = (body.variables ?? {}) as Record<string, unknown>;
  for (const [name, defaultValue] of operation.varDefaults) vars[name] = evalValue(defaultValue, {});
  for (const [name, value] of Object.entries(given)) vars[name] = value;
  const ctx: Ctx = { forge, vars, errors: [], fragments: document.fragments };
  const rootType = operation.op === 'mutation' ? 'Mutation' : 'Query';
  const data = execSelectionSet(rootType, { __typename: rootType }, operation.sels, ctx);
  const envelope: GqlEnvelope = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** POST /api/graphql: one operation object, or an array of them answered in order. */
export function handleGraphQL(forge: Forge, bodyValue: unknown): { status: number; body: unknown } {
  if (Array.isArray(bodyValue)) {
    const results = bodyValue.map((entry) =>
      executeOne(forge, typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}),
    );
    return { status: 200, body: results };
  }
  if (typeof bodyValue !== 'object' || bodyValue === null) {
    return { status: 400, body: { errors: [{ message: 'a GraphQL request body must be an object or an array' }] } };
  }
  const envelope = executeOne(forge, bodyValue as Record<string, unknown>);
  return { status: 200, body: envelope };
}
