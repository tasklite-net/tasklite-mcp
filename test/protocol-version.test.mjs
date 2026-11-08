// node --test test/protocol-version.test.mjs (after tsc)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptUnknownProtocolVersion } from '../dist/protocol-version.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

const req = (v) => {
  const headers = { 'content-type': 'application/json' };
  const rawHeaders = ['Content-Type', 'application/json'];
  if (v !== undefined) {
    headers['mcp-protocol-version'] = v;
    rawHeaders.push('MCP-Protocol-Version', v);
  }
  return { headers, rawHeaders };
};

test('an unknown version is answered as the latest, in headers and rawHeaders', () => {
  const r = req('2099-01-01');
  assert.equal(acceptUnknownProtocolVersion(r), '2099-01-01');
  assert.equal(r.headers['mcp-protocol-version'], LATEST_PROTOCOL_VERSION);
  assert.deepEqual(r.rawHeaders, ['Content-Type', 'application/json', 'MCP-Protocol-Version', LATEST_PROTOCOL_VERSION]);
});

test('a known version, or no header, is left alone', () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    const r = req(v);
    assert.equal(acceptUnknownProtocolVersion(r), null);
    assert.equal(r.headers['mcp-protocol-version'], v);
    assert.equal(r.rawHeaders[3], v);
  }
  const none = req(undefined);
  assert.equal(acceptUnknownProtocolVersion(none), null);
  assert.equal(none.headers['mcp-protocol-version'], undefined);
});
