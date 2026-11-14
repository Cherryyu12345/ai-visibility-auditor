/**
 * Cloudflare REST API client.
 *
 * Endpoint shapes verified against the current API reference rather than
 * recalled: Workers upload is a multipart PUT whose metadata names the entry
 * module, KV lives under /accounts/{id}/storage/kv, and Worker routes are a
 * zone-level resource.
 */

import { AuthError, ConnectorError } from '../../core/errors.js';
import { registerSecret } from '../../core/logger.js';
import type { PlannedRequest } from '../../core/connector.js';

const API_BASE = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

export interface Zone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  name_servers?: string[];
  original_name_servers?: string[];
  account: { id: string; name: string };
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

export interface CloudflareCredentials {
  /** Scoped API token. Never a global API key. */
  apiToken: string;
  /** The single zone this connection may touch. */
  zoneId?: string;
  /** Convenience when the zone id is not yet known. */
  domain?: string;
}

export interface CloudflareApiOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  dryRunSink?: (req: PlannedRequest) => void;
}

export class CloudflareApi {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly dryRunSink?: (req: PlannedRequest) => void;

  constructor(private readonly creds: CloudflareCredentials, opts: CloudflareApiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.dryRunSink = opts.dryRunSink;
    registerSecret(creds.apiToken);
  }

  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown; describes?: string; raw?: BodyInit; contentType?: string } = {},
  ): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = `${API_BASE}${path}`;

    if (this.dryRunSink && method !== 'GET') {
      this.dryRunSink({
        method,
        url,
        headers: { authorization: 'Bearer [redacted]' },
        body: init.body ?? (init.raw ? '[binary/multipart]' : undefined),
        describes: init.describes ?? `${method} ${path}`,
      });
      return undefined as T;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${this.creds.apiToken}` };
      let body: BodyInit | undefined;

      if (init.raw !== undefined) {
        body = init.raw;
        // FormData sets its own boundary; never set content-type for it.
        if (init.contentType) headers['content-type'] = init.contentType;
      } else if (init.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.body);
      }

      const res = await this.fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal });
      const text = await res.text();

      let parsed: Envelope<T> | undefined;
      try { parsed = text ? (JSON.parse(text) as Envelope<T>) : undefined; } catch { /* non-JSON */ }

      if (res.status === 401 || res.status === 403) {
        throw new AuthError(
          `Cloudflare rejected the API token (HTTP ${res.status}). ${firstError(parsed)}`,
          { status: res.status, path },
        );
      }
      if (!res.ok || (parsed && parsed.success === false)) {
        throw new ConnectorError(
          `Cloudflare API error on ${method} ${path}: ${firstError(parsed) || `HTTP ${res.status}`}`,
          'CF_API', res.status >= 500 || res.status === 429, { status: res.status },
        );
      }
      return (parsed?.result ?? (undefined as T));
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ConnectorError(`Cloudflare request timed out after ${this.timeoutMs}ms`, 'TIMEOUT', true);
      }
      throw new ConnectorError(
        `Cloudflare request failed: ${err instanceof Error ? err.message : String(err)}`, 'NETWORK', true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ tokens

  /** Confirm the token is live. Does not tell us which permissions it carries. */
  async verifyToken(): Promise<{ status: string }> {
    return this.call<{ status: string }>('/user/tokens/verify');
  }

  // ------------------------------------------------------------------- zones

  async listZones(name?: string): Promise<Zone[]> {
    const q = name ? `?name=${encodeURIComponent(name)}` : '';
    return (await this.call<Zone[]>(`/zones${q}`)) ?? [];
  }

  async getZone(zoneId: string): Promise<Zone> {
    return this.call<Zone>(`/zones/${zoneId}`);
  }

  async getSslMode(zoneId: string): Promise<string | null> {
    try {
      const r = await this.call<{ value: string }>(`/zones/${zoneId}/settings/ssl`);
      return r?.value ?? null;
    } catch {
      // Reading zone settings needs its own permission; absence is not fatal.
      return null;
    }
  }

  async listDnsRecords(zoneId: string): Promise<DnsRecord[]> {
    return (await this.call<DnsRecord[]>(`/zones/${zoneId}/dns_records?per_page=100`)) ?? [];
  }

  // ---------------------------------------------------------------------- KV

  async listKvNamespaces(accountId: string): Promise<Array<{ id: string; title: string }>> {
    return (await this.call<Array<{ id: string; title: string }>>(
      `/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
    )) ?? [];
  }

  async createKvNamespace(accountId: string, title: string): Promise<{ id: string; title: string }> {
    return this.call(`/accounts/${accountId}/storage/kv/namespaces`, {
      method: 'POST', body: { title }, describes: `Create KV namespace "${title}"`,
    });
  }

  async kvPut(accountId: string, namespaceId: string, key: string, value: string): Promise<void> {
    await this.call(
      `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      { method: 'PUT', raw: value, contentType: 'text/plain', describes: `Write KV key ${key}` },
    );
  }

  async kvGet(accountId: string, namespaceId: string, key: string): Promise<string | null> {
    const url = `${API_BASE}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
    try {
      const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.creds.apiToken}` } });
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  async kvListKeys(accountId: string, namespaceId: string, prefix?: string): Promise<string[]> {
    const q = prefix ? `?prefix=${encodeURIComponent(prefix)}&limit=1000` : '?limit=1000';
    const keys = await this.call<Array<{ name: string }>>(
      `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys${q}`,
    );
    return (keys ?? []).map((k) => k.name);
  }

  async kvDelete(accountId: string, namespaceId: string, key: string): Promise<void> {
    await this.call(
      `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      { method: 'DELETE', describes: `Delete KV key ${key}` },
    );
  }

  // ----------------------------------------------------------------- workers

  /**
   * Upload an ES-module Worker.
   *
   * multipart/form-data: a JSON `metadata` part naming the entry module in
   * `main_module`, plus each module as its own part with the
   * `application/javascript+module` content type.
   */
  async uploadWorker(
    accountId: string,
    scriptName: string,
    source: string,
    bindings: Array<Record<string, unknown>>,
    compatibilityDate: string,
  ): Promise<{ id: string }> {
    const entry = 'worker.js';
    const form = new FormData();
    form.set(
      'metadata',
      new Blob(
        [JSON.stringify({ main_module: entry, bindings, compatibility_date: compatibilityDate })],
        { type: 'application/json' },
      ),
    );
    form.set(entry, new Blob([source], { type: 'application/javascript+module' }), entry);

    return this.call(`/accounts/${accountId}/workers/scripts/${scriptName}`, {
      method: 'PUT', raw: form, describes: `Upload Worker "${scriptName}"`,
    });
  }

  async deleteWorker(accountId: string, scriptName: string): Promise<void> {
    await this.call(`/accounts/${accountId}/workers/scripts/${scriptName}`, {
      method: 'DELETE', describes: `Delete Worker "${scriptName}"`,
    });
  }

  async listRoutes(zoneId: string): Promise<Array<{ id: string; pattern: string; script: string }>> {
    return (await this.call<Array<{ id: string; pattern: string; script: string }>>(
      `/zones/${zoneId}/workers/routes`,
    )) ?? [];
  }

  async createRoute(zoneId: string, pattern: string, script: string): Promise<{ id: string }> {
    return this.call(`/zones/${zoneId}/workers/routes`, {
      method: 'POST', body: { pattern, script }, describes: `Route ${pattern} to Worker "${script}"`,
    });
  }

  async deleteRoute(zoneId: string, routeId: string): Promise<void> {
    await this.call(`/zones/${zoneId}/workers/routes/${routeId}`, {
      method: 'DELETE', describes: `Remove Worker route ${routeId}`,
    });
  }
}

function firstError(env?: Envelope<unknown>): string {
  return env?.errors?.[0] ? `${env.errors[0].message} (code ${env.errors[0].code})` : '';
}
