// deploy_frontend guards: no server-side dir in hosted mode, a zipUrl that
// cannot reach private networks, zip entry checks, and ids in URL paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isPublicAddress, downloadPublicZip } from '../dist/safe-fetch.js';
import { registerTools, normalizeBundle, MAX_UNCOMPRESSED, idSeg } from '../dist/tools.js';

async function connect(options) {
  const calls = [];
  const api = {
    apiUrl: 'https://api.test',
    appUrl: (p) => `https://app.test${p}`,
    defaultOrganizationId: async () => 'org-1',
    writableOrganizations: async () => [{ id: 'org-1', name: 'Test' }],
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return {};
    },
    requestUpload: async (path) => {
      calls.push({ method: 'UPLOAD', path });
      return {};
    },
  };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, () => api, undefined, options);
  const client = new Client({ name: 'c', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls };
}

const text = (res) => res.content.map((c) => c.text).join('\n');

test('isPublicAddress refuses private, loopback, link-local, CGNAT, unspecified and mapped forms', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    'not-an-ip',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('isPublicAddress allows public addresses', () => {
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

const publicResolver = async () => [{ address: '8.8.8.8', family: 4 }];
const stream = (...parts) =>
  (async function* () {
    for (const p of parts) yield Buffer.from(p);
  })();
const reply = (status, headers, body = stream('')) => ({ status, headers, body, destroy: () => {} });

test('downloadPublicZip: http, private literal and private resolution are refused', async () => {
  const never = async () => assert.fail('must not connect');
  await assert.rejects(downloadPublicZip('http://example.com/a.zip', 1000, { resolve: publicResolver, request: never }), /https/);
  await assert.rejects(downloadPublicZip('https://127.0.0.1/a.zip', 1000, { request: never }), /public host/);
  await assert.rejects(downloadPublicZip('https://[::1]/a.zip', 1000, { request: never }), /public host/);
  const mixed = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ];
  await assert.rejects(downloadPublicZip('https://evil.test/a.zip', 1000, { resolve: mixed, request: never }), /public host/);
});

test('downloadPublicZip: a redirect to a private host is refused, and the chain is capped at 3', async () => {
  const resolve = async (host) =>
    host === 'internal.test' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '8.8.8.8', family: 4 }];
  const toInternal = async () => reply(302, { location: 'https://internal.test/x' });
  await assert.rejects(downloadPublicZip('https://ok.test/a.zip', 1000, { resolve, request: toInternal }), /public host/);
  let hops = 0;
  const loop = async () => {
    hops++;
    return reply(301, { location: 'https://ok.test/next' });
  };
  await assert.rejects(downloadPublicZip('https://ok.test/a.zip', 1000, { resolve, request: loop }), /redirected more than 3/);
  assert.equal(hops, 4);
});

test('downloadPublicZip: follows a public redirect and pins the checked address', async () => {
  const seen = [];
  const request = async (url, pinned) => {
    seen.push([url.hostname, pinned.address]);
    return url.hostname === 'a.test' ? reply(302, { location: 'https://b.test/z.zip' }) : reply(200, {}, stream('PK', 'data'));
  };
  const buf = await downloadPublicZip('https://a.test/z.zip', 1000, { resolve: publicResolver, request });
  assert.equal(buf.toString(), 'PKdata');
  assert.deepEqual(seen, [
    ['a.test', '8.8.8.8'],
    ['b.test', '8.8.8.8'],
  ]);
});

test('downloadPublicZip: aborts a stream that passes the limit even when content-length lies', async () => {
  let destroyed = false;
  let pulled = 0;
  const body = (async function* () {
    for (let i = 0; i < 1000; i++) {
      pulled++;
      yield Buffer.alloc(100);
    }
  })();
  const request = async () => ({
    status: 200,
    headers: { 'content-length': '5' },
    body,
    destroy: () => {
      destroyed = true;
    },
  });
  await assert.rejects(downloadPublicZip('https://a.test/z.zip', 1000, { resolve: publicResolver, request }), /limit/);
  assert.ok(destroyed);
  assert.ok(pulled < 20);
});

test('normalizeBundle refuses absolute and .. entry names and a zip that unpacks too large', () => {
  for (const name of ['../evil.txt', 'a/../../b.txt', '/etc/passwd', 'C:/x.txt', '..\\evil.txt']) {
    const fakeZip = {
      getEntries: () => [
        { entryName: 'index.html', isDirectory: false, header: { size: 1 } },
        { entryName: name, isDirectory: false, header: { size: 1 } },
      ],
    };
    assert.throws(() => normalizeBundle(fakeZip), /absolute path/, name);
  }
  const fake = {
    getEntries: () => [{ entryName: 'index.html', isDirectory: false, header: { size: MAX_UNCOMPRESSED + 1 } }],
  };
  assert.throws(() => normalizeBundle(fake), /unpacks to/);
  const fine = new AdmZip();
  fine.addFile('site/index.html', Buffer.from('x'));
  assert.ok(normalizeBundle(fine).getEntries().some((e) => e.entryName === 'index.html'));
});

test('hosted: dir is not advertised and a call with dir is refused without echoing the path', async () => {
  const { client, calls } = await connect({ hosted: true });
  const deploy = (await client.listTools()).tools.find((t) => t.name === 'deploy_frontend');
  assert.equal(deploy.inputSchema.properties.dir, undefined);
  assert.ok(!deploy.description.includes('`dir`'));
  const res = await client.callTool({ name: 'deploy_frontend', arguments: { appId: 'app-1', dir: '/etc/secret-site' } });
  assert.ok(res.isError);
  assert.ok(!/secret-site|\/etc/.test(text(res)), text(res));
  assert.match(text(res), /files|zipUrl/);
  assert.equal(calls.length, 0);
});

test('local (default): dir is still advertised', async () => {
  const { client } = await connect(undefined);
  const deploy = (await client.listTools()).tools.find((t) => t.name === 'deploy_frontend');
  assert.ok(deploy.inputSchema.properties.dir);
});

test('idSeg accepts normal ids and rejects path tricks', () => {
  for (const good of ['abc', 'app-x1y2z3', '8477c713-1111-2222-3333-444455556666', 'a_b']) assert.equal(idSeg(good), good);
  for (const bad of ['', '../x', 'a/b', 'a?b=1', 'a b', 'a.b', 'x'.repeat(129), undefined, 5]) {
    assert.throws(() => idSeg(bad), /Invalid id/, String(bad));
  }
});

test('a tool call with a malformed id is refused before any request', async () => {
  const { client, calls } = await connect({ hosted: true });
  const res = await client.callTool({ name: 'list_deployments', arguments: { appId: '../../admin' } });
  assert.ok(res.isError);
  assert.match(text(res), /Invalid id/);
  assert.equal(calls.length, 0);
});
