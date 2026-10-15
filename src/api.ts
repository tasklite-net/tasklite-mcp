/**
 * TaskLite REST client with per-instance credentials.
 *
 * Two credential kinds:
 *  - 'tl_...' personal API key → exchanged for a short-lived JWT
 *    (POST /public/v1/auth/session) and auto-refreshed.
 *  - anything else is treated as a ready TaskLite JWT (hosted/OAuth mode)
 *    and sent as-is.
 *
 * No LLM calls, no global state, safe for one instance per HTTP request.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://api.tasklite.net';
export const DEFAULT_APP_URL = 'https://app.tasklite.net';

const CRED_DIR = join(homedir(), '.tasklite');
const CRED_FILE = join(CRED_DIR, 'credentials.json');

export function envApiUrl(): string {
  return (process.env.TASKLITE_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
}

export function envAppUrl(): string {
  return (process.env.TASKLITE_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
}

/** stdio mode: env var wins, then the credentials file written by sign_up. */
export function readStoredApiKey(): string {
  if (process.env.TASKLITE_API_KEY) return process.env.TASKLITE_API_KEY;
  try {
    const parsed = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
    if (typeof parsed.apiKey === 'string') return parsed.apiKey;
  } catch {
    /* no credentials file yet */
  }
  return '';
}

export function saveApiKey(apiKey: string): string {
  mkdirSync(CRED_DIR, { recursive: true });
  writeFileSync(
    CRED_FILE,
    JSON.stringify({ apiKey, savedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  return CRED_FILE;
}

/** Remove the stored credential. Returns false if there was nothing to remove. */
export function clearApiKey(): boolean {
  try {
    rmSync(CRED_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when TASKLITE_API_KEY is set. It wins over the credentials file, so
 * connect/disconnect must warn: the file they touch is not what will be used
 * the next time the server starts.
 */
export function envApiKeyOverrides(): boolean {
  return Boolean(process.env.TASKLITE_API_KEY);
}

export const credentialsPath = CRED_FILE;

interface Session {
  token: string;
  expiresAt: number;
  organizationId: string | null;
}

/**
 * A refusal from the API, with its status and its body as sent. The message
 * is the same as before, so callers that only print it see no change; a tool
 * that must pass the server's answer on (set_cells_if_unchanged) reads
 * status and body.
 */
export class TaskLiteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "TaskLiteApiError";
  }
}

export interface OrganizationSummary {
  id: string;
  name: string;
  userRole: string | null;
  hasValidSubscription: boolean;
}

export class TaskLiteApi {
  private session: Session | null = null;

  constructor(
    private readonly credential: string,
    readonly apiUrl: string = envApiUrl(),
    readonly appUrlBase: string = envAppUrl(),
  ) {}

  appUrl(path: string): string {
    return `${this.appUrlBase}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private get isApiKey(): boolean {
    return this.credential.startsWith('tl_');
  }

  private async getToken(): Promise<string> {
    if (!this.isApiKey) return this.credential;
    if (!this.session || Date.now() >= this.session.expiresAt) {
      const res = await fetch(`${this.apiUrl}/public/v1/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.credential}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Failed to authenticate API key (${res.status}): ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        token: string;
        expiresIn: number;
        organizationId: string | null;
      };
      this.session = {
        token: data.token,
        expiresAt: Date.now() + (data.expiresIn - 60) * 1000,
        organizationId: data.organizationId,
      };
    }
    return this.session.token;
  }

  private orgCache: OrganizationSummary[] | null = null;

  /**
   * Organizations this credential can act in: viewers and lapsed
   * subscriptions are left out, since a write there fails anyway. Cached for
   * the life of the api instance (one request in hosted mode, one process
   * over stdio).
   */
  async writableOrganizations(): Promise<OrganizationSummary[]> {
    if (!this.orgCache) {
      const list = await this.request<Array<Record<string, unknown>>>('GET', '/organizations');
      this.orgCache = (Array.isArray(list) ? list : []).map((o) => ({
        id: String(o.id),
        name: String(o.name ?? ''),
        userRole: typeof o.userRole === 'string' ? o.userRole : null,
        hasValidSubscription: o.hasValidSubscription !== false,
      }));
    }
    return this.orgCache.filter((o) => o.userRole !== 'viewer' && o.hasValidSubscription);
  }

  /**
   * The organization to use when a tool call names none. An API key carries
   * its organization. An OAuth user (every ChatGPT and Claude web session)
   * carries nothing, so the only safe default is the single organization they
   * can write to; with several, the caller has to choose, see resolveOrg in
   * tools.ts, which lists the candidates in the error so one call suffices.
   */
  async defaultOrganizationId(): Promise<string | null> {
    if (this.isApiKey) {
      await this.getToken();
      return this.session?.organizationId ?? null;
    }
    const orgs = await this.writableOrganizations();
    return orgs.length === 1 ? orgs[0].id : null;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.apiUrl}${path.startsWith('/') ? '' : '/'}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 401 && this.isApiKey && !retried) {
      this.session = null;
      return this.request<T>(method, path, body, true);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const message =
        typeof parsed === 'object' && parsed !== null && 'message' in (parsed as any)
          ? JSON.stringify((parsed as any).message)
          : String(parsed).slice(0, 500);
      throw new TaskLiteApiError(
        `TaskLite API ${method} ${path} failed (${res.status}): ${message}`,
        res.status,
        parsed,
      );
    }

    return parsed as T;
  }

  /** Multipart file upload (deploy_frontend). Same auth/retry semantics as
   *  request(), but the body is FormData so fetch sets the boundary itself. */
  async requestUpload<T = unknown>(
    path: string,
    fieldName: string,
    fileName: string,
    data: Buffer,
    retried = false,
  ): Promise<T> {
    const token = await this.getToken();
    const form = new FormData();
    form.append(fieldName, new Blob([new Uint8Array(data)]), fileName);
    const res = await fetch(`${this.apiUrl}${path.startsWith('/') ? '' : '/'}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    if (res.status === 401 && this.isApiKey && !retried) {
      this.session = null;
      return this.requestUpload<T>(path, fieldName, fileName, data, true);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const message =
        typeof parsed === 'object' && parsed !== null && 'message' in (parsed as any)
          ? JSON.stringify((parsed as any).message)
          : String(parsed).slice(0, 500);
      throw new Error(`TaskLite API upload ${path} failed (${res.status}): ${message}`);
    }
    return parsed as T;
  }
}
