/**
 * Offline tests: the built server (dist/) against a fake API that records
 * every request. Nothing here reaches the network.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  registerTools,
  RLS_SCHEMA,
  BUILD_RLS_SCHEMA,
  planBuildRls,
  mergeSettings,
} from '../dist/tools.js';

const ORG = 'org-1';

/** A connected client over a server whose API calls land in `calls`. */
async function harness(respond = () => ({})) {
  const calls = [];
  let n = 0;
  const api = {
    apiUrl: 'https://api.test',
    appUrl: (p) => `https://app.test${p}`,
    defaultOrganizationId: async () => ORG,
    writableOrganizations: async () => [{ id: ORG, name: 'Test' }],
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      const answer = await respond(method, path, body, ++n);
      return answer === undefined ? {} : answer;
    },
  };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, () => api);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '';
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: Boolean(res.isError), text, json };
  };
  return { client, calls, call };
}

const RELATION_ALL = {
  enabled: true,
  mode: 'relation',
  relationColumn: 'col-trainee',
  viaColumn: 'col-coach',
  identityPhoneColumn: 'col-coach-phone',
  identityEmailColumn: 'col-coach-email',
  allowInvites: true,
};

const EXPOSED = [{ columnId: 'c1', alias: 'name' }];

// ── The schema itself ────────────────────────────────────────────────────────

test('RLS_SCHEMA: relation mode round-trips with every field', () => {
  assert.deepEqual(RLS_SCHEMA.parse(RELATION_ALL), RELATION_ALL);
});

test('RLS_SCHEMA: owner, shared and phone still round-trip', () => {
  for (const value of [
    { enabled: true },
    { enabled: false },
    { enabled: true, mode: 'owner' },
    { enabled: true, mode: 'shared' },
    { enabled: true, mode: 'phone', phoneColumn: 'col-phone' },
    { enabled: true, mode: 'phone', phoneColumn: 'col-phone', emailColumn: 'col-email' },
  ]) {
    assert.deepEqual(RLS_SCHEMA.parse(value), value);
  }
});

test('RLS_SCHEMA: an unknown key is refused by name, never stripped', () => {
  const res = RLS_SCHEMA.safeParse({ ...RELATION_ALL, futureColumn: 'x' });
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error.issues), /futureColumn/);
  // The two keys the backend itself refuses as unenforced.
  assert.equal(RLS_SCHEMA.safeParse({ enabled: true, filterColumn: 'x' }).success, false);
  assert.equal(RLS_SCHEMA.safeParse({ enabled: true, filterByUserId: true }).success, false);
});

test('RLS_SCHEMA: an unknown mode is refused', () => {
  assert.equal(RLS_SCHEMA.safeParse({ enabled: true, mode: 'team' }).success, false);
});

test('BUILD_RLS_SCHEMA: every field round-trips and unknown keys are refused', () => {
  const { enabled: _enabled, ...byName } = RELATION_ALL;
  assert.deepEqual(BUILD_RLS_SCHEMA.parse(byName), byName);
  assert.equal(BUILD_RLS_SCHEMA.safeParse({ mode: 'relation', relationColum: 'Coach' }).success, false);
});

// ── What reaches the API ─────────────────────────────────────────────────────

test('create_app_endpoint sends relation row-level security unchanged', async () => {
  const { calls, call } = await harness();
  const res = await call('create_app_endpoint', {
    appId: 'app-1',
    boardId: 'board-1',
    slug: 'weighins',
    name: 'Weigh-ins',
    exposedColumns: EXPOSED,
    rowLevelSecurity: RELATION_ALL,
  });
  assert.equal(res.isError, false, res.text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, `/organizations/${ORG}/apps/app-1/endpoints`);
  assert.deepEqual(calls[0].body.rowLevelSecurity, RELATION_ALL);
});

test('create_app_endpoint refuses an unknown row-level security key before any request', async () => {
  const { calls, call } = await harness();
  const res = await call('create_app_endpoint', {
    appId: 'app-1',
    boardId: 'board-1',
    slug: 'weighins',
    name: 'Weigh-ins',
    exposedColumns: EXPOSED,
    rowLevelSecurity: { ...RELATION_ALL, somethingNew: true },
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /somethingNew/);
  assert.equal(calls.length, 0);
});

test('update_app_endpoint sends relation row-level security unchanged, and null', async () => {
  const { calls, call } = await harness();
  let res = await call('update_app_endpoint', {
    appId: 'app-1',
    endpointId: 'ep-1',
    rowLevelSecurity: RELATION_ALL,
  });
  assert.equal(res.isError, false, res.text);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].path, `/organizations/${ORG}/apps/app-1/endpoints/ep-1`);
  assert.deepEqual(calls[0].body, { rowLevelSecurity: RELATION_ALL });

  res = await call('update_app_endpoint', {
    appId: 'app-1',
    endpointId: 'ep-1',
    rowLevelSecurity: null,
  });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(calls[1].body, { rowLevelSecurity: null });

  res = await call('update_app_endpoint', {
    appId: 'app-1',
    endpointId: 'ep-1',
    rowLevelSecurity: { enabled: true, mode: 'relation', relationColumn: 'c', nope: 1 },
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /nope/);
  assert.equal(calls.length, 2);
});

test('delete_app_endpoint calls DELETE on the endpoint', async () => {
  const { calls, call } = await harness();
  const res = await call('delete_app_endpoint', { appId: 'app-1', endpointId: 'ep-1' });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(calls, [
    { method: 'DELETE', path: `/organizations/${ORG}/apps/app-1/endpoints/ep-1`, body: undefined },
  ]);
  assert.deepEqual(res.json, { deleted: true, endpointId: 'ep-1' });
});

// ── build_backend ────────────────────────────────────────────────────────────

const COACHING = {
  project: { name: 'Coaching' },
  boards: [
    {
      name: 'Coaches',
      columns: [
        { name: 'Phone', type: 'phone' },
        { name: 'Email', type: 'email' },
      ],
      rowLevelSecurity: { mode: 'phone', phoneColumn: 'Phone', emailColumn: 'Email' },
    },
    {
      name: 'Trainees',
      columns: [
        { name: 'Coach', type: 'relation', relatedBoard: 'Coaches', relationType: 'many_to_one' },
        { name: 'Goal', type: 'text' },
      ],
      rowLevelSecurity: {
        mode: 'relation',
        relationColumn: 'Coach',
        identityPhoneColumn: 'Phone',
        identityEmailColumn: 'Email',
        allowInvites: true,
      },
    },
    {
      name: 'Weighins',
      columns: [
        { name: 'Trainee', type: 'relation', relatedBoard: 'Trainees', relationType: 'many_to_one' },
        { name: 'Weight', type: 'number' },
      ],
      rowLevelSecurity: {
        mode: 'relation',
        relationColumn: 'Trainee',
        viaColumn: 'Coach',
        identityPhoneColumn: 'Phone',
      },
    },
    { name: 'Tips', columns: [{ name: 'Body', type: 'rich_text' }] },
  ],
  api: { rowLevelSecurity: true },
};

/** Answers build_backend's requests with ids derived from the names sent. */
function buildResponder() {
  const boardIds = new Map();
  return (method, path, body) => {
    if (method === 'GET') return {};
    if (path.endsWith('/projects')) return { id: 'proj-1' };
    if (path.endsWith('/boards')) {
      const id = `board-${body.name}`;
      boardIds.set(id, body.name);
      return { id };
    }
    if (path.endsWith('/columns')) {
      const boardId = path.split('/boards/')[1].split('/')[0];
      return { id: `col-${boardIds.get(boardId)}-${body.name}` };
    }
    if (path.endsWith('/apps')) return { id: 'app-1', slug: 'app-abc' };
    if (path.endsWith('/api-keys')) return { rawKey: 'tk_test' };
    return {};
  };
}

test('build_backend resolves per-board row-level security from column names to ids', async () => {
  const { calls, call } = await harness(buildResponder());
  const res = await call('build_backend', COACHING);
  assert.equal(res.isError, false, res.text);
  assert.equal(res.json.built, true, res.text);

  const sent = Object.fromEntries(
    calls
      .filter((c) => c.method === 'POST' && c.path.endsWith('/endpoints'))
      .map((c) => [c.body.name, c.body.rowLevelSecurity]),
  );
  assert.deepEqual(sent.Coaches, {
    enabled: true,
    mode: 'phone',
    phoneColumn: 'col-Coaches-Phone',
    emailColumn: 'col-Coaches-Email',
  });
  assert.deepEqual(sent.Trainees, {
    enabled: true,
    mode: 'relation',
    relationColumn: 'col-Trainees-Coach',
    identityPhoneColumn: 'col-Coaches-Phone',
    identityEmailColumn: 'col-Coaches-Email',
    allowInvites: true,
  });
  assert.deepEqual(sent.Weighins, {
    enabled: true,
    mode: 'relation',
    relationColumn: 'col-Weighins-Trainee',
    viaColumn: 'col-Trainees-Coach',
    identityPhoneColumn: 'col-Coaches-Phone',
  });
  // A board with no rowLevelSecurity of its own keeps the api-wide default.
  assert.deepEqual(sent.Tips, { enabled: true });
});

test('build_backend without per-board security behaves as before', async () => {
  const plain = {
    project: { name: 'Shop' },
    boards: [{ name: 'Orders', columns: [{ name: 'Note', type: 'text' }] }],
  };
  let h = await harness(buildResponder());
  await h.call('build_backend', { ...plain, api: { rowLevelSecurity: true } });
  let ep = h.calls.find((c) => c.path.endsWith('/endpoints'));
  assert.deepEqual(ep.body.rowLevelSecurity, { enabled: true });

  h = await harness(buildResponder());
  await h.call('build_backend', { ...plain, api: {} });
  ep = h.calls.find((c) => c.path.endsWith('/endpoints'));
  assert.equal('rowLevelSecurity' in ep.body, false);
});

test('build_backend refuses a bad row-level security spec before creating anything', async () => {
  const { calls, call } = await harness(buildResponder());
  const bad = structuredClone(COACHING);
  bad.boards[1].rowLevelSecurity.relationColumn = 'Goal';
  bad.boards[2].rowLevelSecurity.identityPhoneColumn = 'Mobile';
  const res = await call('build_backend', bad);
  assert.equal(res.json.built, false);
  assert.match(res.json.problems.join('\n'), /"Goal" is not a relation column of Trainees/);
  assert.match(res.json.problems.join('\n'), /"Mobile" is not a column of Coaches/);
  assert.equal(calls.length, 0);

  const unknownKey = structuredClone(COACHING);
  unknownKey.boards[1].rowLevelSecurity.identityColumn = 'Phone';
  const refused = await call('build_backend', unknownKey);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /identityColumn/);
  assert.equal(calls.length, 0);
});

test('planBuildRls mirrors the server rules about which field goes with which mode', () => {
  const boards = COACHING.boards;
  const p = (board, rls) => planBuildRls(board, rls, boards).problems.join('\n');
  assert.match(p(boards[0], { mode: 'phone' }), /needs phoneColumn/);
  assert.match(p(boards[1], { mode: 'relation' }), /needs relationColumn/);
  assert.match(p(boards[1], { mode: 'owner', allowInvites: true }), /only apply to mode "relation"/);
  assert.match(p(boards[1], { mode: 'relation', relationColumn: 'Coach', phoneColumn: 'Phone' }), /only apply to mode "phone"/);
  assert.match(p(boards[2], { mode: 'relation', relationColumn: 'Trainee', viaColumn: 'Goal' }), /not a relation column of Trainees/);
  assert.equal(p(boards[3], { mode: 'shared' }), '');
});

// ── Settings ─────────────────────────────────────────────────────────────────

test('mergeSettings merges objects at depth, replaces arrays, and removes on null', () => {
  const current = {
    language: 'he',
    passwordReset: { returnUrls: ['a://x'], other: 1 },
    custom: { keep: true },
  };
  assert.deepEqual(
    mergeSettings(current, {
      language: null,
      passwordReset: { returnUrls: ['b://y'] },
      endUserDeletion: { rows: 'delete' },
    }),
    {
      passwordReset: { returnUrls: ['b://y'], other: 1 },
      custom: { keep: true },
      endUserDeletion: { rows: 'delete' },
    },
  );
  // The input is not mutated.
  assert.equal(current.language, 'he');
  assert.deepEqual(current.passwordReset.returnUrls, ['a://x']);
});

test('configure_app_settings reads first and writes the whole merged object', async () => {
  const stored = { language: 'he', passwordReset: { returnUrls: ['a://x'] } };
  const { calls, call } = await harness((method, _path, body) =>
    method === 'GET' ? { id: 'app-1', settings: stored } : { id: 'app-1', settings: body.settings },
  );
  const res = await call('configure_app_settings', {
    appId: 'app-1',
    set: { endUserDeletion: { rows: 'delete' } },
  });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [`GET /organizations/${ORG}/apps/app-1`, `PATCH /organizations/${ORG}/apps/app-1`],
  );
  assert.deepEqual(calls[1].body, {
    settings: { ...stored, endUserDeletion: { rows: 'delete' } },
  });
  assert.equal(res.json.changed, true);
});

test('configure_app_settings with nothing to set only reads', async () => {
  const { calls, call } = await harness(() => ({ id: 'app-1', settings: { language: 'en' } }));
  const res = await call('configure_app_settings', { appId: 'app-1' });
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
  assert.deepEqual(res.json.settings, { language: 'en' });
  assert.equal(res.json.changed, false);
});

test('configure_external_access accepts the invite policy', async () => {
  const { calls, call } = await harness((_m, _p, body) => ({ settings: body?.settings ?? {} }));
  const res = await call('configure_external_access', { registrationPolicy: 'invite' });
  assert.equal(res.isError, false, res.text);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].path, `/organizations/${ORG}`);
  assert.deepEqual(calls[0].body, { settings: { externalRegistrationPolicy: 'invite' } });
  assert.equal(res.json.registrationPolicy, 'invite');
});

// ── Invites and links ────────────────────────────────────────────────────────

test('invite tools call the invite routes', async () => {
  const { calls, call } = await harness();
  await call('create_app_invite', {
    appId: 'app-1',
    itemId: 'item-1',
    role: 'editor',
    maxUses: 3,
    expiresInDays: 7,
    label: 'Dana',
  });
  await call('list_app_invites', { appId: 'app-1' });
  await call('revoke_app_invite', { appId: 'app-1', inviteId: 'inv-1' });
  await call('check_invite_code', { code: 'K7PM-4XQ2' });
  const base = `/organizations/${ORG}/apps/app-1`;
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: `${base}/invites`,
      body: { itemId: 'item-1', role: 'editor', maxUses: 3, expiresInDays: 7, label: 'Dana' },
    },
    { method: 'GET', path: `${base}/invites`, body: undefined },
    { method: 'DELETE', path: `${base}/invites/inv-1`, body: undefined },
    { method: 'POST', path: '/auth/invites/check', body: { code: 'K7PM-4XQ2' } },
  ]);
});

test('create_app_invite needs a row or a role, and keeps to the server limits', async () => {
  const { calls, call } = await harness();
  const empty = await call('create_app_invite', { appId: 'app-1' });
  assert.match(empty.json.error, /itemId/);
  assert.equal((await call('create_app_invite', { appId: 'app-1', itemId: 'i', maxUses: 0 })).isError, true);
  assert.equal((await call('create_app_invite', { appId: 'app-1', itemId: 'i', expiresInDays: 366 })).isError, true);
  assert.equal((await call('create_app_invite', { appId: 'app-1', role: 'owner' })).isError, true);
  assert.equal(calls.length, 0);
  const roleOnly = await call('create_app_invite', { appId: 'app-1', role: 'viewer' });
  assert.equal(roleOnly.isError, false, roleOnly.text);
  assert.deepEqual(calls[0].body, { role: 'viewer' });
});

test('link tools call the user link routes', async () => {
  const { calls, call } = await harness();
  await call('list_app_users', { appId: 'app-1' });
  await call('link_app_user', { appId: 'app-1', userId: 'user-1', itemId: 'item-1' });
  await call('list_app_user_links', { appId: 'app-1', userId: 'user-1' });
  await call('unlink_app_user', { appId: 'app-1', userId: 'user-1', itemId: 'item-1' });
  const base = `/organizations/${ORG}/apps/app-1/users`;
  assert.deepEqual(calls, [
    { method: 'GET', path: base, body: undefined },
    { method: 'GET', path: `${base}/pending`, body: undefined },
    { method: 'POST', path: `${base}/user-1/links`, body: { itemId: 'item-1' } },
    { method: 'GET', path: `${base}/user-1/links`, body: undefined },
    { method: 'DELETE', path: `${base}/user-1/links/item-1`, body: undefined },
  ]);
});

// ── Access by phone ──────────────────────────────────────────────────────────

test('add_app_user sends the phone and the role, and passes the answer through', async () => {
  const { calls, call } = await harness(() => ({
    status: 'pending',
    phone: '+972548468601',
    role: 'editor',
    pendingId: 'p-1',
    expiresAt: null,
  }));
  const res = await call('add_app_user', { appId: 'app-1', phone: '054-8468601', role: 'editor' });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: `/organizations/${ORG}/apps/app-1/users`,
      body: { phone: '054-8468601', role: 'editor' },
    },
  ]);
  assert.equal(res.json.status, 'pending');
  assert.equal(res.json.pendingId, 'p-1');
});

test('add_app_user leaves the role and the expiry to the server when not given', async () => {
  const { calls, call } = await harness();
  await call('add_app_user', { appId: 'app-1', phone: '+972548468601' });
  assert.deepEqual(calls[0].body, { phone: '+972548468601' });
  await call('add_app_user', { appId: 'app-1', phone: '+972548468601', expiresInDays: 7 });
  assert.deepEqual(calls[1].body, { phone: '+972548468601', expiresInDays: 7 });
});

test('add_app_user refuses a role or an expiry the server would refuse', async () => {
  const { calls, call } = await harness();
  assert.equal((await call('add_app_user', { appId: 'app-1', phone: '0548468601', role: 'admin' })).isError, true);
  assert.equal((await call('add_app_user', { appId: 'app-1', phone: '0548468601', expiresInDays: 0 })).isError, true);
  assert.equal((await call('add_app_user', { appId: 'app-1' })).isError, true);
  assert.equal(calls.length, 0);
});

test('list_app_users answers users and the phones still waiting', async () => {
  const user = { userId: 'user-1', name: 'Dana', role: 'editor', isActive: true, hasAccessRow: false, phone: '+972545511985' };
  const waiting = { id: 'p-1', phone: '+972548468601', role: 'editor', status: 'pending' };
  const { call } = await harness((_m, path) => (path.endsWith('/pending') ? [waiting] : [user]));
  const res = await call('list_app_users', { appId: 'app-1' });
  assert.deepEqual(res.json, { users: [user], pending: [waiting] });
});

test('set_app_user_role patches only what was passed', async () => {
  const { calls, call } = await harness();
  const path = `/organizations/${ORG}/apps/app-1/users/user-1`;
  await call('set_app_user_role', { appId: 'app-1', userId: 'user-1', role: 'viewer' });
  await call('set_app_user_role', { appId: 'app-1', userId: 'user-1', isActive: false });
  await call('set_app_user_role', { appId: 'app-1', userId: 'user-1', role: 'editor', isActive: true });
  assert.deepEqual(calls, [
    { method: 'PATCH', path, body: { role: 'viewer' } },
    { method: 'PATCH', path, body: { isActive: false } },
    { method: 'PATCH', path, body: { role: 'editor', isActive: true } },
  ]);
});

test('set_app_user_role with nothing to change calls nothing', async () => {
  const { calls, call } = await harness();
  const res = await call('set_app_user_role', { appId: 'app-1', userId: 'user-1' });
  assert.match(res.json.error, /role, isActive, or both/);
  assert.equal((await call('set_app_user_role', { appId: 'app-1', userId: 'user-1', role: 'owner' })).isError, true);
  assert.equal(calls.length, 0);
});

test('remove_app_user switches a user off, or cancels a waiting phone', async () => {
  const { calls, call } = await harness();
  const base = `/organizations/${ORG}/apps/app-1/users`;
  await call('remove_app_user', { appId: 'app-1', userId: 'user-1' });
  await call('remove_app_user', { appId: 'app-1', pendingId: 'p-1' });
  assert.deepEqual(calls, [
    { method: 'PATCH', path: `${base}/user-1`, body: { isActive: false } },
    { method: 'DELETE', path: `${base}/pending/p-1`, body: undefined },
  ]);
});

test('remove_app_user takes exactly one id', async () => {
  const { calls, call } = await harness();
  const none = await call('remove_app_user', { appId: 'app-1' });
  const both = await call('remove_app_user', { appId: 'app-1', userId: 'user-1', pendingId: 'p-1' });
  assert.match(none.json.error, /exactly one/);
  assert.match(both.json.error, /exactly one/);
  assert.equal(calls.length, 0);
});

test('a builder is told how the people who run an app get in', async () => {
  const { instructions } = await import('../dist/instructions.js').then((m) => ({
    instructions: Object.values(m).find((v) => typeof v === 'string' && v.includes('add_app_user')),
  }));
  assert.ok(instructions, 'the instructions mention add_app_user');
  assert.match(instructions, /mode shared/);
  assert.match(instructions, /before their first sign-in/);
});

// ── What a client is told ────────────────────────────────────────────────────

const NEW_TOOLS = [
  'delete_app_endpoint',
  'configure_app_settings',
  'list_app_users',
  'add_app_user',
  'set_app_user_role',
  'remove_app_user',
  'create_app_invite',
  'list_app_invites',
  'revoke_app_invite',
  'check_invite_code',
  'link_app_user',
  'list_app_user_links',
  'unlink_app_user',
];

test('tools/list: the new tools are there, annotated, and the schema shows relation mode', async () => {
  const { client } = await harness();
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of NEW_TOOLS) {
    const t = byName.get(name);
    assert.ok(t, `${name} is registered`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof t.annotations?.[hint], 'boolean', `${name}.${hint}`);
    }
    assert.ok(t.annotations.title, `${name} has a title`);
  }
  for (const t of tools) {
    assert.ok(t.annotations?.title, `${t.name} has annotations`);
    assert.equal(JSON.stringify(t).includes('\u2014'), false, `${t.name} carries an em dash`);
  }

  for (const name of ['create_app_endpoint', 'update_app_endpoint']) {
    const text = JSON.stringify(byName.get(name).inputSchema.properties.rowLevelSecurity);
    for (const key of [
      'relation',
      'relationColumn',
      'viaColumn',
      'identityPhoneColumn',
      'identityEmailColumn',
      'allowInvites',
      'singleLink',
      'editOwnOnly',
      'emailColumn',
    ]) {
      assert.ok(text.includes(`"${key}"`), `${name} schema names ${key}`);
    }
    assert.ok(text.includes('"additionalProperties":false'), `${name} rowLevelSecurity is strict`);
  }

  const policy = byName.get('configure_external_access').inputSchema.properties.registrationPolicy;
  assert.deepEqual([...policy.enum].sort(), ['approval', 'closed', 'invite', 'open']);
});

test('create_automation describes the scheduled trigger and send_push as the engine reads them', async () => {
  const { client } = await harness();
  const { tools } = await client.listTools();
  const t = tools.find((x) => x.name === 'create_automation');
  const all = JSON.stringify(t);
  assert.equal(/\{ cron:/.test(all), false, 'no cron example');
  for (const word of [
    'intervalHours',
    'runAtHour',
    'UTC',
    'send_push',
    'recipientsFromRelation',
    'includeRowOwner',
    'userIds',
    'dataOnly',
    'badge',
    'sound',
    'people column',
  ]) {
    assert.ok(all.includes(word), `mentions ${word}`);
  }
});

// ── Status columns: dropdowns named like a status, and the status filter ──────

const STATUS_OPTIONS = [
  { value: 'Received', label: 'Received' },
  { value: 'in_repair', label: 'In Repair' },
  { value: 'Completed', label: 'Completed' },
];

test('create_column rejects a dropdown named like a status, in English and Hebrew', async () => {
  for (const name of ['Status', 'סטטוס', 'מצב', 'Repair Status']) {
    const { calls, call } = await harness();
    const res = await call('create_column', {
      projectId: 'p1',
      boardId: 'b1',
      name,
      type: 'dropdown',
      settings: { options: ['A', 'B'] },
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.json.created, false, name);
    assert.equal(res.json.suggestedType, 'status', name);
    assert.match(res.json.rejected, /must be type "status"/, name);
    assert.match(res.json.retry, /type:"status"/, name);
    assert.match(res.json.retry, /force:true/, name);
    assert.equal(calls.length, 0, 'nothing was created');
  }
});

test('create_column: force passes a dropdown named status, other names and a real status column pass', async () => {
  const cases = [
    { name: 'סטטוס', type: 'dropdown', force: true },
    { name: 'קטגוריה', type: 'dropdown' },
    { name: 'Status', type: 'status' },
    { name: 'סטטוס', type: 'status' },
  ];
  for (const c of cases) {
    const { calls, call } = await harness();
    const res = await call('create_column', {
      projectId: 'p1',
      boardId: 'b1',
      settings: { options: ['A', 'B'] },
      ...c,
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(calls.length, 1, `${c.name}/${c.type} reaches the API`);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.type, c.type);
  }
});

test('update_column objects to renaming a dropdown to a status name, and force passes', async () => {
  const columns = [{ id: 'c1', name: 'Kind', type: 'dropdown', settings: { options: ['A'] } }];
  let h = await harness((method) => (method === 'GET' ? columns : {}));
  let res = await h.call('update_column', {
    projectId: 'p1',
    boardId: 'b1',
    columnId: 'c1',
    name: 'סטטוס',
  });
  assert.equal(res.json.suggestedType, 'status', res.text);
  assert.equal(h.calls.filter((c) => c.method === 'PATCH').length, 0);

  h = await harness((method) => (method === 'GET' ? columns : {}));
  res = await h.call('update_column', {
    projectId: 'p1',
    boardId: 'b1',
    columnId: 'c1',
    name: 'סטטוס',
    force: true,
  });
  assert.equal(res.isError, false, res.text);
  assert.equal(h.calls.filter((c) => c.method === 'PATCH').length, 1);
});

test('build_backend turns a dropdown named status into a status column, and keeps a proper one', async () => {
  const spec = {
    project: { name: 'Repairs' },
    boards: [
      {
        name: 'Orders',
        columns: [
          { name: 'סטטוס', type: 'dropdown', options: ['New', 'Done'] },
          { name: 'Stage', type: 'status', options: ['A', 'B'] },
          { name: 'Category', type: 'dropdown', options: ['X', 'Y'] },
        ],
      },
    ],
  };
  const { calls, call } = await harness(buildResponder());
  const res = await call('build_backend', spec);
  assert.equal(res.isError, false, res.text);
  const sentTypes = Object.fromEntries(
    calls
      .filter((c) => c.method === 'POST' && c.path.endsWith('/columns'))
      .map((c) => [c.body.name, c.body.type]),
  );
  assert.deepEqual(sentTypes, { 'סטטוס': 'status', Stage: 'status', Category: 'dropdown' });
  assert.match(res.text, /created as status rather than dropdown/);
});

/** A fake board: its columns, its rows and its kind, answering the routes query_items uses. */
function boardFake({ kind = 'data', columns, rows, boardExtra = {} }) {
  return (method, path) => {
    if (method !== 'GET') return {};
    if (/\/boards\/[^/]+\/columns$/.test(path)) return columns;
    if (/\/boards\/[^/]+$/.test(path)) {
      return { id: 'b1', metadata: kind === 'data' ? { kind: 'data' } : {}, ...boardExtra };
    }
    if (path.includes('/items')) {
      const q = new URL(`https://x${path}`).searchParams;
      const limit = Number(q.get('limit') ?? 200);
      const page = Number(q.get('page') ?? 1);
      const slice = rows.slice((page - 1) * limit, page * limit);
      return { items: slice, meta: { currentPage: page, itemsPerPage: limit, totalItems: rows.length } };
    }
    return {};
  };
}

const DROPDOWN_COLUMNS = [
  { id: 'c-title', name: 'Title', type: 'text' },
  { id: 'c-status', name: 'סטטוס', type: 'dropdown', settings: { options: STATUS_OPTIONS } },
  { id: 'c-kind', name: 'קטגוריה', type: 'dropdown', settings: { options: [{ value: 'a', label: 'A' }] } },
];

/** A row of the admin shape: cells as [{ columnId, value }]. */
function row(id, status) {
  return {
    id,
    title: id,
    status: 'todo',
    cells: [
      { columnId: 'c-title', value: { value: id } },
      ...(status === undefined ? [] : [{ columnId: 'c-status', value: { value: status } }]),
    ],
  };
}

const ROWS = [
  row('r1', 'Received'),
  row('r2', 'in_repair'),
  row('r3', 'Completed'),
  row('r4'),
  row('r5', 'Completed'),
];

const ids = (json) => json.map((r) => r.id);

test('query_items: a dropdown named status is filtered client-side, by value or label', async () => {
  for (const wanted of ['completed', 'Completed', ' COMPLETED ']) {
    const { calls, call } = await harness(boardFake({ columns: DROPDOWN_COLUMNS, rows: ROWS }));
    const res = await call('query_items', { projectId: 'p1', boardId: 'b1', status: wanted });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(ids(res.json), ['r3', 'r5'], wanted);
    // The include filter is not sent: a server that cannot see the column would answer with nothing.
    const itemCalls = calls.filter((c) => c.path.includes('/items'));
    assert.ok(itemCalls.length > 0);
    assert.ok(itemCalls.every((c) => !c.path.includes('status=')), 'no status param sent');
  }
  // Label differs from value: "In Repair" is stored as in_repair.
  let h = await harness(boardFake({ columns: DROPDOWN_COLUMNS, rows: ROWS }));
  let res = await h.call('query_items', { projectId: 'p1', boardId: 'b1', status: 'In Repair,received' });
  assert.deepEqual(ids(res.json), ['r1', 'r2']);
  h = await harness(boardFake({ columns: DROPDOWN_COLUMNS, rows: ROWS }));
  res = await h.call('query_items', { projectId: 'p1', boardId: 'b1', status: 'in_repair' });
  assert.deepEqual(ids(res.json), ['r2']);
});

test('query_items: excludeStatus on a status dropdown keeps rows with no status, by value or label', async () => {
  let h = await harness(boardFake({ columns: DROPDOWN_COLUMNS, rows: ROWS }));
  let res = await h.call('query_items', { projectId: 'p1', boardId: 'b1', excludeStatus: 'completed' });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(ids(res.json), ['r1', 'r2', 'r4']);
  // Still passed to the server, where the fixed backend resolves it.
  assert.ok(h.calls.some((c) => c.path.includes('excludeStatus=completed')));

  h = await harness(boardFake({ columns: DROPDOWN_COLUMNS, rows: ROWS }));
  res = await h.call('query_items', { projectId: 'p1', boardId: 'b1', excludeStatus: 'In Repair,Completed' });
  assert.deepEqual(ids(res.json), ['r1', 'r4']);
});

test('query_items: a cell holding a bare string or the label still matches', async () => {
  const rows = [
    { id: 'a', cells: [{ columnId: 'c-status', value: 'Completed' }] },
    { id: 'b', cells: [{ columnId: 'c-status', value: { value: 'In Repair' } }] },
    { id: 'c', cells: { 'c-status': 'Received' } },
  ];
  const { call } = await harness(boardFake({ columns: DROPDOWN_COLUMNS, rows }));
  const res = await call('query_items', { projectId: 'p1', boardId: 'b1', status: 'completed,in_repair' });
  assert.deepEqual(ids(res.json), ['a', 'b']);
});

test('query_items: the client-side filter applies to every page it concatenates', async () => {
  const many = [];
  for (let i = 0; i < 450; i++) many.push(row(`r${i}`, i % 3 === 0 ? 'Completed' : 'Received'));
  const { calls, call } = await harness(boardFake({ columns: DROPDOWN_COLUMNS, rows: many }));
  const res = await call('query_items', { projectId: 'p1', boardId: 'b1', excludeStatus: 'Completed' });
  assert.equal(res.json.length, 300);
  assert.ok(res.json.every((r) => r.id.slice(1) % 3 !== 0));
  assert.equal(calls.filter((c) => c.path.includes('/items')).length, 3, 'three pages of 200 were read');
});

test('query_items: with an explicit limit the page is filtered and the answer says so', async () => {
  const { call } = await harness(boardFake({ columns: DROPDOWN_COLUMNS, rows: ROWS }));
  const res = await call('query_items', {
    projectId: 'p1',
    boardId: 'b1',
    status: 'Completed',
    limit: 4,
    page: 1,
  });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(ids(res.json.items), ['r3']);
  assert.match(res.json.note, /after the page was fetched/);
  assert.match(res.json.note, /fewer than 4 rows/);
});

test('query_items: a board with no status column is a tool error that lists its dropdowns', async () => {
  const columns = DROPDOWN_COLUMNS.filter((c) => c.id !== 'c-status');
  for (const args of [{ status: 'Completed' }, { excludeStatus: 'Completed' }]) {
    const { calls, call } = await harness(boardFake({ columns, rows: ROWS }));
    const res = await call('query_items', { projectId: 'p1', boardId: 'b1', ...args });
    assert.equal(res.isError, true, res.text);
    assert.match(res.text, /no status column/);
    assert.match(res.text, /"קטגוריה" \(id c-kind\)/);
    assert.equal(
      calls.filter((c) => c.path.includes('/items')).length,
      0,
      'no rows were fetched',
    );
  }
  // Without any status filter the same board is queried as always.
  const { call } = await harness(boardFake({ columns, rows: ROWS }));
  const res = await call('query_items', { projectId: 'p1', boardId: 'b1' });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.json.length, ROWS.length);
});

test('query_items: a board with a real status column is unchanged and costs no extra request', async () => {
  const columns = [
    { id: 'c-title', name: 'Title', type: 'text' },
    { id: 'c-st', name: 'Stage', type: 'status', settings: { options: STATUS_OPTIONS } },
  ];
  // Rows the server returned for the filter: the tool must not touch them.
  const served = [row('s1', 'Received'), row('s2', 'Completed')];
  const { calls, call } = await harness(
    boardFake({ columns, rows: served, boardExtra: { columns } }),
  );
  const res = await call('query_items', { projectId: 'p1', boardId: 'b1', status: 'Completed' });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(ids(res.json), ['s1', 's2']);
  // The board answer carried its columns, so there was no separate columns request.
  assert.equal(calls.filter((c) => c.path.endsWith('/columns')).length, 0);
  const itemCall = calls.find((c) => c.path.includes('/items'));
  assert.match(itemCall.path, /status=Completed/);

  // Board answer without columns: exactly one columns request, still no client-side filtering.
  const h = await harness(boardFake({ columns, rows: served }));
  const res2 = await h.call('query_items', { projectId: 'p1', boardId: 'b1', status: 'Completed' });
  assert.deepEqual(ids(res2.json), ['s1', 's2']);
  assert.equal(h.calls.filter((c) => c.path.endsWith('/columns')).length, 1);
  assert.equal(h.calls.filter((c) => c.path === '/projects/p1/boards/b1').length, 1);
});

test('query_items without a status filter makes no columns request', async () => {
  const { calls, call } = await harness(boardFake({ columns: [], rows: ROWS }));
  const res = await call('query_items', { projectId: 'p1', boardId: 'b1', search: 'x' });
  assert.equal(res.isError, false, res.text);
  assert.equal(calls.filter((c) => c.path.endsWith('/columns')).length, 0);
});

test('query_items sorted by status on a board with no status column is refused too', async () => {
  const { call } = await harness(boardFake({ columns: [{ id: 'c1', name: 'Title', type: 'text' }], rows: ROWS }));
  const res = await call('query_items', { projectId: 'p1', boardId: 'b1', sort: '-status' });
  assert.equal(res.isError, true, res.text);
  assert.match(res.text, /status sort/);
});

test('query_items still answers when the columns cannot be read', async () => {
  const fake = boardFake({ columns: [], rows: ROWS });
  const { call } = await harness((method, path, body, n) => {
    if (path.endsWith('/columns')) throw new Error('boom');
    return fake(method, path, body, n);
  });
  const res = await call('query_items', { projectId: 'p1', boardId: 'b1', status: 'Completed' });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.json.length, ROWS.length);
});

test('create_item / update_item: status on a data board is refused and names the status column', async () => {
  const fake = boardFake({ columns: DROPDOWN_COLUMNS, rows: [] });
  let h = await harness(fake);
  let res = await h.call('create_item', { projectId: 'p1', boardId: 'b1', title: 'x', status: 'done' });
  assert.equal(res.isError, true, res.text);
  assert.match(res.text, /data board/);
  assert.match(res.text, /"סטטוס" \(id c-status\)/);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);

  h = await harness(fake);
  res = await h.call('update_item', { projectId: 'p1', boardId: 'b1', itemId: 'i1', status: 'done' });
  assert.equal(res.isError, true, res.text);
  assert.match(res.text, /set_cell/);
  assert.equal(h.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('create_item / update_item: status on a task board goes through, and other calls cost no board read', async () => {
  const fake = boardFake({ kind: 'tasks', columns: [], rows: [] });
  let h = await harness(fake);
  let res = await h.call('create_item', { projectId: 'p1', boardId: 'b1', title: 'x', status: 'done' });
  assert.equal(res.isError, false, res.text);
  assert.equal(h.calls.find((c) => c.method === 'POST').body.status, 'done');

  h = await harness(fake);
  res = await h.call('update_item', { projectId: 'p1', boardId: 'b1', itemId: 'i1', status: 'done' });
  assert.equal(res.isError, false, res.text);
  assert.equal(h.calls.find((c) => c.method === 'PATCH').body.status, 'done');

  // No status given: no extra request, on any board.
  h = await harness(boardFake({ columns: DROPDOWN_COLUMNS, rows: [] }));
  res = await h.call('create_item', { projectId: 'p1', boardId: 'b1', title: 'x' });
  assert.equal(res.isError, false, res.text);
  assert.equal(h.calls.length, 1);
});

// ── set_cells_if_unchanged: compare-and-set, all or none (tastlite-be #315) ──

test('set_cells_if_unchanged sends every cell, with what was read, in one PUT to the conditional route', async () => {
  const { calls, call } = await harness(() => ({ cells: [{ columnId: 'c1', value: { value: 'idle|t' } }] }));
  const cells = [
    { columnId: 'c1', value: 'idle|t', expected: 'building|t0' },
    { columnId: 'c2', value: 'https://a.tasklite.dev', expected: null },
  ];
  const res = await call('set_cells_if_unchanged', { projectId: 'p1', boardId: 'b1', itemId: 'i1', cells });
  assert.equal(res.isError, false);
  assert.deepEqual(calls, [{ method: 'PUT', path: '/projects/p1/boards/b1/items/i1/cells/conditional', body: { cells } }]);
});

test('set_cells_if_unchanged returns a 409 whole (code, conflicts), so the caller can read again and decide', async () => {
  const { TaskLiteApiError } = await import('../dist/api.js');
  const body = { code: 'CELL_CONFLICT', message: 'CELL_CONFLICT: a cell changed since it was read', conflicts: [{ columnId: 'c1', current: { value: 'human|t|director' } }] };
  const { calls, call } = await harness(() => {
    throw new TaskLiteApiError('TaskLite API PUT ... failed (409)', 409, body);
  });
  const res = await call('set_cells_if_unchanged', { projectId: 'p1', boardId: 'b1', itemId: 'i1', cells: [{ columnId: 'c1', value: 'idle|t', expected: 'building|t0' }] });
  assert.equal(res.isError, true);
  assert.deepEqual(res.json, { status: 409, ...body });
  assert.equal(calls.length, 1, 'not retried');
});

test('set_cells_if_unchanged refuses a cell without expected or value before any API call', async () => {
  const { calls, call } = await harness();
  const noExpected = await call('set_cells_if_unchanged', { projectId: 'p1', boardId: 'b1', itemId: 'i1', cells: [{ columnId: 'c1', value: 'x' }] });
  const noValue = await call('set_cells_if_unchanged', { projectId: 'p1', boardId: 'b1', itemId: 'i1', cells: [{ columnId: 'c1', expected: 'x' }] });
  assert.equal(noExpected.isError, true);
  assert.equal(noValue.isError, true);
  assert.equal(calls.length, 0);
});

test('set_cells_if_unchanged does not dress other errors as conflicts: a 403 stays an error with its message', async () => {
  const { TaskLiteApiError } = await import('../dist/api.js');
  const { call } = await harness(() => {
    throw new TaskLiteApiError('TaskLite API PUT ... failed (403): "You do not have permission to modify this item"', 403, { message: 'You do not have permission to modify this item' });
  });
  const res = await call('set_cells_if_unchanged', { projectId: 'p1', boardId: 'b1', itemId: 'i1', cells: [{ columnId: 'c1', value: 'x', expected: null }] });
  assert.equal(res.isError, true);
  assert.match(res.text, /403/);
  assert.equal(res.json?.code, undefined);
});

test('get_cells reads the item cells route (the database, not the item cache) and returns one value per asked column, empty when absent', async () => {
  const { calls, call } = await harness(() => [
    { id: 'x1', columnId: 'c1', value: { value: 'idle|t' }, column: { name: 'state' } },
    { id: 'x2', columnId: 'c2', value: { value: 'https://a.tasklite.dev' } },
  ]);
  const res = await call('get_cells', { projectId: 'p1', boardId: 'b1', itemId: 'i1', columnIds: ['C1', 'c3'] });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(calls, [{ method: 'GET', path: '/projects/p1/boards/b1/items/i1/cells', body: undefined }]);
  assert.deepEqual(res.json, { cells: [{ columnId: 'c1', value: { value: 'idle|t' } }, { columnId: 'c3', value: null }] });
});

test('get_email_usage reads the organization email usage route, for the given or the default organization', async () => {
  const usage = { month: '2026-10', used: 12, queued: 3, limit: 300, marketingAllowed: false, paused: false, pausedReason: null };
  const { calls, call } = await harness(() => usage);
  const own = await call('get_email_usage', {});
  assert.equal(own.isError, false, own.text);
  assert.deepEqual(own.json, usage);
  const other = await call('get_email_usage', { organizationId: 'org-9' });
  assert.equal(other.isError, false, other.text);
  assert.deepEqual(calls, [
    { method: 'GET', path: '/organizations/org-1/email/usage', body: undefined },
    { method: 'GET', path: '/organizations/org-9/email/usage', body: undefined },
  ]);
});

test('create_automation documents the send_email kind, attachments and quotas, and the app email endpoint', async () => {
  const { client } = await harness();
  const tools = (await client.listTools()).tools;
  const create = tools.find((t) => t.name === 'create_automation');
  for (const needle of ['"marketing"', 'attachments', 'Free 300', 'Pro 20000', '_email/send', 'get_email_usage']) {
    assert.ok(create.description.includes(needle), `missing ${needle}`);
  }
  assert.ok(tools.some((t) => t.name === 'get_email_usage'));
});
