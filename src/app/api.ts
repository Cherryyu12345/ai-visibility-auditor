/**
 * HTTP API.
 *
 * Kept separate from the server so it can be driven directly in tests without
 * opening a socket. Every handler returns a plain `{ status, body }`.
 *
 * Two rules hold throughout:
 *   - a stored credential never leaves this process (see `publicConnection`);
 *   - a share-link caller can approve and reject, and can reach nothing else.
 */

import { z } from 'zod';
import { seal } from '../core/crypto.js';
import { registerSecret } from '../core/logger.js';
import { ConnectorError } from '../core/errors.js';
import type { Change } from '../core/types.js';
import { Store, StateError } from '../store/store.js';
import type { Connection, ConnectionKind, ShareToken, Site } from '../store/types.js';
import { Engine } from './engine.js';
import { buildConnector, primaryKindFor } from './registry.js';
import { detectSite, normaliseSiteUrl } from './detect-site.js';
import {
  InvalidShareLink, issueShareLink, resolveShareLink, revokeShareLink, shareActor,
} from './share.js';

export interface ApiContext {
  store: Store;
  engine: Engine;
  /** Who the audit log records for anything done through the main UI. */
  operator: string;
  fetchImpl?: typeof fetch;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const SECRET_FIELDS: Record<ConnectionKind, string[]> = {
  wordpress: ['applicationPassword'],
  cloudflare: ['apiToken'],
  wix: ['clientSecret', 'apiKey'],
  squarespace: [],
};

/** Connection as the UI may see it: config yes, credential never. */
export function publicConnection(conn: Connection) {
  return {
    id: conn.id,
    siteId: conn.siteId,
    kind: conn.kind,
    label: conn.label,
    config: conn.config,
    hasCredential: conn.secret !== null,
    createdAt: conn.createdAt,
    lastTestedAt: conn.lastTestedAt,
    lastTestOk: conn.lastTestOk,
    lastChecks: conn.lastChecks,
    capabilities: conn.capabilities,
  };
}

function publicShare(share: ShareToken) {
  return {
    id: share.id,
    changeIds: share.changeIds,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    usedBy: share.usedBy,
    expired: share.expiresAt.getTime() < Date.now(),
  };
}

const siteInput = z.object({
  url: z.string().min(3),
  name: z.string().min(1).optional(),
  platform: z.enum(['wordpress', 'wix', 'squarespace', 'custom', 'unknown']).optional(),
});

const connectionInput = z.object({
  kind: z.enum(['wordpress', 'wix', 'squarespace', 'cloudflare']),
  config: z.record(z.string()).default({}),
  secret: z.record(z.string()).default({}),
});

const changeInput = z.object({
  page: z.string().min(1),
  field: z.enum([
    'title', 'meta_description', 'seo_title', 'canonical', 'robots_meta', 'slug',
    'excerpt', 'image_alt', 'content_block', 'json_ld', 'robots_txt', 'llms_txt',
  ]),
  target: z.string().optional(),
  before: z.string().nullable().default(null),
  after: z.string(),
  reason: z.string().default(''),
});

export function createApi(ctx: ApiContext) {
  const { store, engine } = ctx;

  return async function handle(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse> {
    try {
      return await route(method, path, body);
    } catch (err) {
      return errorResponse(err);
    }
  };

  async function route(method: string, path: string, body: unknown): Promise<ApiResponse> {
    const segments = path.replace(/^\/+|\/+$/g, '').split('/');
    // Everything here is under /api.
    if (segments[0] !== 'api') return { status: 404, body: { error: 'Not found' } };
    const rest = segments.slice(1);

    // ------------------------------------------------- share link (no account)
    if (rest[0] === 'share' && rest[1]) {
      return shareRoutes(method, rest[1], rest[2], body);
    }

    if (rest[0] === 'config' && method === 'GET') {
      return { status: 200, body: { operator: ctx.operator } };
    }

    // ------------------------------------------------------------------ sites
    if (rest[0] === 'sites') {
      if (!rest[1]) {
        if (method === 'GET') return { status: 200, body: { sites: store.listSites() } };
        if (method === 'POST') return createSite(body);
        return methodNotAllowed();
      }

      const siteId = rest[1];
      const sub = rest[2];

      if (!sub) {
        if (method === 'GET') return { status: 200, body: siteOverview(siteId) };
        if (method === 'PATCH') return patchSite(siteId, body);
        return methodNotAllowed();
      }

      switch (sub) {
        case 'connections':
          if (method === 'GET') {
            return { status: 200, body: { connections: store.listConnections(siteId).map(publicConnection) } };
          }
          if (method === 'POST') return connect(siteId, body);
          return methodNotAllowed();

        case 'changes':
          if (method === 'GET') return { status: 200, body: { changes: store.listChanges(siteId) } };
          if (method === 'POST') return addChanges(siteId, body);
          return methodNotAllowed();

        case 'approve-all':
          if (method !== 'POST') return methodNotAllowed();
          return {
            status: 200,
            body: {
              approved: await engine.approveAll(
                siteId, ctx.operator,
                (body as { changeIds?: string[] })?.changeIds,
              ),
            },
          };

        case 'plan':
          if (method !== 'GET') return methodNotAllowed();
          return { status: 200, body: { plan: await engine.plan(siteId) } };

        case 'apply': {
          if (method !== 'POST') return methodNotAllowed();
          const dryRun = Boolean((body as { dryRun?: boolean })?.dryRun);
          return { status: 200, body: await engine.apply(siteId, ctx.operator, dryRun) };
        }

        case 'batches':
          if (method !== 'GET') return methodNotAllowed();
          return { status: 200, body: { batches: store.listBatches(siteId) } };

        case 'audit':
          if (method !== 'GET') return methodNotAllowed();
          return { status: 200, body: { audit: store.listAudit(siteId) } };

        case 'shares':
          if (method === 'GET') {
            return { status: 200, body: { shares: store.listShareTokens(siteId).map(publicShare) } };
          }
          if (method === 'POST') return createShare(siteId, body);
          return methodNotAllowed();

        default:
          return { status: 404, body: { error: 'Not found' } };
      }
    }

    // ------------------------------------------------------------ connections
    if (rest[0] === 'connections' && rest[1]) {
      const id = rest[1];
      if (rest[2] === 'test' && method === 'POST') return testConnection(id);
      if (!rest[2] && method === 'DELETE') return disconnect(id);
      return methodNotAllowed();
    }

    // ---------------------------------------------------------------- changes
    if (rest[0] === 'changes' && rest[1]) {
      const id = rest[1];
      const action = rest[2];
      if (method === 'GET' && !action) {
        return { status: 200, body: { change: store.requireChange(id) } };
      }
      if (method === 'GET' && action === 'card') {
        return { status: 200, body: { card: engine.cardFor(store.requireChange(id)) } };
      }
      if (method !== 'POST') return methodNotAllowed();

      switch (action) {
        case 'approve':
          return { status: 200, body: { change: await engine.approve(id, ctx.operator) } };
        case 'reject':
          return {
            status: 200,
            body: { change: await engine.reject(id, ctx.operator, (body as { note?: string })?.note) },
          };
        case 'mark-done':
          return { status: 200, body: await engine.markManualDone(id, ctx.operator) };
        case 'rollback':
          return { status: 200, body: await engine.rollbackChange(id, ctx.operator) };
        default:
          return { status: 404, body: { error: 'Not found' } };
      }
    }

    // ---------------------------------------------------------------- batches
    if (rest[0] === 'batches' && rest[1] && rest[2] === 'rollback' && method === 'POST') {
      return { status: 200, body: await engine.rollbackBatch(rest[1], ctx.operator) };
    }

    // ----------------------------------------------------------------- shares
    if (rest[0] === 'shares' && rest[1] && rest[2] === 'revoke' && method === 'POST') {
      return { status: 200, body: { share: publicShare(await revokeShareLink(store, rest[1], ctx.operator)) } };
    }

    return { status: 404, body: { error: 'Not found' } };
  }

  // ------------------------------------------------------------------ handlers

  async function createSite(body: unknown): Promise<ApiResponse> {
    const input = siteInput.parse(body);
    const url = normaliseSiteUrl(input.url);

    const detection = input.platform
      ? null
      : await detectSite(url, ctx.fetchImpl ?? fetch);

    const site = await store.addSite({
      name: input.name ?? new URL(url).hostname,
      url,
      platform: input.platform ?? detection?.platform ?? 'unknown',
      platformOverridden: Boolean(input.platform),
      ...(detection ? { detectionConfidence: detection.confidence } : {}),
    });

    await store.appendAudit({
      siteId: site.id, actor: ctx.operator, action: 'site_added',
      detail: { url, platform: site.platform, detected: !input.platform },
    });

    return { status: 201, body: { site, detection } };
  }

  async function patchSite(siteId: string, body: unknown): Promise<ApiResponse> {
    const input = siteInput.partial().parse(body ?? {});
    const patch: Partial<Site> = {};
    if (input.name) patch.name = input.name;
    if (input.platform) {
      patch.platform = input.platform;
      patch.platformOverridden = true;
    }
    const site = await store.updateSite(siteId, patch);
    await store.appendAudit({
      siteId, actor: ctx.operator, action: 'site_updated', detail: { ...patch },
    });
    return { status: 200, body: { site } };
  }

  function siteOverview(siteId: string): unknown {
    const site = store.requireSite(siteId);
    const changes = store.listChanges(siteId);
    const counts = changes.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      site,
      connections: store.listConnections(siteId).map(publicConnection),
      counts,
      /** Which connection kind this platform needs, for the Connect step. */
      primaryKind: primaryKindFor(site.platform),
    };
  }

  /**
   * Store a credential.
   *
   * The secret is sealed immediately and the plaintext is registered with the
   * log redactor first, so that even an exception thrown between here and the
   * connector cannot carry it into a log line.
   */
  async function connect(siteId: string, body: unknown): Promise<ApiResponse> {
    const site = store.requireSite(siteId);
    const input = connectionInput.parse(body);

    const allowed = SECRET_FIELDS[input.kind];
    const provided = Object.keys(input.secret).filter((k) => input.secret[k]);
    const unexpected = provided.filter((k) => !allowed.includes(k));
    if (unexpected.length) {
      return {
        status: 400,
        body: { error: `A ${input.kind} connection does not take: ${unexpected.join(', ')}.` },
      };
    }
    for (const value of Object.values(input.secret)) registerSecret(value);

    const conn = await store.putConnection({
      siteId,
      kind: input.kind,
      label: labelFor(input.kind, input.config, site),
      config: input.config,
      secret: provided.length ? seal(input.secret) : null,
    });

    await store.appendAudit({
      siteId, actor: ctx.operator, action: 'connected',
      // The config keys are recorded, never the values, so the log shows what
      // kind of access was granted without becoming a place secrets live.
      detail: { kind: input.kind, fields: Object.keys(input.config), credential: provided.length > 0 },
    });

    return { status: 201, body: { connection: publicConnection(conn) } };
  }

  async function testConnection(connectionId: string): Promise<ApiResponse> {
    const conn = store.getConnection(connectionId);
    if (!conn) return { status: 404, body: { error: 'No such connection' } };
    const site = store.requireSite(conn.siteId);

    const connector = buildConnector(conn, site, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {});
    const result = await connector.testConnection();

    const updated = await store.updateConnection(connectionId, {
      lastTestedAt: new Date(),
      lastTestOk: result.ok,
      lastChecks: result.checks,
      // WordPress resolves setSeoMeta and friends against the live site during
      // the test; capturing it here is what lets routing be right later.
      capabilities: { ...connector.capabilities } as Record<string, boolean>,
      // And how it resolved them, so applying does not have to probe the site
      // again — the probe writes a throwaway draft, which is not something to
      // repeat on every batch.
      ...(resolvedStateOf(connector) !== undefined ? { resolvedState: resolvedStateOf(connector) } : {}),
    });

    await store.appendAudit({
      siteId: conn.siteId, actor: ctx.operator, action: 'connection_tested',
      detail: { kind: conn.kind, ok: result.ok },
    });

    return { status: 200, body: { test: result, connection: publicConnection(updated) } };
  }

  /** Disconnect: the stored credential is deleted, not merely unlinked. */
  async function disconnect(connectionId: string): Promise<ApiResponse> {
    const conn = store.getConnection(connectionId);
    if (!conn) return { status: 404, body: { error: 'No such connection' } };

    const removed = await store.deleteConnection(connectionId);
    await store.appendAudit({
      siteId: conn.siteId, actor: ctx.operator, action: 'disconnected',
      detail: { kind: conn.kind, credentialDeleted: conn.secret !== null },
    });
    // Force the delete to reach disk before telling anyone it is gone.
    await store.flush();
    return { status: 200, body: { removed } };
  }

  async function addChanges(siteId: string, body: unknown): Promise<ApiResponse> {
    store.requireSite(siteId);
    const payload = Array.isArray(body) ? body : (body as { changes?: unknown[] })?.changes ?? [];
    const parsed = z.array(changeInput).parse(payload);

    const created = await store.addChanges(
      parsed.map((c) => ({
        siteId,
        page: c.page,
        field: c.field,
        before: c.before,
        after: c.after,
        reason: c.reason,
        ...(c.target ? { target: c.target } : {}),
      })) as Array<Omit<Change, 'id' | 'createdAt' | 'updatedAt' | 'status'>>,
    );

    await store.appendAudit({
      siteId, actor: ctx.operator, action: 'changes_imported', detail: { count: created.length },
    });
    return { status: 201, body: { changes: created } };
  }

  async function createShare(siteId: string, body: unknown): Promise<ApiResponse> {
    const input = z.object({
      changeIds: z.array(z.string()).optional(),
      ttlDays: z.number().int().positive().max(90).optional(),
    }).parse(body ?? {});

    const changeIds = input.changeIds?.length
      ? input.changeIds
      : store.listChanges(siteId, ['draft']).map((c) => c.id);

    const { token, share } = await issueShareLink(
      store, siteId, changeIds, ctx.operator, input.ttlDays,
    );
    // The token is returned exactly once, here. It is not stored, so this is
    // the only moment it can be copied.
    return { status: 201, body: { share: publicShare(share), token, path: `/approve/${token}` } };
  }

  // ----------------------------------------------------------- share routes

  async function shareRoutes(
    method: string, token: string, action: string | undefined, body: unknown,
  ): Promise<ApiResponse> {
    let share: ShareToken;
    try {
      share = resolveShareLink(store, token);
    } catch (err) {
      if (err instanceof InvalidShareLink) return { status: 403, body: { error: err.message, code: err.code } };
      throw err;
    }

    const site = store.requireSite(share.siteId);

    if (method === 'GET' && !action) {
      // Only the named changes, and only the fields a reviewer needs. No
      // connection, credential, batch or audit data is reachable from here.
      const changes = share.changeIds
        .map((id) => store.getChange(id))
        .filter((c): c is Change => Boolean(c))
        .map((c) => ({
          id: c.id, page: c.page, field: c.field, target: c.target,
          before: c.before, after: c.after, reason: c.reason, status: c.status,
        }));
      return {
        status: 200,
        body: {
          site: { name: site.name, url: site.url },
          expiresAt: share.expiresAt,
          reviewer: share.usedBy,
          changes,
        },
      };
    }

    if (method !== 'POST') return methodNotAllowed();

    const input = z.object({
      changeId: z.string(),
      name: z.string().min(1).max(100).optional(),
      note: z.string().max(1000).optional(),
    }).parse(body);

    // A link may only touch the changes it was issued for.
    if (!share.changeIds.includes(input.changeId)) {
      return { status: 403, body: { error: 'That change is not part of this approval link.' } };
    }
    if (input.name && input.name !== share.usedBy) {
      share = await store.updateShareToken(share.id, { usedBy: input.name });
    }
    const actor = shareActor(share);

    if (action === 'approve') {
      return { status: 200, body: { change: await engine.approve(input.changeId, actor) } };
    }
    if (action === 'reject') {
      return { status: 200, body: { change: await engine.reject(input.changeId, actor, input.note) } };
    }
    // Deliberately nothing else: a share link cannot apply, roll back, read
    // the audit log, or see a credential.
    return { status: 404, body: { error: 'Not found' } };
  }
}

/** Connector-owned state worth remembering between connector instances. */
function resolvedStateOf(connector: unknown): unknown {
  const wp = connector as { resolvedSeoStrategy?: unknown };
  return wp.resolvedSeoStrategy ?? undefined;
}

function labelFor(kind: ConnectionKind, config: Record<string, string>, site: Site): string {
  switch (kind) {
    case 'wordpress':
      return `${hostOf(config.siteUrl ?? site.url)} as ${config.username ?? 'unknown user'}`;
    case 'cloudflare':
      return `Cloudflare zone ${config.domain ?? hostOf(site.url)}`;
    case 'wix':
      return config.identity === 'api-key'
        ? `Wix site ${config.siteId ?? ''} (API key)`.trim()
        : `Wix app instance ${config.instanceId ?? ''}`.trim();
    case 'squarespace':
      return `${hostOf(config.siteUrl ?? site.url)} (read-only)`;
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function methodNotAllowed(): ApiResponse {
  return { status: 405, body: { error: 'Method not allowed' } };
}

function errorResponse(err: unknown): ApiResponse {
  if (err instanceof z.ZodError) {
    return { status: 400, body: { error: 'That request is not valid.', issues: err.issues } };
  }
  if (err instanceof StateError) {
    const status = err.code === 'NOT_FOUND' ? 404 : 409;
    return { status, body: { error: err.message, code: err.code } };
  }
  if (err instanceof ConnectorError) {
    return { status: 502, body: { error: err.message, code: err.code, retryable: err.retryable } };
  }
  return {
    status: 500,
    body: { error: err instanceof Error ? err.message : 'Something went wrong.' },
  };
}
