#!/usr/bin/env node
/**
 * Post-deploy smoke check of the conditional cell write, through the TaskLite
 * MCP exactly as the bot calls it (a stdio child per client, tool
 * set_cells_if_unchanged), against ANY API.
 *
 * Reads go through REST GET .../items/:id/cells with a session token: the
 * database, not the item cache (the read a state door must decide on);
 * writes go through the MCP tool.
 *
 * Checks:
 *   (a) a legal change succeeds and is stored;
 *   (b) a change based on a stale read gets 409 CELL_CONFLICT through MCP,
 *       conflicts[].current is the stored value, nothing is overwritten;
 *   (c) four cells, one stale: 409, only the stale one in conflicts, none
 *       of the four changes;
 *   (g) a cell without `expected` is refused (MCP schema, and the server
 *       itself with 400 CELL_EXPECTED_REQUIRED), nothing is written.
 * At the end the row's original values are written back, conditionally and
 * only over the values this script wrote itself: if anyone else wrote the
 * row meanwhile, nothing is overwritten and the run fails loudly.
 *
 * Env (all required unless marked):
 *   TASKLITE_API_URL   e.g. https://api-dev.example (no trailing slash needed)
 *   TASKLITE_API_KEY   a tl_ key of the dev organization (never a live key)
 *   PROJECT_ID, BOARD_ID, ITEM_ID   a row reserved for this test
 *   COL_1 .. COL_4     four TEXT column ids of that board
 *   MCP_COMMAND        optional, default "tasklite-mcp" (what the bot spawns)
 *   MCP_ARGS           optional JSON array, e.g. '["/path/dist/index.js"]'
 *   MCP_SDK_FROM       optional dir whose node_modules has
 *                      @modelcontextprotocol/sdk (default: the cwd, so run it
 *                      from the bot's checkout)
 *
 * Exit 0 = every check passed and the row was restored; 1 = a check failed
 * or the restore did not land; 2 = bad env.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const E = process.env;
const NEED = ['TASKLITE_API_URL', 'TASKLITE_API_KEY', 'PROJECT_ID', 'BOARD_ID', 'ITEM_ID', 'COL_1', 'COL_2', 'COL_3', 'COL_4'];
const missing = NEED.filter((k) => !E[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(', ')}`);
  process.exit(2);
}
const API = E.TASKLITE_API_URL.replace(/\/+$/, '');
const P = E.PROJECT_ID;
const B = E.BOARD_ID;
const I = E.ITEM_ID;
const COLS = [E.COL_1, E.COL_2, E.COL_3, E.COL_4].map((c) => c.toLowerCase());
const [C1, C2, C3, C4] = COLS;
const ITEM = `/projects/${P}/boards/${B}/items/${I}`;

const req = createRequire(join(E.MCP_SDK_FROM || process.cwd(), 'noop.js'));
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = req('@modelcontextprotocol/sdk/client/stdio.js');

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};

// ---------- REST read, like board-read.mjs readRow ----------
let token = null;
async function session(force) {
  if (token && !force) return token;
  if (!E.TASKLITE_API_KEY.startsWith('tl_')) return (token = E.TASKLITE_API_KEY);
  const r = await fetch(`${API}/public/v1/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${E.TASKLITE_API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`session failed (${r.status})`);
  return (token = (await r.json()).token);
}
async function http(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await session(attempt > 0)}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 401 && attempt === 0) continue;
    const text = await r.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: r.status, body: json };
  }
}
let warnedDup = false;
async function read() {
  const { status, body } = await http('GET', `${ITEM}/cells`);
  if (status !== 200) throw new Error(`read failed (${status}): ${JSON.stringify(body).slice(0, 300)}`);
  const out = {};
  for (const c of COLS) {
    const rows = (Array.isArray(body) ? body : []).filter((x) => String(x.columnId).toLowerCase() === c);
    if (rows.length > 1 && !warnedDup) {
      warnedDup = true;
      console.log(`WARN column ${c} has ${rows.length} cell rows on this item (tastlite-be#316); compare uses conflicts[].current`);
    }
    out[c] = rows[0]?.value ?? null;
  }
  return out;
}

const unwrap = (v) => {
  const u = v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v;
  return u === undefined || u === '' ? null : u;
};
const same = (a, b) => JSON.stringify(unwrap(a)) === JSON.stringify(unwrap(b));

// ---------- MCP, like the bot's connectMcp / callTool ----------
const transport = new StdioClientTransport({
  command: E.MCP_COMMAND || 'tasklite-mcp',
  args: E.MCP_ARGS ? JSON.parse(E.MCP_ARGS) : [],
  env: { ...process.env },
  stderr: 'ignore',
});
const client = new Client({ name: 'smoke-conditional', version: '0.1.0' });
await client.connect(transport);

async function cas(cells) {
  try {
    const res = await client.callTool(
      { name: 'set_cells_if_unchanged', arguments: { projectId: P, boardId: B, itemId: I, cells } },
      undefined,
      { timeout: 90_000 },
    );
    const text = (res.content || []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { isError: !!res.isError, body, text };
  } catch (e) {
    // A protocol-level refusal (e.g. input validation as an MCP error).
    return { isError: true, rejected: true, body: null, text: String(e?.message || e) };
  }
}

const { tools } = await client.listTools();
check('MCP exposes set_cells_if_unchanged', tools.some((t) => t.name === 'set_cells_if_unchanged'), tools.map((t) => t.name));

const orig = await read();
// What this script itself last wrote to each column: the only values the
// restore may write over.
const mine = {};
const nonce = Date.now().toString(36);
const A = `smoke-a-${nonce}`;
try {
  // (a) legal change
  let r = await cas([{ columnId: C1, value: A, expected: orig[C1] }]);
  check('(a) legal change answers 200', !r.isError && r.body?.cells?.[0]?.columnId === C1, r.text);
  if (!r.isError) mine[C1] = A;
  let now = await read();
  check('(a) value stored', same(now[C1], A), now[C1]);

  // (b) stale read: orig[C1] no longer holds
  r = await cas([{ columnId: C1, value: `smoke-b-${nonce}`, expected: orig[C1] }]);
  check('(b) stale write refused: 409 CELL_CONFLICT', r.isError && r.body?.status === 409 && r.body?.code === 'CELL_CONFLICT', r.text);
  const cur = r.body?.conflicts?.find((c) => String(c.columnId).toLowerCase() === C1)?.current;
  check('(b) conflicts[].current is the stored value', same(cur, A), r.body?.conflicts);
  now = await read();
  check('(b) nothing overwritten', same(now[C1], A), now[C1]);

  // (c) four cells, one stale (C1), three fresh
  const before = await read();
  r = await cas([
    { columnId: C1, value: `smoke-c1-${nonce}`, expected: orig[C1] },
    { columnId: C2, value: `smoke-c2-${nonce}`, expected: before[C2] },
    { columnId: C3, value: `smoke-c3-${nonce}`, expected: before[C3] },
    { columnId: C4, value: `smoke-c4-${nonce}`, expected: before[C4] },
  ]);
  const conflictCols = (r.body?.conflicts || []).map((c) => String(c.columnId).toLowerCase());
  check('(c) four cells, one stale: 409 CELL_CONFLICT', r.isError && r.body?.code === 'CELL_CONFLICT', r.text);
  check('(c) only the stale cell is in conflicts', conflictCols.length === 1 && conflictCols[0] === C1, conflictCols);
  now = await read();
  check('(c) none of the four changed', COLS.every((c) => same(now[c], before[c])), { before, now });

  // (g) no `expected`
  r = await cas([{ columnId: C2, value: `smoke-g-${nonce}` }]);
  check('(g) MCP refuses a cell without expected', r.isError, r.text);
  const h = await http('PUT', `${ITEM}/cells/conditional`, { cells: [{ columnId: C2, value: `smoke-g2-${nonce}` }] });
  check('(g) server refuses it too: 400 CELL_EXPECTED_REQUIRED', h.status === 400 && h.body?.code === 'CELL_EXPECTED_REQUIRED', h);
  now = await read();
  check('(g) nothing written', COLS.every((c) => same(now[c], before[c])), now);
} catch (e) {
  check('no unexpected error', false, String(e?.stack || e));
} finally {
  // Restore the original values, only over what this script wrote. A column
  // that holds anything else was written by someone else meanwhile: it is
  // reported and left alone, and a 409 stops the restore (never a resend on
  // `current`, which would write over that newer value).
  let restored = false;
  try {
    const cur = await read();
    const foreign = COLS.filter((c) => !same(cur[c], orig[c]) && !(c in mine && same(cur[c], mine[c])));
    if (foreign.length) console.log(`restore: ${foreign.join(', ')} changed by someone else; left as is`);
    const cells = COLS.filter((c) => c in mine && same(cur[c], mine[c]) && !same(cur[c], orig[c])).map((c) => ({
      columnId: c,
      value: unwrap(orig[c]),
      expected: cur[c],
    }));
    if (cells.length) {
      const r = await cas(cells);
      if (r.isError) console.log(`restore refused, nothing written: ${r.text.slice(0, 300)}`);
    }
    const end = await read();
    restored = !foreign.length && COLS.every((c) => same(end[c], orig[c]));
  } catch (e) {
    console.log(`restore error: ${e?.message || e}`);
  }
  check('row restored to its original values', restored, orig);
  await client.close();
}
console.log(failed ? `SMOKE FAILED: ${failed} check(s)` : 'SMOKE OK');
process.exit(failed ? 1 : 0);
