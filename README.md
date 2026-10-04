# @tasklite/mcp

[![npm](https://img.shields.io/npm/v/@tasklite/mcp)](https://www.npmjs.com/package/@tasklite/mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-net.tasklite%2Fmcp-blue)](https://registry.modelcontextprotocol.io)
[![license](https://img.shields.io/npm/l/@tasklite/mcp)](./LICENSE)

**A backend and an admin for apps built by AI agents.** [tasklite.net](https://tasklite.net) · [docs](https://tasklite.net/docs)

Describe a system and get the thing behind it: a project with typed tables and
relations, rows, REST endpoints, an API key, and an admin interface the
business itself operates afterwards. From Claude Code, Claude Desktop, ChatGPT,
Gemini, Cursor or VS Code. Deploy a frontend onto it and hand the whole thing
over.

> **Not the CLI task manager.** There is an older, unrelated project also called
> TaskLite, [ad-si/TaskLite](https://github.com/ad-si/TaskLite) at
> [tasklite.org](https://tasklite.org), a command-line task manager. This is a
> different product from a different author: a hosted backend at
> **tasklite.net**, published as `@tasklite/mcp` and as `net.tasklite/mcp` in
> the MCP registry.

## The 63 tools

63 when installed locally, 58 over the hosted server (the five account tools
`sign_up` `connect` `login` `disconnect` `connection_status` exist only
locally; hosted connections sign in with OAuth). Every tool declares
`readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, so a
client can tell what is safe to run unattended.

| Area | Tools |
| --- | --- |
| Account | `sign_up` `connect` `login` `disconnect` `connection_status` `list_organizations` `configure_external_access` |
| Structure | `create_project` `create_board` `create_column` `update_board` `update_column` `delete_board` `delete_column` `delete_project` `reorder_columns` `get_board_schema` `list_projects` `list_boards` `export_project` |
| Data | `query_items` `create_item` `update_item` `set_cell` `delete_item` `search` `fetch` |
| Comments | `list_comments` `add_comment` `update_comment` `delete_comment` |
| Files | `request_file_upload` `list_uploaded_files` `revoke_upload_link` |
| Apps and API | `build_backend` `create_app` `publish_app` `list_apps` `get_app_spec` `create_app_endpoint` `list_app_endpoints` `update_app_endpoint` `delete_app_endpoint` `create_app_api_key` `configure_app_settings` |
| App users, invites and links | `list_app_users` `create_app_invite` `list_app_invites` `revoke_app_invite` `check_invite_code` `link_app_user` `list_app_user_links` `unlink_app_user` |
| Frontend hosting | `deploy_frontend` `list_deployments` `get_deployment_files` `rollback_deployment` `get_frontend_prompt` |
| Automation and push | `create_automation` `update_automation` `list_automations` `push_status` `send_test_push` |

### Apps with two kinds of users

An endpoint's `rowLevelSecurity.mode` decides which rows a signed-in user
reaches: `owner` (the rows they created), `shared` (every row, for authorized
users), `phone` (the rows that carry their verified phone) or `relation` (the
rows linked through a relation column to the row that stands for them). A
coaching app, coaches and their trainees in one organization, is built from
these:

| Board | Endpoint security |
| --- | --- |
| Coaches | `mode: "phone"`, `phoneColumn`: the phone column. Each coach reads and edits his own row. |
| Trainees | `mode: "relation"`, `relationColumn`: Trainees.Coach, `identityPhoneColumn`: Coaches.Phone, `allowInvites: true`. A coach sees only his trainees and can invite each to her row. |
| Weigh-ins (coach) | `mode: "relation"`, `relationColumn`: Weigh-ins.Trainee, `viaColumn`: Trainees.Coach. One more hop: the weigh-ins of all his trainees. |
| Weigh-ins (trainee) | A second endpoint on the same board: `mode: "relation"`, `relationColumn`: Weigh-ins.Trainee. |

A user "is" a row through an invite code (`create_app_invite`, or minted by a
coach inside the app when the endpoint has `allowInvites`), through
`link_app_user`, or with no link at all when their verified phone or email is
written in the row (`identityPhoneColumn`, `identityEmailColumn`).
`configure_external_access` with `registrationPolicy: "invite"` lets new people
in only with a code. `rowLevelSecurity` accepts only the keys the server reads:
an unknown key is refused, never dropped.

`build_backend` is the one to reach for first: it takes a description of a
system and creates the project, the boards, their typed columns including the
relations between them, sample rows, and a published REST API with a key, in
one call, instead of a dozen.

## Setup

Install the package (and Claude Code if you don't have it), then add the server
by its binary. That avoids a known Windows issue where `claude mcp add`
mis-parses `npx -y`.

```bash
npm install -g @anthropic-ai/claude-code @tasklite/mcp
claude mcp add tasklite -- tasklite-mcp
```

Add `-s user` to `claude mcp add` to make it available in every project
(`claude mcp add -s user tasklite -- tasklite-mcp`); the default scope is the
current project only.

Then tell Claude what you want to build. The `sign_up` tool creates your account, organization, and connection from the conversation (a strong random password is generated locally and never shown; use "forgot password" with your email for web access).

**Already have an account?** Create a key at TaskLite → Integrations → "Connect Claude Code" and use:

```bash
claude mcp add tasklite -e TASKLITE_API_KEY=tl_xxx -- tasklite-mcp
```

### Hosted (no install)

Point any MCP client at the hosted server; there is nothing to install locally:

```bash
claude mcp add --transport http tasklite https://mcp.tasklite.net/mcp \
  --header "Authorization: Bearer tl_xxx"
```

The hosted server is stateless: every request carries its own credential, so
one endpoint serves every account safely.

**Simplest of all: the connector.** In Claude (claude.ai or the desktop app),
Settings → Connectors → add TaskLite, or add it by address using the URL above.
You sign in once over OAuth; there is no key to create or store. Note that the
tools appear in a *new* chat, not in the conversation you were already in.

Optional env: `TASKLITE_API_URL` (default `https://api.tasklite.net`), `TASKLITE_APP_URL` (default `https://app.tasklite.net`).

## Other clients

One hosted server, every MCP client. Full setup notes: https://tasklite.net/docs/guides/connector-from-cursor-codex-desktop

- **Cursor**: [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=tasklite&config=eyJ1cmwiOiAiaHR0cHM6Ly9tY3AudGFza2xpdGUubmV0L21jcCJ9) or put `{"mcpServers":{"tasklite":{"url":"https://mcp.tasklite.net/mcp"}}}` in `.cursor/mcp.json`.
- **VS Code**: [Install in VS Code](vscode:mcp/install?%7B%22name%22%3A%20%22tasklite%22%2C%20%22type%22%3A%20%22http%22%2C%20%22url%22%3A%20%22https%3A//mcp.tasklite.net/mcp%22%7D) or `.vscode/mcp.json` with `{"servers":{"tasklite":{"type":"http","url":"https://mcp.tasklite.net/mcp"}}}`.
- **ChatGPT**: Settings → Connectors (developer mode) → add `https://mcp.tasklite.net/mcp`. The server implements `search` and `fetch`.
- **Gemini CLI**: `gemini extensions install https://github.com/tasklite-net/tasklite-mcp` (this repo ships `gemini-extension.json`), or add `httpUrl` + `oauth` to `~/.gemini/settings.json`.
- **OpenAI Responses API / Agents SDK, Gemini API**: pass the hosted URL with `Authorization: Bearer tl_…`.

## Typical flow (what Claude Code does)

1. `create_project` → `create_board` → `create_column` × N builds the schema.
2. `create_item` / `query_items` seed and inspect data.
3. `create_app` → `create_app_endpoint` (with exposedColumns + RLS) → `create_app_api_key` expose the REST surface for your frontend.
4. `get_app_spec` / `get_frontend_prompt` generate the frontend against it.
5. Every tool returns an `adminUrl`, the ready-made admin for the end client.

## Hosting your frontend

`deploy_frontend` puts a static frontend on `https://{slug}.tasklite.dev`.
No server, no hosting account, no CI to configure. Hand the site over in one
of three ways:

```
deploy_frontend(appId: "app-xxxxxx", files: [{ path: "index.html", content: "<!doctype html>…" }, { path: "app.js", content: "…" }])
deploy_frontend(appId: "app-xxxxxx", zipUrl: "https://github.com/you/site/releases/download/v1/dist.zip")
deploy_frontend(appId: "app-xxxxxx", dir: "./dist")
```

`files` is the path from ChatGPT or any hosted client: the assistant writes the
page and deploys it in the same turn. `zipUrl` takes an export from Lovable,
Bolt or a GitHub release. `dir` is for an MCP running on the machine with the
build output.

Hosted pages call the app API through the relative path `/api/{endpoint}`. The
hosting proxy attaches the app identity server-side, so the browser never
carries an API key. `list_deployments` shows the versions and
`rollback_deployment` points the live URL back at an earlier one.

## Security model

- The `tl_` key is exchanged for a short-lived JWT (`POST /public/v1/auth/session`); all calls run with the key owner's own permissions, never super-admin.
- App API keys belong in server-side env vars (Next.js API routes), never in browser code. Frontends hosted on `tasklite.dev` need no key at all.

## Development

```bash
npm install
npm run build
TASKLITE_API_KEY=tl_xxx TASKLITE_API_URL=http://localhost:3333 node dist/index.js
```

## License

MIT
