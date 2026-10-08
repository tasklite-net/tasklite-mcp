# Changelog

All notable changes to `@tasklite/mcp`. Versions that were never published
are folded into the next published one, so the numbers on npm may skip.

## 0.16.1, 2026-10-08

### Added
- `rowLevelSecurity.singleLink` and `rowLevelSecurity.editOwnOnly` on
  `create_app_endpoint`, `update_app_endpoint` and the boards of
  `build_backend`, for mode `relation`. `singleLink` gives each row to one
  linked user: an invite code for a row that already has someone is refused
  with `INVITE_ROW_TAKEN`. `editOwnOnly` lets everyone the relation reaches
  read a row while only its creator changes or deletes it (`ROW_NOT_YOURS`).
  The names are the server's own.

## 0.16.0, 2026-10-04

An app with two kinds of users can be built through the connector.

A coaching app has coaches and their trainees in one organization: a coach
must see only his trainees, a trainee only her own rows. The server has had
row-level security by relation, invite codes and user-to-row links for a
while, all over REST. The connector knew none of it, so a developer building
through it had to leave it and call the API by hand, and a `rowLevelSecurity`
set that way was at risk the next time `update_app_endpoint` touched it.

### Added
- `rowLevelSecurity.mode: "relation"` on `create_app_endpoint` and
  `update_app_endpoint`, with `relationColumn`, `viaColumn`,
  `identityPhoneColumn`, `identityEmailColumn` and `allowInvites`; and
  `emailColumn` next to `phoneColumn` in mode `phone`. The names are the
  server's own.
- `build_backend`: a board may carry its own `rowLevelSecurity` (any mode),
  with columns given by name as in the spec; the ids are resolved once the
  columns exist, and a name that matches nothing is refused before anything
  is created. `api.rowLevelSecurity: true` still means mode `owner` for every
  other board.
- `create_app_invite`, `list_app_invites`, `revoke_app_invite`,
  `check_invite_code`: invite codes that link a new user to a row, grant an
  app role, or both.
- `list_app_users`, `link_app_user`, `list_app_user_links`, `unlink_app_user`:
  who uses the app, and which rows each of them stands for.
- `configure_external_access` takes `registrationPolicy: "invite"`: new people
  get in only with an invite code.
- `configure_app_settings`: reads an app's settings, or merges keys into them.
  The server replaces `settings` whole, so the tool reads, merges and writes
  the full object back.
- `delete_app_endpoint`.
- `npm test`: offline tests of the built server against a recording fake API.

### Changed
- `rowLevelSecurity` is strict: a key the schema does not know is refused by
  name instead of being dropped. Dropping is what stored every "shared"
  endpoint as "owner" before 0.15. `filterColumn` and `filterByUserId`, which
  the server refuses anyway, are now refused here.
- `update_app_endpoint` says that `rowLevelSecurity` replaces the stored
  object whole.

### Fixed
- `create_automation` described the scheduled trigger with `{ cron }`. The
  engine reads no cron expression: it checks hourly and takes
  `{ intervalHours, runAtHour }`, with `runAtHour` in UTC. The description now
  says so, and that a daily run at a fixed hour wants `intervalHours: 23`.
- `send_push` was missing from the list of actions. It is listed with its
  config (`title`, `body`, `data`, `userIds`, `recipientsFromRelation`,
  `includeRowOwner`, `sound`, `badge`, `dataOnly`), and with the rule that the
  last segment of `recipientsFromRelation` must be a people column.
- The action `type` field of `create_automation` was described as a column
  type.

Needs a backend with relation row-level security, `/apps/:appId/invites` and
`/apps/:appId/users/:userId/links`.

## 0.15.0, 2026-09-23

`rowLevelSecurity` keeps its `mode` (`owner`, `shared`, `phone`) and
`phoneColumn`, and `update_app_endpoint` can set it. Before, the schema had no
`mode` and the unknown key was dropped, so every endpoint asked to be "shared"
was stored as "owner".

## 0.14.5, 2026-09-16

A hosted site can be read back and reused, not only rolled back.

Every deployed version is a full copy of the site, and for a site written by
hand that copy is the source. A new conversation asked to keep going on it
could see the version numbers and none of the files, so it started over.

### Added
- `get_deployment_files`: every file of a version with its size and URL, and
  the text of the text files. The live version unless one is named; `paths`
  narrows it; `includeContent: false` lists without text. Text is capped at
  512KB per file and 4MB per call, and a file left out says why.
- `deploy_frontend` takes `fromAppId` (and optionally `fromVersion`): the
  server copies a version that is already hosted in the same organization
  into a new version of this app. From another app, a site forks into a new
  one; from the same app, an old version comes back as a fresh version.
  Nothing passes through the conversation, so size does not matter.

Needs the backend with `GET deployments/files` and `POST deployments/copy`.

## 0.14.4, 2026-09-16

Files can now reach TaskLite from the person who has them.

A model cannot read a folder on someone's laptop, and a hosted connector
runs on our server, not theirs. So anything that started life outside the
chat, the customer's photos, a signed contract, a logo, a build zip, had
nowhere to go: the advice was to publish it somewhere public first, which
nobody does. The server has had token-based upload links for a while, used
for asking a client for material from a row. They were never exposed as
tools.

### Added
- `request_file_upload`: mints an upload link for an item,
  `https://app.tasklite.net/upload/<token>`, that works with no account, no
  login and no key. With `clientEmail` TaskLite sends it; without one the
  link comes back to hand over. `maxFiles` and `expiryDays` bound it.
- `list_uploaded_files`: the files on an item, each with a short-lived
  download URL, plus the open links and how many files each has taken, so a
  model can tell whether the person delivered.
- `revoke_upload_link`: closes a link early. The files already uploaded stay.

### Changed
- `deploy_frontend` says what to do when the build is on the person's
  machine and the server cannot see it: upload the zip on the app's Versions
  screen, which deploys through the same route and keeps the same history.
  The `dir` error now names that screen with the app's own URL.

## 0.14.3, 2026-09-13

get_app_spec can return a real OpenAPI document.

"Give me the OpenAPI spec of the Bike Repair API" got TaskLite's own compact
spec shape (appName, baseUrl, authMethod, endpoints), which is what the
frontend prompts are built from and not what a developer or another tool
expects under that name. The server has had an OpenAPI 3.1 route for a
while; the tool just never reached it.

### Added
- `format` on get_app_spec: "tasklite" (default, unchanged) or "openapi",
  the OpenAPI 3.1 document with every endpoint, typed fields, the filter
  grammar, auth and errors. The description tells the model to pass
  "openapi" when the user asks for the OpenAPI spec or wants to hand the
  API to a developer.

## 0.14.2, 2026-09-11

Filtering by status now works on data boards, and "everything that is not
done" is one call.

A board that build_backend creates is a data board: its status lives in an
ordinary status-type column with whatever options the builder chose
("Received", "Completed"), not in the task field every row carries with the
default "todo". query_items sent `status` to that task field, so on a data
board it matched every row or none. The server now resolves `status` against
the board's status column, whichever one that is, and accepts option labels
as well as values, case-insensitively.

### Added
- `excludeStatus` on query_items: rows whose status is not one of the given
  values. Rows with no status at all are kept.

### Changed
- `status` on query_items matches the board's status column on data boards
  too, by option value or label. `sort: "status"` sorts by that column on a
  data board.
- Every tool now declares `idempotentHint` as well, so all four MCP hints
  are explicit booleans on all 48 tools. Reads, deletes, updates that set a
  value and publish are idempotent; creates, key minting, test pushes,
  deploy_frontend and sign_up are not.
- One bin, `tasklite-mcp`. A second bin made `npx -y @tasklite/mcp` refuse
  to run the package at all.

## 0.14.0, 2026-09-07

Every tool now declares all three annotation hints explicitly.

A missing hint is not the same as a false one. Until now 48 tools said
nothing at all about `openWorldHint`, and every read-only tool said nothing
about `destructiveHint`, so a client, or a directory reviewer, could not
tell "this tool does not reach the open internet" from "nobody said". The
OpenAI Apps scan flags exactly that on every tool.

### Changed
- All 48 tools carry `readOnlyHint`, `destructiveHint` and `openWorldHint`.
  `openWorldHint` is true only where the effect leaves the user's own
  workspace: signing up, connecting, signing in, publishing or rolling back
  a page the public can load, an automation that may call a URL the user
  names, and a push delivered through Google. Everything else touches only
  data inside their own organization.

## 0.13.0, 2026-09-07

Push notifications reached the API, so the tools can see and test them.

A live connection reaches a phone only while the app is on screen; the
operating system closes it the moment the app goes to the background. What
actually reaches someone whose app is closed is a push, and it now exists
as a `send_push` automation action.

### Added
- `push_status`. Whether an app can notify phones, whose Firebase project it
  sends through, and how many devices have registered. When nothing is set
  up it says how to set it up, and says plainly that the service account is
  a private key which must not be pasted into a chat.
- `send_test_push`. One real notification to named app users, so the chain
  can be proven before an automation depends on it. The answer separates
  "delivered", "this user has no device yet" and "the service says this
  device is gone", because those are three different problems.

## 0.12.0, 2026-09-07

`query_items` could only page. Anyone who wanted a subset had to pull the
whole board and filter on their side, which is slow, expensive, and reads
like the product cannot query its own data. The REST endpoints could always
do more; the tool simply never exposed it.

### Added
- `query_items` takes `search`, `status`, `priority`, `sort` and `archived`.
  `search` matches the row title and its text cells; `status` and `priority`
  take a comma-separated list; `sort` takes `title`, `createdAt`, `updatedAt`
  or `status`, with a leading `-` for descending; `archived` chooses `active`
  (the default), `archived` or `all`. They combine with `limit` and `page`,
  and they apply to the paging loop as well, so an unpaged call also comes
  back narrowed instead of pulling every row first.

### Changed
- `query_items` says in its description that a published app's own REST
  endpoints take a fuller grammar, nine filter operators per column,
  relation filters, per-field search, and points at `get_app_spec` for it.
  The tool is the admin view of a board, not the app's query language.

## 0.11.0, 2026-09-07

From a reviewer's API-quality report.

### Added
- `delete_project`. Boards, columns and rows could be deleted and projects
  could not, so anything built for a test stayed forever. The project goes
  to the organization recycle bin and can be restored from the admin.

### Changed
- `query_items` on a data board returns records, not tasks: `status`,
  `priority`, `dueDate`, `subtaskProgress` and the rest of the task fields
  are left out, matching what the App API already does for those boards.
- `build_backend` says when a row has no title and no text value, so
  nothing can reference it, instead of reporting the missing title as a
  problem in the board that pointed at it. The description now matches what
  the code does.

## 0.10.1, 2026-09-07

### Fixed
- `build_backend` no longer leaves a half-built project behind. When the
  plan does not allow another published app it says so before creating
  anything, and if any later step fails it removes the project and the app
  it made instead of naming them in an error.

## 0.10.0, 2026-09-06

### Added
- `deploy_frontend` takes the site in one of three ways instead of only a
  local folder: `files` (the files inline, path + content, base64 for
  binaries; up to 500 files / 8MB) so ChatGPT and every hosted client can
  write a page and put it live in the same turn; `zipUrl` (a public https
  zip such as a Lovable/Bolt export or a GitHub release asset, up to 50MB;
  a single top-level folder is re-rooted); and `dir` as before. Exactly one
  of the three is required. Private hosts, plain http and non-zip answers
  are refused before anything is uploaded.

## 0.9.0, 2026-09-06

Requires a TaskLite server from 2026-09-06 for the new behaviour; older
servers ignore `kind` and keep creating task boards.

### Added
- Data boards. `create_board` takes `kind`: `"tasks"` (default) also gives
  the board the built-in task columns, status, priority, assignee, due
  date, tags; `"data"` creates a plain table with only the columns you add.
  `build_backend` boards default to `"data"`: a backend's tables are
  customers, orders and payments, not to-dos. Rows of a data board come
  back from the App API without `status` and `priority`, and its OpenAPI
  document does not list them.
- Relation values from the App API now always carry
  `relatedItems: [{ id, title }]` next to `relatedItemIds`, whoever wrote
  the row, so a frontend shows "Sam Miller" without a second request.

## 0.8.3, 2026-09-06

### Changed
- `build_backend` no longer cares about the order of boards in the spec.
  Sample rows are created in dependency order, a board's rows after the
  rows of every board it links to, so an order that names a customer
  works whether Customers is listed first or last.
- A sample row that links to a title not present in the related board's
  rows is refused before anything is created, with the board and the
  missing title named. Previously the project was built and the gap was
  only mentioned in a note.

## 0.8.2, 2026-09-06

### Changed
- `build_backend` relation columns take `relatedBoard` and `relationType`
  as fields of their own, and `relationType` is an enum
  (`many_to_one`, `one_to_many`, `many_to_many`, `one_to_one`) with a
  description that says what each means for a business model. A model
  reading the schema now sees the valid values instead of guessing; the
  previous `settings.relatedBoardName` form still works. The summary echoes
  the relation type of every relation column. Using either field on a
  non-relation column is refused before anything is built.

## 0.8.1, 2026-09-06

### Added
- `build_backend` links boards: a `relation` column with
  `settings.relatedBoardName` naming another board in the same spec is
  wired to it (relation type defaults to many_to_many). Sample rows can
  fill a relation cell with the title(s) of rows in the related board, so
  "Customer": "Sam Miller" on an order links to that customer. Boards are
  created before any column, so order in the spec only matters for rows.
- The API summary echoes `scopes`, and says the key is shown once.

### Changed
- A relation to a board not in the spec is refused before anything is
  created, with the list of boards that are.

## 0.8.0, 2026-09-06

### Added
- `build_backend`, one call builds a project, its boards, typed columns,
  optional sample rows, and optionally a published REST API with an endpoint
  per board and a server-side key. The model designs the schema; the tool
  executes it and returns one compact summary. API field names are derived
  from column names and never collide with reserved item fields, so nothing
  needs a retry. A spec problem is reported before anything is created.
- `create_app_api_key` accepts `scopes` (`["read"]` or `["read","write"]`).
  With a server from 2026-09-06 the default follows the app: write once any
  endpoint accepts POST, PATCH or DELETE. Earlier keys said `read` while
  writing, which was a label, not a restriction.

### Changed
- Organization defaulting for OAuth users (ChatGPT, Claude web): the single
  organization the user can write to is chosen automatically; with several,
  the error names them with ids so the model can choose in the same turn.
  Previously every OAuth call without `organizationId` failed and asked for
  `list_organizations` first.
- `create_app_endpoint` / `update_app_endpoint` spell out the reserved alias
  names (`status`, `title`, …) so a model never trips on them.
- Tool count 44 → 45; hosted 39 → 40.

## 0.7.1, 2026-09-06

### Changed
- Every tool parameter now carries a description (155 parameters across 44 tools), so clients and directories show what each argument means.

### Fixed
- Hosted server: `resources/list` and `prompts/list` join the discovery methods that work without a credential (directory scanners logged them as failures).

## 0.7.0, 2026-09-04

Requires TaskLite API from 2026-09-04 (branch `feat/app-api-hardening`) for
the new behaviour; older servers ignore the new fields.

### Added
- `search` and `fetch`, the two tools ChatGPT connectors and deep research
  require. `search` covers projects, boards and items; `fetch` returns one of
  them by the id `search` gave (or an app URL path).
- Schema editing: `update_column` (rename, retype, options, required, hidden),
  `delete_column`, `reorder_columns`, `update_board`, `delete_board`.
  A type change converts stored values and reports `{ converted, cleared }`.
- `export_project`, the whole project as JSON (boards, columns, items,
  cells), capped per board for the model; the REST endpoint returns everything.
- Column validation rules through `settings.validation` on `create_column` /
  `update_column`: `unique`, `min`, `max`, `minLength`, `maxLength`,
  `pattern`, `patternMessage`. Enforced on every write path.
- `create_automation`: the `delay` action (`{ minutes | hours | days }`) and
  `config.retry` on network actions; `send_webhook` takes `config.secret`.
- `get_frontend_prompt` accepts `claude-code` (it was documented but rejected).
- Hosted server: `initialize`, `ping` and `tools/list` work without a
  credential, so directories and client "test connection" buttons can see
  the tools before sign-in. Every `tools/call` still requires auth.

### Fixed
- `create_automation` and `list_automations` failed with
  "typedHandler is not a function": an empty annotations object was parsed
  by the SDK as the callback. Tools without annotations now register with the
  four-argument form.
- `create_item` description no longer tells agents to create title-only and
  then `set_cell`; cells are saved atomically with the row.

### Changed
- Tool count 31 → 44. Hosted server exposes 39 (no onboarding tools).

## 0.5.7, 2026-08

Last version published before this changelog existed.
