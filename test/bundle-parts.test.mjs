// deploy_frontend with a folder over one request: the parts, and how they are sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { packParts } from '../dist/bundle-parts.js';
import { registerTools } from '../dist/tools.js';

const MB = 1024 * 1024;

function site(files) {
  const dir = mkdtempSync(join(tmpdir(), 'parts-'));
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), data);
  }
  return dir;
}

const names = (buf) => new AdmZip(buf).getEntries().map((e) => e.entryName).sort();

test('packParts: every file once, no part over the limit, index.html in the last one', () => {
  // Random bytes do not compress, the worst case for the size of a part.
  const dir = site({
    'index.html': '<h1>home</h1>',
    'a/1.bin': randomBytes(4 * MB),
    'a/2.bin': randomBytes(4 * MB),
    'b/3.bin': randomBytes(4 * MB),
    'c.css': 'body{}',
  });
  try {
    const packed = packParts(dir, 10 * MB);
    assert.ok(packed.count >= 2);
    const all = [];
    for (let i = 0; i < packed.count; i++) {
      const buf = packed.part(i);
      assert.ok(buf.length <= 10 * MB);
      all.push(...names(buf));
    }
    assert.deepEqual(all.sort(), ['a/1.bin', 'a/2.bin', 'b/3.bin', 'c.css', 'index.html']);
    assert.ok(names(packed.part(packed.count - 1)).includes('index.html'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packParts: a small folder is one part, and a file over the limit is refused by name', () => {
  const small = site({ 'index.html': 'x', 'y.js': 'y' });
  const big = site({ 'index.html': 'x', 'video.mp4': randomBytes(2 * MB) });
  try {
    assert.equal(packParts(small, 10 * MB).count, 1);
    assert.throws(() => packParts(big, 2 * MB), /video\.mp4/);
  } finally {
    rmSync(small, { recursive: true, force: true });
    rmSync(big, { recursive: true, force: true });
  }
});

test('deploy_frontend sends a folder over 95MB as parts, with the upload id, final on the last', async () => {
  const dir = site({
    'index.html': '<h1>home</h1>',
    'p1.bin': randomBytes(60 * MB),
    'p2.bin': randomBytes(60 * MB),
  });
  const uploads = [];
  const api = {
    apiUrl: 'https://api.test',
    appUrl: (p) => `https://app.test${p}`,
    defaultOrganizationId: async () => 'org-1',
    writableOrganizations: async () => [{ id: 'org-1', name: 'Test' }],
    request: async () => ({}),
    requestUpload: async (path, field, fileName, data, fields) => {
      uploads.push({ path, fields, size: data.length });
      const final = fields?.final === 'true';
      return final
        ? { version: 7, url: 'https://s.tasklite.dev', uploadId: 'u-1', parts: uploads.length, published: false }
        : { uploadId: 'u-1', parts: uploads.length, final: false };
    },
  };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, () => api);
  const client = new Client({ name: 'c', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const res = await client.callTool({ name: 'deploy_frontend', arguments: { appId: 'app-1', dir } });
    assert.ok(!res.isError, res.content?.[0]?.text);
    const out = JSON.parse(res.content[0].text);
    assert.equal(out.version, 7);
    assert.ok(uploads.length >= 2);
    assert.ok(uploads.every((u) => u.path === '/organizations/org-1/apps/app-1/deployments/parts'));
    assert.ok(uploads.every((u) => u.size <= 95 * MB));
    assert.equal(uploads[0].fields.uploadId, undefined);
    assert.ok(uploads.slice(1).every((u) => u.fields.uploadId === 'u-1'));
    assert.deepEqual(uploads.map((u) => u.fields.final), [...uploads.slice(1).map(() => 'false'), 'true']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
