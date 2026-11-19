// The contest's HTTP surface: one Node server exposing git smart HTTP, REST v3, GraphQL v4 and MCP,
// all against one in-memory store. app.ts is deliberately separate from main.ts: this is the
// server, the file you grow; main.ts is the entry <-> env lifecycle and should stay as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleGitHttp } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { createStore } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function searchOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** `/{owner}/{repo}.git` optionally followed by `/info/refs` or `/git-<service>`. */
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = createStore();
  let requestCounter = 0;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void serve(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    requestCounter += 1;
    // GitHub stamps every REST reply with a request id; the conformance suite requires a non-empty one.
    const requestId = `forge-${requestCounter}`;

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const authorization = req.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
    const authenticated = token !== null && (expected === '' || token === expected);
    const body = await readBody(req);

    if (path.startsWith('/api/v3')) {
      let json: unknown;
      let malformed = false;
      if (body.length > 0) {
        try {
          json = JSON.parse(body.toString('utf8')) as unknown;
        } catch {
          malformed = true;
        }
      }
      const reply = handleRest(store, {
        method,
        pathname: path,
        searchParams: searchOf(req),
        host: req.headers.host ?? 'localhost',
        authenticated,
        json,
        malformed,
      });
      if (reply === null) {
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
        return;
      }
      if (reply.body === undefined) {
        res.writeHead(reply.status, { ...reply.headers, 'x-github-request-id': requestId });
        res.end();
        return;
      }
      sendJson(res, reply.status, reply.body, { ...reply.headers, 'x-github-request-id': requestId });
      return;
    }

    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
        return;
      }
      const reply = await handleGraphQL(store, body.toString('utf8'), authenticated);
      sendJson(res, reply.status, reply.body, { 'x-github-request-id': requestId });
      return;
    }

    if (path === '/mcp') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
        return;
      }
      const reply = await handleMcp(store, { rawBody: body, headers: req.headers, authenticated });
      res.writeHead(reply.status, { ...reply.headers, 'x-github-request-id': requestId });
      res.end(reply.body);
      return;
    }

    const gitMatch = GIT_PATH.exec(path);
    if (gitMatch !== null) {
      const gitReply = handleGitHttp(store, {
        owner: decodeURIComponent(gitMatch[1] as string),
        repo: decodeURIComponent(gitMatch[2] as string),
        path: gitMatch[3] ?? '',
        method,
        query: searchOf(req),
        headers: req.headers,
        body,
        authenticated,
      });
      if (gitReply !== null) {
        res.writeHead(gitReply.status, {
          'content-type': gitReply.contentType,
          'content-length': gitReply.body.length,
          'x-github-request-id': requestId,
        });
        res.end(gitReply.body);
        return;
      }
    }

    // Everything else, every method: GitHub's 404 body.
    sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
  }
}
