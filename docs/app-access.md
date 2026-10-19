# Giving a person access to an app

Who may use an app is decided in two places: the row-level security mode of
each endpoint, and, for mode `shared`, the app's access list. This page says
which one applies and how to let a person in.

## The modes

| Mode | Who reaches which rows | Needs the access list |
| --- | --- | --- |
| `owner` (default) | Each signed-in user: the rows they created. | No |
| `phone` | A user signed in by phone code: the rows whose `phoneColumn` holds their phone. | No |
| `relation` | Each user: the rows linked through a relation column to the row that stands for them. | No |
| `shared` | Every user on the app's access list, and every owner, admin or editor of the organization: all rows. | **Yes** |
| `policy` | Rows and columns by business role, from the board's policy (see [Roles and board policies](#roles-and-board-policies)). | No: roles |

In `owner`, `phone` and `relation` anyone who signs in gets in, and the mode
itself limits them to their own rows. Use them for the customers of an app.

`shared` is for the people who run the app: an admin screen, a back office, a
team system. Signing in is not enough there. A person who signs in and is not
on the access list gets `403` on every `shared` endpoint.

## Letting someone into a `shared` screen

One call, with their phone number and a role:

```
add_app_user { appId, phone: "054-1234567", role: "editor" }
```

- If that phone already signed in to the organization, access is on at once:
  `status: "active"`.
- If it never did, the answer is `status: "pending"`. Nothing is created for
  the number. The first time the phone signs in to the app with an SMS code,
  the access opens by itself. The person does nothing extra, and neither does
  anyone else.

The phone is matched whatever its spelling: `054-1234567`, `+972 54 123 4567`
and `972541234567` are one number. A number outside Israel needs its country
code.

Roles: `editor` reads and writes, `viewer` reads, `submitter` creates.

Calling `add_app_user` again for the same phone sets its role again and
switches back on a user who was switched off. It requires an owner or admin
of the organization; an editor gets `403`.

REST, for a client that does not use the connector:

```
POST   /organizations/<orgId>/apps/<appId>/users            { phone, role?, expiresInDays? }
GET    /organizations/<orgId>/apps/<appId>/users/pending
DELETE /organizations/<orgId>/apps/<appId>/users/pending/<pendingId>
PATCH  /organizations/<orgId>/apps/<appId>/users/<userId>   { role?, isActive? }
```

## Seeing who can use the app

`list_app_users` answers `{ users, pending }`.

- `users`: everyone who ever signed in or was sent with `X-App-User`. The
  field to read is `hasAccessRow`. When it is `false`, `role` and `isActive`
  are only defaults: the person can use `owner`, `phone` and `relation`
  endpoints, and is refused by `shared` ones.
- `pending`: the phones still waiting for their first sign-in.

## Changing or taking access away

- `set_app_user_role { userId, role?, isActive? }` changes a role, switches a
  user off or back on, and puts on the list a user who signed in and is
  refused. `isActive: false` blocks the user in every mode.
- `remove_app_user { userId }` switches a user off. `remove_app_user
  { pendingId }` cancels access a phone is still waiting for, so its first
  sign-in opens nothing.

## Building an admin screen

1. Put the endpoints of the screen in mode `shared`.
2. Sign people in by phone code: `POST /auth/otp/send`, then
   `POST /auth/otp/verify`, with the organization id of the app.
3. Call the API with the token from the sign-in:
   `Authorization: Bearer <token>`, at `https://api.tasklite.net/apps/<slug>/api/<endpoint>`.
   On a site TaskLite hosts, the relative `/api/<endpoint>` with the same
   header works too.
4. Add each person who runs the app with `add_app_user`.

Do not build the list of allowed people into the page (a board of phones the
page checks, an invite code the owner types in). The access list is enforced
by the server on every request; a list the page keeps is not.

## Roles and board policies

The four modes decide by who created or owns a row. When the rule is about the
person's job (a manager, an agent, bookkeeping), use mode `policy`: the
endpoint takes its rules from a **policy of the board**, and people get
**roles**.

### 1. Roles

- `define_app_role { appId, key: "manager", label }` creates a role
  (`list_app_roles`, `delete_app_role`). `*` (any signed-in user) and
  `public` are built in.
- `grant_app_role { appId, userId, roleKey, expiresAt? }` gives a user a role;
  a user may hold several. `revoke_app_role`, `list_app_role_grants`.
- Or derive roles from the data: `set_policy_identity` points at the employees
  board, its phone (or email) column, the column with the position and a map
  from position to role keys. A user whose verified phone is in an active row
  gets that row's roles. `get_policy_identity` reads it back.

### 2. The policy

`set_board_policy { appId, boardId, policy }` replaces the whole policy
(`get_board_policy`, `delete_board_policy`). Example for a claims office with
three roles: the manager reads and edits every case, an agent only the cases
whose agent column is him, bookkeeping reads all. The commission is for the
owner and the manager, and for the agent on his own rows. Who the case is
assigned to can be changed only by the owner and the manager:

```json
{
  "schemaVersion": 1,
  "rows": {
    "read": [
      { "roles": ["owner", "manager", "bookkeeping"], "scope": "all" },
      { "roles": ["agent"], "scope": { "mine": "<agent column id>" } }
    ],
    "write": [
      { "roles": ["owner", "manager"], "scope": "all" },
      { "roles": ["agent"], "scope": { "mine": "<agent column id>" } }
    ],
    "create": ["owner", "manager", "agent"],
    "delete": ["owner"]
  },
  "columns": {
    "<commission column id>": {
      "read": { "roles": ["owner", "manager"], "orMine": "<agent column id>" },
      "write": ["owner"]
    },
    "<agent column id>": { "write": ["owner", "manager"] },
    "assignedTo": { "write": [] }
  }
}
```

- `scope`: `"all"`; `{ "mine": col }` (rows whose column points at the caller:
  a relation to the row that stands for them, or their verified phone or
  email; `"via"` adds one relation hop); `{ "created": true }`.
- `columns` is keyed by column id or by a reserved field (`title`,
  `description`, `status`, `priority`, `dueDate`, `assignedTo`). `"write": []`
  locks the column for everyone through the app. **Lock `assignedTo`**:
  the reserved fields are otherwise writable by anyone who may write the row.
- `internalBypass` (default `true`): owners, admins and editors of the
  organization who use the app are let through. `rules` and `actions` are
  validated by the server and enforced by backends that have them.
- A bad document is refused with `POLICY_INVALID` and a list of problems.

### 3. The endpoint, then prove it

Set `rowLevelSecurity: { enabled: true, mode: "policy" }` on the endpoint
(`create_app_endpoint` or `update_app_endpoint`; no other field goes with
it). Then:

- `explain_access { appId, boardId, userId }` (or `roles: ["agent"]`): what the
  person may read, write, create and delete.
- `simulate_request { appId, userId, endpoint, method, itemId?, bodyKeys? }`:
  the verdict for one request, nothing changed. Check that an agent's PATCH
  of `assignedTo` is refused and that his PATCH of his own case passes.

### History

`get_item_history { itemId, limit?, before? }` returns the changes of one
row, newest first: field, from, to, time, who, channel, and the event and
reason when a named action made it. Pass `nextBefore` as `before` for the
next page.

## What this does not cover

- A person who signs in by email and password or by Google is a different
  account from their phone. Give them access with `set_app_user_role` after
  their first sign-in.
- Invite codes (`create_app_invite`) are still the way to link a new user to
  a row for mode `relation`, and to let people into an organization whose
  registration policy is `"invite"`. A phone added with `add_app_user` is let
  into such an organization without a code.
