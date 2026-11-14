/**
 * Wix REST client.
 *
 * One oddity worth knowing about: the Item SEO Tags reference documents the
 * endpoint as `/seo-metatags-server/v1/item-seo-tags/...` in its Endpoint
 * field, while every cURL example on the same pages uses
 * `/promote/seo/v1/item-seo-tags/...`. The docs contradict themselves, and we
 * have no Wix account to settle it. So the client tries the documented path,
 * falls back to the example path on a 404, and remembers which one answered.
 * Both are recorded so the real-account checklist can confirm which is live.
 */

import { AuthError, ConnectorError } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import type { PlannedRequest } from '../../core/connector.js';
import type { WixAuth } from './auth.js';

const API_BASE = 'https://www.wixapis.com';

/** Documented first, cURL-example path second. */
export const SEO_PATH_CANDIDATES = ['/seo-metatags-server/v1', '/promote/seo/v1'] as const;

export interface WixApiOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  dryRunSink?: (req: PlannedRequest) => void;
}

export interface WixRequestInit {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  describes?: string;
}

export class WixApi {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly dryRunSink?: (req: PlannedRequest) => void;

  /** Which SEO base path actually answered; null until discovered. */
  private seoBase: string | null = null;

  constructor(private readonly auth: WixAuth, opts: WixApiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.dryRunSink = opts.dryRunSink;
  }

  get resolvedSeoBase(): string | null {
    return this.seoBase;
  }

  async request<T>(path: string, init: WixRequestInit = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = buildUrl(path, init.query);

    if (this.dryRunSink && method !== 'GET') {
      this.dryRunSink({
        method,
        url,
        headers: { authorization: '[redacted]', 'content-type': 'application/json' },
        body: init.body,
        describes: init.describes ?? `${method} ${path}`,
      });
      return undefined as T;
    }

    return this.send<T>(url, method, init.body, path);
  }

  /**
   * Call an SEO endpoint, discovering which base path this account serves.
   *
   * Once one answers it is reused, so the fallback costs at most one extra
   * request per connection.
   */
  async seoRequest<T>(suffix: string, init: WixRequestInit = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();

    const bases = this.seoBase ? [this.seoBase] : [...SEO_PATH_CANDIDATES];

    let lastError: unknown;
    for (const base of bases) {
      const path = `${base}${suffix}`;
      const url = buildUrl(path, init.query);

      if (this.dryRunSink && method !== 'GET') {
        this.dryRunSink({
          method,
          url,
          headers: { authorization: '[redacted]', 'content-type': 'application/json' },
          body: init.body,
          describes: init.describes ?? `${method} ${path}`,
        });
        return undefined as T;
      }

      try {
        const result = await this.send<T>(url, method, init.body, path);
        if (this.seoBase !== base) {
          this.seoBase = base;
          log.info('resolved Wix SEO base path', { base });
        }
        return result;
      } catch (err) {
        // Only a missing route justifies trying the other spelling; an auth or
        // validation failure means we found the endpoint and it said no.
        if (err instanceof ConnectorError && err.code === 'NOT_FOUND') {
          lastError = err;
          continue;
        }
        if (this.seoBase !== base && bases.length > 1) this.seoBase = base;
        throw err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ConnectorError('No Wix SEO endpoint responded.', 'NOT_FOUND', false);
  }

  private async send<T>(url: string, method: string, body: unknown, path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        ...(await this.auth.headers()),
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      };

      const res = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
        throw new ConnectorError(`Wix request timed out after ${this.timeoutMs}ms`, 'TIMEOUT', true);
      }
      throw new ConnectorError(
        `Wix request failed: ${err instanceof Error ? err.message : String(err)}`, 'NETWORK', true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private toError(status: number, body: unknown, method: string, path: string): ConnectorError {
    const detail = body as { message?: string; details?: { applicationError?: { code?: string } } } | null;
    const message = detail?.message ?? `HTTP ${status}`;
    const appCode = detail?.details?.applicationError?.code;

    if (status === 401) {
      this.auth.invalidate();
      return new AuthError(`Wix rejected the credentials: ${message}`, { status, path });
    }
    if (status === 403) {
      return new ConnectorError(
        this.auth.identity === 'api-key'
          ? 'Wix refused this call for an API key. SEO tags require an installed app (the Wix app ' +
            'identity); an API key is a different identity and cannot write them.'
          : `Wix refused this call: ${message}. The app is probably missing the MANAGE SEO SETTINGS scope.`,
        'FORBIDDEN', false, { status, path, appCode },
      );
    }
    if (status === 404) {
      return new ConnectorError(`No Wix route for ${method} ${path}`, 'NOT_FOUND', false, { status });
    }
    if (appCode === 'DRAFT_SAVED_NOT_PUBLISHED') {
      return new ConnectorError(
        'The change was saved to the page draft, but the page has no published revision to update. ' +
        'Publish the page in the Wix editor, then re-apply.',
        'DRAFT_SAVED_NOT_PUBLISHED', false, { status, appCode },
      );
    }
    if (appCode === 'LANGUAGE_NOT_SUPPORTED') {
      return new ConnectorError(
        'Wix only accepts SEO tag writes for a site\'s primary language.',
        'LANGUAGE_NOT_SUPPORTED', false, { status, appCode },
      );
    }
    if (status === 429 || status >= 500) {
      return new ConnectorError(`Wix returned ${status}: ${message}`, 'UPSTREAM', true, { status });
    }
    return new ConnectorError(`Wix returned ${status}: ${message}`, appCode ?? 'WIX_API', false, { status, path });
  }
}

function buildUrl(path: string, query?: WixRequestInit['query']): string {
  const url = new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}
