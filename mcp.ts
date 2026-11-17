// MCP over Streamable HTTP at /mcp: JSON-RPC 2.0, the 2026-07-28 server/discover revision
// (with the initialize handshake also served), tools/list and tools/call for the six
// github-mcp-server tools the suite drives. Tools act on the same store as REST, and their
// results carry both a text block and structuredContent holding the REST-shaped object.

import { Forge, Repo, mergePullRequest } from './store.ts';
import { createIssue, createPull, issueJson, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required };
}

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema(
      { name: str('The repository name'), description: str('The repository description'), private: { type: 'boolean', description: 'Whether the repository is private' } },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: str('The repository owner login'), repo: str('The repository name') }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema(
      { owner: str('The repository owner login'), repo: str('The repository name'), title: str('The issue title'), body: str('The issue body') },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed or all).',
    inputSchema: objectSchema(
      { owner: str('The repository owner login'), repo: str('The repository name'), state: str('Filter by state: open, closed or all') },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        title: str('The pull request title'),
        body: str('The pull request body'),
        head: str('The head branch name'),
        base: str('The base branch name'),
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: objectSchema(
      {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        pull_number: { type: 'integer', description: 'The pull request number' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

type JsonRpcId = string | number | null;

interface RpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const ok = (id: JsonRpcId, result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: JsonRpcId, code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The repository a tool call names, or the tool error to answer with. */
function toolRepo(forge: Forge, args: Record<string, unknown>): { repo: Repo } | { error: Record<string, unknown> } {
  const owner = stringArg(args, 'owner');
  const name = stringArg(args, 'repo');
  if (owner === undefined || name === undefined) return { error: toolError('owner and repo are required') };
  const repo = forge.repo(owner, name);
  if (repo === null) return { error: toolError(`repository ${owner}/${name} not found`) };
  return { repo };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { result?: unknown; error?: { code: number; message: string } } {
  const missing = (keys: string[]): string | null => {
    for (const key of keys) if (args[key] === undefined || args[key] === '') return key;
    return null;
  };
  switch (name) {
    case 'create_repo': {
      const bad = missing(['name']);
      if (bad) return { error: { code: -32602, message: `missing required argument: ${bad}` } };
      const repoName = String(args.name);
      if (forge.repo(forge.viewer.login, repoName) !== null) return { result: toolError(`repository ${repoName} already exists`) };
      const repo = forge.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { result: toolResult(repoJson(forge, repo)) };
    }
    case 'get_repo': {
      const bad = missing(['owner', 'repo']);
      if (bad) return { error: { code: -32602, message: `missing required argument: ${bad}` } };
      const found = toolRepo(forge, args);
      if ('error' in found) return { result: found.error };
      return { result: toolResult(repoJson(forge, found.repo)) };
    }
    case 'create_issue': {
      const bad = missing(['owner', 'repo', 'title']);
      if (bad) return { error: { code: -32602, message: `missing required argument: ${bad}` } };
      const found = toolRepo(forge, args);
      if ('error' in found) return { result: found.error };
      const issue = createIssue(forge, found.repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { result: toolResult(issueJson(forge, found.repo, issue)) };
    }
    case 'list_issues': {
      const bad = missing(['owner', 'repo']);
      if (bad) return { error: { code: -32602, message: `missing required argument: ${bad}` } };
      const found = toolRepo(forge, args);
      if ('error' in found) return { result: found.error };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...found.repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { result: toolResult({ issues: issues.map((issue) => issueJson(forge, found.repo, issue)) }) };
    }
    case 'create_pull_request': {
      const bad = missing(['owner', 'repo', 'title', 'head', 'base']);
      if (bad) return { error: { code: -32602, message: `missing required argument: ${bad}` } };
      const found = toolRepo(forge, args);
      if ('error' in found) return { result: found.error };
      const repo = found.repo;
      const head = String(args.head);
      const base = String(args.base);
      if (repo.tipOf(base) === null) return { result: toolError(`base branch "${base}" does not exist`) };
      if (repo.tipOf(head) === null) return { result: toolError(`head branch "${head}" does not exist`) };
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          return { result: toolResult(pullJson(forge, repo, existing)) };
        }
      }
      const pull = createPull(forge, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return { result: toolResult(pullJson(forge, repo, pull)) };
    }
    case 'merge_pull_request': {
      const bad = missing(['owner', 'repo', 'pull_number']);
      if (bad) return { error: { code: -32602, message: `missing required argument: ${bad}` } };
      const found = toolRepo(forge, args);
      if ('error' in found) return { result: found.error };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = found.repo.pulls.get(number);
      if (!pull) return { result: toolError(`pull request #${number} not found`) };
      const outcome = mergePullRequest(forge, found.repo, pull);
      if (!outcome.ok) return { result: toolError(outcome.reason === 'conflict' ? 'pull request is not mergeable: conflicts' : 'pull request is not mergeable') };
      return { result: toolResult(pullJson(forge, found.repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

function dispatch(forge: Forge, message: Record<string, unknown>): RpcResponse | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id: JsonRpcId = (message.id as JsonRpcId) ?? null;
  const isNotification = message.id === undefined;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  let response: RpcResponse;
  switch (method) {
    case 'server/discover':
      response = ok(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      response = ok(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      break;
    }
    case 'ping':
      response = ok(id, {});
      break;
    case 'tools/list':
      response = ok(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(forge, toolName, args);
      response = outcome.error ? rpcError(id, outcome.error.code, outcome.error.message) : ok(id, outcome.result);
      break;
    }
    default:
      response = rpcError(id, -32601, `method not found: ${method}`);
  }
  return isNotification ? null : response;
}

export interface McpResult {
  status: number;
  body?: unknown;
}

/**
 * POST /mcp. `rawBody` is the exact request text: a body that is not JSON is a 400 with
 * -32700 before anything else (the parse-error contract); authentication is enforced by
 * the caller before dispatch, so an unauthenticated call is a plain HTTP 401.
 */
export function handleMcp(forge: Forge, rawBody: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const responses: RpcResponse[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'object' && entry !== null) {
        const response = dispatch(forge, entry as Record<string, unknown>);
        if (response !== null) responses.push(response);
      }
    }
    return responses.length === 0 ? { status: 202 } : { status: 200, body: responses };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const response = dispatch(forge, parsed as Record<string, unknown>);
  if (response === null) return { status: 202 };
  return { status: 200, body: response };
}
