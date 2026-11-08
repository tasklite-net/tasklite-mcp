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

// Each unknown protocol version is logged once per process.
const loggedVersions = new Set<string>();
const PORT = Number(process.env.PORT || 8811);

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

const API_URL = (process.env.TASKLITE_API_URL || 'https://api.tasklite.net').replace(/\/+$/, '');
const RESOURCE_URL = (process.env.MCP_RESOURCE_URL || 'https://mcp.tasklite.net').replace(/\/+$/, '');

const server = http.createServer(async (req, res) => {
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
  const body = await readBody(req);
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
    registerTools(mcp, getApi); // no onboarding tools in hosted mode, auth is the front door
    const unknownVersion = acceptUnknownProtocolVersion(req);
    if (unknownVersion && !loggedVersions.has(unknownVersion)) {
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
        error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
        id: null,
      });
    }
  }
});

server.listen(PORT, () => {
  console.error(`TaskLite MCP hosted server listening on :${PORT} (POST /mcp)`);
});
