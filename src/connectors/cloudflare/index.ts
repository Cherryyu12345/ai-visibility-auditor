/**
 * Cloudflare connector.
 *
 * The universal fallback: it applies changes as pages are served, so it works
 * on any site behind Cloudflare regardless of what the underlying platform
 * allows. That makes it the only route for Squarespace, and the escape hatch
 * for locked-down WordPress and hand-built sites.
 *
 * Changes live in KV, one document per URL path, so updating a change is a KV
 * write and never a redeploy.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as cheerio from 'cheerio';

import type {
  ApplyResult, Capabilities, Connector, ConnectionTest, PagePatch, PlannedRequest,
} from '../../core/connector.js';
import { DryRunRecorder } from '../../core/connector.js';
import type { PageContent, PageRef, Platform, RootFile, SeoMeta, Snapshot } from '../../core/types.js';
import { ConnectorError, UnsupportedOperation } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { CloudflareApi, type CloudflareCredentials, type CloudflareApiOptions } from './api.js';
import { checkDomain, type OnboardingReport } from './onboarding.js';
import { KV_KEYS, pathOf, emptyChangeSet, type ChangeSet, type ContentBlock } from './changeset.js';

const here = dirname(fileURLToPath(import.meta.url));

export const WORKER_SCRIPT_NAME = 'ai-visibility-auditor';
export const KV_NAMESPACE_TITLE = 'ai-visibility-auditor-changesets';
/** Pinned so a Worker runtime change can never silently alter behaviour. */
export const COMPATIBILITY_DATE = '2025-01-01';

export interface CloudflareConnectorOptions extends CloudflareApiOptions {
  dryRun?: boolean;
  /** The site's platform, so onboarding can give platform-specific guidance. */
  platform?: Platform;
  /** Override for tests. */
  workerSourcePath?: string;
}

export class CloudflareConnector implements Connector {
  readonly platform: Platform = 'custom';

  /**
   * Cloudflare serves pages; it does not own them. It can change what a
   * visitor sees, but it cannot enumerate a site's pages or read its CMS, so
   * listPages reports only URLs we have changes for and getPage reads the
   * live page rather than any stored source.
   */
  readonly capabilities: Capabilities = {
    testConnection: true,
    listPages: true,
    getPage: true,
    updatePage: true,
    createPage: true,
    setSeoMeta: true,
    injectSchema: true,
    setRootFile: true,
    snapshot: true,
    rollback: true,
  };

  dryRun: boolean;

  private readonly api: CloudflareApi;
  private readonly recorder = new DryRunRecorder();
  private readonly sitePlatform: Platform;
  private readonly workerSourcePath: string;

  private zoneId?: string;
  private accountId?: string;
  private namespaceId?: string;
  private domain?: string;

  constructor(private readonly creds: CloudflareCredentials, opts: CloudflareConnectorOptions = {}) {
    this.dryRun = opts.dryRun ?? false;
    this.sitePlatform = opts.platform ?? 'unknown';
    this.workerSourcePath = opts.workerSourcePath ?? resolve(here, 'worker/worker.js');
    this.zoneId = creds.zoneId;
    this.domain = creds.domain;
    this.api = new CloudflareApi(creds, {
      ...opts,
      dryRunSink: this.dryRun ? (r) => this.recorder.record(r) : opts.dryRunSink,
    });
  }

  drainPlanned(): PlannedRequest[] {
    return this.recorder.drain();
  }

  // ---------------------------------------------------------------- connect

  async testConnection(): Promise<ConnectionTest> {
    const domain = this.domain ?? (this.zoneId ? (await this.api.getZone(this.zoneId)).name : undefined);
    if (!domain) {
      return {
        ok: false,
        platform: this.platform,
        checks: [{ name: 'Domain', ok: false, detail: 'No domain or zone id was supplied.' }],
      };
    }

    const report = await checkDomain(this.api, domain, this.sitePlatform);
    this.zoneId = report.zoneId ?? this.zoneId;
    this.accountId = report.accountId;
    this.domain = domain;

    const checks = report.checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      detail: c.warning ? `${c.detail} ${c.warning}` : c.detail,
      ...(c.remedy ? { remedy: c.remedy } : {}),
    }));

    // Worker deployment state, only worth checking once the zone is usable.
    if (report.level === 'ready' || report.level === 'action-needed') {
      try {
        const routes = await this.api.listRoutes(this.zoneId!);
        const deployed = routes.some((r) => r.script === WORKER_SCRIPT_NAME);
        checks.push({
          name: 'Worker deployed',
          ok: deployed,
          detail: deployed
            ? `Worker "${WORKER_SCRIPT_NAME}" is routed on this zone.`
            : 'The Worker is not deployed yet.',
          ...(deployed ? {} : { remedy: 'Press Deploy on the Connect step. Nothing changes until a change is applied.' }),
        });
      } catch (err) {
        checks.push({
          name: 'Worker deployed',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          remedy: 'The token needs Zone → Workers Routes → Edit.',
        });
      }
    }

    return { ok: report.level === 'ready', platform: this.platform, checks };
  }

  /** Full onboarding report, including migration steps when not on Cloudflare. */
  async onboarding(domain?: string): Promise<OnboardingReport> {
    const target = domain ?? this.domain;
    if (!target) throw new ConnectorError('No domain supplied for onboarding.', 'NO_DOMAIN', false);
    return checkDomain(this.api, target, this.sitePlatform);
  }

  /**
   * Create the KV namespace, upload the Worker and route it.
   *
   * Idempotent: running it again upgrades the script in place and leaves the
   * existing changesets untouched.
   */
  async deploy(): Promise<{ scriptName: string; namespaceId: string; routePattern: string }> {
    // Deliberately resolveZone, not resolveIds: deploy is what creates the KV
    // namespace, so it cannot require one to already exist.
    const { accountId, zoneId } = await this.resolveZone();

    const existing = await this.api.listKvNamespaces(accountId);
    const found = existing.find((n) => n.title === KV_NAMESPACE_TITLE);
    const namespace = found ?? (await this.api.createKvNamespace(accountId, KV_NAMESPACE_TITLE));
    this.namespaceId = namespace?.id ?? this.namespaceId;

    const source = await readFile(this.workerSourcePath, 'utf8');
    await this.api.uploadWorker(
      accountId,
      WORKER_SCRIPT_NAME,
      source,
      [{ type: 'kv_namespace', name: 'CHANGESETS', namespace_id: this.namespaceId }],
      COMPATIBILITY_DATE,
    );

    const domain = this.domain ?? (await this.api.getZone(zoneId)).name;
    const pattern = `${domain}/*`;
    const routes = await this.api.listRoutes(zoneId).catch(() => []);
    if (!routes.some((r) => r.pattern === pattern && r.script === WORKER_SCRIPT_NAME)) {
      await this.api.createRoute(zoneId, pattern, WORKER_SCRIPT_NAME);
    }

    log.info('Cloudflare Worker deployed', { pattern, scriptName: WORKER_SCRIPT_NAME });
    return { scriptName: WORKER_SCRIPT_NAME, namespaceId: this.namespaceId!, routePattern: pattern };
  }

  /**
   * Disable every rewrite instantly, without a redeploy.
   *
   * The Worker checks this key before doing anything else, so the site reverts
   * to its unmodified self on the next request.
   */
  async setKillSwitch(enabled: boolean): Promise<ApplyResult> {
    const { accountId, namespaceId } = await this.resolveIds();
    if (enabled) {
      await this.api.kvPut(accountId, namespaceId, KV_KEYS.killSwitch, '1');
    } else {
      await this.api.kvDelete(accountId, namespaceId, KV_KEYS.killSwitch);
    }
    return this.result(
      KV_KEYS.killSwitch,
      enabled ? 'All edge rewrites are now disabled.' : 'Edge rewrites re-enabled.',
    );
  }

  async isKillSwitchOn(): Promise<boolean> {
    const { accountId, namespaceId } = await this.resolveIds();
    return (await this.api.kvGet(accountId, namespaceId, KV_KEYS.killSwitch)) !== null;
  }

  /** Remove the Worker and its routes. Changesets in KV are left for audit. */
  async undeploy(): Promise<ApplyResult> {
    const { accountId, zoneId } = await this.resolveZone();
    const routes = await this.api.listRoutes(zoneId).catch(() => []);
    for (const route of routes.filter((r) => r.script === WORKER_SCRIPT_NAME)) {
      await this.api.deleteRoute(zoneId, route.id);
    }
    await this.api.deleteWorker(accountId, WORKER_SCRIPT_NAME).catch(() => undefined);
    return this.result(WORKER_SCRIPT_NAME, 'Worker removed; the site is served unmodified.');
  }

  // ------------------------------------------------------------------ reads

  async listPages(): Promise<{ pages: PageRef[] }> {
    const { accountId, namespaceId } = await this.resolveIds();
    const keys = await this.api.kvListKeys(accountId, namespaceId, 'changeset:');
    const pages: PageRef[] = keys.map((key) => {
      const path = key.slice('changeset:'.length);
      return {
        id: path,
        url: this.domain ? `https://${this.domain}${path}` : path,
        title: path,
        type: 'edge-changeset',
        status: 'published' as const,
      };
    });
    return { pages };
  }

  async getPage(id: string): Promise<PageContent> {
    const path = pathOf(id);
    const url = this.domain ? `https://${this.domain}${path}` : id;

    const res = await fetch(url, { redirect: 'follow' });
    const html = res.ok ? await res.text() : '';
    const $ = cheerio.load(html);

    return {
      id: path,
      url,
      title: $('head title').first().text(),
      type: 'edge-changeset',
      status: res.ok ? 'published' : 'unknown',
      slug: path,
      content: html,
      // Cloudflare rewrites the rendered page, so a builder at the origin is
      // irrelevant here — this is the only connector for which that is true.
      contentIsBuilderData: false,
      seo: {
        ...( $('head meta[name="description"]').attr('content') ? { description: $('head meta[name="description"]').attr('content')! } : {}),
        ...( $('head link[rel="canonical"]').attr('href') ? { canonical: $('head link[rel="canonical"]').attr('href')! } : {}),
      },
    };
  }

  // ----------------------------------------------------------------- writes

  async updatePage(id: string, patch: PagePatch): Promise<ApplyResult> {
    if (patch.slug !== undefined) {
      throw new UnsupportedOperation(
        'updatePage', 'cloudflare',
        'a URL cannot be changed at the edge without breaking the origin; change it in the CMS',
      );
    }
    if (patch.content !== undefined) {
      throw new UnsupportedOperation(
        'updatePage', 'cloudflare',
        'replacing a whole page body at the edge would discard the real page; use content blocks instead',
      );
    }
    if (patch.excerpt !== undefined) {
      throw new UnsupportedOperation(
        'updatePage', 'cloudflare', 'excerpts are a CMS concept and are not present in served HTML',
      );
    }

    return this.mutate(id, (cs) => {
      if (patch.title !== undefined) cs.title = patch.title;
      if (patch.blocks?.length) cs.blocks = mergeBlocks(cs.blocks ?? [], patch.blocks);
    }, describePatch(patch));
  }

  /**
   * Serve a page the origin does not have.
   *
   * The Worker only uses this where the origin returns 404, so a real page
   * added later at the same path always wins.
   */
  async createPage(input: { title: string; slug?: string; content: string }): Promise<ApplyResult> {
    const path = pathOf(input.slug ?? `/${slugify(input.title)}`);
    const { accountId, namespaceId } = await this.resolveIds();
    // A fragment that merely starts with a tag is not a document: wrapping is
    // decided by whether there is an <html> or doctype, so a page built from a
    // "<p>..." fragment still gets a <title> — without one it is invisible to
    // the answer engines this product exists to serve.
    const looksLikeDocument = /^\s*(<!doctype\s+html|<html[\s>])/i.test(input.content);
    const html = looksLikeDocument
      ? input.content
      : `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title></head>` +
        `<body>${input.content}</body></html>`;

    await this.api.kvPut(accountId, namespaceId, KV_KEYS.page(path), html);
    return this.result(path, `Page will be served at ${path} only if the site has nothing there.`);
  }

  async setSeoMeta(id: string, meta: SeoMeta): Promise<ApplyResult> {
    return this.mutate(id, (cs) => {
      if (meta.title !== undefined) cs.title = meta.title;
      if (meta.description !== undefined) cs.metaDescription = meta.description;
      if (meta.canonical !== undefined) cs.canonical = meta.canonical;
      if (meta.robots !== undefined) cs.robots = meta.robots;
    }, `Set ${Object.keys(meta).join(', ')} at the edge`);
  }

  async injectSchema(id: string, jsonLd: object | object[]): Promise<ApplyResult> {
    return this.mutate(id, (cs) => { cs.jsonLd = jsonLd; }, 'Inject JSON-LD at the edge');
  }

  async setRootFile(file: RootFile, content: string): Promise<ApplyResult> {
    const { accountId, namespaceId } = await this.resolveIds();
    await this.api.kvPut(accountId, namespaceId, KV_KEYS.rootFile(file), content);
    return this.result(file, `${file} is now served from the edge.`);
  }

  // ---------------------------------------------------------- snapshot/undo

  async snapshot(scope: { pageIds?: string[]; rootFiles?: RootFile[] }): Promise<Snapshot> {
    const { accountId, namespaceId } = await this.resolveIds();
    const entries: Record<string, string | null> = {};

    for (const id of scope.pageIds ?? []) {
      const key = KV_KEYS.changeset(pathOf(id));
      entries[key] = await this.api.kvGet(accountId, namespaceId, key);
    }
    for (const file of scope.rootFiles ?? []) {
      const key = KV_KEYS.rootFile(file);
      entries[key] = await this.api.kvGet(accountId, namespaceId, key);
    }

    return {
      id: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      siteId: this.domain ?? this.zoneId ?? 'unknown',
      payload: { entries },
      takenAt: new Date(),
    };
  }

  /**
   * Restore KV to the snapshot.
   *
   * A key that did not exist when the snapshot was taken is deleted rather
   * than blanked, so rolling back a first-ever change leaves no trace.
   */
  async rollback(snapshot: Snapshot): Promise<ApplyResult> {
    const { accountId, namespaceId } = await this.resolveIds();
    const { entries } = snapshot.payload as { entries: Record<string, string | null> };

    const restored: string[] = [];
    const failed: string[] = [];

    for (const [key, value] of Object.entries(entries ?? {})) {
      try {
        if (value === null) {
          await this.api.kvDelete(accountId, namespaceId, key);
        } else {
          await this.api.kvPut(accountId, namespaceId, key, value);
        }
        restored.push(key);
      } catch (err) {
        log.error('edge rollback failed for key', { key, error: err });
        failed.push(key);
      }
    }

    return {
      ok: failed.length === 0,
      detail: failed.length ? `Restored ${restored.length}; failed: ${failed.join(', ')}.` : `Restored ${restored.length} key(s).`,
      ...(this.dryRun ? { planned: this.recorder.drain() } : {}),
    };
  }

  // ---------------------------------------------------------------- helpers

  /** Read-modify-write a changeset, bumping its version. */
  private async mutate(id: string, apply: (cs: ChangeSet) => void, describes: string): Promise<ApplyResult> {
    const { accountId, namespaceId } = await this.resolveIds();
    const path = pathOf(id);
    const key = KV_KEYS.changeset(path);

    const existingRaw = await this.api.kvGet(accountId, namespaceId, key);
    let changeSet: ChangeSet = emptyChangeSet();
    if (existingRaw) {
      try { changeSet = JSON.parse(existingRaw) as ChangeSet; } catch {
        log.warn('existing changeset was unreadable and will be replaced', { key });
      }
    }

    apply(changeSet);
    changeSet.version = (changeSet.version ?? 0) + 1;
    changeSet.updatedAt = new Date().toISOString();

    await this.api.kvPut(accountId, namespaceId, key, JSON.stringify(changeSet));
    return this.result(path, `${describes} (version ${changeSet.version}).`);
  }

  /** Zone and account only — safe to call before anything is deployed. */
  private async resolveZone(): Promise<{ accountId: string; zoneId: string }> {
    if (!this.zoneId) {
      if (!this.domain) throw new ConnectorError('No zone id or domain configured.', 'NO_ZONE', false);
      const zones = await this.api.listZones(this.domain);
      const zone = zones.find((z) => z.name === this.domain) ?? zones[0];
      if (!zone) throw new ConnectorError(`${this.domain} is not on this Cloudflare account.`, 'NO_ZONE', false);
      this.zoneId = zone.id;
      this.accountId = zone.account?.id;
    }
    if (!this.accountId) {
      const zone = await this.api.getZone(this.zoneId);
      this.accountId = zone.account?.id;
      this.domain = this.domain ?? zone.name;
    }
    if (!this.accountId) throw new ConnectorError('Could not resolve the Cloudflare account id.', 'NO_ACCOUNT', false);

    return { accountId: this.accountId, zoneId: this.zoneId };
  }

  /** Zone, account and the KV namespace. Required by anything that writes. */
  private async resolveIds(): Promise<{ accountId: string; zoneId: string; namespaceId: string }> {
    const { accountId, zoneId } = await this.resolveZone();

    if (!this.namespaceId) {
      const namespaces = await this.api.listKvNamespaces(accountId);
      const found = namespaces.find((n) => n.title === KV_NAMESPACE_TITLE);
      if (!found) {
        throw new ConnectorError(
          'The edge store is not set up yet. Deploy the Worker first.', 'NOT_DEPLOYED', false,
        );
      }
      this.namespaceId = found.id;
    }

    return { accountId, zoneId, namespaceId: this.namespaceId };
  }

  private result(platformRef?: string, detail?: string): ApplyResult {
    return {
      ok: true,
      ...(platformRef ? { platformRef } : {}),
      ...(detail ? { detail } : {}),
      ...(this.dryRun ? { planned: this.recorder.drain() } : {}),
    };
  }
}

/** Later blocks for the same selector replace earlier ones. */
function mergeBlocks(existing: ContentBlock[], incoming: ContentBlock[]): ContentBlock[] {
  const bySelector = new Map(existing.map((b) => [`${b.selector}|${b.mode}`, b]));
  for (const block of incoming) bySelector.set(`${block.selector}|${block.mode}`, block);
  return [...bySelector.values()];
}

function describePatch(patch: PagePatch): string {
  const parts: string[] = [];
  if (patch.title !== undefined) parts.push('title');
  if (patch.blocks?.length) parts.push(`${patch.blocks.length} content block(s)`);
  return `Set ${parts.join(', ') || 'nothing'} at the edge`;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { type CloudflareCredentials } from './api.js';
export { type ChangeSet, type ContentBlock } from './changeset.js';
