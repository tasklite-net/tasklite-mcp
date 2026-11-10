// The hosted HTTP server keeps serving after bad input, and binds loopback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import os from 'node:os';

let child;
let port;
let log = '';

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

function post(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: false, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  port = await freePort();
  child = spawn(process.execPath, ['dist/http.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 50));
});

after(() => child?.kill());

test('binds loopback by default', async () => {
  assert.match(log, /listening on 127\.0\.0\.1:/);
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!external) return;
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = http.get({ host: external.address, port, path: '/health', timeout: 2000 }, resolve);
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
    }),
  );
});

test('malformed JSON gets a 400 parse error and the server keeps serving', async () => {
  const res = await post('{not json', { authorization: 'Bearer tl_x' });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.data).error.code, -32700);
  const health = await new Promise((resolve, reject) =>
    http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, (r) => {
      r.resume();
      resolve(r.statusCode);
    }).on('error', reject),
  );
  assert.equal(health, 200);
});

// Repeated: the failure this guards against (a reset instead of the answer) was intermittent on Linux.
test('a body over the limit is refused with 413, every time', async () => {
  const big = Buffer.alloc(17 * 1024 * 1024, 120);
  for (let i = 0; i < 12; i++) {
    const res = await post(big, { authorization: 'Bearer tl_x' }).catch((e) => ({ status: 0, error: String(e && e.code) }));
    assert.equal(res.status, 413, 'round ' + i + ' ' + (res.error || ''));
  }
});

test('a streamed body with no declared length is cut off at the limit with 413', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: false, headers: { 'content-type': 'application/json', authorization: 'Bearer tl_x' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let i = 0; i < 17; i++) req.write(chunk);
    req.end();
  }).catch(() => 0);
  assert.equal(status, 413);
});

test('a valid discovery request still works', async () => {
  const res = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { accept: 'application/json, text/event-stream' });
  assert.equal(res.status, 200);
});
