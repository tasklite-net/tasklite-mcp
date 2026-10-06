---
name: tasklite
description: Build and manage a business backend on TaskLite from natural language: projects, boards, typed columns, data, public forms, and REST APIs for external frontends. Use whenever the user wants to create, model, populate, or expose operational data (orders, clients, inventory, bookings, leads, tickets), or asks to "build me a system / an app / a backend / an admin".
---

# Building on TaskLite

TaskLite is the backend: the data lives in **boards** (tables) inside **projects**
(one project = one business process). The boards double as a ready-made admin the
end client operates, so you are building a real system, not a throwaway.

Tools are provided by the `tasklite` MCP server. They are deterministic REST
wrappers: you are the intelligence, they are the hands.

## First: make sure you're connected

Call `connection_status`.
- Connected → note the organization id; proceed.
- Not connected → this is a **new user**. Ask for their email, name, and a
  business name, then call `sign_up`. It creates the account, organization, and
  connection from here, with no website visit. (A strong password is set locally
  and never shown; for web login they use "forgot password" with that email.)

## The build order

1. **Model before you fill.** `create_project` → `create_board` → `create_column`
   for each field. Then `get_board_schema` to read back the real column ids,
   which you need for cells. Only after the schema exists, add data.
2. **Pick honest column types.** text, number, date, select (pass
   `settings.options`), multiselect, person, checkbox, link, file. A status field
   is `select` with real options, not free text, because the admin and the
   automations rely on it.
3. **Seed a little real-looking data** with `create_item` (use `cells` keyed by
   the column ids from step 1) so the user sees their system alive.
4. **Only if they want an external frontend/app:** `create_app` (needs the
   projectId) → `create_app_endpoint` (choose `exposedColumns`; set
   `rowLevelSecurity` if end users should see only their own rows) →
   `publish_app` → `create_app_api_key`. Then `get_frontend_prompt` with
   tool `claude-code` to get a CLAUDE.md for the frontend project.
5. **Ship the frontend.** After building it, `deploy_frontend(appId, dir)`
   uploads the build output and returns a live `https://{slug}.tasklite.dev`
   URL. Hosted pages call the API at the relative path `/api/{endpoint}`, so
   they need no key and no base URL.

## Apps with their own users

`rowLevelSecurity.mode` on an endpoint decides which rows a signed-in user
reaches: `owner` (the rows they created, the default), `shared` (every row, for
authorized users), `phone` (the rows that carry their verified phone),
`relation` (the rows linked through a relation column to the row that stands
for them). For two kinds of people in one app, coaches and their trainees:

- Coaches board: `mode: "phone"`, `phoneColumn` = its phone column.
- Trainees board: `mode: "relation"`, `relationColumn` = its Coach column,
  `identityPhoneColumn` = the Coaches phone column, `allowInvites: true` so a
  coach can invite a trainee from inside the app.
- A board one hop further (weigh-ins of a trainee): `relationColumn` = its
  Trainee column, `viaColumn` = Trainees.Coach for the coach; a second endpoint
  without `viaColumn` for the trainee herself.

Tools around it: `create_app_invite` / `list_app_invites` / `revoke_app_invite`
/ `check_invite_code` (invite codes), `list_app_users` / `link_app_user` /
`list_app_user_links` / `unlink_app_user` (who is which row),
`configure_external_access` with `registrationPolicy: "invite"` (new people
only with a code), `configure_app_settings` (reads and merges app settings),
`delete_app_endpoint`. `update_app_endpoint` replaces `rowLevelSecurity` whole:
send every field again. `build_backend` takes the same thing per board, with
columns by name.

## Automations

`create_automation`, `update_automation`, `list_automations`. The `scheduled`
trigger is checked hourly and takes `{ intervalHours, runAtHour }` with
`runAtHour` in UTC; it reads no cron expression. `send_push` notifies app
users on their phones (`push_status` first, `send_test_push` to try); the last
segment of its `recipientsFromRelation` path must be a people column.

## Schema patterns (the value you add)

Don't ask the user to design tables. Infer a sound schema from their domain:

- **Orders / service:** an Orders board (customer, phone, item/service, status
  select, price, due date) is usually the spine. Suppliers or staff get their own
  board when they recur.
- **CRM / leads:** Contacts (name, company, email, phone, source select) +
  Deals (title, stage select, value, contact link).
- **Bookings / appointments:** one board keyed by date/time with a status select
  and a customer link.
- **Inventory:** items (name, sku, quantity number, category select, reorder
  level).

Prefer few well-typed boards over many thin ones. Add a board only when the data
recurs and has its own lifecycle.

## Guardrails

- **The app API key (`tk_...`) is server-side only.** When you scaffold a
  frontend, keep the key in an env var and call the app API from server code
  (Next.js route handlers / server actions), never from the browser. Frontends
  hosted on `tasklite.dev` need no key at all.
- **Confirm destructive actions.** `delete_item` removes data, so check with the
  user first.
- **Close the loop.** Creation tools return an `adminUrl`. End by telling the
  user where their ready-made admin is: "Manage this at <adminUrl>."
- Pass `organizationId` explicitly when the user has more than one org
  (`list_organizations`); otherwise the connected org is used.
