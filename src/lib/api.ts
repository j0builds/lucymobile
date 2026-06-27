import * as SecureStore from 'expo-secure-store';

import { LUCY_API_URL, hasBackend } from './config';

// --- token storage -----------------------------------------------------------
// Legacy single-key path (manual bearer seed). Kept so the README's setApiKey
// flow + apiKeyFromHeaders() resolver still work for staging.
const KEY_STORAGE = 'lucy.apiKey';
// Auth-session tokens from /v1/auth/login | /v1/auth/oauth.
const TOKEN_STORAGE = 'lucy.token';
const REFRESH_STORAGE = 'lucy.refreshToken';

export async function getApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_STORAGE);
}

export async function setApiKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_STORAGE, key);
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_STORAGE);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_STORAGE);
}

/** Persist both tokens. Refresh rotates server-side, so always store the new one. */
export async function setTokens(token: string, refreshToken: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_STORAGE, token);
  await SecureStore.setItemAsync(REFRESH_STORAGE, refreshToken);
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_STORAGE);
  await SecureStore.deleteItemAsync(REFRESH_STORAGE);
}

/**
 * Resolve the bearer the authed request() should send. Prefers a session token
 * from login/OAuth; falls back to the manually-seeded API key.
 */
async function getBearer(): Promise<string | null> {
  return (await getToken()) ?? (await getApiKey());
}

// --- logged-out signalling ---------------------------------------------------
// request() can't navigate, so it broadcasts a logged-out event for the UI to
// react to (clear state, show "signed out"). index.tsx subscribes via
// onLoggedOut().
type LoggedOutListener = () => void;
const loggedOutListeners = new Set<LoggedOutListener>();

export function onLoggedOut(fn: LoggedOutListener): () => void {
  loggedOutListeners.add(fn);
  return () => loggedOutListeners.delete(fn);
}

function emitLoggedOut(): void {
  for (const fn of loggedOutListeners) fn();
}

function base(): string {
  return LUCY_API_URL.replace(/\/$/, '');
}

// --- refresh -----------------------------------------------------------------
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Exchange the stored refresh token for a fresh pair. The server ROTATES the
 * refresh token, so we persist the new one. Returns the new access token, or
 * null on failure (which clears tokens + signals logged-out). Deduped so a
 * burst of 401s triggers exactly one refresh.
 */
async function refreshTokens(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const refreshToken = await getRefreshToken();
      if (!refreshToken) return null;
      const res = await fetch(`${base()}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        await clearTokens();
        emitLoggedOut();
        return null;
      }
      const data = (await res.json()) as { token?: string; refreshToken?: string };
      if (!data.token || !data.refreshToken) {
        await clearTokens();
        emitLoggedOut();
        return null;
      }
      await setTokens(data.token, data.refreshToken);
      return data.token;
    } catch {
      // network failure: don't nuke tokens (could be transient), just give up.
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// --- authed request wrapper --------------------------------------------------
export type RequestResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'no-backend' }
  | { ok: false; reason: 'no-key' }
  | { ok: false; reason: 'http'; status: number; body: string }
  | { ok: false; reason: 'network'; message: string };

/**
 * Authed JSON fetch. On 401 it refreshes once (rotating both tokens) and retries
 * the original request. If refresh fails, tokens are cleared and a logged-out
 * event fires.
 */
export async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<RequestResult<T>> {
  if (!hasBackend) return { ok: false, reason: 'no-backend' };
  let bearer = await getBearer();
  if (!bearer) return { ok: false, reason: 'no-key' };

  const doFetch = (token: string) =>
    fetch(`${base()}${path}`, {
      method: init?.method ?? (init?.body ? 'POST' : 'GET'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  try {
    let res = await doFetch(bearer);

    if (res.status === 401) {
      const fresh = await refreshTokens();
      if (!fresh) return { ok: false, reason: 'no-key' };
      bearer = fresh;
      res = await doFetch(bearer);
    }

    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, body: await res.text() };
    }
    // Some endpoints (logout, device delete) return empty bodies.
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as T;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: 'network', message: (e as Error).message };
  }
}

// --- auth --------------------------------------------------------------------
export type LoginResult =
  | { ok: true }
  | { ok: false; reason: 'no-backend' }
  | { ok: false; reason: 'http'; status: number; body: string }
  | { ok: false; reason: 'network'; message: string };

/** Email/password login. Persists the returned token pair. */
export async function login(email: string, password: string): Promise<LoginResult> {
  if (!hasBackend) return { ok: false, reason: 'no-backend' };
  try {
    const res = await fetch(`${base()}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, body: await res.text() };
    }
    const data = (await res.json()) as {
      token: string;
      refreshToken: string;
      expiresInSec?: number;
    };
    await setTokens(data.token, data.refreshToken);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'network', message: (e as Error).message };
  }
}

/** Logout: best-effort server revoke + always clear local tokens. */
export async function logout(): Promise<void> {
  const refreshToken = await getRefreshToken();
  if (hasBackend && refreshToken) {
    try {
      await fetch(`${base()}/v1/auth/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // best effort; clearing local tokens below is what matters.
    }
  }
  await clearTokens();
}

/**
 * Begin the GitHub OAuth flow: ask the server for the provider URL bound to our
 * app deep link. The caller opens this URL in an auth session and captures the
 * returned tokens via setTokens().
 */
export async function githubOAuthStart(redirectUri: string): Promise<
  | { ok: true; url: string }
  | { ok: false; reason: 'no-backend' }
  | { ok: false; reason: 'http'; status: number; body: string }
  | { ok: false; reason: 'network'; message: string }
> {
  if (!hasBackend) return { ok: false, reason: 'no-backend' };
  try {
    const res = await fetch(
      `${base()}/v1/auth/oauth/github/start?redirect_uri=${encodeURIComponent(redirectUri)}`,
      { method: 'GET', headers: { 'content-type': 'application/json' } },
    );
    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, body: await res.text() };
    }
    const data = (await res.json()) as { url: string };
    return { ok: true, url: data.url };
  } catch (e) {
    return { ok: false, reason: 'network', message: (e as Error).message };
  }
}

// --- devices -----------------------------------------------------------------
/** Register this device's push token. Authed (Bearer). */
export async function registerDevice(
  pushToken: string,
  platform: 'ios' | 'android',
  deviceId?: string,
): Promise<RequestResult<unknown>> {
  return request('/v1/devices/register', {
    method: 'POST',
    body: { pushToken, platform, ...(deviceId ? { deviceId } : {}) },
  });
}

/** Unregister a push token (e.g. on logout). Authed (Bearer). */
export async function unregisterDevice(pushToken: string): Promise<RequestResult<unknown>> {
  return request('/v1/devices', { method: 'DELETE', body: { pushToken } });
}

// --- capture (legacy fallback) -----------------------------------------------
export type CaptureResult =
  | { ok: true; committed: number; drafts: { id: string; title: string }[]; redactions: number }
  | { ok: false; reason: 'no-backend' }
  | { ok: false; reason: 'no-key' }
  | { ok: false; reason: 'http'; status: number; body: string }
  | { ok: false; reason: 'network'; message: string };

export async function captureText(text: string, ref?: string): Promise<CaptureResult> {
  if (!hasBackend) return { ok: false, reason: 'no-backend' };
  const key = await getBearer();
  if (!key) return { ok: false, reason: 'no-key' };

  try {
    const res = await fetch(`${base()}/v1/capture`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ text, ref: ref ?? `mobile:${Date.now()}` }),
    });
    if (!res.ok) {
      return { ok: false, reason: 'http', status: res.status, body: await res.text() };
    }
    const data = (await res.json()) as {
      committed?: number;
      drafts?: { id: string; title: string }[];
      redactions?: number;
    };
    return {
      ok: true,
      committed: data.committed ?? 0,
      drafts: data.drafts ?? [],
      redactions: data.redactions ?? 0,
    };
  } catch (e) {
    return { ok: false, reason: 'network', message: (e as Error).message };
  }
}

// --- act (primary path) ------------------------------------------------------
export type ActResponse = {
  intent: string;
  spokenReply: string;
  needsConfirm?: boolean;
  captured?: { committed: number; drafts: { id: string; title: string }[]; redactions: number };
  answer?: string;
  sources?: { id: string; title: string }[];
  action?: string;
  result?: unknown;
};

export type ActResult = RequestResult<ActResponse>;

/**
 * Primary conversational path. The server interprets `text`, returns a unified
 * shape with the line to speak back. Pass `confirm: true` to resolve a prior
 * `needsConfirm` prompt. `ref` defaults to `mobile:<ts>` for dedup.
 */
export async function act(text: string, confirm?: boolean, ref?: string): Promise<ActResult> {
  return request<ActResponse>('/v1/mobile/act', {
    method: 'POST',
    body: {
      text,
      ref: ref ?? `mobile:${Date.now()}`,
      ...(confirm ? { confirm: true } : {}),
    },
  });
}
