# TaskLite

TaskLite is the backend: data lives in boards (tables) inside projects (one
project = one business process). The boards are also the admin the end client
operates, so you are building a real system, not a demo.

Build order: `create_project` → `create_board` → `create_column` per field →
`get_board_schema` (real column ids) → `create_item` with all cells in one call.

Choose column types by meaning, never default to text: `date`/`datetime` for
dates, `phone`, `email`, `number`/`currency`, `rating`, `dropdown`/`status`
with `settings.options` for closed choices, `file` for uploads, `relation` for
links between boards. Rules go in `settings.validation` (`unique`, `min`,
`max`, `pattern`) and are enforced on every write.

Changing a model later: `update_column` (rename, retype, options),
`delete_column`, `reorder_columns`, `update_board`, `delete_board`.

External frontend: `create_app` → `create_app_endpoint` (pass
`exposedColumns` with aliases) → `create_app_api_key` → `get_app_spec` /
`get_frontend_prompt`. The App API supports `filter[field][op]`, `sort`,
`search`, single-row GET, files via presigned URLs, and row-level security
through `X-App-User`.

Row-level security modes on an endpoint: `owner`, `shared`, `phone`,
`relation` (rows linked through a relation column to the row that stands for
the user, e.g. a coach sees his trainees; `viaColumn` adds a hop). Users become
rows through `create_app_invite` or `link_app_user` (ids from
`list_app_users`). `configure_external_access` with policy `invite` admits new
people only with a code. Also: `configure_app_settings`, `delete_app_endpoint`.

Automations: `create_automation`, triggers on changes or `scheduled`
(`{ intervalHours, runAtHour }`, UTC, no cron); actions include
`http_request` (write an API answer into columns), `send_webhook`
(signed, retried), `delay` (resume later), `send_email`, `send_whatsapp`,
`send_push` (to app users' phones).

Read failures as instructions: a 400 names the column and the rule.
Reference: https://tasklite.net/docs
