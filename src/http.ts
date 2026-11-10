#!/usr/bin/env node
/**
 * TaskLite MCP, hosted HTTP entry (mcp.tasklite.net).
 *
 * Streamable HTTP transport, stateless: every POST /mcp carries the caller's
 * own credential in the Authorization header (Bearer tl_... key, or a TaskLite
 * JWT once the OAuth flow issues one), and gets a fresh server+api scoped to
 * that credential. No cross-user state ever lives in this process.
 *
 * Connect from Claude Code:
 *   claude mcp add --transport http tasklite https://mcp.tasklite.net/mcp \
 *     --header "Authorization: Bearer tl_xxx"
 *
 * OAuth discovery for Claude Desktop/web connectors is the next phase -
 * this server already returns spec-compliant 401 + WWW-Authenticate.
 */
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TaskLiteApi } from './api.js';
import { registerTools } from './tools.js';
import { VERSION } from './version.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { acceptUnknownProtocolVersion } from './protocol-version.js';

// Discovery without a credential: initialize, ping and tools/list carry no
// data, and directories / catalogs / client "test connection" buttons need
// them before the user has signed in. Every tools/call still requires auth.
const DISCOVERY_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'prompts/list',
  'notifications/initialized',
]);
function isDiscoveryOnly(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.length > 0 && msgs.every((m) => m && typeof m === 'object' && DISCOVERY_METHODS.has((m as { method?: string }).method ?? ''));
}

// Each unknown protocol version is logged once per process, the first 20 only:
// the header is the caller's, and random values must not grow the set or the log.
const loggedVersions = new Set<string>();
const PORT = Number(process.env.PORT || 8811);
// Loopback by default: nginx on the same box is the only intended client.
// Set HOST (for example 0.0.0.0 in a container) to listen elsewhere.
const HOST = process.env.HOST || '127.0.0.1';

// The largest JSON-RPC body accepted. The biggest legitimate one is a
// deploy_frontend call with inline files (8 MB decoded, about 11 MB as base64).
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

// How long, and how much, an oversized upload is still read (and thrown away) after the 413.
const DRAIN_MS = 30_000;
const DRAIN_BYTES = 128 * 1024 * 1024;

export class BodyTooLargeError extends Error {}
export class BadJsonError extends Error {}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

// Read with listeners, not `for await`: leaving a for-await loop early destroys the request, and
// with it the socket, before the 413 can be written. Here an oversized body is no longer kept but
// keeps flowing, so the client can finish sending and then read the answer.
export function readBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBytes) {
      req.resume();
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return; // over the limit: discard what is still arriving
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BadJsonError());
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

const API_URL = (process.env.TASKLITE_API_URL || 'https://api.tasklite.net').replace(/\/+$/, '');
const RESOURCE_URL = (process.env.MCP_RESOURCE_URL || 'https://mcp.tasklite.net').replace(/\/+$/, '');

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');

  if (url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'tasklite-mcp', version: VERSION });
  }

  // RFC 9728, lets MCP clients discover the auth server with no config.
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    return sendJson(res, 200, {
      resource: RESOURCE_URL,
      authorization_servers: [API_URL],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    });
  }

  if (url.pathname !== '/mcp') {
    return sendJson(res, 404, { error: 'not_found' });
  }

  if (req.method !== 'POST') {
    // Stateless mode: no server-initiated SSE stream, no sessions to delete.
    return sendJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed, POST only (stateless mode)' },
      id: null,
    });
  }

  const auth = req.headers['authorization'];
  const credential = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // The answer waits until the client has finished sending. A server that answers and closes while
      // the upload is still arriving leaves unread data on the socket, the kernel then sends a reset,
      // and the client loses the 413 it had not read yet (seen on Linux in CI, and on every platform
      // when the request asks for Connection: close). The rest of the body is thrown away as it arrives
      // (readBody); a client still sending after DRAIN_MS, or past DRAIN_BYTES, is answered and cut off.
      await new Promise<void>((done) => {
        if (req.readableEnded || req.destroyed) return done();
        let drained = 0;
        const giveUp = setTimeout(done, DRAIN_MS);
        giveUp.unref();
        const finish = () => {
          clearTimeout(giveUp);
          done();
        };
        req.on('data', (chunk: Buffer) => {
          drained += chunk.length;
          if (drained > DRAIN_BYTES) finish();
        });
        req.on('end', finish);
        req.on('close', finish);
        req.on('error', finish);
      });
      if (res.destroyed || res.headersSent) return;
      return sendJson(
        res,
        413,
        { jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large' }, id: null },
        { Connection: 'close' },
      );
    }
    if (err instanceof BadJsonError) {
      return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    throw err;
  }
  if (!credential && !isDiscoveryOnly(body)) {
    // Point clients at the resource metadata so they can start the OAuth flow.
    return sendJson(
      res,
      401,
      { error: 'unauthorized', message: 'Authentication required.' },
      {
        'WWW-Authenticate': `Bearer realm="TaskLite MCP", resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource"`,
      },
    );
  }

  try {
    const api = credential ? new TaskLiteApi(credential) : null;
    const getApi = () => {
      if (!api) throw new Error('Authentication required: connect with OAuth or pass Authorization: Bearer tl_… to call tools.');
      return api;
    };
    const mcp = new McpServer(
      { name: 'tasklite', version: VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerTools(mcp, getApi, undefined, { hosted: true }); // no onboarding tools in hosted mode, auth is the front door
    const unknownVersion = acceptUnknownProtocolVersion(req);
    if (unknownVersion && loggedVersions.size < 20 && !loggedVersions.has(unknownVersion)) {
      loggedVersions.add(unknownVersion);
      console.error(`protocol version ${unknownVersion} (${req.headers['user-agent'] || '?'}) answered as the latest this SDK knows`);
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      });
    }
  }
}

const server = http.createServer((req, res) => {
  // No rejection may escape a request: it would take the whole process down.
  handle(req, res).catch((err) => {
    console.error('request failed:', err);
    try {
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      } else {
        res.end();
      }
    } catch {
      /* the socket is already gone */
    }
  });
});

// Slow or stalled clients must not hold sockets open forever. The request
// timeout covers a full 16 MB upload on a slow link.
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;

// Log and keep serving: one bad request must never end the process for every customer.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

server.listen(PORT, HOST, () => {
  console.error(`TaskLite MCP hosted server listening on ${HOST}:${PORT} (POST /mcp)`);
});
