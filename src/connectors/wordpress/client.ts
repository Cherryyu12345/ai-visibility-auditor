/**
 * Thin WordPress REST client.
 *
 * Authentication is an Application Password (core since 5.6). Two practical
 * facts shape this file:
 *   - Application Passwords are only offered over HTTPS, or on a site WordPress
 *     considers a local environment. We surface that rather than guessing.
 *   - Many hosts and some FastCGI setups strip the Authorization header before
 *     PHP sees it. The symptom is an anonymous 401 on every write, which looks
 *     like a wrong password. `diagnoseAuth` tells the two apart.
 */

import { AuthError, ConnectorError } from '../../core/errors.js';
import { log, registerSecret } from '../../core/logger.js';
import type { PlannedRequest } from '../../core/connector.js';

export interface WpCredentials {
  siteUrl: string;
  username: string;
  /** Application Password. WordPress accepts it with or without spaces. */
  applicationPassword: string;
}

export interface WpClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** When set, requests are recorded here instead of sent. */
  dryRunSink?: (req: PlannedRequest) => void;
}

export interface WpRequestInit {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Plain-language effect, required for anything that writes. */
  describes?: string;
  /** Namespace: 'wp/v2' by default, or our bridge plugin's namespace. */
  namespace?: string;
}

export class WordPressClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly dryRunSink?: (req: PlannedRequest) => void;

  constructor(private readonly creds: WpCredentials, opts: WpClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.dryRunSink = opts.dryRunSink;
    registerSecret(creds.applicationPassword);
    registerSecret(creds.applicationPassword.replace(/\s/g, ''));
  }

  get siteUrl(): string {
    return this.creds.siteUrl.replace(/\/+$/, '');
  }

  private authHeader(): string {
    const token = Buffer.from(`${this.creds.username}:${this.creds.applicationPassword}`).toString('base64');
    return `Basic ${token}`;
  }

  private buildUrl(path: string, namespace = 'wp/v2', query?: WpRequestInit['query']): string {
    const clean = path.replace(/^\/+/, '');
    const url = new URL(`${this.siteUrl}/wp-json/${namespace}/${clean}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** Is this request a write? Used to require a dry-run description. */
  private static isWrite(method: string): boolean {
    return method !== 'GET' && method !== 'HEAD';
  }

  async request<T>(path: string, init: WpRequestInit = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = this.buildUrl(path, init.namespace, init.query);

    if (this.dryRunSink && WordPressClient.isWrite(method)) {
      this.dryRunSink({
        method,
        url,
        // The real Authorization value never enters the dry-run view.
        headers: { 'content-type': 'application/json', authorization: 'Basic [redacted]' },
        body: init.body,
        describes: init.describes ?? `${method} ${path}`,
      });
      return undefined as T;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: this.authHeader(),
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'follow',
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

      if (!res.ok) throw this.toError(res.status, parsed, method, path);
      return parsed as T;
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ConnectorError(`WordPress request timed out after ${this.timeoutMs}ms`, 'TIMEOUT', true);
      }
      throw new ConnectorError(
        `WordPress request failed: ${err instanceof Error ? err.message : String(err)}`,
        'NETWORK', true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private toError(status: number, body: unknown, method: string, path: string): ConnectorError {
    const code = (body as { code?: string } | null)?.code ?? 'http_error';
    const message = (body as { message?: string } | null)?.message ?? `HTTP ${status}`;

    if (status === 401 || code === 'rest_not_logged_in' || code === 'incorrect_password') {
      return new AuthError(
        `WordPress rejected the credentials (${code}). If the password is definitely correct, ` +
        'the host is probably stripping the Authorization header.',
        { status, code, path },
      );
    }
    if (status === 403 && code === 'rest_cannot_edit') {
      return new ConnectorError(
        `The connected user lacks permission to edit this content (${code}).`,
        'FORBIDDEN', false, { status, code, path },
      );
    }
    if (status === 404 && code === 'rest_no_route') {
      return new ConnectorError(
        `No REST route for ${method} ${path}. If this is a bridge endpoint, the companion plugin is not active.`,
        'NO_ROUTE', false, { status, code, path },
      );
    }
    if (status === 429 || status >= 500) {
      return new ConnectorError(`WordPress returned ${status}: ${message}`, 'UPSTREAM', true, { status, code });
    }
    return new ConnectorError(`WordPress returned ${status}: ${message}`, code, false, { status, code, path });
  }

  /**
   * Distinguish a wrong password from a stripped Authorization header.
   *
   * These have completely different fixes, and WordPress gives no help: a bad
   * password, a bad username, a malformed header and no header at all ALL
   * return 401 `rest_not_logged_in`, with no WWW-Authenticate header. We
   * confirmed that against a live site rather than assuming it.
   *
   * So the only reliable way to tell them apart is to ask PHP what it actually
   * received, which the companion plugin exposes. Without the plugin we cannot
   * know, and we say so instead of guessing — a confident wrong diagnosis here
   * sends people to edit .htaccess when their password was simply mistyped.
   */
  async diagnoseAuth(): Promise<{ ok: boolean; reason: string; remedy?: string }> {
    const meUrl = this.buildUrl('users/me');

    const withAuth = await this.rawStatus(meUrl, { authorization: this.authHeader() });
    if (withAuth.status === 200) return { ok: true, reason: 'Authenticated successfully.' };

    const echo = await this.authEcho();

    if (echo && !echo.authorization_header_received) {
      return {
        ok: false,
        reason:
          'WordPress never received the Authorization header — the host or proxy stripped it ' +
          'before PHP saw the request. The password is not the problem.',
        remedy:
          'Add to .htaccess:  SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1  ' +
          '(on nginx/FastCGI: fastcgi_pass_header Authorization;). Then reconnect.',
      };
    }

    if (echo && !echo.application_passwords_available) {
      return {
        ok: false,
        reason:
          `WordPress is refusing Application Passwords on this site (environment: ${echo.environment}, ` +
          `TLS: ${echo.is_ssl ? 'on' : 'off'}).`,
        remedy: 'Application Passwords require HTTPS outside local development. Enable TLS, then reconnect.',
      };
    }

    if (echo) {
      return {
        ok: false,
        reason: 'WordPress received credentials and rejected them.',
        remedy: 'Generate a fresh Application Password under Users → Profile and reconnect.',
      };
    }

    // No companion plugin: be honest that both causes remain open.
    return {
      ok: false,
      reason:
        'Authentication failed. WordPress returns the same error for a wrong password and for a ' +
        'stripped Authorization header, so without the companion plugin we cannot tell which it is.',
      remedy:
        'First try a freshly generated Application Password. If that still fails, the host is ' +
        'stripping the Authorization header — add to .htaccess:  ' +
        'SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1',
    };
  }

  /** Ask the companion plugin what PHP actually received. Null when absent. */
  private async authEcho(): Promise<{
    authorization_header_received: boolean;
    application_passwords_available: boolean;
    is_ssl: boolean;
    environment: string;
  } | null> {
    try {
      const res = await this.fetchImpl(
        `${this.siteUrl}/wp-json/ai-visibility-bridge/v1/auth-echo`,
        { headers: { authorization: this.authHeader(), accept: 'application/json' }, redirect: 'follow' },
      );
      if (!res.ok) return null;
      return (await res.json()) as never;
    } catch {
      return null;
    }
  }

  private async rawStatus(url: string, headers: Record<string, string>): Promise<{ status: number; code?: string }> {
    try {
      const res = await this.fetchImpl(url, { headers: { accept: 'application/json', ...headers }, redirect: 'follow' });
      const text = await res.text();
      let code: string | undefined;
      try { code = (JSON.parse(text) as { code?: string }).code; } catch { /* non-JSON body */ }
      return { status: res.status, code };
    } catch (err) {
      log.debug('raw status probe failed', { url, error: err instanceof Error ? err.message : String(err) });
      return { status: 0 };
    }
  }

  /** Fetch the REST index, used for capability and plugin detection. */
  async index(): Promise<{ namespaces: string[]; name?: string; description?: string }> {
    const res = await this.fetchImpl(`${this.siteUrl}/wp-json/`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new ConnectorError(`REST root returned HTTP ${res.status}`, 'NO_REST', false);
    return (await res.json()) as { namespaces: string[] };
  }
}
