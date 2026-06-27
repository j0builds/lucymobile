import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { githubOAuthStart, setTokens } from './api';

// Ensures the auth session closes cleanly after the redirect on web/standalone.
WebBrowser.maybeCompleteAuthSession();

export type GithubLoginResult =
  | { ok: true }
  | { ok: false; reason: 'no-backend' }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'no-tokens' }
  | { ok: false; reason: 'start-failed'; detail: string };

/**
 * Sign in with GitHub.
 *
 * 1. Build the app deep link (scheme `lucymobile://`, path `auth/github`).
 * 2. Ask the server for the provider URL bound to that redirect.
 * 3. Open an auth session; the server redirects back to the deep link with
 *    `token` + `refreshToken` query params on success.
 * 4. Persist both tokens.
 *
 * The deep link is the redirect target the server must allow-list. The exact
 * query-param names below assume the server appends `?token=&refreshToken=`;
 * if the server uses a different param shape (e.g. a one-time code to exchange),
 * adjust the parsing block.
 */
export async function loginWithGithub(): Promise<GithubLoginResult> {
  const redirectUri = Linking.createURL('auth/github'); // lucymobile://auth/github

  const start = await githubOAuthStart(redirectUri);
  if (!start.ok) {
    if (start.reason === 'no-backend') return { ok: false, reason: 'no-backend' };
    const detail = start.reason === 'http' ? `${start.status} ${start.body}` : start.message;
    return { ok: false, reason: 'start-failed', detail };
  }

  const result = await WebBrowser.openAuthSessionAsync(start.url, redirectUri);
  if (result.type !== 'success' || !result.url) {
    return { ok: false, reason: 'cancelled' };
  }

  const { queryParams } = Linking.parse(result.url);
  const token = typeof queryParams?.token === 'string' ? queryParams.token : null;
  const refreshToken =
    typeof queryParams?.refreshToken === 'string' ? queryParams.refreshToken : null;

  // TODO: if the server returns a short-lived `code` instead of tokens directly,
  // POST it to a token-exchange endpoint here before persisting.
  if (!token || !refreshToken) {
    return { ok: false, reason: 'no-tokens' };
  }

  await setTokens(token, refreshToken);
  return { ok: true };
}
