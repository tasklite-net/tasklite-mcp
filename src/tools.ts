/**
 * All TaskLite MCP tools, bound to a credential-scoped TaskLiteApi via getApi().
 * Used by both entries: stdio (index.ts, single user) and HTTP (http.ts,
 * one api instance per authenticated request). Deterministic by design -
 * zero LLM calls (docs/specs/MCP_SERVER_SPEC.md).
 */
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import AdmZip from "adm-zip";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TaskLiteApi,
  envApiUrl,
  envAppUrl,
  envApiKeyOverrides,
  credentialsPath,
} from "./api.js";

export type GetApi = () => TaskLiteApi;

export interface OnboardingHooks {
  /** Persist a freshly created key; returns where it was saved. */
  save: (apiKey: string) => string;
  /** Swap the active api instance after sign_up/connect; null disconnects. */
  activate: (api: TaskLiteApi | null) => void;
  isConnected: () => boolean;
  /** Forget the stored credential. Returns false if there was none. */
  clear: () => boolean;
}

// Every tool response funnels through here, which makes this the one place that
// can guarantee no internal user row leaves the server, see sanitizeUsersDeep.
function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      { type: "text", text: JSON.stringify(sanitizeUsersDeep(data), null, 2) },
    ],
  };
}

// Several endpoints embed a user relation as the full internal record (email,
// googleId, phone, telegram id, reset-password token, MFA state, …), comments
// as the author, projects as the owner, and any other `relations: ['user']`
// read. The backend narrows comments only, so until it narrows the rest, strip
// any user-shaped object here, on every response. Detection keys on
// internal-only columns so ordinary entities with id+name are left untouched.
const USER_PUBLIC_FIELDS = [
  "id",
  "name",
  "avatar",
  "userType",
  "companyName",
] as const;
const USER_INTERNAL_MARKERS = [
  "resetPasswordToken",
  "googleId",
  "aiTokensLimit",
  "mfaEnabled",
];

export function sanitizeUsersDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeUsersDeep);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("email" in obj && USER_INTERNAL_MARKERS.some((k) => k in obj)) {
      return Object.fromEntries(
        USER_PUBLIC_FIELDS.filter((k) => k in obj).map((k) => [k, obj[k]]),
      );
    }
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, sanitizeUsersDeep(v)]),
    );
  }
  return value;
}

// Directory requirement: every tool carries a title and a safety hint -
// readOnlyHint for reads, destructiveHint for irreversible writes.
/**
 * Semantic type guard for create_column, the MCP-side twin of the
 * architect's "mandatory semantic mapping" table.
 *
 * Matchers are deliberately narrow (word-ish boundaries, notes exempt) so a
 * "Notes on payment" column stays text while "Install Date" typed text is
 * caught. Hebrew is included because half the customer base names columns in
 * it. Returns null when the pairing is fine.
 */
const NOTES_RE = /(note|notes|comment|remark|memo|הערה|הערות|תיאור)/i;
const TYPE_HINTS: Array<{ re: RegExp; suggest: string }> = [
  {
    re: /(^|[\s_/(-])(date|deadline|due|תאריך|מועד)($|[\s_/)-])/i,
    suggest: "date",
  },
  {
    re: /(^|[\s_/(-])(phone|mobile|cell|tel|טלפון|נייד)($|[\s_/)-])/i,
    suggest: "phone",
  },
  { re: /(e-?mail|אימייל|מייל|דוא"ל)/i, suggest: "email" },
  {
    re: /(^|[\s_/(-])(price|cost|amount|total|מחיר|עלות|סכום)($|[\s_/)-])/i,
    suggest: "currency",
  },
  {
    re: /(^|[\s_/(-])(quantity|qty|count|כמות)($|[\s_/)-])/i,
    suggest: "number",
  },
  { re: /(percent|אחוז|%)/i, suggest: "number" },
  {
    re: /(^|[\s_/(-])(rating|score|דירוג|ציון)($|[\s_/)-])/i,
    suggest: "rating",
  },
  { re: /(^|[\s_/(-])(status|סטטוס|מצב)($|[\s_/)-])/i, suggest: "status" },
  { re: /(^|[\s_/(-])(url|link|קישור)($|[\s_/)-])/i, suggest: "link" },
];

function columnTypeObjection(
  name: string,
  type: string,
  settings?: Record<string, unknown>,
): { rejected: string; suggestedType: string; retry: string } | null {
  if (type === "text" || type === "rich_text") {
    if (NOTES_RE.test(name)) return null;
    const hint = TYPE_HINTS.find((h) => h.re.test(name));
    if (hint) {
      return {
        rejected: `column "${name}" typed ${type}, but the name suggests ${hint.suggest}. A ${hint.suggest} column powers calendars/filters/tap-actions; text there is dead data.`,
        suggestedType: hint.suggest,
        retry: `Call create_column again with type:"${hint.suggest}" (add settings.options if it is a closed choice), or force:true if "${name}" really is free text.`,
      };
    }
  }
  if (
    (type === "dropdown" || type === "status") &&
    !(settings as any)?.options?.length
  ) {
    return {
      rejected: `${type} column "${name}" has no settings.options, it would render as an empty select.`,
      suggestedType: type,
      retry: `Call create_column again with settings.options as an array of the real choice labels.`,
    };
  }
  return null;
}

/**
 * Every tool declares all three hints explicitly.
 *
 * A missing hint is not the same as a false one: a client, and a directory
 * reviewer, cannot tell "this tool does not reach the open internet" from
 * "nobody said". The three are:
 *
 * - readOnlyHint: the call changes nothing.
 * - destructiveHint: it removes or overwrites something the user would miss.
 * - idempotentHint: calling it again with the same arguments adds nothing to
 *   what the first call did. Not the same as safe, and not the same as
 *   read-only. A delete is idempotent, because deleting what is already gone
 *   leaves the state the first call left; a create is not, because two calls
 *   make two rows; and anything that mints or sends is not, because a second
 *   key is a second key and a second test push is a second notification on
 *   somebody's phone.
 * - openWorldHint: its effect leaves the user's own workspace. True only for
 *   signing in or up, publishing a page the public can load, an automation
 *   that may call a URL the user names, and a push delivered through Google.
 *   Everything else touches only data inside their own organization.
 */
const ANNOTATIONS: Record<string, Record<string, unknown>> = {
  connection_status: {
    title: "Check TaskLite connection",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  sign_up: {
    title: "Create TaskLite account",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  connect: {
    title: "Connect or switch TaskLite account",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  login: {
    title: "Sign in to TaskLite with email and password",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  disconnect: {
    title: "Disconnect TaskLite account",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_organizations: {
    title: "List organizations",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  configure_external_access: {
    title: "Configure external user access",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_projects: {
    title: "List projects",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  create_project: {
    title: "Create project",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  create_board: {
    title: "Create board",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  create_column: {
    title: "Add column",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  get_board_schema: {
    title: "Read board schema",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  update_board: {
    title: "Update board",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_board: {
    title: "Delete board",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_project: {
    title: "Delete project",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  push_status: {
    title: "Push status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  send_test_push: {
    title: "Send a test push",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  update_column: {
    title: "Update column",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_column: {
    title: "Delete column",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  reorder_columns: {
    title: "Reorder columns",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  query_items: {
    title: "List items",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  create_item: {
    title: "Create item",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  update_item: {
    title: "Update item",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  set_cell: {
    title: "Set cell value",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_item: {
    title: "Delete item",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_comments: {
    title: "List item comments",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  add_comment: {
    title: "Add a comment to an item",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  update_comment: {
    title: "Edit a comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_comment: {
    title: "Delete a comment",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  request_file_upload: {
    title: "Create a file upload link",
    readOnlyHint: false,
    destructiveHint: false,
    // Each call mints another link, and with an email each call sends another.
    idempotentHint: false,
    // The link works without a TaskLite account, and the invitation leaves as
    // an email, so the effect reaches outside the workspace.
    openWorldHint: true,
  },
  list_uploaded_files: {
    title: "List files on an item",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  get_deployment_files: {
    title: "Read a deployed version's files",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  revoke_upload_link: {
    title: "Revoke a file upload link",
    readOnlyHint: false,
    // Ends access through that link; the files already uploaded stay.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  create_app: {
    title: "Create app",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  publish_app: {
    title: "Publish app",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  create_app_endpoint: {
    title: "Create app endpoint",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  create_app_api_key: {
    title: "Create app API key",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  build_backend: {
    title: "Build a backend in one call",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  list_boards: {
    title: "List boards",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_apps: {
    title: "List apps",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_app_endpoints: {
    title: "List app endpoints",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  update_app_endpoint: {
    title: "Update app endpoint",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  get_app_spec: {
    title: "Get app spec",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  get_frontend_prompt: {
    title: "Get frontend prompt",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  search: {
    title: "Search projects, boards and items",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  export_project: {
    title: "Export project as JSON",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  fetch: {
    title: "Fetch one record by id",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  deploy_frontend: {
    title: "Deploy frontend to TaskLite hosting",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  list_deployments: {
    title: "List frontend deployments",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  rollback_deployment: {
    title: "Roll back a frontend deployment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  create_automation: {
    title: "Create automation",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  update_automation: {
    title: "Update automation",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_automations: {
    title: "List automations",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  delete_app_endpoint: {
    title: "Delete app endpoint",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  configure_app_settings: {
    title: "Read or change app settings",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_app_users: {
    title: "List app users",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  create_app_invite: {
    title: "Create invite code",
    readOnlyHint: false,
    destructiveHint: false,
    // Each call mints another code.
    idempotentHint: false,
    openWorldHint: false,
  },
  list_app_invites: {
    title: "List invite codes",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  revoke_app_invite: {
    title: "Revoke invite code",
    readOnlyHint: false,
    // Ends the code; the people who already signed up with it stay linked.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  check_invite_code: {
    title: "Check an invite code",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  link_app_user: {
    title: "Link a user to a row",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_app_user_links: {
    title: "List a user's row links",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  unlink_app_user: {
    title: "Remove a user's row link",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// Row-level security of an app endpoint. Up to 0.15 the schema had no `mode`,
// and zod drops keys it does not know: every endpoint a model asked to be
// "shared" was stored as "owner" (the owner of a business then saw none of its
// orders), and update_app_endpoint dropped rowLevelSecurity altogether, which
// once left an admin endpoint readable by anyone (23.9).
//
// 0.16 closes that for good: the object is strict. A key this schema does not
// know is refused with its name instead of being stripped, so a field the
// backend adds later fails loudly here (and gets added) rather than being
// stored as something weaker than what was asked. The field names are the
// backend's own (AppEndpointRowLevelSecurity in app-endpoint.entity.ts);
// which field goes with which mode is checked by the server, whose message
// names the field.
const RLS_MODE_DESCRIPTION =
  '"owner" (default): each user sees and edits only the rows they created. "shared": every user authorized on the app (listed on it, or an owner/admin of the organization) sees and edits every row; the mode for an admin screen or a team system. "phone": a user signed in with a code sent to their phone sees and edits only the rows whose phoneColumn holds that phone, e.g. a directory where each person keeps their own card, or the Coaches board itself in a coaching app (each coach reads and edits his own row; a POST writes his verified phone into the row whatever the body says). "relation": each user reaches the rows whose relationColumn points at the row that stands for them, e.g. a Trainees board whose "Coach" relation column points at the Coaches board: a coach sees only his trainees. A relation endpoint never returns the row that IS the user, only rows pointing at it, so expose the identity board itself through a second endpoint in mode "phone". In relation mode a new row is linked to the caller by the server, the link cannot be moved with PATCH, and a user who stands for no row gets an empty list on GET and 403 on POST';

const RLS_FIELDS = {
  phoneColumn:
    'mode "phone" only, required there: the column that holds each row\'s phone number',
  emailColumn:
    'mode "phone" only, optional, next to phoneColumn: a column that holds each row\'s email. A user whose email was proved by a login code also reaches the rows that carry that address; for people whose number takes no SMS (outside Israel the code goes by email, which proves the email, not the phone)',
  relationColumn:
    'mode "relation" only, required there: a RELATION column on this endpoint\'s board. A row belongs to the caller when this column points at an item that stands for the caller (or, with viaColumn, at an item that points at one). Example: on the Trainees board, the "Coach" column',
  viaColumn:
    'mode "relation" only, optional: one more hop. A RELATION column on the board that relationColumn points to, leading to the board of the caller\'s own items. Example: a Weigh-ins endpoint with relationColumn = Weigh-ins."Trainee" and viaColumn = Trainees."Coach" lets a coach reach the weigh-ins of all his trainees. For the trainee herself, make a second endpoint on the same board with relationColumn = "Trainee" and no viaColumn',
  identityPhoneColumn:
    'mode "relation" only, optional: a phone column on the board where the caller\'s own items live (the board relationColumn points to, or with viaColumn the board viaColumn points to). A user whose VERIFIED phone (sign-in by a code sent to that phone) is written in a row there stands for that row, with no invite and no link. Example: Coaches."Phone", so a coach who signed in by phone is his own Coaches row at once. Whoever may write that column decides who the row is, so expose it readOnly wherever it must not move',
  identityEmailColumn:
    'mode "relation" only, optional: like identityPhoneColumn, for an email column and a user whose email was verified by a login code',
  allowInvites:
    'mode "relation" only, default false: true lets a user of the app mint an invite code for a row they reach through this endpoint (POST /apps/{appSlug}/api/{endpointSlug}/{itemId}/invites with body { maxUses?, expiresInDays?, label? }; the endpoint must also allow POST). A coach invites a trainee to the trainee\'s own row; whoever signs up with the code is linked to that row. Such an invite never grants an access role. Without it only an owner or admin creates invites (create_app_invite)',
  singleLink:
    'mode "relation" only, default false: true gives each row of this endpoint\'s board to ONE linked user. Once someone is linked to a row, another person redeeming an invite code for the same row is refused (the sign-up answers inviteRedeemed: false with inviteError "INVITE_ROW_TAKEN"), so a coach cannot become a trainee\'s row from a second account. Whoever is already linked is not affected, and the app owner can still link by hand (link_app_user). Set it on the endpoint of the board whose rows are invited to, e.g. Trainees',
  editOwnOnly:
    'mode "relation" only, default false: true lets everyone the relation reaches READ a row, while only the user who created it may PATCH or DELETE it, or change its files (others get 403 with code ROW_NOT_YOURS). For rows two people both see but only one of them owns, e.g. a trainee\'s own log that her coach reads',
} as const;

export const RLS_SCHEMA = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "true: every request must carry a signed-in user (the token from sign-in, or the app key with X-App-User)",
      ),
    mode: z
      .enum(["owner", "shared", "phone", "relation"])
      .optional()
      .describe(RLS_MODE_DESCRIPTION),
    phoneColumn: z
      .string()
      .optional()
      .describe(`${RLS_FIELDS.phoneColumn}. A column id (get_board_schema)`),
    emailColumn: z
      .string()
      .optional()
      .describe(`${RLS_FIELDS.emailColumn}. A column id (get_board_schema)`),
    relationColumn: z
      .string()
      .optional()
      .describe(`${RLS_FIELDS.relationColumn}. A column id (get_board_schema)`),
    viaColumn: z
      .string()
      .optional()
      .describe(
        `${RLS_FIELDS.viaColumn}. A column id (get_board_schema of that other board)`,
      ),
    identityPhoneColumn: z
      .string()
      .optional()
      .describe(
        `${RLS_FIELDS.identityPhoneColumn}. A column id (get_board_schema of that board)`,
      ),
    identityEmailColumn: z
      .string()
      .optional()
      .describe(
        `${RLS_FIELDS.identityEmailColumn}. A column id (get_board_schema of that board)`,
      ),
    allowInvites: z.boolean().optional().describe(RLS_FIELDS.allowInvites),
    singleLink: z.boolean().optional().describe(RLS_FIELDS.singleLink),
    editOwnOnly: z.boolean().optional().describe(RLS_FIELDS.editOwnOnly),
  })
  .strict();

// The same thing inside build_backend, where no column has an id yet: every
// column is named as the spec names it, and the tool resolves the ids once the
// columns exist. Strict for the same reason as RLS_SCHEMA.
export const BUILD_RLS_SCHEMA = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe("Defaults to true; false leaves this endpoint without row-level security"),
    mode: z
      .enum(["owner", "shared", "phone", "relation"])
      .optional()
      .describe(RLS_MODE_DESCRIPTION),
    phoneColumn: z
      .string()
      .optional()
      .describe(`${RLS_FIELDS.phoneColumn}. The NAME of a column of this board in the spec`),
    emailColumn: z
      .string()
      .optional()
      .describe(`${RLS_FIELDS.emailColumn}. The NAME of a column of this board in the spec`),
    relationColumn: z
      .string()
      .optional()
      .describe(
        `${RLS_FIELDS.relationColumn}. The NAME of a relation column of this board in the spec`,
      ),
    viaColumn: z
      .string()
      .optional()
      .describe(
        `${RLS_FIELDS.viaColumn}. The NAME of a relation column of the board relationColumn points to`,
      ),
    identityPhoneColumn: z
      .string()
      .optional()
      .describe(
        `${RLS_FIELDS.identityPhoneColumn}. The NAME of a column of that board in the spec`,
      ),
    identityEmailColumn: z
      .string()
      .optional()
      .describe(
        `${RLS_FIELDS.identityEmailColumn}. The NAME of a column of that board in the spec`,
      ),
    allowInvites: z.boolean().optional().describe(RLS_FIELDS.allowInvites),
    singleLink: z.boolean().optional().describe(RLS_FIELDS.singleLink),
    editOwnOnly: z.boolean().optional().describe(RLS_FIELDS.editOwnOnly),
  })
  .strict();

type BuildRls = z.infer<typeof BUILD_RLS_SCHEMA>;
type BuildRlsBoard = {
  name: string;
  columns: Array<{
    name: string;
    type: string;
    relatedBoard?: string;
    settings?: Record<string, unknown>;
  }>;
};

/**
 * Checks one board's rowLevelSecurity in a build_backend spec against the
 * spec itself, before anything is created, and says which board and column
 * each name resolved to. Mirrors the server's assertRowLevelSecurity and
 * relationPath (tastlite-be app-builder), so a spec the server would refuse
 * is refused here, where nothing has been built yet.
 */
type BuildRlsRefs = Partial<
  Record<
    | "phoneColumn"
    | "emailColumn"
    | "relationColumn"
    | "viaColumn"
    | "identityPhoneColumn"
    | "identityEmailColumn",
    { board: string; column: string }
  >
>;

export function planBuildRls(
  board: BuildRlsBoard,
  rls: BuildRls,
  boards: BuildRlsBoard[],
): { problems: string[]; refs: BuildRlsRefs } {
  const problems: string[] = [];
  const refs: BuildRlsRefs = {};
  const where = `${board.name}.rowLevelSecurity`;
  const mode = rls.mode ?? "owner";
  const findBoard = (name: string) =>
    boards.find((b) => b.name.toLowerCase() === name.toLowerCase());
  const findColumn = (b: BuildRlsBoard, name: string) =>
    b.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const targetOf = (c: BuildRlsBoard["columns"][number]) =>
    String(c.relatedBoard ?? (c.settings as any)?.relatedBoardName ?? "");

  const relationOnly = [
    "relationColumn",
    "viaColumn",
    "identityPhoneColumn",
    "identityEmailColumn",
    "allowInvites",
    "singleLink",
    "editOwnOnly",
  ] as const;
  if (mode !== "relation") {
    const stray = relationOnly.filter((k) => rls[k] !== undefined);
    if (stray.length) {
      problems.push(
        `${where}: ${stray.join(", ")} only apply to mode "relation" (got "${mode}")`,
      );
    }
  }
  if (mode !== "phone") {
    const stray = (["phoneColumn", "emailColumn"] as const).filter(
      (k) => rls[k] !== undefined,
    );
    if (stray.length) {
      problems.push(
        `${where}: ${stray.join(", ")} only apply to mode "phone" (got "${mode}")`,
      );
    }
  }

  if (mode === "phone") {
    if (!rls.phoneColumn) {
      problems.push(
        `${where}: mode "phone" needs phoneColumn, the name of the phone column of ${board.name}`,
      );
    }
    for (const k of ["phoneColumn", "emailColumn"] as const) {
      const name = rls[k];
      if (!name) continue;
      const col = findColumn(board, name);
      if (!col) {
        problems.push(
          `${where}.${k}: "${name}" is not a column of ${board.name} (have: ${board.columns.map((c) => c.name).join(", ")})`,
        );
      } else {
        refs[k] = { board: board.name, column: col.name };
      }
    }
  }

  if (mode === "relation") {
    if (!rls.relationColumn) {
      problems.push(
        `${where}: mode "relation" needs relationColumn, the name of the relation column of ${board.name} that points at the row standing for each user`,
      );
      return { problems, refs };
    }
    const rel = findColumn(board, rls.relationColumn);
    if (!rel || rel.type !== "relation") {
      problems.push(
        `${where}.relationColumn: "${rls.relationColumn}" is not a relation column of ${board.name}`,
      );
      return { problems, refs };
    }
    refs.relationColumn = { board: board.name, column: rel.name };
    const first = findBoard(targetOf(rel));
    // A relation column naming no board of the spec is reported by the
    // column checks; nothing more can be resolved from here.
    if (!first) return { problems, refs };
    let identity = first;
    if (rls.viaColumn) {
      const via = findColumn(first, rls.viaColumn);
      if (!via || via.type !== "relation") {
        problems.push(
          `${where}.viaColumn: "${rls.viaColumn}" is not a relation column of ${first.name}, the board relationColumn points to`,
        );
        return { problems, refs };
      }
      refs.viaColumn = { board: first.name, column: via.name };
      const next = findBoard(targetOf(via));
      if (!next) return { problems, refs };
      identity = next;
    }
    for (const k of ["identityPhoneColumn", "identityEmailColumn"] as const) {
      const name = rls[k];
      if (!name) continue;
      const col = findColumn(identity, name);
      if (!col) {
        problems.push(
          `${where}.${k}: "${name}" is not a column of ${identity.name}, the board whose rows stand for the users (have: ${identity.columns.map((c) => c.name).join(", ")})`,
        );
      } else {
        refs[k] = { board: identity.name, column: col.name };
      }
    }
  }
  return { problems, refs };
}

/**
 * Merges a patch into an app's settings the way configure_app_settings
 * promises: plain objects merge key by key at every depth, arrays and scalars
 * replace, and null removes the key. The backend stores whatever `settings`
 * object it is sent, whole, so the merge has to happen on this side.
 */
export function mergeSettings(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const out: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isPlain(value)) {
      out[key] = mergeSettings(isPlain(out[key]) ? out[key] : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// An automation filter: every condition must hold for the actions to run.
const CONDITIONS_SCHEMA = z
  .array(
    z.object({
      field: z
        .string()
        .describe(
          "A column id on this board (from get_board_schema), or status, priority, title",
        ),
      operator: z
        .string()
        .describe(
          "equals, not_equals, contains, not_contains, is_empty, is_not_empty, greater_than, less_than",
        ),
      value: z.any().optional().describe("The value to compare with"),
    }),
  )
  .optional()
  .describe(
    'Run only for rows that match, e.g. [{ field: "<column id>", operator: "equals", value: "New seller" }]',
  );

/**
 * create_cross_board_item reads config.columnValues and nothing else. On 23.9
 * a model wrote { mapping: { source: target } } twice; both automations ran,
 * "succeeded" and copied the title only. Refuse that shape with the right one.
 */
function checkCrossBoardActions(
  actions: Array<{ type: string; config: Record<string, unknown> }>,
): string | null {
  for (const a of actions) {
    if (a.type !== "create_cross_board_item") continue;
    const cfg = a.config || {};
    if (!cfg.targetBoardId) {
      return "create_cross_board_item needs config.targetBoardId (the board to copy into).";
    }
    if ("mapping" in cfg || "fieldMapping" in cfg || "columnMapping" in cfg) {
      return 'create_cross_board_item has no mapping field; it would copy the title only. Use config.columnValues: { "<column id on the TARGET board>": "{{<column name on this board>}}" }, one entry per column to copy. get_board_schema of both boards gives the ids and names.';
    }
    const values = cfg.columnValues;
    if (values !== undefined && (typeof values !== "object" || values === null || Array.isArray(values))) {
      return "create_cross_board_item config.columnValues must be an object: { <target column id>: <value or {{source column name}}> }.";
    }
  }
  return null;
}

export function registerTools(
  server: McpServer,
  getApi: GetApi,
  onboarding?: OnboardingHooks,
): void {
  // Wrap server.tool to inject the per-tool annotations (5-arg overload).
  const tool = (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    cb: (...args: any[]) => any,
  ) => {
    // An empty annotations object is indistinguishable from an empty zod shape
    // to the SDK's overload parser, which then treats it as the callback and the
    // tool dies with "typedHandler is not a function". Only pass real annotations.
    const annotations = ANNOTATIONS[name];
    return annotations
      ? server.tool(name, description, schema as any, annotations, cb)
      : server.tool(name, description, schema as any, cb);
  };

  const resolveOrg = async (organizationId?: string): Promise<string> => {
    if (organizationId) return organizationId;
    const fallback = await getApi().defaultOrganizationId();
    if (fallback) return fallback;
    // No usable default. Name the candidates here so the model can choose in
    // this same turn instead of spending a round trip on list_organizations.
    const orgs = await getApi().writableOrganizations();
    if (orgs.length === 0) {
      throw new Error(
        `This account has no organization it can write to. Create one at ${getApi().appUrl("/")} or ask an organization admin for access.`,
      );
    }
    const named = orgs.map((o) => `"${o.name}" = ${o.id}`).join("; ");
    throw new Error(
      `This account belongs to ${orgs.length} organizations, so pass organizationId. Candidates: ${named}. If the user did not say which, ask, or pick the one whose name matches the request.`,
    );
  };

  // ── Onboarding (stdio mode only, hosted mode authenticates via OAuth) ────

  if (onboarding) {
    tool(
      "connection_status",
      "Check whether this machine is connected to a TaskLite account. Call this first if any tool fails with an auth error.",
      {},
      async () => {
        if (!onboarding.isConnected()) {
          return ok({
            connected: false,
            next: "New user: call sign_up. Existing user: create a key at TaskLite → Integrations → Connect Claude Code, then pass it to the connect tool.",
          });
        }
        try {
          const orgs = await getApi().request<any[]>("GET", "/organizations");
          return ok({
            connected: true,
            organizations: (orgs || []).map((o: any) => ({
              id: o.id,
              name: o.name,
            })),
            switchAccount:
              "To use a different account, call connect with that account’s tl_ key.",
          });
        } catch (e) {
          return ok({ connected: false, error: (e as Error).message });
        }
      },
    );

    tool(
      "sign_up",
      'Create a brand-new TaskLite account + organization and connect this machine, no website visit needed. A strong random password is generated locally and never shown or stored; for web access the user later uses "forgot password" with this email. Ask the user for email, their name, and a business name before calling.',
      {
        email: z.string().email().describe("Email address"),
        name: z.string().describe("The user's full name"),
        organizationName: z.string().describe("Business/organization name"),
      },
      async ({ email, name, organizationName }) => {
        if (onboarding.isConnected()) {
          throw new Error(
            "Already connected. Call connection_status to see the current account.",
          );
        }
        const password = `Tl1!${randomBytes(24).toString("base64url")}`;
        const apiUrl = envApiUrl();
        const res = await fetch(`${apiUrl}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            name,
            password,
            organizationName,
            acceptTerms: true,
          }),
        });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            `Sign-up failed (${res.status}): ${JSON.stringify(data?.message ?? data).slice(0, 300)}`,
          );
        }
        const orgId = data.user?.currentOrganizationId;
        const keyRes = await fetch(`${apiUrl}/api-keys`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.token}`,
          },
          body: JSON.stringify({ name: "claude-code", organizationId: orgId }),
        });
        const keyData: any = await keyRes.json().catch(() => null);
        if (!keyRes.ok || !keyData?.key) {
          throw new Error(
            `Account created but key creation failed (${keyRes.status}). Create a key at TaskLite → Integrations → Connect Claude Code.`,
          );
        }
        const savedTo = onboarding.save(keyData.key);
        onboarding.activate(new TaskLiteApi(keyData.key));
        return ok({
          connected: true,
          organizationId: orgId,
          credentialsSavedTo: savedTo,
          adminUrl: `${envAppUrl()}/`,
          webAccessNote: `To log into the website later, use "forgot password" with ${email}.`,
        });
      },
    );

    tool(
      "connect",
      'Connect this machine to an existing TaskLite account, or switch to a different one. Takes a personal API key (tl_...) created at TaskLite → Integrations → "Connect Claude Code". Replaces the current connection if there is one, use this to switch user or organization. The switch takes effect immediately; no restart.',
      {
        apiKey: z
          .string()
          .describe("Personal TaskLite API key, starts with tl_"),
      },
      async ({ apiKey }) => {
        const key = apiKey.trim();
        if (!key.startsWith("tl_")) {
          throw new Error(
            'Not a personal API key. Expected a key starting with "tl_" from TaskLite → Integrations → Connect Claude Code. (App keys starting with "tk_" are for calling app endpoints, not for connecting.)',
          );
        }

        // Verify before persisting, so a bad key can never replace a good one.
        const candidate = new TaskLiteApi(key);
        let orgs: any[];
        try {
          orgs =
            (await candidate.request<any[]>("GET", "/organizations")) || [];
        } catch (e) {
          throw new Error(
            `That key was rejected, nothing changed: ${(e as Error).message}`,
          );
        }

        const savedTo = onboarding.save(key);
        onboarding.activate(candidate);

        return ok({
          connected: true,
          organizations: orgs.map((o: any) => ({ id: o.id, name: o.name })),
          defaultOrganizationId: await candidate.defaultOrganizationId(),
          credentialsSavedTo: savedTo,
          ...(envApiKeyOverrides()
            ? {
                warning:
                  "TASKLITE_API_KEY is set in this environment and takes precedence over the saved file. This switch applies to the running server, but the next start will use the env var again, remove it from your MCP server config to make this permanent.",
              }
            : {}),
        });
      },
    );

    tool(
      "login",
      'Connect this machine to an existing TaskLite account with email + password, or switch to a different account. Creates a personal API key named "claude-code" on that account and stores it, so the password is used once and never saved. Replaces the current connection if there is one. Prefer connect when the user already has a tl_ key.',
      {
        email: z.string().email().describe("Email address"),
        password: z
          .string()
          .describe("Used once to mint an API key; never stored"),
      },
      async ({ email, password }) => {
        const apiUrl = envApiUrl();
        const res = await fetch(`${apiUrl}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data: any = await res.json().catch(() => null);

        if (!res.ok) {
          const detail = JSON.stringify(data?.message ?? data).slice(0, 200);
          throw new Error(
            res.status === 429
              ? "Too many login attempts (limit is 5 per minute). Wait a minute and try again."
              : `Login failed (${res.status}): ${detail}. Nothing changed.`,
          );
        }

        if (data?.mfaRequired) {
          throw new Error(
            'This account has two-factor authentication enabled, which this tool cannot complete. Nothing changed. Sign in on the website instead and create a key at TaskLite → Integrations → "Connect Claude Code", then pass it to the connect tool.',
          );
        }

        const orgId = data?.user?.currentOrganizationId;
        const keyRes = await fetch(`${apiUrl}/api-keys`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.token}`,
          },
          body: JSON.stringify({ name: "claude-code", organizationId: orgId }),
        });
        const keyData: any = await keyRes.json().catch(() => null);
        if (!keyRes.ok || !keyData?.key) {
          throw new Error(
            `Signed in but key creation failed (${keyRes.status}). Nothing changed. Create a key at TaskLite → Integrations → "Connect Claude Code" and pass it to the connect tool.`,
          );
        }

        const api = new TaskLiteApi(keyData.key);
        const orgs = (
          (await api.request<any[]>("GET", "/organizations")) || []
        ).map((o: any) => ({
          id: o.id,
          name: o.name,
        }));
        const savedTo = onboarding.save(keyData.key);
        onboarding.activate(api);

        return ok({
          connected: true,
          account: {
            id: data.user?.id,
            email: data.user?.email,
            name: data.user?.name,
          },
          organizations: orgs,
          defaultOrganizationId: orgId ?? null,
          credentialsSavedTo: savedTo,
          note: 'A personal API key named "claude-code" was created on this account. Revoke it at TaskLite → Integrations to cut this machine off.',
          ...(envApiKeyOverrides()
            ? {
                warning:
                  "TASKLITE_API_KEY is set in this environment and takes precedence over the saved file. This login applies to the running server, but the next start will use the env var again, remove it from your MCP server config to make this permanent.",
              }
            : {}),
        });
      },
    );

    tool(
      "disconnect",
      "Disconnect this machine from TaskLite by forgetting the stored credential. Use before connecting a different account, or to revoke local access. Does not delete anything in TaskLite itself and does not revoke the key server-side.",
      {},
      async () => {
        const had = onboarding.clear();
        onboarding.activate(null);
        return ok({
          connected: false,
          removedStoredCredential: had,
          credentialsPath,
          next: "Call connect with another tl_ key to sign in as a different user.",
          ...(envApiKeyOverrides()
            ? {
                warning:
                  "TASKLITE_API_KEY is still set in this environment. The running server is disconnected, but the next start will reconnect from that env var, remove it from your MCP server config for a real disconnect.",
              }
            : {}),
        });
      },
    );
  }

  // ── Group A: schema & structure ────────────────────────────────────────────

  tool(
    "list_organizations",
    "List the organizations the authenticated user belongs to. Use the returned id as organizationId in other tools.",
    {},
    async () => ok(await getApi().request("GET", "/organizations")),
  );

  tool(
    "configure_external_access",
    'Read or change how EXTERNAL users (people who sign up to your app through TaskLite auth) get into an organization. They have two ways in, and both obey the policy below: email and password (POST /auth/register-external with this organizationId, then POST /auth/login), or Google (POST /auth/google-external with a Google ID token and this organizationId). Either way the answer carries a token the app sends as Authorization: Bearer on every App API call. registrationPolicy: "open", in at once; "approval", an organization admin approves each signup (TaskLite mails the admins on every signup, and the person once approved; unapproved users are never billed); "invite", a new person gets in only with an invite code (create_app_invite, or a code a user of the app minted on a relation endpoint with allowInvites): the app sends it as inviteCode with POST /auth/otp/verify, /auth/register-external or /auth/google-external, a sign-up without one is refused with 403 INVITE_REQUIRED and a bad code with 403 INVITE_INVALID, while people who are already members keep signing in as before; "closed" (the default), self-signup refused, external users are created by an admin. Under every policy a valid invite code admits its holder as if the organization were open, so "invite" is the policy for an app where people join only through someone who invited them (a coach inviting trainees). appLoginUrl: the page of YOUR app where these users log in, it becomes the "Log in" button in the approval email, so set it whenever you deploy an app that uses this flow; pass "" to clear. Call with no changes to just read the current settings. Requires organization admin.',
    {
      organizationId: z
        .string()
        .optional()
        .describe("Defaults to the credential organization"),
      registrationPolicy: z
        .enum(["closed", "approval", "open", "invite"])
        .optional()
        .describe(
          "How external sign-ups are admitted: open, approval, invite (only with an invite code) or closed",
        ),
      appLoginUrl: z
        .string()
        .optional()
        .describe(
          'https URL of your app\'s login page for external users; "" clears it',
        ),
    },
    async ({ organizationId, registrationPolicy, appLoginUrl }) => {
      const orgId = await resolveOrg(organizationId);
      const settings: Record<string, unknown> = {};
      if (registrationPolicy !== undefined)
        settings.externalRegistrationPolicy = registrationPolicy;
      if (appLoginUrl !== undefined) {
        const value = appLoginUrl.trim();
        if (value && !/^https?:\/\/\S+$/i.test(value)) {
          throw new Error(
            "appLoginUrl must be an absolute http(s) URL, e.g. https://app.example.com/login",
          );
        }
        settings.externalAppUrl = value;
      }
      const org =
        Object.keys(settings).length > 0
          ? await getApi().request<any>("PATCH", `/organizations/${orgId}`, {
              settings,
            })
          : await getApi().request<any>("GET", `/organizations/${orgId}`);
      const current = (org && org.settings) || {};
      return ok({
        organizationId: orgId,
        registrationPolicy: current.externalRegistrationPolicy || "closed",
        appLoginUrl: current.externalAppUrl || null,
        approvalsUrl: `${envAppUrl()}/organization/settings`,
        signupEndpoint: `${envApiUrl()}/auth/register-external`,
        loginEndpoint: `${envApiUrl()}/auth/login`,
        note:
          (current.externalRegistrationPolicy || "closed") === "approval"
            ? "Each signup waits for an admin; admins are emailed with a link to approvalsUrl, and the user is emailed (with appLoginUrl as the button) once approved."
            : (current.externalRegistrationPolicy || "closed") === "open"
              ? "Signups are active immediately."
              : (current.externalRegistrationPolicy || "closed") === "invite"
                ? "A new person gets in only with an invite code, sent as inviteCode with the sign-up call (403 INVITE_REQUIRED without one). Mint codes with create_app_invite."
                : "Self-signup is refused; external users are created by an admin. A valid invite code still admits its holder.",
      });
    },
  );

  tool(
    "list_projects",
    "List projects in an organization. The API returns 50 per page, an organization with more than that needs page 2 and beyond, so check the returned total before assuming a project does not exist.",
    {
      organizationId: z
        .string()
        .optional()
        .describe("Defaults to the credential organization"),
      page: z.number().optional().describe("1-based; defaults to 1"),
      limit: z.number().optional().describe("Defaults to 50"),
    },
    async ({ organizationId, page, limit }) => {
      const orgId = await resolveOrg(organizationId);
      const qs = new URLSearchParams();
      if (page) qs.set("page", String(page));
      if (limit) qs.set("limit", String(limit));
      const suffix = qs.toString() ? `?${qs}` : "";
      return ok(
        await getApi().request(
          "GET",
          `/organizations/${orgId}/projects${suffix}`,
        ),
      );
    },
  );

  tool(
    "list_boards",
    "List the boards inside a project, id, name, description. Every other board tool needs a boardId, and this is the only way to discover one without being handed a URL.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      page: z.number().optional().describe("1-based; defaults to 1"),
      limit: z.number().optional().describe("Defaults to 50"),
    },
    async ({ projectId, page, limit }) => {
      const qs = new URLSearchParams();
      if (page) qs.set("page", String(page));
      if (limit) qs.set("limit", String(limit));
      const suffix = qs.toString() ? `?${qs}` : "";
      return ok(
        await getApi().request("GET", `/projects/${projectId}/boards${suffix}`),
      );
    },
  );

  tool(
    "create_project",
    "Create a project (a business process container). Boards with data live inside projects.",
    {
      name: z.string().describe("Human-readable name"),
      description: z.string().optional().describe("Free-text description"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ name, description, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      const project = await getApi().request<any>(
        "POST",
        `/organizations/${orgId}/projects`,
        {
          name,
          organizationId: orgId,
          ...(description ? { description } : {}),
        },
      );
      return ok({
        project,
        adminUrl: getApi().appUrl(`/projects/${project.id}`),
      });
    },
  );

  tool(
    "create_board",
    'Create a board (a data table) inside a project. Add typed columns with create_column afterwards. kind: "tasks" (default) also gives the board the built-in task columns, status, priority, assignee, due date, tags, for work people track; "data" creates a plain table with only the columns you add, for records such as customers, products or orders (requires a TaskLite server from 2026-09-06; older servers ignore kind).',
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      name: z.string().describe("Human-readable name"),
      description: z.string().optional().describe("Free-text description"),
      kind: z
        .enum(["tasks", "data"])
        .optional()
        .describe(
          '"tasks": with the built-in task columns (status, priority, assignee, due date, tags). "data": only the columns you add. Default tasks.',
        ),
    },
    async ({ projectId, name, description, kind }) => {
      const board = await getApi().request<any>(
        "POST",
        `/projects/${projectId}/boards`,
        {
          name,
          projectId,
          ...(description ? { description } : {}),
          ...(kind ? { kind } : {}),
        },
      );
      return ok({
        board,
        adminUrl: getApi().appUrl(`/projects/${projectId}/boards/${board.id}`),
      });
    },
  );

  tool(
    "create_column",
    "Add a typed column to a board. Valid types: text, rich_text, number, status, date, datetime, duration, people, checkbox, dropdown, label, priority, link, email, phone, relation, lookup, rollup, formula, rating, currency, file. Choose by meaning, date for dates, phone for phones, number/currency for amounts, dropdown/status (with settings.options as an array of labels) for closed choices; text is for free text only. An obvious name/type mismatch is rejected with the suggested type; pass force:true to override. Rules go in settings.validation: { unique, min, max, minLength, maxLength, pattern, patternMessage }, enforced on every write (UI, MCP, App API). Closed choices (dropdown/status) reject values outside settings.options unless settings.allowCustom is true.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      name: z.string().describe("Human-readable name"),
      type: z
        .string()
        .describe(
          "Action type: http_request, send_notification, send_email, send_whatsapp, change_status, set_column_value, create_cross_board_item, send_webhook or delay",
        ),
      settings: z
        .record(z.any())
        .optional()
        .describe(
          'Type-specific settings. For dropdown/status/priority: options, either as labels ["A","B"] or as full objects [{value,label,color}], labels are expanded server-side, and colors are assigned if you do not supply them.',
        ),
      isRequired: z
        .boolean()
        .optional()
        .describe("Require a non-blank value on every App API create"),
      force: z
        .boolean()
        .optional()
        .describe(
          "Create the column even when the name suggests a different type",
        ),
    },
    async ({ projectId, boardId, name, type, settings, isRequired, force }) => {
      // The corrective loop: a model asking for text where the name announces
      // a date/phone/price gets the mismatch back as a tool result and fixes
      // itself on the very next call, instructions alone are advisory, this
      // is enforcement. (A real user built 110 rows with "Install Date" as
      // text; every calendar view and reminder was dead on arrival.)
      if (!force) {
        const objection = columnTypeObjection(name, type, settings);
        if (objection) return ok({ created: false, ...objection });
      }
      const column = await getApi().request<any>(
        "POST",
        `/projects/${projectId}/boards/${boardId}/columns`,
        {
          name,
          type,
          ...(settings ? { settings } : {}),
          ...(isRequired !== undefined ? { isRequired } : {}),
        },
      );
      return ok(column);
    },
  );

  tool(
    "get_board_schema",
    "Get a board with its full column schema (ids, names, types, settings). Call this before creating items with cells.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
    },
    async ({ projectId, boardId }) => {
      const [board, columns] = await Promise.all([
        getApi().request("GET", `/projects/${projectId}/boards/${boardId}`),
        getApi().request(
          "GET",
          `/projects/${projectId}/boards/${boardId}/columns`,
        ),
      ]);
      return ok({ board, columns });
    },
  );

  // ── Group B: data ──────────────────────────────────────────────────────────

  tool(
    "update_board",
    "Rename a board or change its description. Structure (columns) is changed with update_column / delete_column / reorder_columns.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      name: z.string().optional().describe("Human-readable name"),
      description: z.string().optional().describe("Free-text description"),
    },
    async ({ projectId, boardId, ...rest }) => {
      const body = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      );
      return ok(
        await getApi().request(
          "PATCH",
          `/projects/${projectId}/boards/${boardId}`,
          body,
        ),
      );
    },
  );

  tool(
    "delete_board",
    "Delete a board with every item on it. Destructive and not undoable, confirm with the user first, and prefer delete_column when only part of the model is wrong.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
    },
    async ({ projectId, boardId }) => {
      await getApi().request(
        "DELETE",
        `/projects/${projectId}/boards/${boardId}`,
      );
      return ok({ deleted: true, boardId });
    },
  );

  tool(
    "delete_project",
    "Delete a project with every board, column and row inside it. Destructive: confirm with the user first, and name the project in the confirmation. The project goes to the organization recycle bin, so it can be restored from the admin until it is emptied.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      projectId,
      organizationId,
    }: {
      projectId: string;
      organizationId?: string;
    }) => {
      const orgId = await resolveOrg(organizationId);
      await getApi().request(
        "DELETE",
        `/organizations/${orgId}/projects/${projectId}`,
      );
      return ok({
        deleted: true,
        projectId,
        note: "In the recycle bin. An organization admin can restore it, or empty the bin to remove it for good.",
      });
    },
  );

  tool(
    "update_column",
    "Change a column after the fact: rename it, change its type (e.g. number -> currency), replace settings (dropdown options), or set isRequired / isHidden. A type change converts existing values (number↔currency, text→number/date/checkbox, anything→text) and clears the ones that cannot convert; the response carries conversion: { converted, cleared }. settings.validation rules apply here too.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      columnId: z.string().describe("Column id (from get_board_schema)"),
      name: z.string().optional().describe("Human-readable name"),
      type: z
        .string()
        .optional()
        .describe("New column type (same list as create_column)"),
      settings: z
        .record(z.unknown())
        .optional()
        .describe(
          "Replaces the column settings, e.g. { options: [...] } for dropdown/status",
        ),
      isRequired: z
        .boolean()
        .optional()
        .describe("Require a non-blank value on every App API create"),
      isHidden: z
        .boolean()
        .optional()
        .describe("Hide the column in the TaskLite UI"),
      description: z.string().optional().describe("Free-text description"),
      force: z.boolean().optional().describe("Skip the name/type sanity check"),
    },
    async ({ projectId, boardId, columnId, force, ...rest }) => {
      const body = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      );
      if (!force && (body.type || body.name)) {
        // Sanity-check the resulting name/type pair the same way create_column does.
        const cols = await getApi().request<any>(
          "GET",
          `/projects/${projectId}/boards/${boardId}/columns`,
        );
        const list: any[] = Array.isArray(cols)
          ? cols
          : (cols?.items ?? cols?.data ?? []);
        const current = list.find((c) => c.id === columnId);
        const name = (body.name as string | undefined) ?? current?.name;
        const type = (body.type as string | undefined) ?? current?.type;
        if (name && type) {
          const hint = columnTypeObjection(
            name,
            type,
            body.settings ?? current?.settings,
          );
          if (hint) return ok(hint);
        }
      }
      return ok(
        await getApi().request(
          "PATCH",
          `/projects/${projectId}/boards/${boardId}/columns/${columnId}`,
          body,
        ),
      );
    },
  );

  tool(
    "delete_column",
    "Delete a column and every value stored in it. Destructive, confirm with the user first. Use update_column when the column is right but its name, type or options are wrong.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      columnId: z.string().describe("Column id (from get_board_schema)"),
    },
    async ({ projectId, boardId, columnId }) => {
      await getApi().request(
        "DELETE",
        `/projects/${projectId}/boards/${boardId}/columns/${columnId}`,
      );
      return ok({ deleted: true, columnId });
    },
  );

  tool(
    "reorder_columns",
    "Set the display order of a board's columns. Pass every column id in the wanted order (get_board_schema lists them).",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      columnIds: z
        .array(z.string())
        .min(1)
        .describe("Column ids in the new order (every column of the board)"),
    },
    async ({ projectId, boardId, columnIds }) => {
      return ok(
        await getApi().request(
          "PUT",
          `/projects/${projectId}/boards/${boardId}/columns/reorder`,
          { columnIds },
        ),
      );
    },
  );

  tool(
    "export_project",
    "The whole project as JSON, boards, columns with settings, items with their cells keyed by column id. For migrations, backups and reading a system back. Items are capped per board for the model's sake; the REST endpoint GET /organizations/{orgId}/projects/{projectId}/export.json returns everything.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      organizationId: z
        .string()
        .optional()
        .describe("Defaults to the credential organization"),
      maxItemsPerBoard: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe("Default 200"),
    },
    async ({ projectId, organizationId, maxItemsPerBoard }) => {
      const orgId = await resolveOrg(organizationId);
      const data = await getApi().request<any>(
        "GET",
        `/organizations/${orgId}/projects/${projectId}/export.json`,
      );
      const cap = maxItemsPerBoard ?? 200;
      let truncated = false;
      for (const b of data?.boards ?? []) {
        if (Array.isArray(b.items) && b.items.length > cap) {
          b.items = b.items.slice(0, cap);
          b.truncated = true;
          truncated = true;
        }
      }
      return ok({
        ...data,
        ...(truncated
          ? {
              note: `Some boards were cut to ${cap} items; the REST endpoint returns them all.`,
            }
          : {}),
      });
    },
  );

  tool(
    "query_items",
    "List items (rows) of a board, including their cell values. Returns all items unless limit/page are given (the API defaults to 50 per page when unpaged, so the tool pages through and concatenates). Narrow the result with search, status, priority and sort instead of fetching everything. This is the admin view; the REST endpoints of a published app take a fuller grammar, filter[column][gte], relation filters, per-field search, see get_app_spec.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      search: z
        .string()
        .optional()
        .describe("Free text; matches the row title and its text cells"),
      status: z
        .string()
        .optional()
        .describe(
          'Only rows whose status is one of these, comma separated. Matched against the board\'s status column by option value or label, case-insensitive: "todo,in_progress" on a task board, "Received,In Repair" on a data board whose status column lists those (get_board_schema shows the options)',
        ),
      excludeStatus: z
        .string()
        .optional()
        .describe(
          'Only rows whose status is NOT one of these, comma separated, resolved like status. The way to ask for everything that is not done: excludeStatus "done" (task board) or "Completed" (a data board with that option). Rows with no status at all are kept',
        ),
      priority: z
        .string()
        .optional()
        .describe(
          "Only rows with one of these priorities, comma separated (task boards only)",
        ),
      sort: z
        .string()
        .optional()
        .describe(
          'Sort by title, createdAt, updatedAt or status; prefix with "-" for descending, e.g. "-createdAt" for newest first. Anything else keeps the board order',
        ),
      archived: z
        .enum(["active", "archived", "all"])
        .optional()
        .describe("Which rows to include. Default active"),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Page size; omit to fetch all items"),
      page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based page, only with limit"),
    },
    async ({
      projectId,
      boardId,
      search,
      status,
      excludeStatus,
      priority,
      sort,
      archived,
      limit,
      page,
    }: {
      projectId: string;
      boardId: string;
      search?: string;
      status?: string;
      excludeStatus?: string;
      priority?: string;
      sort?: string;
      archived?: string;
      limit?: number;
      page?: number;
    }) => {
      const base = `/projects/${projectId}/boards/${boardId}/items`;
      const filters = new URLSearchParams();
      if (search) filters.set("search", search);
      if (status) filters.set("status", status);
      if (excludeStatus) filters.set("excludeStatus", excludeStatus);
      if (priority) filters.set("priority", priority);
      if (archived) filters.set("archiveFilter", archived);
      if (sort) {
        const desc = sort.startsWith("-");
        filters.set("sortField", desc ? sort.slice(1) : sort);
        filters.set("sortDirection", desc ? "DESC" : "ASC");
      }
      const extra = filters.toString();
      // A row of a data board is a record, not a task: the App API already
      // omits the built-in task fields for those boards, and this tool now
      // matches it instead of returning status, priority and the rest of the
      // task machinery on a customer or an invoice.
      let plain = false;
      try {
        const board = await getApi().request<any>(
          "GET",
          `/projects/${projectId}/boards/${boardId}`,
        );
        plain = board?.metadata?.kind === "data";
      } catch {
        // Cannot read the board: return the rows unchanged rather than fail.
      }
      const TASK_FIELDS = [
        "status",
        "priority",
        "dueDate",
        "startDate",
        "assignedTo",
        "tags",
        "isCompleted",
        "completedAt",
        "subtaskProgress",
        "isTimerActive",
        "timerStartedAt",
        "totalTimeSpent",
        "isRecurring",
        "recurrencePattern",
        "recurrenceEndDate",
        "parentId",
        "aiGenerated",
        "livingTaskStatus",
        "estimatedHours",
        "actualHours",
      ] as const;
      const strip = (row: unknown): unknown => {
        if (!plain || !row || typeof row !== "object") return row;
        const out = { ...(row as Record<string, unknown>) };
        for (const f of TASK_FIELDS) delete out[f];
        return out;
      };
      const stripAll = (res: unknown): unknown => {
        if (!plain) return res;
        if (Array.isArray(res)) return res.map(strip);
        const o = res as { items?: unknown[]; data?: unknown[] } | null;
        if (o && Array.isArray(o.items))
          return { ...o, items: o.items.map(strip) };
        if (o && Array.isArray(o.data))
          return { ...o, data: o.data.map(strip) };
        return res;
      };
      if (limit) {
        const qs = new URLSearchParams({ limit: String(limit) });
        if (page) qs.set("page", String(page));
        const url = `${base}?${qs.toString()}${extra ? `&${extra}` : ""}`;
        return ok(stripAll(await getApi().request("GET", url)));
      }
      // No explicit paging: fetch everything in 200-item pages and concatenate.
      const all: unknown[] = [];
      for (let p = 1; p <= 50; p++) {
        const res = await getApi().request(
          "GET",
          `${base}?limit=200&page=${p}${extra ? `&${extra}` : ""}`,
        );
        const batch = Array.isArray(res)
          ? res
          : ((res as { items?: unknown[]; data?: unknown[] })?.items ??
            (res as { data?: unknown[] })?.data ??
            []);
        all.push(...batch);
        if (batch.length < 200) break;
      }
      return ok(plain ? all.map(strip) : all);
    },
  );

  tool(
    "create_item",
    "Create an item (row) with all of its data in one call. cells maps columnId -> value (use get_board_schema for column ids); every cell is saved with the row. Use set_cell only for later edits.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      title: z.string().describe("Item title, shown as the row name"),
      description: z.string().optional().describe("Free-text description"),
      status: z
        .string()
        .optional()
        .describe(
          "Status value (todo, in_progress, done, or a value from the board's status options)",
        ),
      priority: z
        .string()
        .optional()
        .describe("Priority: low, medium, high or urgent"),
      dueDate: z.string().optional().describe("ISO date"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags as an array of strings"),
      cells: z
        .record(z.any())
        .optional()
        .describe(
          'Cell values keyed by column id: { "<columnId>": value }. Scalars, { amount, currency } for currency, { relatedItemIds: [...] } for relations',
        ),
    },
    async ({ projectId, boardId, ...body }) =>
      ok(
        await getApi().request(
          "POST",
          `/projects/${projectId}/boards/${boardId}/items`,
          body,
        ),
      ),
  );

  tool(
    "update_item",
    "Update item fields (title, description, status, priority, dueDate, tags).",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      itemId: z.string().describe("Item (row) id"),
      title: z
        .string()
        .optional()
        .describe("Item title, shown as the row name"),
      description: z.string().optional().describe("Free-text description"),
      status: z
        .string()
        .optional()
        .describe(
          "Status value (todo, in_progress, done, or a value from the board's status options)",
        ),
      priority: z
        .string()
        .optional()
        .describe("Priority: low, medium, high or urgent"),
      dueDate: z
        .string()
        .optional()
        .describe("Due date, ISO 8601 (YYYY-MM-DD or full timestamp)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags as an array of strings"),
    },
    async ({ projectId, boardId, itemId, ...body }) =>
      ok(
        await getApi().request(
          "PATCH",
          `/projects/${projectId}/boards/${boardId}/items/${itemId}`,
          body,
        ),
      ),
  );

  tool(
    "set_cell",
    "Set a single cell value on an item by columnId.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      itemId: z.string().describe("Item (row) id"),
      columnId: z.string().describe("Column id (from get_board_schema)"),
      value: z
        .union([
          z.string(),
          z.number(),
          z.boolean(),
          z.null(),
          z.array(z.unknown()),
          z.record(z.unknown()),
        ])
        .describe("The new cell value; shape depends on the column type"),
    },
    async ({ projectId, boardId, itemId, columnId, value }) =>
      ok(
        await getApi().request(
          "PUT",
          `/projects/${projectId}/boards/${boardId}/items/${itemId}/cells/by-column/${columnId}`,
          { value },
        ),
      ),
  );

  tool(
    "delete_item",
    "Delete an item. Destructive, confirm with the user before calling.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      itemId: z.string().describe("Item id (from query_items / create_item)"),
    },
    async ({ projectId, boardId, itemId }) =>
      ok(
        await getApi().request(
          "DELETE",
          `/projects/${projectId}/boards/${boardId}/items/${itemId}`,
        ),
      ),
  );

  // ── Group B2: comments (the item's correspondence thread) ──────────────────

  tool(
    "list_comments",
    "List the comments (the correspondence thread) on an item, oldest first. Each comment includes its author and any @mentions. Needs projectId and itemId (get itemId from query_items).",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      itemId: z.string().describe("Item (row) id"),
      page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based page, default 1"),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Page size, default 20"),
    },
    async ({ projectId, itemId, page, limit }) => {
      const qs = new URLSearchParams();
      if (page) qs.set("page", String(page));
      if (limit) qs.set("limit", String(limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return ok(
        await getApi().request(
          "GET",
          `/projects/${projectId}/items/${itemId}/comments${suffix}`,
        ),
      );
    },
  );

  tool(
    "add_comment",
    "Post a comment on an item's thread. To notify people, pass their user ids in mentionedUserIds (each also appears as an @mention). attachmentIds references already-uploaded files. Needs projectId and itemId.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      itemId: z.string().describe("Item (row) id"),
      content: z.string().describe("The comment text"),
      mentionedUserIds: z
        .array(z.string())
        .optional()
        .describe("User ids to @mention and notify"),
      attachmentIds: z
        .array(z.string())
        .optional()
        .describe("Ids of already-uploaded attachments to link"),
    },
    async ({ projectId, itemId, content, mentionedUserIds, attachmentIds }) =>
      ok(
        await getApi().request(
          "POST",
          `/projects/${projectId}/items/${itemId}/comments`,
          {
            content,
            ...(mentionedUserIds ? { mentionedUserIds } : {}),
            ...(attachmentIds ? { attachmentIds } : {}),
          },
        ),
      ),
  );

  tool(
    "update_comment",
    "Edit the text of an existing comment. Only the author can edit their comment. Needs projectId, itemId and the commentId.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      itemId: z.string().describe("Item (row) id"),
      commentId: z.string().describe("Comment id (from list_comments)"),
      content: z.string().describe("The new comment text"),
    },
    async ({ projectId, itemId, commentId, content }) =>
      ok(
        await getApi().request(
          "PATCH",
          `/projects/${projectId}/items/${itemId}/comments/${commentId}`,
          { content },
        ),
      ),
  );

  tool(
    "delete_comment",
    "Delete a comment from an item thread. Destructive, confirm with the user before calling. Needs projectId, itemId and the commentId.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      itemId: z.string().describe("Item id (from query_items / create_item)"),
      commentId: z
        .string()
        .describe("Comment id (from list_comments / add_comment)"),
    },
    async ({ projectId, itemId, commentId }) =>
      ok(
        await getApi().request(
          "DELETE",
          `/projects/${projectId}/items/${itemId}/comments/${commentId}`,
        ),
      ),
  );

  tool(
    "request_file_upload",
    'Create a link that puts files onto an item from outside TaskLite: the customer\'s photos, a signed contract, a logo, a build zip. Returns an address like https://app.tasklite.net/upload/<token> that anyone you hand it to can use with no account, no login and no API key; pass clientEmail and TaskLite emails the link for you. What arrives lands as attachments on that item, and list_uploaded_files reads them back with a download URL. This is the answer when the person has the file and the model does not: a hosted client cannot read a folder on someone\'s machine. The link is public for as long as it lasts, so keep expiryDays short and maxFiles tight, and revoke_upload_link when the material is in.',
    {
      itemId: z
        .string()
        .describe(
          "Item (row) the files belong to, from query_items / create_item. Make the row first if the material has no home yet",
        ),
      clientName: z
        .string()
        .optional()
        .describe("Who is being asked, shown on the upload page"),
      clientEmail: z
        .string()
        .email()
        .optional()
        .describe(
          "Send the link to this address. Omit to get the link back and pass it on yourself",
        ),
      clientPhone: z.string().optional().describe("Recorded with the request"),
      message: z
        .string()
        .optional()
        .describe(
          'What to upload, in the words the recipient will read: "the four room photos and the price list"',
        ),
      maxFiles: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("How many files the link accepts before it stops. Default 10"),
      expiryDays: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("How long the link lives. Default 7 days"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      itemId,
      clientName,
      clientEmail,
      clientPhone,
      message,
      maxFiles,
      expiryDays,
      organizationId,
    }: {
      itemId: string;
      clientName?: string;
      clientEmail?: string;
      clientPhone?: string;
      message?: string;
      maxFiles?: number;
      expiryDays?: number;
      organizationId?: string;
    }) => {
      const orgId = await resolveOrg(organizationId);
      const body = {
        itemId,
        ...(clientName ? { clientName } : {}),
        ...(clientEmail ? { clientEmail } : {}),
        ...(clientPhone ? { clientPhone } : {}),
        ...(message ? { message } : {}),
        ...(maxFiles ? { maxFiles } : {}),
        ...(expiryDays ? { expiryDays } : {}),
      };
      // With an address the server sends the invitation itself; without one it
      // only mints the link and handing it over is the caller's business.
      const path = clientEmail
        ? `/api/client-uploads/request-material?organizationId=${orgId}`
        : `/api/client-uploads/tokens?organizationId=${orgId}`;
      const created = await getApi().request<{
        id: string;
        token: string;
        expiresAt: string;
        maxFiles: number;
      }>("POST", path, body);
      return ok({
        uploadUrl: getApi().appUrl(`/upload/${created.token}`),
        tokenId: created.id,
        expiresAt: created.expiresAt,
        maxFiles: created.maxFiles,
        emailed: clientEmail ?? null,
        note: clientEmail
          ? "The link was emailed. Anyone holding it can upload until it expires; revoke_upload_link ends it early."
          : "Hand this link to the person with the files. Anyone holding it can upload until it expires; revoke_upload_link ends it early.",
      });
    },
  );

  tool(
    "list_uploaded_files",
    "The files attached to an item, including everything that came in through a request_file_upload link, each with a download URL that is signed and short lived (mint a fresh one by calling again). Also lists the upload links on the item and how many files each has taken, which is how to tell whether the person you asked has delivered.",
    {
      itemId: z.string().describe("Item (row) id"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      itemId,
      organizationId,
    }: {
      itemId: string;
      organizationId?: string;
    }) => {
      const orgId = await resolveOrg(organizationId);
      const files = await getApi().request<
        Array<{
          id: string;
          fileName: string;
          fileSize: number;
          mimeType: string;
          createdAt: string;
          metadata?: Record<string, unknown>;
        }>
      >(
        "GET",
        `/api/attachments?entityType=item&entityId=${itemId}&organizationId=${orgId}`,
      );
      const links = await getApi()
        .request<unknown>(
          "GET",
          `/api/client-uploads/tokens/item/${itemId}?organizationId=${orgId}`,
        )
        .catch(() => null);
      // One signing call per file, capped: a board's worth of URLs that nobody
      // opens is wasted work, and they expire before a long list is read.
      const SIGN_AT_MOST = 20;
      const list = Array.isArray(files) ? files : [];
      const withUrls = await Promise.all(
        list.slice(0, SIGN_AT_MOST).map(async (f) => {
          const signed = await getApi()
            .request<{ url: string }>(
              "GET",
              `/api/attachments/${f.id}/download-url?organizationId=${orgId}`,
            )
            .catch(() => null);
          return { ...f, downloadUrl: signed?.url ?? null };
        }),
      );
      return ok({
        files: [...withUrls, ...list.slice(SIGN_AT_MOST)],
        uploadLinks: links,
        ...(list.length > SIGN_AT_MOST
          ? {
              note: `Download URLs were minted for the first ${SIGN_AT_MOST} files; call again for the rest.`,
            }
          : {}),
      });
    },
  );

  tool(
    "revoke_upload_link",
    "Close an upload link before it expires, so the address stops accepting files. The files already uploaded stay on the item. Use it as soon as the material is in, because until then anyone holding the link can add more.",
    {
      tokenId: z
        .string()
        .describe("Link id (the tokenId from request_file_upload)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      tokenId,
      organizationId,
    }: {
      tokenId: string;
      organizationId?: string;
    }) => {
      const orgId = await resolveOrg(organizationId);
      await getApi().request(
        "DELETE",
        `/api/client-uploads/tokens/${tokenId}?organizationId=${orgId}`,
      );
      return ok({ revoked: true, tokenId });
    },
  );

  // ── Group C: app layer (the backend of an external frontend) ───────────────

  tool(
    "create_app",
    "Create an app, a named API surface over the boards of a project, for an external frontend. Then add endpoints and an API key.",
    {
      name: z.string().describe("Human-readable name"),
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ name, projectId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      const app = await getApi().request<any>(
        "POST",
        `/organizations/${orgId}/apps`,
        {
          name,
          projectId,
        },
      );
      return ok({ app, adminUrl: getApi().appUrl(`/apps/${app.id}`) });
    },
  );

  tool(
    "push_status",
    "Whether an app can send push notifications to phones, and how many devices are registered. Push goes out through the customer's OWN Firebase project, so it has to be configured once per app before send_push automations do anything. This tool never returns the key.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      appId,
      organizationId,
    }: {
      appId: string;
      organizationId?: string;
    }) => {
      const orgId = await resolveOrg(organizationId);
      const status = await getApi().request<any>(
        "GET",
        `/organizations/${orgId}/apps/${appId}/push`,
      );
      return ok({
        ...status,
        ...(status?.configured
          ? {}
          : {
              howToConfigure:
                "Push is not set up for this app. It needs the customer's own Firebase service account, which is a private key: it must NOT be pasted into a chat. Tell them to download it from Firebase console -> Project settings -> Service accounts -> Generate new private key, and POST the file to /organizations/" +
                orgId +
                "/apps/" +
                appId +
                '/push/credentials as { "serviceAccount": <the JSON> }.',
            }),
        ...(status?.configured && !status?.devices
          ? {
              note: "Configured, but no device has registered yet. The app must POST its FCM token to /apps/<slug>/api/devices after the user signs in.",
            }
          : {}),
      });
    },
  );

  tool(
    "send_test_push",
    "Send one real push notification to the given app users, to prove the chain works before an automation depends on it. Confirm with the user first: this reaches actual phones.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      userIds: z
        .array(z.string())
        .describe(
          "App user ids to notify (the same ids row-level security uses)",
        ),
      title: z
        .string()
        .optional()
        .describe('Notification title; defaults to "TaskLite"'),
      body: z.string().optional().describe("Notification body"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      appId,
      userIds,
      title,
      body,
      organizationId,
    }: {
      appId: string;
      userIds: string[];
      title?: string;
      body?: string;
      organizationId?: string;
    }) => {
      const orgId = await resolveOrg(organizationId);
      const res = await getApi().request<any>(
        "POST",
        `/organizations/${orgId}/apps/${appId}/push/test`,
        {
          userIds,
          title,
          body,
        },
      );
      return ok({
        ...res,
        reading:
          "sent = notifications handed to Google. unreachable = users with no registered device, which means the app has not sent its token yet. removedTokens = devices the service says no longer exist; those are deleted.",
      });
    },
  );

  tool(
    "publish_app",
    "Publish an app, required before its API endpoints accept external calls.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "POST",
          `/organizations/${orgId}/apps/${appId}/publish`,
          {},
        ),
      );
    },
  );

  tool(
    "create_app_endpoint",
    "Expose a board as a REST endpoint of an app: /apps/{appSlug}/api/{slug}. exposedColumns limits which columns are readable/writable. rowLevelSecurity.enabled makes the endpoint per-user: the developer's server sends `X-App-User: <their user id>` next to the API key, and the endpoint returns, updates and deletes ONLY that user's rows (401 without the header). Use it whenever the app has its own users. rowLevelSecurity.mode chooses which rows a user reaches: owner (the rows they created), shared (all rows, for authorized users), phone (the rows that carry their verified phone) or relation (the rows linked through a relation column to the row that stands for them). An app with two kinds of people in one organization, coaches and their trainees, is built from these: the Coaches board in mode phone (phoneColumn = its phone column), so each coach reads and edits his own row; Trainees in mode relation with relationColumn = its Coach column and identityPhoneColumn = the Coaches phone column, so a coach who signed in by phone sees only his trainees; boards one hop further (weigh-ins of a trainee) in mode relation with relationColumn = the Trainee column and viaColumn = Trainees.Coach for the coach, plus a second endpoint on the same board without viaColumn for the trainee herself. A trainee becomes her row through an invite code (create_app_invite, or allowInvites so the coach mints it in the app) or link_app_user.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      slug: z
        .string()
        .describe("URL slug: lowercase letters, digits and dashes"),
      name: z.string().describe("Human-readable name"),
      allowedMethods: z
        .array(z.enum(["GET", "POST", "PATCH", "DELETE"]))
        .optional()
        .describe(
          "HTTP methods the endpoint accepts: GET, POST, PATCH, DELETE",
        ),
      exposedColumns: z
        .array(
          z.object({
            columnId: z.string().describe("Column id (from get_board_schema)"),
            alias: z
              .string()
              .optional()
              .describe(
                "JSON key exposed for this column: letters, digits, underscore. Never one of the reserved item fields id, title, description, status, priority, dueDate, assignedTo, createdAt, updatedAt, order, appUserId, a business status column becomes repairStatus or orderStatus, not status.",
              ),
            readOnly: z
              .boolean()
              .optional()
              .describe(
                "Expose the column for reading only; writes to it are refused with 400",
              ),
          }),
        )
        .optional()
        .describe(
          "Columns the endpoint reads and writes, with the JSON key each one gets; without it the endpoint returns bare metadata",
        ),
      rowLevelSecurity: RLS_SCHEMA.optional().describe(
        "Row-level security. Off: whoever holds the app key reads everything. On: every request must name a signed-in user, and mode decides which rows they reach. Only the keys listed here exist; an unknown key is refused, not ignored",
      ),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, organizationId, ...body }) => {
      // Without exposedColumns the endpoint answers reads with bare item
      // metadata and drops every field on write. It looks like it works, so
      // say so here rather than let it be discovered weeks later.
      if (!body.exposedColumns?.length) {
        return ok({
          error:
            "exposedColumns is required in practice: an endpoint without it returns only id/title/status on GET and stores nothing on POST/PATCH. Call get_board_schema for the board and pass its column ids.",
        });
      }
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "POST",
          `/organizations/${orgId}/apps/${appId}/endpoints`,
          body,
        ),
      );
    },
  );

  tool(
    "list_app_endpoints",
    "List an app's REST endpoints, slug, board, allowed methods, and how many columns each exposes. An endpoint exposing 0 columns is broken: it returns only item metadata and silently discards writes.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "GET",
          `/organizations/${orgId}/apps/${appId}/endpoints`,
        ),
      );
    },
  );

  tool(
    "update_app_endpoint",
    "Change an existing endpoint, most often to set exposedColumns on one that was created without them. Get the endpoint id from list_app_endpoints and the column ids from get_board_schema.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      endpointId: z.string().describe("Endpoint id (from list_app_endpoints)"),
      slug: z
        .string()
        .optional()
        .describe("URL slug: lowercase letters, digits and dashes"),
      name: z.string().optional().describe("Human-readable name"),
      allowedMethods: z
        .array(z.enum(["GET", "POST", "PATCH", "DELETE"]))
        .optional()
        .describe(
          "HTTP methods the endpoint accepts: GET, POST, PATCH, DELETE",
        ),
      exposedColumns: z
        .array(
          z.object({
            columnId: z.string().describe("Column id (from get_board_schema)"),
            alias: z
              .string()
              .optional()
              .describe(
                "JSON key exposed for this column: letters, digits, underscore. Never one of the reserved item fields id, title, description, status, priority, dueDate, assignedTo, createdAt, updatedAt, order, appUserId, a business status column becomes repairStatus or orderStatus, not status.",
              ),
            readOnly: z
              .boolean()
              .optional()
              .describe(
                "Expose the column for reading only; writes to it are refused with 400",
              ),
          }),
        )
        .optional()
        .describe(
          "Replacement list of exposed columns (same shape as create_app_endpoint)",
        ),
      rowLevelSecurity: RLS_SCHEMA.nullable()
        .optional()
        .describe(
          "Replacement row-level security (same shape as create_app_endpoint); null turns it off. The object replaces the stored one whole, it is not merged: to change one field, read the current value with list_app_endpoints and send every field again (enabled, mode and the columns of that mode), or the ones left out are lost",
        ),
      isActive: z.boolean().optional().describe("Whether it is active"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, endpointId, organizationId, ...body }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "PATCH",
          `/organizations/${orgId}/apps/${appId}/endpoints/${endpointId}`,
          body,
        ),
      );
    },
  );

  tool(
    "delete_app_endpoint",
    "Delete an endpoint of an app for good: /apps/{appSlug}/api/{slug} stops answering at once and the endpoint cannot be brought back (create it again with create_app_endpoint). The board and its rows are not touched. Confirm with the user first: a frontend that calls this endpoint breaks. To take an endpoint offline and keep its definition, use update_app_endpoint with isActive false instead (list_app_endpoints shows active endpoints only, so keep the id). Get the endpoint id from list_app_endpoints.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      endpointId: z.string().describe("Endpoint id (from list_app_endpoints)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, endpointId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      await getApi().request(
        "DELETE",
        `/organizations/${orgId}/apps/${appId}/endpoints/${endpointId}`,
      );
      return ok({ deleted: true, endpointId });
    },
  );

  // ── App settings ───────────────────────────────────────────────────────────

  tool(
    "configure_app_settings",
    'Read or change the settings object of an app. Call with only appId to read. To change, pass set: the keys in it are MERGED into the current settings (objects merge key by key at every depth, arrays and plain values replace, null removes a key). The server itself does not merge: PATCH replaces the whole settings object with what it is sent, so this tool reads the app, merges, and writes the full object back; two writers at the same moment can still overwrite each other, so do not run it in parallel on one app. Settings the server reads: passwordReset.returnUrls (array of up to 50 URLs the "reset password" email may send a user back to, matched by scheme, host, port and path prefix; needed only for a custom app scheme such as myapp://reset or a domain other than the app\'s own {slug}.tasklite.dev and its connected custom domains, which are always allowed; http is never accepted), language (the language of the password reset email: a value starting with "he" gives Hebrew, any other value English; left out, the user\'s own language decides), endUserDeletion.rows ("delete": when an end user deletes their account, the rows they wrote in this app are deleted with it and erased for good 30 days later; left out, the rows stay with the author shown as a deleted account). Other keys are stored as given and returned, and the server does not act on them.',
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      set: z
        .record(z.any())
        .optional()
        .describe(
          'Keys to merge into the settings, e.g. { passwordReset: { returnUrls: ["myapp://reset"] } } or { endUserDeletion: { rows: "delete" } }. null removes a key: { language: null }. Omit to read without changing anything',
        ),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      appId,
      set,
      organizationId,
    }: {
      appId: string;
      set?: Record<string, unknown>;
      organizationId?: string;
    }) => {
      const orgId = await resolveOrg(organizationId);
      const app = await getApi().request<any>(
        "GET",
        `/organizations/${orgId}/apps/${appId}`,
      );
      const current: Record<string, unknown> =
        app && typeof app.settings === "object" && app.settings !== null
          ? app.settings
          : {};
      if (!set || Object.keys(set).length === 0) {
        return ok({ appId: app?.id ?? appId, settings: current, changed: false });
      }
      const merged = mergeSettings(current, set);
      const updated = await getApi().request<any>(
        "PATCH",
        `/organizations/${orgId}/apps/${appId}`,
        { settings: merged },
      );
      return ok({
        appId: updated?.id ?? app?.id ?? appId,
        settings: updated?.settings ?? merged,
        changed: true,
        previous: current,
      });
    },
  );

  // ── App users, invite codes and user-to-row links ─────────────────────────
  // What row-level security mode "relation" reads: a user "is" a row either
  // by a link (made by an invite code or by link_app_user) or by a verified
  // phone or email written in the row (identityPhoneColumn/identityEmailColumn).

  tool(
    "list_app_users",
    "List the end users of an app: everyone who ever called it with X-App-User or signed in to it with a code. Each has userId (the id link_app_user, list_app_user_links and send_test_push take), externalId (the developer's own id for them, or null for a user who signed in by code), name, source (api or otp), role (viewer, editor or submitter; editor when never set), isActive, lastSeenAt and itemCount (rows they own on the app's boards). Use it to find the userId of the person to link to a row.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "GET",
          `/organizations/${orgId}/apps/${appId}/users`,
        ),
      );
    },
  );

  tool(
    "create_app_invite",
    'Create an invite code for an app (8 characters shown as XXXX-XXXX, typed without regard to case or the dash). The person signs up or signs in through the app with the code: the app sends it as inviteCode with POST /auth/otp/verify, /auth/register-external or /auth/google-external, after it may check it with POST /auth/invites/check. An invite does one or both of two things, and must do at least one: itemId links the new user to that row, so they "are" the row for every endpoint in row-level security mode "relation" (invite a trainee to her own Trainees row, or a coach to his Coaches row); role puts them on the app\'s access list (viewer, editor or submitter), which is what mode "shared" endpoints check. A valid code also admits a new person into an organization whose registration policy is "invite" or "closed" (configure_external_access). An existing access row is never changed by an invite: it does not re-enable a user who was switched off and does not raise a role. Requires organization owner or admin (an editor gets 403). To let the app\'s own users invite (a coach invites his trainees from inside the app), set allowInvites on the relation endpoint instead; the app then calls POST /apps/{appSlug}/api/{endpointSlug}/{itemId}/invites.',
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      itemId: z
        .string()
        .optional()
        .describe(
          "Id of the row the new user becomes (from query_items); any live row in the app's organization. Required unless role is given",
        ),
      role: z
        .enum(["viewer", "editor", "submitter"])
        .optional()
        .describe(
          "App-level access role granted on sign-up: viewer (reads), submitter (creates), editor (reads and writes). Omit to grant no access row. Required unless itemId is given",
        ),
      maxUses: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe(
          "How many people may use the code, 1 to 1000; defaults to 1 (one person)",
        ),
      expiresInDays: z
        .number()
        .min(1)
        .max(365)
        .optional()
        .describe("Days until the code stops working, 1 to 365; defaults to 30"),
      label: z
        .string()
        .max(120)
        .optional()
        .describe(
          'Shown to whoever checks the code before signing up, e.g. "Dana, trainee of coach Avi"; up to 120 characters. Do not put anything private in it: the check is public',
        ),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      appId,
      itemId,
      role,
      maxUses,
      expiresInDays,
      label,
      organizationId,
    }: {
      appId: string;
      itemId?: string;
      role?: string;
      maxUses?: number;
      expiresInDays?: number;
      label?: string;
      organizationId?: string;
    }) => {
      if (!itemId && !role) {
        return ok({
          error:
            "An invite has to do something: pass itemId (the row the new user becomes), role (viewer, editor or submitter), or both.",
        });
      }
      const orgId = await resolveOrg(organizationId);
      const body: Record<string, unknown> = {};
      if (itemId !== undefined) body.itemId = itemId;
      if (role !== undefined) body.role = role;
      if (maxUses !== undefined) body.maxUses = maxUses;
      if (expiresInDays !== undefined) body.expiresInDays = expiresInDays;
      if (label !== undefined) body.label = label;
      const invite = await getApi().request<any>(
        "POST",
        `/organizations/${orgId}/apps/${appId}/invites`,
        body,
      );
      return ok({
        invite,
        howToUse:
          'Give the code to the person. The app sends it as "inviteCode" in the body of POST /auth/otp/verify, /auth/register-external or /auth/google-external. POST /auth/invites/check { "code" } tells the app, without a token, whether it still works.',
      });
    },
  );

  tool(
    "list_app_invites",
    "List the invite codes of an app, newest first (the latest 200): the ones created with create_app_invite and the ones the app's own users minted through a relation endpoint with allowInvites (createdVia admin or app). Each carries id, code, itemId, role, label, maxUses, useCount, expiresAt, revokedAt and status: active, used (no uses left), expired or revoked.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "GET",
          `/organizations/${orgId}/apps/${appId}/invites`,
        ),
      );
    },
  );

  tool(
    "revoke_app_invite",
    "Revoke an invite code so nobody else can sign up with it. People who already used it stay linked to their row and keep their access; to cut one of them off use unlink_app_user. Cannot be undone, create a new invite instead. Requires organization owner or admin. Get the invite id (not the code) from list_app_invites.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      inviteId: z
        .string()
        .describe("Invite id, the id field from list_app_invites (a UUID, not the code)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, inviteId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "DELETE",
          `/organizations/${orgId}/apps/${appId}/invites/${inviteId}`,
        ),
      );
    },
  );

  tool(
    "check_invite_code",
    'Check whether an invite code works right now, the way an app does before sign-up (POST /auth/invites/check, the same public route, limited to 10 calls a minute per address). A working code answers { valid: true, organizationId, app: { name, slug }, label, expiresAt }; anything else (unknown, revoked, expired, used up, its row deleted, its app switched off or deleted) answers only { valid: false }, with no reason, by design. It does not use the code up. For the reason a code stopped working, read its status in list_app_invites.',
    {
      code: z
        .string()
        .describe('The invite code, e.g. "K7PM-4XQ2"; case and the dash do not matter'),
    },
    async ({ code }: { code: string }) =>
      ok(await getApi().request("POST", "/auth/invites/check", { code })),
  );

  tool(
    "link_app_user",
    'Link an existing user of an app to a row, so the user "is" that row for every endpoint in row-level security mode "relation": link a coach to his Coaches row and he reaches the trainees whose Coach column points at it. This is the manual form of what an invite code does at sign-up; use it for someone who already has an account (find the userId with list_app_users). A user may be linked to several rows, and linking the same pair again changes nothing. The user must already be a member of the app\'s organization (anyone who signed in to the app is) and the row must be a live row in that organization, otherwise 404. Requires organization owner or admin.',
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      userId: z
        .string()
        .describe("The user's id (userId from list_app_users), a UUID; not their externalId"),
      itemId: z
        .string()
        .describe("Id of the row that stands for this user (from query_items)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, userId, itemId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "POST",
          `/organizations/${orgId}/apps/${appId}/users/${userId}/links`,
          { itemId },
        ),
      );
    },
  );

  tool(
    "list_app_user_links",
    'List the rows one user of an app is linked to, oldest first: each link has itemId, source (invite or admin) and createdAt. These are the rows the user "is" under row-level security mode "relation". A user can also stand for a row with no link at all, through identityPhoneColumn or identityEmailColumn; those matches are computed on every request and do not appear here.',
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      userId: z
        .string()
        .describe("The user's id (userId from list_app_users), a UUID"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, userId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "GET",
          `/organizations/${orgId}/apps/${appId}/users/${userId}/links`,
        ),
      );
    },
  );

  tool(
    "unlink_app_user",
    "Remove the link between a user of an app and a row: the user stops being that row, and at once loses the rows of every relation endpoint they reached through it. The account, the row and the user's app access are not touched, and nothing is deleted. A user matched to the row by identityPhoneColumn or identityEmailColumn still reaches it; change the phone or email in the row to end that. Requires organization owner or admin. Removing a link that does not exist also answers success.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      userId: z
        .string()
        .describe("The user's id (userId from list_app_users), a UUID"),
      itemId: z
        .string()
        .describe("Id of the linked row (itemId from list_app_user_links)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, userId, itemId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "DELETE",
          `/organizations/${orgId}/apps/${appId}/users/${userId}/links/${itemId}`,
        ),
      );
    },
  );

  tool(
    "create_app_api_key",
    "Create an API key for an app. SECURITY: the key must live server-side only (env var, Next.js API routes), never in browser code. If the app has its own users, the server also sends `X-App-User: <user id>` with the key so per-user endpoints know who is acting.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      name: z.string().optional().describe("Human-readable name"),
      scopes: z
        .array(z.enum(["read", "write"]))
        .optional()
        .describe(
          'Permissions recorded on the key: ["read"] or ["read","write"]. Omit to match the app: write when any endpoint accepts POST, PATCH or DELETE.',
        ),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, name, scopes, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "POST",
          `/organizations/${orgId}/apps/${appId}/api-keys`,
          {
            name: name || "frontend",
            ...(scopes?.length ? { scopes } : {}),
          },
        ),
      );
    },
  );

  // ── One-call backend ───────────────────────────────────────────────────────
  // The model designs; this executes. Ten tool calls became one because every
  // one of them was a place for the user to see plumbing: organization ids,
  // reserved aliases, column ids, and ten verbose results (an external review
  // of the ChatGPT connector scored exactly those). Deterministic, no model
  // in here, the caller already is one.
  const RESERVED_ALIASES = new Set([
    "id",
    "title",
    "description",
    "status",
    "priority",
    "duedate",
    "assignedto",
    "createdat",
    "updatedat",
    "order",
    "appuserid",
  ]);
  const toAlias = (name: string, index: number, used: Set<string>): string => {
    let base = name
      .replace(/[^A-Za-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .map((w, i) =>
        i === 0
          ? w.charAt(0).toLowerCase() + w.slice(1)
          : w.charAt(0).toUpperCase() + w.slice(1),
      )
      .join("");
    if (!base || /^\d/.test(base)) base = `field${index + 1}`;
    if (RESERVED_ALIASES.has(base.toLowerCase())) base = `${base}Value`;
    let alias = base;
    let n = 2;
    while (used.has(alias.toLowerCase())) alias = `${base}${n++}`;
    used.add(alias.toLowerCase());
    return alias;
  };
  const toSlug = (name: string, index: number, used: Set<string>): string => {
    let base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!base) base = `board-${index + 1}`;
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
  };

  tool(
    "build_backend",
    'Build a whole backend in one call from a spec you compose: the project, its boards, their typed columns (including relations between the boards), optional sample rows, and optionally a published REST API with one endpoint per board and a server-side key. Use it whenever the user describes a system ("a backend for my repair shop: customers, orders, payments") instead of calling create_project, create_board, create_column, create_app, publish_app, create_app_endpoint and create_app_api_key one by one. You do the design, pick column types by meaning (phone, date, currency, dropdown/status with options for closed choices), link boards with a relation column (type "relation", relatedBoard: "<board name in this spec>", relationType: many_to_one for an order→customer link), and this tool executes it and returns one compact summary. API field names are derived from column names and never collide with reserved item fields, so there is nothing to retry. Boards are created as plain data tables (kind "data": only the columns you define, no task fields); set kind "tasks" on a board where people track work to do and want status, priority, assignee and due date built in. Every row still has a title. When the API has its own users, api.rowLevelSecurity: true gives every endpoint mode "owner"; a board may carry its own rowLevelSecurity instead (mode shared, phone or relation, with columns named as in this spec), e.g. Coaches { mode: "phone", phoneColumn: "Phone" } and Trainees { mode: "relation", relationColumn: "Coach", identityPhoneColumn: "Phone", allowInvites: true }.',
    {
      project: z
        .object({
          name: z.string().describe('Project name, e.g. "Bike Repair Shop"'),
          description: z
            .string()
            .optional()
            .describe("One line on what the system is for"),
        })
        .describe("The project that holds the boards"),
      boards: z
        .array(
          z.object({
            name: z
              .string()
              .describe('Board (table) name, e.g. "Repair Orders"'),
            description: z
              .string()
              .optional()
              .describe("One line on what a row is"),
            kind: z
              .enum(["tasks", "data"])
              .optional()
              .describe(
                '"data" (default here): a plain table with only the columns you define, right for customers, products, orders, payments. "tasks": also the built-in task columns (status, priority, assignee, due date, tags), only for boards where people track work to do.',
              ),
            columns: z
              .array(
                z.object({
                  name: z
                    .string()
                    .describe(
                      'Column name as the user would say it, e.g. "Customer", "Phone", "Repair Status"',
                    ),
                  type: z
                    .string()
                    .describe(
                      "text, rich_text, number, currency, date, datetime, phone, email, link, checkbox, dropdown, status, priority, rating, file, people, relation, label, duration",
                    ),
                  options: z
                    .array(z.string())
                    .optional()
                    .describe(
                      'The closed choices for dropdown/status/priority, e.g. ["Received","In Repair","Ready","Completed"]',
                    ),
                  required: z
                    .boolean()
                    .optional()
                    .describe("Reject API creates that leave it blank"),
                  validation: z
                    .record(z.any())
                    .optional()
                    .describe(
                      "{ unique, min, max, minLength, maxLength, pattern, patternMessage }",
                    ),
                  relatedBoard: z
                    .string()
                    .optional()
                    .describe(
                      'relation columns only: the name of another board in this spec that this column links to, e.g. "Customers"',
                    ),
                  relationType: z
                    .enum([
                      "many_to_one",
                      "one_to_many",
                      "many_to_many",
                      "one_to_one",
                    ])
                    .optional()
                    .describe(
                      "relation columns only. many_to_one: many rows here point at one row there (an order has one customer; a payment has one order). one_to_many: one row here owns many there. many_to_many: both sides several (a job has several tags). one_to_one: exactly one each way. Defaults to many_to_many, which is rarely what a business model means, say it.",
                    ),
                  settings: z
                    .record(z.any())
                    .optional()
                    .describe(
                      'Other type settings, e.g. { currency: "ILS" }. (relatedBoardName / relationType are also accepted here for compatibility.)',
                    ),
                  alias: z
                    .string()
                    .optional()
                    .describe(
                      "API field name to use instead of the derived one (letters, digits, underscore; not a reserved item field)",
                    ),
                }),
              )
              .min(1)
              .describe("Typed columns of the board"),
            rowLevelSecurity: BUILD_RLS_SCHEMA.optional().describe(
              'Row-level security of this board\'s endpoint, used only when "api" is given; overrides api.rowLevelSecurity for this board. Columns are given by NAME as written in this spec (the ids do not exist yet). Only the keys listed here exist; an unknown key is refused, not ignored',
            ),
            rows: z
              .array(z.record(z.any()))
              .optional()
              .describe(
                'Optional sample rows keyed by column name, e.g. [{ "Customer": "Sam Miller", "Phone": "052-555-0142", "Price": 80 }]. "title" sets the row title; without it the first plain text value is used, and failing that the row is named after its board and position. A row that other boards reference must carry a title (or a text value) so the reference can be resolved. A relation cell takes the title(s) of rows in the related board (any order in the spec; rows are created in dependency order).',
              ),
          }),
        )
        .min(1)
        .describe("The boards (tables) of the backend, in any order"),
      api: z
        .object({
          name: z
            .string()
            .optional()
            .describe('App name; defaults to "<project> API"'),
          methods: z
            .array(z.enum(["GET", "POST", "PATCH", "DELETE"]))
            .optional()
            .describe(
              "HTTP methods every endpoint accepts; defaults to all four",
            ),
          rowLevelSecurity: z
            .boolean()
            .optional()
            .describe(
              'true when the app has its own users and each may see only their rows (the caller then sends X-App-User): every endpoint gets mode "owner", except a board that carries its own rowLevelSecurity. For shared, phone or relation modes set rowLevelSecurity on the board itself',
            ),
        })
        .optional()
        .describe(
          "Include to publish a REST API over every board and mint a key; omit for a boards-only build",
        ),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; needed only when the account belongs to several (the error then lists them)",
        ),
    },
    async ({ project, boards, api, organizationId }) => {
      // Validate the whole spec before creating anything: a half-built project
      // after a spec error is worse than a clear refusal.
      const problems: string[] = [];
      const boardNames = new Set(
        boards.map((b: { name: string }) => b.name.toLowerCase()),
      );
      for (const b of boards) {
        for (const c of b.columns) {
          if (
            (c.type === "dropdown" ||
              c.type === "status" ||
              c.type === "priority") &&
            !c.options?.length &&
            !(c.settings as any)?.options
          ) {
            problems.push(`${b.name}.${c.name}: ${c.type} needs options`);
          }
          if (c.alias && RESERVED_ALIASES.has(c.alias.toLowerCase())) {
            problems.push(
              `${b.name}.${c.name}: alias "${c.alias}" is a reserved item field`,
            );
          }
          if (c.type === "relation") {
            const target = String(
              c.relatedBoard ?? (c.settings as any)?.relatedBoardName ?? "",
            ).toLowerCase();
            if (!target || !boardNames.has(target)) {
              problems.push(
                `${b.name}.${c.name}: relation needs relatedBoard naming a board in this spec (have: ${boards.map((x: { name: string }) => x.name).join(", ")})`,
              );
            }
          } else if (c.relatedBoard || c.relationType) {
            problems.push(
              `${b.name}.${c.name}: relatedBoard/relationType only apply to type "relation" (got ${c.type})`,
            );
          }
        }
      }
      // Sample rows that link to other boards: the referenced row must be in
      // the spec (its title, or its first text value). Checked here so a typo
      // is refused before anything is built rather than reported as a note.
      const specTitles = new Map<string, Set<string>>();
      // Rows with neither a title nor a plain text value: they are built
      // (their title becomes "Orders 3") but nothing can reference them, so
      // say that plainly instead of reporting a missing title elsewhere.
      const untitled = new Map<string, number>();
      for (const b of boards) {
        const titles = new Set<string>();
        for (const row of b.rows || []) {
          const cols = b.columns;
          let title = typeof row.title === "string" ? row.title : "";
          if (!title) {
            for (const [k, v] of Object.entries(row)) {
              const col = cols.find(
                (c: { name: string }) =>
                  c.name.toLowerCase() === k.toLowerCase(),
              );
              if (col && col.type !== "relation" && typeof v === "string") {
                title = v;
                break;
              }
            }
          }
          if (title) titles.add(title.toLowerCase());
          else
            untitled.set(
              b.name.toLowerCase(),
              (untitled.get(b.name.toLowerCase()) ?? 0) + 1,
            );
        }
        specTitles.set(b.name.toLowerCase(), titles);
      }
      for (const b of boards) {
        for (const row of b.rows || []) {
          for (const [k, v] of Object.entries(row)) {
            const col = b.columns.find(
              (c: { name: string }) => c.name.toLowerCase() === k.toLowerCase(),
            );
            if (!col) continue;
            if (
              (col.type === "dropdown" ||
                col.type === "status" ||
                col.type === "priority") &&
              col.options?.length &&
              typeof v === "string" &&
              !col.options.includes(v)
            ) {
              problems.push(
                `${b.name} row "${String(row.title ?? "")}": "${col.name}" = "${v}" is not one of its options (${col.options.join(", ")})`,
              );
              continue;
            }
            if (col.type !== "relation") continue;
            const rt = col.relationType ?? (col.settings as any)?.relationType;
            if (
              (rt === "many_to_one" || rt === "one_to_one") &&
              Array.isArray(v) &&
              v.length > 1
            ) {
              problems.push(
                `${b.name} row "${String(row.title ?? "")}": relation "${col.name}" is ${rt}, so it takes one title, not ${v.length}`,
              );
              continue;
            }
            const target = String(
              col.relatedBoard ?? (col.settings as any)?.relatedBoardName ?? "",
            ).toLowerCase();
            const have = specTitles.get(target) || new Set<string>();
            for (const want of (Array.isArray(v) ? v : [v]).map(String)) {
              if (!have.has(want.toLowerCase())) {
                const targetName = String(
                  col.relatedBoard ??
                    (col.settings as any)?.relatedBoardName ??
                    "",
                );
                const blank = untitled.get(target) ?? 0;
                problems.push(
                  `${b.name} row "${String(row.title ?? "")}": relation "${col.name}" names "${want}", but no row with that title is in the spec for ${targetName}` +
                    (blank
                      ? `. ${blank} row(s) of ${targetName} have no title and no text value, so nothing can reference them, give each row a title.`
                      : ""),
                );
              }
            }
          }
        }
      }
      // Row-level security named per board: every column it names must be in
      // the spec, on the board the server will look for it on.
      const rlsRefs = new Map<string, BuildRlsRefs>();
      for (const b of boards) {
        if (!b.rowLevelSecurity) continue;
        if (!api) {
          problems.push(
            `${b.name}.rowLevelSecurity: row-level security belongs to an endpoint, and this spec has no "api". Add api, or remove it.`,
          );
          continue;
        }
        const plan = planBuildRls(b, b.rowLevelSecurity, boards);
        problems.push(...plan.problems);
        rlsRefs.set(b.name.toLowerCase(), plan.refs);
      }
      if (problems.length) return ok({ built: false, problems });

      const orgId = await resolveOrg(organizationId);

      const client = getApi();
      const notes: string[] = [];
      // Publishing an app is the one step that can be refused by the plan.
      // Ask first: a refusal after the project exists leaves a half-built
      // backend behind, which is worse than never starting.
      if (api) {
        try {
          const sub = await client.request<any>(
            "GET",
            `/organizations/${orgId}/subscription`,
          );
          const allowed = sub?.plan?.features?.limits?.publishedApps;
          if (typeof allowed === "number") {
            const apps = await client.request<any>(
              "GET",
              `/organizations/${orgId}/apps`,
            );
            const list: any[] = Array.isArray(apps)
              ? apps
              : (apps?.items ?? apps?.data ?? []);
            const published = list.filter(
              (a) => a?.status === "published" && !a?.deletedAt,
            ).length;
            if (published >= allowed) {
              return ok({
                built: false,
                problems: [
                  `The ${sub?.plan?.name ?? "current"} plan allows ${allowed} published app${allowed === 1 ? "" : "s"} and this organization already has ${published}. Nothing was created. Archive an app, upgrade the plan, or call build_backend again without "api" to build the project and publish later.`,
                ],
              });
            }
          }
        } catch {
          // No subscription endpoint, or no permission to read it: fall
          // through and let the publish call itself answer.
        }
      }

      let createdAppId: string | undefined;
      const created = await client.request<any>(
        "POST",
        `/organizations/${orgId}/projects`,
        {
          name: project.name,
          organizationId: orgId,
          ...(project.description ? { description: project.description } : {}),
        },
      );
      try {
        type Col = {
          id: string;
          name: string;
          type: string;
          alias: string;
          relatedBoardId?: string;
          relationType?: string;
        };
        type Built = {
          id: string;
          name: string;
          kind: string;
          slug: string;
          columns: Col[];
          rows: number;
          adminUrl: string;
        };
        const outBoards: Built[] = [];
        const boardIdByName = new Map<string, string>();
        const usedSlugs = new Set<string>();

        // 1. boards first, so relation columns can point at any of them
        for (const [bi, b] of boards.entries()) {
          const kind = b.kind || "data";
          const board = await client.request<any>(
            "POST",
            `/projects/${created.id}/boards`,
            {
              name: b.name,
              projectId: created.id,
              kind,
              ...(b.description ? { description: b.description } : {}),
            },
          );
          boardIdByName.set(b.name.toLowerCase(), board.id);
          outBoards.push({
            id: board.id,
            name: b.name,
            kind,
            slug: toSlug(b.name, bi, usedSlugs),
            columns: [],
            rows: 0,
            adminUrl: client.appUrl(
              `/projects/${created.id}/boards/${board.id}`,
            ),
          });
        }

        // 2. columns
        for (const [bi, b] of boards.entries()) {
          const built = outBoards[bi];
          const usedAliases = new Set<string>();
          for (const [ci, c] of b.columns.entries()) {
            let type = c.type;
            const settings: Record<string, unknown> = { ...(c.settings || {}) };
            if (c.options?.length) settings.options = c.options;
            if (c.validation) settings.validation = c.validation;
            let relatedBoardId: string | undefined;
            if (type === "relation") {
              relatedBoardId = boardIdByName.get(
                String(
                  c.relatedBoard ?? settings.relatedBoardName,
                ).toLowerCase(),
              );
              delete settings.relatedBoardName;
              settings.relatedBoardId = relatedBoardId;
              settings.projectId = created.id;
              settings.relationType =
                c.relationType || settings.relationType || "many_to_many";
            }
            const objection = columnTypeObjection(c.name, type, settings);
            if (objection && objection.suggestedType !== type) {
              notes.push(
                `${b.name}.${c.name}: created as ${objection.suggestedType} rather than ${type}, because the name says so`,
              );
              type = objection.suggestedType;
            }
            const column = await client.request<any>(
              "POST",
              `/projects/${created.id}/boards/${built.id}/columns`,
              {
                name: c.name,
                type,
                ...(Object.keys(settings).length ? { settings } : {}),
                ...(c.required !== undefined ? { isRequired: c.required } : {}),
              },
            );
            const alias = c.alias || toAlias(c.name, ci, usedAliases);
            if (c.alias) usedAliases.add(c.alias.toLowerCase());
            built.columns.push({
              id: column.id,
              name: c.name,
              type,
              alias,
              ...(relatedBoardId
                ? {
                    relatedBoardId,
                    relationType: String(settings.relationType),
                  }
                : {}),
            });
          }
        }

        // 3. rows, in dependency order: a board's rows after the rows of every
        // board it links to, whatever order the spec listed them in. A cycle
        // (A links B, B links A) falls back to spec order for what remains.
        const depsOf = (b: (typeof boards)[number]): string[] =>
          b.columns
            .filter((c: { type: string }) => c.type === "relation")
            .map(
              (c: {
                relatedBoard?: string;
                settings?: Record<string, unknown>;
              }) =>
                String(
                  c.relatedBoard ?? (c.settings as any)?.relatedBoardName ?? "",
                ).toLowerCase(),
            )
            .filter((n: string) => n && n !== b.name.toLowerCase());
        const rowOrder: number[] = [];
        const done = new Set<string>();
        let remaining = boards.map((_: unknown, i: number) => i);
        while (remaining.length) {
          const ready = remaining.filter((i: number) =>
            depsOf(boards[i]).every((d: string) => done.has(d)),
          );
          const next = ready.length ? ready : [remaining[0]];
          for (const i of next) {
            rowOrder.push(i);
            done.add(boards[i].name.toLowerCase());
          }
          remaining = remaining.filter((i: number) => !next.includes(i));
        }
        const itemIdByBoardTitle = new Map<string, Map<string, string>>();
        for (const bi of rowOrder) {
          const b = boards[bi];
          if (!b.rows?.length) continue;
          const built = outBoards[bi];
          const byName = new Map(
            built.columns.map((c) => [c.name.toLowerCase(), c]),
          );
          const titles = new Map<string, string>();
          itemIdByBoardTitle.set(built.id, titles);
          for (const row of b.rows) {
            const cells: Record<string, unknown> = {};
            let title = typeof row.title === "string" ? row.title : "";
            for (const [k, v] of Object.entries(row)) {
              if (k === "title") continue;
              const col = byName.get(k.toLowerCase());
              if (!col) {
                notes.push(
                  `${b.name}: row field "${k}" matches no column and was skipped`,
                );
                continue;
              }
              if (
                col.type === "relation" &&
                col.relatedBoardId &&
                (typeof v === "string" || Array.isArray(v))
              ) {
                const wanted = (Array.isArray(v) ? v : [v]).map(String);
                const lookup =
                  itemIdByBoardTitle.get(col.relatedBoardId) ||
                  new Map<string, string>();
                const ids = wanted
                  .map((t) => lookup.get(t.toLowerCase()))
                  .filter((x): x is string => Boolean(x));
                if (ids.length < wanted.length) {
                  notes.push(
                    `${b.name}: relation "${col.name}" could not find ${wanted.length - ids.length} of ${wanted.length} referenced rows by title`,
                  );
                }
                if (ids.length) cells[col.id] = { relatedItemIds: ids };
                continue;
              }
              cells[col.id] = v;
              if (!title && typeof v === "string") title = v;
            }
            const item = await client.request<any>(
              "POST",
              `/projects/${created.id}/boards/${built.id}/items`,
              {
                title: title || `${b.name} ${built.rows + 1}`,
                cells,
              },
            );
            if (item?.id)
              titles.set(String(item.title ?? title).toLowerCase(), item.id);
            built.rows++;
          }
        }

        let apiOut: Record<string, unknown> | undefined;
        if (api) {
          const app = await client.request<any>(
            "POST",
            `/organizations/${orgId}/apps`,
            {
              name: api.name || `${project.name} API`,
              projectId: created.id,
            },
          );
          createdAppId = app.id;
          await client.request(
            "POST",
            `/organizations/${orgId}/apps/${app.id}/publish`,
            {},
          );
          const methods = api.methods?.length
            ? api.methods
            : ["GET", "POST", "PATCH", "DELETE"];
          const endpoints: Array<Record<string, unknown>> = [];
          // The column names of each board's rowLevelSecurity, now as ids.
          const columnId = (ref?: { board: string; column: string }) =>
            ref
              ? outBoards
                  .find((x) => x.name.toLowerCase() === ref.board.toLowerCase())
                  ?.columns.find(
                    (c) => c.name.toLowerCase() === ref.column.toLowerCase(),
                  )?.id
              : undefined;
          const rlsFor = (
            boardIndex: number,
          ): Record<string, unknown> | undefined => {
            const spec = boards[boardIndex].rowLevelSecurity as
              | BuildRls
              | undefined;
            if (!spec) {
              return api.rowLevelSecurity ? { enabled: true } : undefined;
            }
            const refs =
              rlsRefs.get(boards[boardIndex].name.toLowerCase()) || {};
            const out: Record<string, unknown> = {
              enabled: spec.enabled ?? true,
            };
            if (spec.mode) out.mode = spec.mode;
            for (const k of [
              "phoneColumn",
              "emailColumn",
              "relationColumn",
              "viaColumn",
              "identityPhoneColumn",
              "identityEmailColumn",
            ] as const) {
              if (spec[k] === undefined) continue;
              const id = columnId(refs[k]);
              if (!id) {
                throw new Error(
                  `${boards[boardIndex].name}.rowLevelSecurity.${k}: column "${spec[k]}" was not found among the columns just created`,
                );
              }
              out[k] = id;
            }
            for (const k of [
              "allowInvites",
              "singleLink",
              "editOwnOnly",
            ] as const) {
              if (spec[k] !== undefined) out[k] = spec[k];
            }
            return out;
          };
          let anyRls = false;
          for (const [bi, b] of outBoards.entries()) {
            const rowLevelSecurity = rlsFor(bi);
            if (rowLevelSecurity?.enabled) anyRls = true;
            await client.request(
              "POST",
              `/organizations/${orgId}/apps/${app.id}/endpoints`,
              {
                boardId: b.id,
                slug: b.slug,
                name: b.name,
                allowedMethods: methods,
                exposedColumns: b.columns.map((c) => ({
                  columnId: c.id,
                  alias: c.alias,
                })),
                ...(rowLevelSecurity ? { rowLevelSecurity } : {}),
              },
            );
            endpoints.push({
              board: b.name,
              url: `${client.apiUrl}/apps/${app.slug}/api/${b.slug}`,
              methods,
              fields: b.columns.map((c) => c.alias),
              // Shown only where a board set its own, so the result of a
              // plain build stays what it was.
              ...(boards[bi].rowLevelSecurity && rowLevelSecurity
                ? { rowLevelSecurity }
                : {}),
            });
          }
          const writes = methods.some((m: string) => m !== "GET");
          const scopes = writes ? ["read", "write"] : ["read"];
          const key = await client.request<any>(
            "POST",
            `/organizations/${orgId}/apps/${app.id}/api-keys`,
            {
              name: "frontend",
              scopes,
            },
          );
          apiOut = {
            appId: app.id,
            appSlug: app.slug,
            baseUrl: `${client.apiUrl}/apps/${app.slug}/api`,
            openapi: `${client.apiUrl}/apps/${app.slug}/api/openapi.json`,
            endpoints,
            apiKey: key.rawKey,
            scopes,
            keyRule:
              "This is the only time the key is shown. Keep it server-side (env var, API route); send it as Authorization: Bearer <key>." +
              (anyRls
                ? " Row-level security is on: also send X-App-User: <your user id> on every call."
                : ""),
            adminUrl: client.appUrl(`/apps/${app.id}`),
          };
        }

        return ok({
          built: true,
          project: {
            id: created.id,
            name: project.name,
            adminUrl: client.appUrl(`/projects/${created.id}`),
          },
          boards: outBoards.map(({ slug, columns, ...b }) => ({
            ...b,
            ...(api ? { endpoint: slug } : {}),
            columns: columns.map(({ relatedBoardId, relationType, ...c }) =>
              relatedBoardId
                ? {
                    ...c,
                    relatedBoard: outBoards.find((x) => x.id === relatedBoardId)
                      ?.name,
                    relationType,
                  }
                : c,
            ),
          })),
          ...(apiOut ? { api: apiOut } : {}),
          ...(notes.length ? { notes } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Undo what this call made. A half-built project the caller did not
        // ask for is worse than no project: it takes a name, shows up in
        // lists, and its app counts against the plan.
        const undone: string[] = [];
        try {
          if (createdAppId) {
            await client.request(
              "DELETE",
              `/organizations/${orgId}/apps/${createdAppId}`,
            );
            undone.push("app");
          }
          await client.request(
            "DELETE",
            `/organizations/${orgId}/projects/${created.id}`,
          );
          undone.push("project");
        } catch {
          // Cleanup itself failed: say so rather than pretend.
        }
        const tail = undone.includes("project")
          ? " Nothing was left behind, the project and everything in it were removed."
          : ` The project "${project.name}" (${created.id}) could not be removed automatically; delete it at ${client.appUrl(`/projects/${created.id}`)}.`;
        throw new Error(
          `build_backend stopped: ${message}.${tail} Fix the spec and call again.`,
        );
      }
    },
  );

  tool(
    "create_automation",
    'Create an automation on a board: when something happens, do something. The most useful action here is http_request, which calls an external API and writes the answer back into columns, pair it with the "scheduled" trigger and the board keeps itself up to date (prices, exchange rates, shipment status, weather). Triggers: item_created, status_changed, column_value_changed, date_approaching, scheduled. Actions: http_request, send_notification, send_email, send_push, change_status, set_column_value, create_cross_board_item, send_webhook. The scheduled trigger has no cron expression: the server checks once an hour, and triggerConfig takes { intervalHours, runAtHour } only (intervalHours: at least this many hours between runs, default 24; runAtHour: 0-23, run only during that hour of the day in UTC, not in the user\'s time zone, so convert: 08:00 in Israel is runAtHour 5 in summer and 6 in winter). A scheduled run executes the actions once for every row of the board that passes conditions, so filter with conditions. send_push sends a notification to the phones of app users through the app\'s own Firebase project (set up once per app: push_status; try it with send_test_push). Its config: { title, body, data, userIds, recipientsFromRelation, includeRowOwner, sound, badge, dataOnly }. title and body take {{column name}} placeholders, title defaults to the row title. Recipients are the union of: the row\'s owner under row-level security (includeRowOwner, default true; false leaves them out), userIds (fixed user ids, as in list_app_users), and recipientsFromRelation, a dotted path of column NAMES such as "Client.Coach.Coach user" that walks relation columns from this row and whose LAST segment must be a people column holding user ids (a single segment is a people column on this board); it does not resolve the user linked to a row by an invite or by phone, so without such a people column use userIds or the row owner. data is a flat object of strings the app reads to decide where to open (itemId and boardId are added). sound: "default" or the file name of a sound bundled in the app; badge: 0 to 99999, 0 clears; dataOnly: true shows nothing and delivers only data (no title, body, sound or badge; iOS may throttle or drop it). With no recipient the action is skipped, not failed. Two more things every action list can use: a { type: "delay", config: { minutes | hours | days } } action pauses the run and resumes the actions after it later (reminders, follow-ups); and any network action (http_request, send_webhook, send_email, send_whatsapp) may carry config.retry: { attempts (1-5), delaySeconds (1-60) }. send_webhook accepts config.secret for an HMAC signature. create_cross_board_item copies a new row to another board: config { targetBoardId, title?: "{{item.title}}", columnValues: { "<column id on the TARGET board>": "{{<column NAME on this board>}}" } }; there is no mapping field, and a column left out is not copied. To act only on some rows pass conditions, e.g. [{ field: "<column id on this board>", operator: "equals", value: "New seller" }]. Change an automation later with update_automation; call list_automations first so you do not add a second one that does the same thing.',
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
      name: z.string().describe("Human-readable name"),
      trigger: z
        .enum([
          "item_created",
          "status_changed",
          "column_value_changed",
          "date_approaching",
          "scheduled",
        ])
        .describe(
          "Event that starts the automation: item_created, status_changed, column_value_changed, date_approaching, or scheduled (checked hourly; an interval in hours and an optional hour of the day in UTC, not a cron expression)",
        ),
      triggerConfig: z
        .record(z.any())
        .optional()
        .describe(
          'For scheduled: { intervalHours?: number (default 24), runAtHour?: 0-23 in UTC }, e.g. { intervalHours: 1 } for every hour, or { runAtHour: 5, intervalHours: 23 } for once a day at 05:00 UTC. The interval is measured from the previous run, which ends a little after the hour, so with runAtHour use 23, not 24: with 24 the next day\'s check falls just short and the run slips a day. A cron field is not read. For column_value_changed: { columnName }',
        ),
      actions: z
        .array(
          z.object({
            type: z
              .string()
              .describe(
                "Action type: http_request, send_notification, send_email, send_push, change_status, set_column_value, create_cross_board_item, send_webhook, send_whatsapp, delay",
              ),
            config: z
              .record(z.any())
              .describe(
                'Action-specific config, e.g. { url, method, headers, responseMapping } for http_request, or { title, body, recipientsFromRelation, includeRowOwner, userIds, data, sound, badge, dataOnly } for send_push',
              ),
          }),
        )
        .describe(
          'e.g. [{ type: "http_request", config: { url: "https://api.frankfurter.app/latest?from=USD&to=ILS", method: "GET", responseMapping: [{ path: "rates.ILS", columnId: "<column id from get_board_schema>" }] } }]',
        ),
      conditions: CONDITIONS_SCHEMA,
      isActive: z.boolean().optional().describe("Whether it is active"),
    },
    async ({
      projectId,
      boardId,
      name,
      trigger,
      triggerConfig,
      actions,
      conditions,
      isActive,
    }) => {
      const crossBoardProblem = checkCrossBoardActions(actions);
      if (crossBoardProblem) return ok({ error: crossBoardProblem });
      // http_request maps response paths onto real column ids. A model that
      // guessed a name instead would create an automation that runs, succeeds,
      // and writes nothing, so say it plainly rather than let it fail quietly.
      for (const action of actions) {
        if (action.type !== "http_request") continue;
        const mapping = (action.config as { responseMapping?: unknown })
          ?.responseMapping;
        if (!Array.isArray(mapping) || !mapping.length) {
          return ok({
            error:
              "http_request needs responseMapping: [{ path, columnId }]. Without it the call runs and stores nothing. Get the column ids from get_board_schema.",
          });
        }
        const missing = mapping.filter(
          (m: { columnId?: string }) => !m?.columnId,
        );
        if (missing.length) {
          return ok({
            error:
              "Every responseMapping entry needs a columnId (not a column name). Call get_board_schema for the real ids.",
          });
        }
      }

      const automation = await getApi().request<any>(
        "POST",
        `/projects/${projectId}/boards/${boardId}/automations`,
        {
          name,
          trigger,
          triggerConfig,
          actions,
          conditions,
          isActive: isActive ?? true,
        },
      );
      return ok({
        automation,
        adminUrl: getApi().appUrl(`/projects/${projectId}/boards/${boardId}`),
      });
    },
  );

  tool(
    "update_automation",
    "Change an existing automation: its actions, conditions, trigger config or name, or switch it off with isActive false. Fields left out stay as they are; actions and conditions, when given, replace the whole list. Use it to fix an automation instead of creating a second one next to it. Get the id from list_automations.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z.string().describe("Board id the automation belongs to"),
      automationId: z
        .string()
        .describe("Automation id (from list_automations)"),
      name: z.string().optional().describe("New name"),
      triggerConfig: z
        .record(z.any())
        .optional()
        .describe(
          "New trigger config, same shape as in create_automation (scheduled: { intervalHours, runAtHour in UTC }, no cron)",
        ),
      actions: z
        .array(
          z.object({
            type: z.string().describe("Action type, as in create_automation"),
            config: z.record(z.any()).describe("Action-specific config"),
          }),
        )
        .optional()
        .describe("The full new list of actions (replaces the old one)"),
      conditions: CONDITIONS_SCHEMA,
      isActive: z
        .boolean()
        .optional()
        .describe("false switches it off, true on"),
    },
    async ({
      projectId,
      boardId,
      automationId,
      name,
      triggerConfig,
      actions,
      conditions,
      isActive,
    }) => {
      if (actions) {
        const crossBoardProblem = checkCrossBoardActions(actions);
        if (crossBoardProblem) return ok({ error: crossBoardProblem });
      }
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (triggerConfig !== undefined) body.triggerConfig = triggerConfig;
      if (actions !== undefined) body.actions = actions;
      if (conditions !== undefined) body.conditions = conditions;
      if (isActive !== undefined) body.isActive = isActive;
      if (!Object.keys(body).length) {
        return ok({ error: "Nothing to change: pass at least one field." });
      }
      return ok(
        await getApi().request(
          "PATCH",
          `/projects/${projectId}/boards/${boardId}/automations/${automationId}`,
          body,
        ),
      );
    },
  );

  tool(
    "list_automations",
    "List the automations on a board, so you can see what already runs before adding another.",
    {
      projectId: z
        .string()
        .describe("Project id (from list_projects / create_project)"),
      boardId: z
        .string()
        .describe("Board id (from list_boards / create_board)"),
    },
    async ({ projectId, boardId }) =>
      ok(
        await getApi().request(
          "GET",
          `/projects/${projectId}/boards/${boardId}/automations`,
        ),
      ),
  );

  tool(
    "list_apps",
    "List the apps in the organization, id, slug, status. Call this first when you need an app id: the slug (app-xxxxxx) is what shows up in URLs and in generated code, and this is how you map it back to the app.",
    {
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(await getApi().request("GET", `/organizations/${orgId}/apps`));
    },
  );

  tool(
    "get_app_spec",
    'Get the machine-readable spec of an app: base URL, endpoints, methods, fields, auth. Two formats: "tasklite" (default), the compact shape the frontend prompts are built from, and "openapi", a standard OpenAPI 3.1 document for developers and other tools. When the user asks for the OpenAPI spec, or wants to hand the API to a developer, pass format "openapi". appId accepts either the app UUID or its slug (app-xxxxxx); list_apps shows both. The returned baseUrl is absolute, use it verbatim, do not rebuild it from the admin URL.',
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      format: z
        .enum(["tasklite", "openapi"])
        .optional()
        .describe(
          '"tasklite" (default): compact endpoint list. "openapi": OpenAPI 3.1 document, every endpoint with typed fields, filter grammar, auth and errors',
        ),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, format, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      const shape = format === "openapi" ? "openapi" : "json";
      return ok(
        await getApi().request(
          "GET",
          `/organizations/${orgId}/apps/${appId}/spec/${shape}`,
        ),
      );
    },
  );

  tool(
    "get_frontend_prompt",
    "Get a ready-made prompt describing the app backend, for pasting into a frontend generator (v0/bolt/lovable/cursor). appId accepts the app UUID or its slug (app-xxxxxx), use list_apps to find it.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      tool: z
        .enum(["v0", "bolt", "lovable", "cursor", "claude-code"])
        .describe("Target tool the prompt is written for"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, tool, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "GET",
          `/organizations/${orgId}/apps/${appId}/spec/prompt/${tool}`,
        ),
      );
    },
  );

  // ── Search & fetch, the two tools ChatGPT connectors and deep research require ──

  type SearchHit = {
    id: string;
    type: string;
    title: string;
    subtitle?: string;
    highlight?: string;
    url: string;
    metadata?: Record<string, unknown>;
  };
  type DocRef =
    | { kind: "project"; projectId: string }
    | { kind: "board"; projectId: string; boardId: string }
    | { kind: "item"; projectId: string; boardId: string; itemId: string };

  const parseDocId = (id: string): DocRef => {
    let m =
      id.match(/^item:([^:]+):([^:]+):([^:]+)$/) ||
      id.match(/\/projects\/([^/]+)\/boards\/([^/]+)\/items\/([^/?#]+)/);
    if (m)
      return { kind: "item", projectId: m[1], boardId: m[2], itemId: m[3] };
    m =
      id.match(/^board:([^:]+):([^:]+)$/) ||
      id.match(/\/projects\/([^/]+)\/boards\/([^/?#]+)/);
    if (m) return { kind: "board", projectId: m[1], boardId: m[2] };
    m = id.match(/^project:([^:]+)$/) || id.match(/\/projects\/([^/?#]+)/);
    if (m) return { kind: "project", projectId: m[1] };
    throw new Error(
      `Unrecognized document id "${id}". Use an id returned by search (project:…, board:…:…, item:…:…:…) or an app URL path.`,
    );
  };
  const docId = (d: DocRef): string =>
    d.kind === "item"
      ? `item:${d.projectId}:${d.boardId}:${d.itemId}`
      : d.kind === "board"
        ? `board:${d.projectId}:${d.boardId}`
        : `project:${d.projectId}`;
  const docPath = (d: DocRef): string =>
    d.kind === "item"
      ? `/projects/${d.projectId}/boards/${d.boardId}/items/${d.itemId}`
      : d.kind === "board"
        ? `/projects/${d.projectId}/boards/${d.boardId}`
        : `/projects/${d.projectId}`;
  // ChatGPT contract: the object as structuredContent AND JSON-encoded in content.
  const structured = (doc: Record<string, unknown>) => {
    const clean = sanitizeUsersDeep(doc) as Record<string, unknown>;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(clean) }],
      structuredContent: clean,
    };
  };

  tool(
    "search",
    "Full-text search across the projects, boards and items of the organization. Returns { results: [{ id, title, url }] }, the shape ChatGPT connectors and deep research expect; pass a result id to fetch for the full record. When you already know the board, query_items is cheaper and complete.",
    {
      query: z.string().min(1).max(100).describe("Search text"),
      projectId: z
        .string()
        .optional()
        .describe("Limit the search to one project"),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Max results, default 20"),
    },
    async ({ query, projectId, limit }) => {
      const qs = new URLSearchParams({
        q: query,
        types: "item,project,board",
        limit: String(limit ?? 20),
      });
      if (projectId) qs.set("projectId", projectId);
      const res = await getApi().request<{ results?: SearchHit[] }>(
        "GET",
        `/search?${qs.toString()}`,
      );
      const results: Record<string, unknown>[] = [];
      for (const r of res?.results ?? []) {
        let ref: DocRef;
        try {
          ref = parseDocId(r.url);
        } catch {
          continue; // users and anything else without a project path
        }
        results.push({
          id: docId(ref),
          title: r.title,
          url: getApi().appUrl(r.url),
          type: ref.kind,
          ...(r.subtitle ? { subtitle: r.subtitle } : {}),
          ...(r.highlight ? { snippet: r.highlight } : {}),
        });
      }
      return structured({ results });
    },
  );

  tool(
    "fetch",
    "One project, board or item in full, by the id search returned (project:<id>, board:<projectId>:<boardId>, item:<projectId>:<boardId>:<itemId>) or by an app URL path. Returns { id, title, text, url, metadata }, the ChatGPT fetch contract; text is the record as JSON.",
    {
      id: z
        .string()
        .describe(
          "An id from search, or an app URL path such as /projects/…/boards/…/items/…",
        ),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Only needed for project ids when the credential has no default organization; otherwise resolved automatically",
        ),
    },
    async ({ id, organizationId }) => {
      const ref = parseDocId(id);
      const api = getApi();
      const url = api.appUrl(docPath(ref));
      if (ref.kind === "item") {
        const item = await api.request<any>("GET", docPath(ref));
        return structured({
          id: docId(ref),
          title: item?.title ?? item?.name ?? ref.itemId,
          text: JSON.stringify(sanitizeUsersDeep(item), null, 2),
          url,
          metadata: {
            type: "item",
            projectId: ref.projectId,
            boardId: ref.boardId,
          },
        });
      }
      if (ref.kind === "board") {
        const [board, columns] = await Promise.all([
          api.request<any>("GET", docPath(ref)),
          api.request<any>("GET", `${docPath(ref)}/columns`),
        ]);
        return structured({
          id: docId(ref),
          title: board?.name ?? ref.boardId,
          text: JSON.stringify(sanitizeUsersDeep({ board, columns }), null, 2),
          url,
          metadata: {
            type: "board",
            projectId: ref.projectId,
            columnCount: Array.isArray(columns) ? columns.length : undefined,
          },
        });
      }
      // The project record lives under its organization; boards do not.
      const loadProject = async (): Promise<unknown> => {
        let orgId: string | null = organizationId ?? null;
        if (!orgId) {
          try {
            orgId = await resolveOrg();
          } catch {
            orgId = null;
          }
        }
        const candidates: string[] = orgId ? [orgId] : [];
        if (!orgId) {
          const orgs = await api.request<any>("GET", "/organizations");
          for (const o of Array.isArray(orgs) ? orgs : (orgs?.items ?? [])) {
            if (o?.id) candidates.push(o.id);
          }
        }
        let lastErr: unknown = null;
        for (const c of candidates) {
          try {
            return await api.request<any>(
              "GET",
              `/organizations/${c}/projects/${ref.projectId}`,
            );
          } catch (e) {
            lastErr = e;
          }
        }
        throw (
          lastErr ??
          new Error(`Project ${ref.projectId} not found in any organization`)
        );
      };
      const [project, boards] = await Promise.all([
        loadProject() as Promise<any>,
        api.request<any>("GET", `${docPath(ref)}/boards`),
      ]);
      const boardList: unknown[] = Array.isArray(boards)
        ? boards
        : ((boards as any)?.items ?? (boards as any)?.data ?? []);
      return structured({
        id: docId(ref),
        title: project?.name ?? ref.projectId,
        text: JSON.stringify(
          sanitizeUsersDeep({ project, boards: boardList }),
          null,
          2,
        ),
        url,
        metadata: { type: "project", boardCount: boardList.length },
      });
    },
  );

  // ── Frontend hosting ({slug}.tasklite.dev) ────────────────────────────────

  // Shared by the three deploy_frontend inputs: the zip must serve index.html
  // at its root. A zip whose only top-level entry is a folder (how most
  // exporters and GitHub pack a build) is re-rooted rather than rejected.
  const normalizeBundle = (zip: AdmZip): AdmZip => {
    const entries = zip
      .getEntries()
      .filter((e) => !e.isDirectory && !e.entryName.startsWith("__MACOSX/"));
    if (entries.some((e) => e.entryName === "index.html")) return zip;
    const tops = new Set(entries.map((e) => e.entryName.split("/")[0]));
    if (tops.size === 1) {
      const [top] = [...tops];
      if (entries.some((e) => e.entryName === `${top}/index.html`)) {
        const out = new AdmZip();
        for (const e of entries)
          out.addFile(e.entryName.slice(top.length + 1), e.getData());
        return out;
      }
    }
    throw new Error(
      "The bundle has no index.html at its root. Pass the build OUTPUT (dist/, build/, out/), not the project source.",
    );
  };
  const MAX_BUNDLE = 50 * 1024 * 1024;
  const checkBundleSize = (n: number) => {
    if (n > MAX_BUNDLE) {
      throw new Error(
        `Bundle is ${Math.round(n / 1024 / 1024)}MB zipped, the limit is 50MB. Static frontends should not embed large media; upload those as attachments instead.`,
      );
    }
  };

  tool(
    "deploy_frontend",
    "Deploy a static frontend to TaskLite hosting and get a live URL https://{slug}.tasklite.dev (HTTPS, auto-published on first deploy, versions kept for rollback_deployment). Hand over the frontend in ONE of three ways: `files`, the files inline (path + content), the way to go from ChatGPT or any hosted client: write index.html and its assets, then deploy in the same turn; `zipUrl`, a public https URL of a zip (a Lovable/Bolt export, a GitHub release asset); `dir`, a build output folder on this machine (only when the MCP runs locally next to the files); `fromAppId`, a version already hosted in the same organization, copied on the server (start a new app from an existing site, or bring an old version back as a new one; get_deployment_files reads a version first). A real build that already exists on the person's machine fits none of these from a hosted server: tell them to drop the zip on the app's Versions screen (the adminUrl of the app, then Versions), which deploys the same way and keeps the same version history. In the frontend, call the app API via relative /api/{endpoint}, the hosting proxy injects the app identity, so no key ships to the browser.",
    {
      appId: z
        .string()
        .describe("App UUID or slug (app-xxxxxx), see list_apps"),
      files: z
        .array(
          z.object({
            path: z
              .string()
              .describe(
                'Path inside the site, e.g. "index.html", "app.js", "css/style.css"',
              ),
            content: z
              .string()
              .describe(
                'File content. Text as-is; binary as base64 with encoding "base64"',
              ),
            encoding: z
              .enum(["utf8", "base64"])
              .optional()
              .describe("Default utf8"),
          }),
        )
        .max(500)
        .optional()
        .describe(
          "The site files inline. Must include index.html. Up to 500 files / 8MB decoded, right for a frontend written in the conversation",
        ),
      zipUrl: z
        .string()
        .url()
        .optional()
        .describe(
          "Public https URL of a zip of the BUILD OUTPUT (index.html at the root, or inside a single top-level folder). Up to 50MB",
        ),
      dir: z
        .string()
        .optional()
        .describe(
          "Local path to the BUILD OUTPUT directory (the one containing index.html), not the project root. Only where the MCP runs on the same machine as the files",
        ),
      fromAppId: z
        .string()
        .optional()
        .describe(
          "Deploy a version that is already hosted, copied on the server: another app in the same organization (start a new app from it), or this same app (bring an old version back as a new one). Nothing passes through the conversation, so any size works",
        ),
      fromVersion: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "With fromAppId: which version to copy (from list_deployments). Default: the live one",
        ),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      appId,
      files,
      zipUrl,
      dir,
      fromAppId,
      fromVersion,
      organizationId,
    }: {
      appId: string;
      files?: Array<{
        path: string;
        content: string;
        encoding?: "utf8" | "base64";
      }>;
      zipUrl?: string;
      dir?: string;
      fromAppId?: string;
      fromVersion?: number;
      organizationId?: string;
    }) => {
      const given = [
        files ? "files" : "",
        zipUrl ? "zipUrl" : "",
        dir ? "dir" : "",
        fromAppId ? "fromAppId" : "",
      ].filter(Boolean);
      if (given.length !== 1) {
        throw new Error(
          given.length === 0
            ? "Pass the frontend as `files` (inline), `zipUrl` (public zip), `dir` (local build folder) or `fromAppId` (copy a hosted version)."
            : `Pass only one of files / zipUrl / dir / fromAppId (got ${given.join(", ")}).`,
        );
      }
      if (fromVersion && !fromAppId) {
        throw new Error(
          "fromVersion goes with fromAppId. To make an old version of this app live again without a new version, use rollback_deployment.",
        );
      }
      const orgId = await resolveOrg(organizationId);

      // A hosted version is copied by the server itself: the bytes never come
      // through here, so the size limits of files / zipUrl do not apply.
      if (fromAppId) {
        const copied = await getApi().request<Record<string, unknown>>(
          "POST",
          `/organizations/${orgId}/apps/${appId}/deployments/copy`,
          { fromAppId, ...(fromVersion ? { fromVersion } : {}) },
        );
        const { published: publishedByThisDeploy, ...rest } = copied;
        return ok({
          ...rest,
          appPublished: true,
          note: `Live now${publishedByThisDeploy ? " (this deploy also published the app)" : ""}. The source version is untouched. Old versions are kept for rollback (rollback_deployment); only the last 5 stay on disk.`,
        });
      }

      let buffer: Buffer;

      if (files) {
        const zip = new AdmZip();
        let total = 0;
        const seen = new Set<string>();
        for (const f of files) {
          const rel = f.path.replace(/\\/g, "/").replace(/^\.?\//, "");
          if (
            !rel ||
            rel.startsWith("/") ||
            rel.split("/").some((seg) => seg === ".." || seg === "")
          ) {
            throw new Error(
              `Bad file path "${f.path}": use a relative path inside the site, e.g. "assets/app.js".`,
            );
          }
          if (seen.has(rel)) throw new Error(`Duplicate file path "${rel}".`);
          seen.add(rel);
          const data = Buffer.from(
            f.content,
            f.encoding === "base64" ? "base64" : "utf8",
          );
          total += data.length;
          if (total > 8 * 1024 * 1024) {
            throw new Error(
              "Inline files exceed 8MB decoded. Build the site and pass a zipUrl (up to 50MB), or keep media out of the bundle.",
            );
          }
          zip.addFile(rel, data);
        }
        if (!seen.has("index.html")) {
          throw new Error(
            `files must include "index.html" at the root (got: ${[...seen].slice(0, 8).join(", ")}${seen.size > 8 ? ", …" : ""}).`,
          );
        }
        buffer = zip.toBuffer();
      } else if (zipUrl) {
        const u = new URL(zipUrl);
        if (u.protocol !== "https:") throw new Error("zipUrl must be https.");
        if (
          /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(
            u.hostname,
          ) ||
          /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
        ) {
          throw new Error(
            "zipUrl must point at a public host, not a private address.",
          );
        }
        const res = await fetch(zipUrl, {
          redirect: "follow",
          headers: { accept: "application/zip, application/octet-stream, */*" },
        });
        if (!res.ok)
          throw new Error(`Could not download zipUrl: HTTP ${res.status}.`);
        const declared = Number(res.headers.get("content-length") || 0);
        checkBundleSize(declared);
        const raw = Buffer.from(await res.arrayBuffer());
        checkBundleSize(raw.length);
        let zip: AdmZip;
        try {
          zip = new AdmZip(raw);
        } catch {
          throw new Error(
            "zipUrl did not return a zip file. Point it at the archive itself (a GitHub release asset, an export download), not at a page.",
          );
        }
        buffer = normalizeBundle(zip).toBuffer();
      } else {
        const abs = resolvePath(dir as string);
        if (!existsSync(abs) || !statSync(abs).isDirectory()) {
          throw new Error(
            `Directory not found: ${abs}. Run the build first, then pass the output folder (dist/, build/, out/). If the MCP is not running on the machine with the files (a hosted connector never is), pass them as \`files\`, or a \`zipUrl\`, or have the person upload the zip on the app's Versions screen at ${getApi().appUrl(`/apps/${appId}/deployments`)}.`,
          );
        }
        if (!existsSync(joinPath(abs, "index.html"))) {
          const candidate = ["dist", "build", "out"].find((d) =>
            existsSync(joinPath(abs, d, "index.html")),
          );
          throw new Error(
            candidate
              ? `No index.html in ${abs}, did you mean ${joinPath(abs, candidate)}?`
              : `No index.html in ${abs}. Pass the build OUTPUT directory, and build first if you haven't.`,
          );
        }
        const zip = new AdmZip();
        zip.addLocalFolder(abs);
        buffer = zip.toBuffer();
      }
      checkBundleSize(buffer.length);

      const result = await getApi().requestUpload<Record<string, unknown>>(
        `/organizations/${orgId}/apps/${appId}/deployments`,
        "file",
        "frontend.zip",
        buffer,
      );
      // The server's `published` means "this deploy is the one that published
      // the app", false whenever it was already published. Next to "Live
      // now" that read as a contradiction, so say what actually happened.
      const { published: publishedByThisDeploy, ...rest } = result;
      return ok({
        ...rest,
        appPublished: true,
        note: `Live now${publishedByThisDeploy ? " (this deploy also published the app)" : ""}. Old versions are kept for rollback (rollback_deployment); only the last 5 stay on disk.`,
      });
    },
  );

  tool(
    "list_deployments",
    "List the hosted-frontend deployments of an app, versions, which one is live, and the public URL.",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "GET",
          `/organizations/${orgId}/apps/${appId}/deployments`,
        ),
      );
    },
  );

  tool(
    "get_deployment_files",
    'Read back what a hosted frontend version is made of: every file with its size and its URL on that version, and the full text of the text files (HTML, CSS, JS, JSON, SVG...). This is how a new conversation continues a site an earlier one built: "take my Krispool site and keep going" starts here, not from scratch. For a site written by hand the files ARE the source. For a bundled build (Vite, React) the JS is minified output: fine to inspect, not something to edit, so ask for the project\'s source instead. Images and other binaries come back as URLs only. Text is capped at 512KB per file and 4MB per call; narrow with `paths` for a big site. To start another app from this version, or bring an old version back as a new one, use deploy_frontend with fromAppId.',
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      version: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Version to read (from list_deployments). Default: the live version",
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Only these files, as listed by a previous call, e.g. ["index.html", "css/site.css"]',
        ),
      includeContent: z
        .boolean()
        .optional()
        .describe(
          "false lists the files without their text, a cheap first look at a large site. Default true",
        ),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({
      appId,
      version,
      paths,
      includeContent,
      organizationId,
    }: {
      appId: string;
      version?: number;
      paths?: string[];
      includeContent?: boolean;
      organizationId?: string;
    }) => {
      const orgId = await resolveOrg(organizationId);
      const qs = new URLSearchParams();
      if (version) qs.set("version", String(version));
      if (paths?.length) qs.set("paths", paths.join(","));
      if (includeContent === false) qs.set("content", "false");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return ok(
        await getApi().request(
          "GET",
          `/organizations/${orgId}/apps/${appId}/deployments/files${suffix}`,
        ),
      );
    },
  );

  tool(
    "rollback_deployment",
    "Point the live URL back at a previous deployment version (see list_deployments for available versions).",
    {
      appId: z
        .string()
        .describe("App id or slug (from list_apps / create_app)"),
      version: z
        .number()
        .int()
        .positive()
        .describe("Deployment version number (from list_deployments)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization id; defaults to the credential organization when omitted",
        ),
    },
    async ({ appId, version, organizationId }) => {
      const orgId = await resolveOrg(organizationId);
      return ok(
        await getApi().request(
          "POST",
          `/organizations/${orgId}/apps/${appId}/deployments/${version}/activate`,
        ),
      );
    },
  );
}
