// The HTTP surface: one server routing /healthz, git smart HTTP, REST v3, GraphQL and MCP
// to their handlers over a single shared Forge store. Every reply carries an
// X-GitHub-Request-Id; every error is JSON with a message, never HTML; a handler failure is
// a 500, never a dead process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGit } from './smarthttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const forge = new Forge(token);
  const authorized = (req: IncomingMessage): boolean => token === '' || req.headers.authorization === `Bearer ${token}`;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const path = url.pathname;

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
          return;
        }
        const result = handleGraphQL(forge, parsed);
        sendJson(res, result.status, result.body);
        return;
      }

      if (path === '/mcp') {
        if (method === 'DELETE') {
          sendJson(res, 200, {});
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const text = body.toString('utf8');
        let parseOk = true;
        try {
          JSON.parse(text);
        } catch {
          parseOk = false;
        }
        if (!parseOk) {
          const result = handleMcp(forge, text);
          sendJson(res, result.status, result.body);
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const result = handleMcp(forge, text);
        if (result.status === 202) {
          res.writeHead(202, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        let parsed: unknown = {};
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON body' });
            return;
          }
        }
        const segments = path
          .slice('/api/v3'.length)
          .split('/')
          .filter((segment) => segment !== '')
          .map(decodeSegment);
        const selfUrl = `http://${req.headers.host ?? 'localhost'}${path}`;
        const result = handleRest(forge, method, segments, url.searchParams, parsed, selfUrl);
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      const gitMatch = GIT_PATH.exec(path);
      if (gitMatch) {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value[0] : value;
        const result = handleGit(
          forge,
          method,
          decodeSegment(gitMatch[1]!),
          decodeSegment(gitMatch[2]!),
          gitMatch[3]!,
          url.searchParams,
          headers,
          body,
        );
        sendBuffer(res, result.status, result.contentType, result.body);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    })().catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; the process stays up for the next request.
      }
    });
  });
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  return server;
}
