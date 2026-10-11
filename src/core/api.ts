import * as https from 'node:https';

import { Logger, nullLogger, redact } from './log';
import { AccountIdentity, StoredCredentials } from './types';

/**
 * The only two hosts this extension ever talks to are the Anthropic API below
 * and whatever git remote the user configures for sync. Asserted in the privacy
 * note (acceptance A12) — there is no telemetry of any kind.
 */
export const API_BASE = 'https://api.anthropic.com';

/** The client id the Claude clients use; needed only for the refresh grant. */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export const USER_AGENT = 'tidemark-vscode (unofficial Claude quota viewer)';

export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'bad-response';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Short, non-alarming text for a tooltip. */
  get display(): string {
    switch (this.kind) {
      case 'unauthorized':
        return 'Sign-in needed';
      case 'forbidden':
        return 'Not permitted for this account';
      case 'rate-limited':
        return 'Anthropic is rate-limiting usage lookups';
      case 'network':
      case 'timeout':
        return 'Offline';
      case 'not-found':
        return 'Usage lookup unavailable on this plan';
      default:
        return 'Usage lookup failed';
    }
  }
}

export interface RawUsageResponse {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  limits?: RawLimit[] | null;
  spend?: unknown;
  extra_usage?: {
    is_enabled?: boolean;
    utilization?: number | null;
  } | null;
  seven_day_breakdown?: {
    as_of?: string;
    window_started_at?: string;
    rows?: { key?: string; display_name?: string; percent?: number }[] | null;
  } | null;
}

export interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
  locked_reason?: string | null;
}

export interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number | null;
  severity?: string | null;
  resets_at?: string | null;
  is_active?: boolean;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: string | null;
  } | null;
}

export interface RawProfileResponse {
  account?: {
    uuid?: string;
    email?: string;
    full_name?: string;
    display_name?: string;
    has_claude_max?: boolean;
    has_claude_pro?: boolean;
  } | null;
  organization?: {
    uuid?: string;
    name?: string;
    organization_type?: string;
    rate_limit_tier?: string;
    seat_tier?: string | null;
  } | null;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface ApiClientOptions {
  logger?: Logger;
  timeoutMs?: number;
  /** Test seam: replaces the HTTPS call. */
  request?: typeof requestJson;
}

export class ApiClient {
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly send: typeof requestJson;

  constructor(options: ApiClientOptions = {}) {
    this.log = options.logger ?? nullLogger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.send = options.request ?? requestJson;
  }

  async usage(accessToken: string): Promise<RawUsageResponse> {
    return this.send<RawUsageResponse>({
      url: `${API_BASE}/api/oauth/usage`,
      method: 'GET',
      accessToken,
      timeoutMs: this.timeoutMs,
    });
  }

  async profile(accessToken: string): Promise<AccountIdentity> {
    const raw = await this.send<RawProfileResponse>({
      url: `${API_BASE}/api/oauth/profile`,
      method: 'GET',
      accessToken,
      timeoutMs: this.timeoutMs,
    });
    return identityFromProfile(raw);
  }

  /**
   * Exchanges a refresh token. The caller must persist the result immediately:
   * Anthropic rotates refresh tokens, so the previous one may stop working the
   * moment this resolves. See D-06 for why only one machine does this.
   */
  async refresh(credentials: StoredCredentials): Promise<RefreshResult> {
    const refreshToken = credentials.claudeAiOauth.refreshToken;
    if (!refreshToken) throw new ApiError('unauthorized', 'No refresh token stored.');
    const raw = await this.send<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    }>({
      url: `${API_BASE}/v1/oauth/token`,
      method: 'POST',
      timeoutMs: this.timeoutMs,
      body: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      },
    });
    if (!raw.access_token) {
      throw new ApiError('bad-response', 'Refresh response contained no access token.');
    }
    const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 3600;
    this.log.debug('refreshed an access token');
    return {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token ?? refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }
}

export function identityFromProfile(raw: RawProfileResponse): AccountIdentity {
  const account = raw.account ?? {};
  const organization = raw.organization ?? {};
  return {
    accountUuid: account.uuid,
    email: account.email,
    fullName: account.full_name ?? account.display_name,
    organizationUuid: organization.uuid,
    organizationName: organization.name,
    rateLimitTier: organization.rate_limit_tier,
    plan: planWord(raw),
  };
}

function planWord(raw: RawProfileResponse): string | undefined {
  const tier = raw.organization?.rate_limit_tier ?? '';
  if (/max_20x/.test(tier)) return 'Max 20x';
  if (/max_5x/.test(tier)) return 'Max 5x';
  if (/max/.test(tier)) return 'Max';
  if (raw.account?.has_claude_max) return 'Max';
  if (raw.account?.has_claude_pro) return 'Pro';
  const type = raw.organization?.organization_type ?? '';
  if (/team/.test(type)) return 'Team';
  if (/enterprise/.test(type)) return 'Enterprise';
  return undefined;
}

export interface RequestOptions {
  url: string;
  method: 'GET' | 'POST';
  accessToken?: string;
  body?: unknown;
  timeoutMs: number;
}

export function requestJson<T>(options: RequestOptions): Promise<T> {
  const { url, method, accessToken, body, timeoutMs } = options;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');

  return new Promise<T>((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.byteLength);
    }

    const request = https.request(url, { method, headers, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString('utf8');
        if (status >= 200 && status < 300) {
          try {
            resolve(text ? (JSON.parse(text) as T) : ({} as T));
          } catch {
            reject(new ApiError('bad-response', 'Response was not JSON.', status));
          }
          return;
        }
        reject(errorFromResponse(status, text));
      });
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new ApiError('timeout', `No response within ${Math.round(timeoutMs / 1000)}s.`));
    });
    request.on('error', (error) => {
      reject(new ApiError('network', redact(error)));
    });

    if (payload) request.write(payload);
    request.end();
  });
}

function errorFromResponse(status: number, text: string): ApiError {
  let message = `HTTP ${status}`;
  let requestId: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; type?: string };
      request_id?: string;
    };
    if (parsed.error?.message) message = parsed.error.message;
    requestId = parsed.request_id;
  } catch {
    /* keep the generic message */
  }
  const kind: ApiErrorKind =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'not-found'
          : status === 429
            ? 'rate-limited'
            : status >= 500
              ? 'server'
              : 'bad-response';
  return new ApiError(kind, message, status, requestId);
}
