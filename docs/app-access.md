# Giving a person access to an app

Who may use an app is decided in two places: the row-level security mode of
each endpoint, and, for mode `shared`, the app's access list. This page says
which one applies and how to let a person in.

## The four modes

| Mode | Who reaches which rows | Needs the access list |
| --- | --- | --- |
| `owner` (default) | Each signed-in user: the rows they created. | No |
| `phone` | A user signed in by phone code: the rows whose `phoneColumn` holds their phone. | No |
| `relation` | Each user: the rows linked through a relation column to the row that stands for them. | No |
| `shared` | Every user on the app's access list, and every owner, admin or editor of the organization: all rows. | **Yes** |

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

## What this does not cover

- A person who signs in by email and password or by Google is a different
  account from their phone. Give them access with `set_app_user_role` after
  their first sign-in.
- Invite codes (`create_app_invite`) are still the way to link a new user to
  a row for mode `relation`, and to let people into an organization whose
  registration policy is `"invite"`. A phone added with `add_app_user` is let
  into such an organization without a code.
