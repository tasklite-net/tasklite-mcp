/**
 * A client that asks with an MCP protocol version this SDK does not know.
 *
 * Seen 8.11.26: the Codex connector (user agent "openai-mcp/1.0.0 (Codex)")
 * sent tool calls with an MCP-Protocol-Version header newer than the latest
 * this SDK supports, and the transport refused each one with 400 "Unsupported
 * protocol version" (41 of one customer's ~170 calls in two hours). The
 * newest SDK on npm (1.32.2) knows no newer version, so updating it does not
 * help.
 *
 * This server is stateless and every request is answered on its own, so a
 * version we do not know is answered as our latest one, the same version
 * initialize would have agreed on. The header is rewritten in both places the
 * SDK may read it from (headers and rawHeaders: @hono/node-server builds the
 * web Request from rawHeaders). Known versions, and requests without the
 * header, are untouched. Returns the version that was replaced, or null.
 */
import type { IncomingMessage } from 'node:http';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

const HEADER = 'mcp-protocol-version';

export function acceptUnknownProtocolVersion(req: IncomingMessage): string | null {
  const raw = req.headers[HEADER];
  const asked = Array.isArray(raw) ? raw[0] : raw;
  if (!asked || SUPPORTED_PROTOCOL_VERSIONS.includes(asked)) return null;
  req.headers[HEADER] = LATEST_PROTOCOL_VERSION;
  const rh = req.rawHeaders;
  for (let i = 0; i + 1 < rh.length; i += 2) {
    if (rh[i].toLowerCase() === HEADER) rh[i + 1] = LATEST_PROTOCOL_VERSION;
  }
  return asked;
}
