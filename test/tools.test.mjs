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
    { method: 'POST', path: `${base}/user-1/links`, body: { itemId: 'item-1' } },
    { method: 'GET', path: `${base}/user-1/links`, body: undefined },
    { method: 'DELETE', path: `${base}/user-1/links/item-1`, body: undefined },
  ]);
});

// ── What a client is told ────────────────────────────────────────────────────

const NEW_TOOLS = [
  'delete_app_endpoint',
  'configure_app_settings',
  'list_app_users',
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
