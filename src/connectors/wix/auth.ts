/**
 * Wix authentication.
 *
 * The spike this phase opened with has a clear answer, and it is not the
 * convenient one. The Item SEO Tags API states: "You can only call this method
 * when authenticated as a Wix app or Wix user identity." Wix's Identities doc
 * lists "API key admin" as a THIRD identity, distinct from both — and the auth
 * quick reference says acting as a Wix user is SDK-only, not available over
 * REST.
 *
 * So writing SEO tags over REST requires the Wix app identity: an app the
 * consultant installs on their site, authenticated with client_credentials
 * against a specific app instance. A pasted API key will not do it.
 *
 * That changes the connect UX for Wix — it cannot be "three or four fields"
 * like WordPress. We still support an API key, because a doc sentence is not a
 * test, and `testConnection` probes what the credential can actually do rather
 * than refusing on principle.
 */

import { AuthError } from '../../core/errors.js';
import { registerSecret, log } from '../../core/logger.js';

const TOKEN_URL = 'https://www.wixapis.com/oauth2/token';

/** An installed app acting on one site. The only identity that can write SEO. */
export interface WixAppCredentials {
  kind: 'app';
  clientId: string;
  clientSecret: string;
  /**
   * The app instance on the consultant's site, delivered by the App Instance
   * Installed webhook or the install redirect. One instance per site.
   */
  instanceId: string;
}

/** Account-level admin key. Cannot write SEO tags; kept so we can say why. */
export interface WixApiKeyCredentials {
  kind: 'api-key';
  apiKey: string;
  siteId: string;
  accountId?: string;
}

export type WixCredentials = WixAppCredentials | WixApiKeyCredentials;

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class WixAuth {
  private cached?: CachedToken;

  constructor(
    private readonly creds: WixCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    registerSecret(creds.kind === 'app' ? creds.clientSecret : creds.apiKey);
  }

  get identity(): 'app' | 'api-key' {
    return this.creds.kind === 'app' ? 'app' : 'api-key';
  }

  /** Headers for an API call, refreshing the app token when needed. */
  async headers(): Promise<Record<string, string>> {
    if (this.creds.kind === 'api-key') {
      return {
        // Wix sends the credential raw, with no Bearer prefix.
        authorization: this.creds.apiKey,
        'wix-site-id': this.creds.siteId,
        ...(this.creds.accountId ? { 'wix-account-id': this.creds.accountId } : {}),
      };
    }
    return { authorization: await this.accessToken() };
  }

  /**
   * App access token, cached until shortly before it expires.
   *
   * Wix issues these for four hours. We refresh a minute early so a request
   * cannot fail on a token that expires mid-flight.
   */
  async accessToken(): Promise<string> {
    if (this.creds.kind !== 'app') {
      throw new AuthError('An app access token requires app credentials, not an API key.');
    }
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;

    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        instance_id: this.creds.instanceId,
      }),
    });

    const text = await res.text();
    let body: { access_token?: string; expires_in?: number; message?: string } = {};
    try { body = JSON.parse(text) as typeof body; } catch { /* non-JSON error body */ }

    if (!res.ok || !body.access_token) {
      throw new AuthError(
        `Wix refused the app credentials (HTTP ${res.status}). ${body.message ?? ''}`.trim(),
        { status: res.status },
      );
    }

    registerSecret(body.access_token);
    const ttl = (body.expires_in ?? 14_400) * 1000;
    this.cached = { token: body.access_token, expiresAt: Date.now() + ttl - 60_000 };
    log.debug('obtained Wix app access token', { expiresInSeconds: body.expires_in });
    return body.access_token;
  }

  /** Drop the cached token, forcing a refresh. Used after a 401. */
  invalidate(): void {
    this.cached = undefined;
  }
}

/**
 * The install URL a consultant opens to put our app on their site.
 *
 * This is the step that has no WordPress equivalent, and the UI must explain
 * it: the consultant signs in to Wix, picks the site, and approves the
 * permission scopes. Only then do we have an instance to act on.
 */
export function installUrl(appId: string, redirectUri: string, state?: string): string {
  const url = new URL('https://www.wix.com/installer/install');
  url.searchParams.set('appId', appId);
  url.searchParams.set('redirectUrl', redirectUri);
  url.searchParams.set('response_type', 'code');
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** Scopes the app must request. Without these the SEO calls 403. */
export const REQUIRED_SCOPES = [
  'SEO.MANAGE-SEO-SETTINGS',
  'SEO.VIEW-SEO-SETTINGS',
] as const;
