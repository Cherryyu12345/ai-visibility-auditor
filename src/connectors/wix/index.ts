/**
 * Wix connector.
 *
 * Wix turned out to be the strongest platform API of the three after
 * WordPress: the Item SEO Tags API writes titles, descriptions, canonicals,
 * robots directives AND structured data, per item, with a bulk call. What it
 * cannot do is edit page bodies or serve root files, so those route onward to
 * Cloudflare or a manual card exactly as designed.
 *
 * Two constraints shape nearly every method here:
 *   - Writes replace an item's tags in full, so everything is read-modify-write.
 *   - Items are addressed by type and id, never by URL, so the connector keeps
 *     a map from URL to item built from the listing.
 */

import type {
  ApplyResult, Capabilities, Connector, ConnectionTest, PagePatch, PlannedRequest,
} from '../../core/connector.js';
import { DryRunRecorder } from '../../core/connector.js';
import type { PageContent, PageRef, Platform, RootFile, SeoMeta, Snapshot } from '../../core/types.js';
import { ConnectorError, UnsupportedOperation } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { WixAuth, type WixCredentials, REQUIRED_SCOPES } from './auth.js';
import { WixApi, type WixApiOptions } from './api.js';
import {
  applyJsonLdToTags, applyMetaToTags, compositeId, DRAFTED_ITEM_TYPES, extractJsonLd,
  parseCompositeId, READABLE_ITEM_TYPES, resolvedTitle, tagsToSeoMeta,
  WRITABLE_ITEM_TYPES, type ItemSeoTags, type WixTag,
} from './seo.js';

export interface WixConnectorOptions extends WixApiOptions {
  dryRun?: boolean;
  /** Restrict listing to specific item types. Defaults to all readable types. */
  itemTypes?: string[];
}

export class WixConnector implements Connector {
  readonly platform: Platform = 'wix';

  readonly capabilities: Capabilities = {
    testConnection: true,
    listPages: true,
    getPage: true,
    updatePage: true,
    setSeoMeta: true,
    injectSchema: true,
    snapshot: true,
    rollback: true,
    // No API creates a page or writes robots.txt / llms.txt on Wix.
    createPage: false,
    setRootFile: false,
  };

  dryRun: boolean;

  private readonly auth: WixAuth;
  private readonly api: WixApi;
  private readonly recorder = new DryRunRecorder();
  private readonly itemTypes: string[];

  /** Cache of the last listing, so a URL can be resolved to an item. */
  private itemsByUrl = new Map<string, { itemType: string; itemId: string }>();

  constructor(creds: WixCredentials, opts: WixConnectorOptions = {}) {
    this.dryRun = opts.dryRun ?? false;
    this.itemTypes = opts.itemTypes ?? [...READABLE_ITEM_TYPES];
    this.auth = new WixAuth(creds, opts.fetchImpl);
    this.api = new WixApi(this.auth, {
      ...opts,
      dryRunSink: this.dryRun ? (r) => this.recorder.record(r) : opts.dryRunSink,
    });
  }

  drainPlanned(): PlannedRequest[] {
    return this.recorder.drain();
  }

  // ---------------------------------------------------------------- connect

  /**
   * Probe what this credential can actually do.
   *
   * The docs say an API key cannot write SEO tags, but a sentence in a doc is
   * not a test — especially for an API in Developer Preview. So we try a real
   * read and report what came back, and only explain the identity rule when
   * Wix itself refuses.
   */
  async testConnection(): Promise<ConnectionTest> {
    const checks: ConnectionTest['checks'] = [];

    checks.push({
      name: 'Credential type',
      ok: this.auth.identity === 'app',
      detail: this.auth.identity === 'app'
        ? 'Connected as an installed Wix app, which is the identity SEO writes require.'
        : 'Connected with an API key. Wix treats this as a different identity from an installed app.',
      ...(this.auth.identity === 'app' ? {} : {
        remedy:
          'Install the AI Visibility Auditor app on the site and reconnect. Wix documents SEO tag ' +
          'writes as available only to the Wix app or Wix user identity, and Wix user is not ' +
          'available over REST.',
      }),
    });

    // Token exchange, for app credentials.
    if (this.auth.identity === 'app') {
      try {
        await this.auth.accessToken();
        checks.push({ name: 'Access token', ok: true, detail: 'Obtained an app access token.' });
      } catch (err) {
        checks.push({
          name: 'Access token',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          remedy: 'Check the app ID, app secret and instance id, then reconnect.',
        });
        return { ok: false, platform: this.platform, checks };
      }
    }

    // A real read decides whether SEO is reachable with this credential.
    try {
      const page = await this.listItemSeoTags('STATIC_PAGE', 1);
      checks.push({
        name: 'SEO read access',
        ok: true,
        detail: `Read SEO tags (${page.items.length} static page(s) sampled) via ${this.api.resolvedSeoBase}.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        name: 'SEO read access',
        ok: false,
        detail: message,
        remedy: err instanceof ConnectorError && err.code === 'FORBIDDEN'
          ? `Grant the app these scopes and reinstall: ${REQUIRED_SCOPES.join(', ')}.`
          : 'Confirm the site has the SEO API enabled and the credentials are for the right site.',
      });
      return { ok: false, platform: this.platform, checks };
    }

    checks.push({
      name: 'Developer Preview',
      ok: true,
      detail:
        'The Item SEO Tags API is in Wix Developer Preview and may change. Verification after ' +
        'apply is the safeguard: a change is only marked verified once a crawler can see it.',
    });

    checks.push({
      name: 'Root files',
      ok: false,
      detail: 'Wix has no API for robots.txt or llms.txt.',
      remedy: 'Apply these through Cloudflare, or use a manual card for the Wix SEO settings panel.',
    });

    const blocking = checks.filter((c) => !c.ok && c.name !== 'Root files');
    return { ok: blocking.length === 0, platform: this.platform, checks };
  }

  // ------------------------------------------------------------------ reads

  async listPages(opts: { limit?: number; cursor?: string } = {}): Promise<{ pages: PageRef[]; cursor?: string }> {
    const limit = Math.min(opts.limit ?? 100, 100);
    const pages: PageRef[] = [];
    this.itemsByUrl = new Map();

    for (const itemType of this.itemTypes) {
      try {
        const { items } = await this.listItemSeoTags(itemType, limit, opts.cursor);
        for (const item of items) {
          const url = itemUrl(item);
          pages.push({
            id: compositeId(item.itemType, item.itemId),
            url,
            title: resolvedTitle(item),
            type: item.itemType,
            status: 'published',
          });
          if (url) this.itemsByUrl.set(normaliseUrl(url), { itemType: item.itemType, itemId: item.itemId });
        }
      } catch (err) {
        // A site without that business solution simply has no items of the
        // type; it should not fail the whole listing.
        log.debug('skipping Wix item type', { itemType, error: err });
      }
    }

    return { pages };
  }

  async getPage(id: string): Promise<PageContent> {
    const { itemType, itemId } = this.resolve(id);
    const item = await this.getItemSeoTags(itemType, itemId);

    return {
      id: compositeId(itemType, itemId),
      url: itemUrl(item),
      title: resolvedTitle(item),
      type: itemType,
      status: 'published',
      slug: '',
      content: '',
      // Wix body content is not reachable through this API at all, so there is
      // no stored content to mistake for the rendered page.
      contentIsBuilderData: true,
      builder: 'wix',
      seo: tagsToSeoMeta(item.tags),
    };
  }

  // ----------------------------------------------------------------- writes

  /**
   * On Wix the rendered <title> is the SEO title tag, so a title change is an
   * SEO write. Everything else `updatePage` can carry has no Wix API.
   */
  async updatePage(id: string, patch: PagePatch): Promise<ApplyResult> {
    if (patch.slug !== undefined) {
      throw new UnsupportedOperation('updatePage', 'wix', 'Wix has no API for changing a page URL slug');
    }
    if (patch.content !== undefined) {
      throw new UnsupportedOperation('updatePage', 'wix', 'Wix has no API for editing page body content');
    }
    if (patch.excerpt !== undefined) {
      throw new UnsupportedOperation('updatePage', 'wix', 'Wix has no API for page excerpts');
    }
    if (patch.blocks?.length) {
      throw new UnsupportedOperation(
        'updatePage', 'wix',
        'selector-addressed content blocks must be applied to the rendered page, not through the SEO API',
      );
    }
    if (patch.title === undefined) {
      throw new ConnectorError('Nothing to update.', 'NO_OP', false);
    }
    return this.setSeoMeta(id, { title: patch.title });
  }

  async createPage(_input: { title: string; slug?: string; content: string }): Promise<ApplyResult> {
    throw new UnsupportedOperation(
      'createPage', 'wix',
      'Wix has no API for creating pages; add it in the Wix editor or serve it from Cloudflare',
    );
  }

  async setSeoMeta(id: string, meta: SeoMeta): Promise<ApplyResult> {
    const { itemType, itemId } = this.resolve(id);
    this.assertWritable(itemType);

    return this.writeTags(
      itemType, itemId,
      (existing) => applyMetaToTags(existing, meta),
      `Set ${Object.keys(meta).join(', ')} on ${itemType}:${itemId}`,
    );
  }

  async injectSchema(id: string, jsonLd: object | object[]): Promise<ApplyResult> {
    const { itemType, itemId } = this.resolve(id);
    this.assertWritable(itemType);

    return this.writeTags(
      itemType, itemId,
      (existing) => applyJsonLdToTags(existing, jsonLd),
      `Set structured data on ${itemType}:${itemId}`,
    );
  }

  async setRootFile(file: RootFile, _content: string): Promise<ApplyResult> {
    throw new UnsupportedOperation(
      'setRootFile', 'wix',
      `Wix has no API for ${file}; it can only be edited in the Wix SEO settings panel`,
    );
  }

  /**
   * Apply many SEO changes in one call.
   *
   * Wix returns a result per item, so one invalid item does not fail the rest —
   * which matters when applying an approved batch across a whole site.
   */
  async bulkSetSeoMeta(
    updates: Array<{ id: string; meta: SeoMeta }>,
  ): Promise<{ applied: string[]; failed: Array<{ id: string; reason: string }> }> {
    if (updates.length === 0) return { applied: [], failed: [] };
    if (updates.length > 100) {
      throw new ConnectorError('Wix accepts at most 100 items per bulk call.', 'TOO_MANY', false);
    }

    const itemTypes = new Set(updates.map((u) => this.resolve(u.id).itemType));
    if (itemTypes.size > 1) {
      throw new ConnectorError(
        'A Wix bulk SEO call must cover a single item type. Group the batch by type first.',
        'MIXED_TYPES', false,
      );
    }
    const itemType = [...itemTypes][0]!;
    this.assertWritable(itemType);

    const entries = [];
    for (const update of updates) {
      const { itemId } = this.resolve(update.id);
      const current = await this.getItemSeoTags(itemType, itemId).catch(() => null);
      entries.push({
        itemSeoTags: {
          itemType,
          itemId,
          tags: applyMetaToTags(current?.tags ?? [], update.meta),
        },
        fieldMask: 'tags',
        ...(DRAFTED_ITEM_TYPES.has(itemType) ? { publish: true } : {}),
      });
    }

    const res = await this.api.seoRequest<{ results?: Array<{ itemMetadata?: { id?: string; success?: boolean; error?: { description?: string } } }> }>(
      `/bulk/item-seo-tags/${itemType}/set`,
      { method: 'POST', body: { entries }, describes: `Bulk set SEO tags on ${entries.length} ${itemType} item(s)` },
    );

    const applied: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const [index, result] of (res?.results ?? []).entries()) {
      const id = result.itemMetadata?.id ?? updates[index]?.id ?? `#${index}`;
      if (result.itemMetadata?.success) applied.push(id);
      else failed.push({ id, reason: result.itemMetadata?.error?.description ?? 'unknown error' });
    }
    return { applied, failed };
  }

  // ---------------------------------------------------------- snapshot/undo

  async snapshot(scope: { pageIds?: string[] }): Promise<Snapshot> {
    const items: ItemSeoTags[] = [];
    for (const id of scope.pageIds ?? []) {
      const { itemType, itemId } = this.resolve(id);
      try {
        items.push(await this.getItemSeoTags(itemType, itemId));
      } catch (err) {
        log.warn('could not snapshot Wix item; rollback for it will be unavailable', { id, error: err });
      }
    }
    return {
      id: `wix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      siteId: 'wix',
      payload: { items },
      takenAt: new Date(),
    };
  }

  /**
   * Restore an item's tags.
   *
   * An item that had no overrides is reset rather than written with an empty
   * array: Wix treats an empty write and a reset differently, and only the
   * reset restores inheritance from the site tags and patterns.
   */
  async rollback(snapshot: Snapshot): Promise<ApplyResult> {
    const { items } = snapshot.payload as { items: ItemSeoTags[] };
    const restored: string[] = [];
    const failed: string[] = [];

    for (const item of items ?? []) {
      const label = compositeId(item.itemType, item.itemId);
      try {
        if (!item.tags || item.tags.length === 0) {
          await this.api.seoRequest(`/item-seo-tags/${item.itemType}/${item.itemId}/reset`, {
            method: 'POST',
            body: DRAFTED_ITEM_TYPES.has(item.itemType) ? { publish: true } : {},
            describes: `Reset ${label} to inherited SEO tags`,
          });
        } else {
          await this.writeTags(item.itemType, item.itemId, () => item.tags, `Restore SEO tags on ${label}`);
        }
        restored.push(label);
      } catch (err) {
        log.error('Wix rollback failed', { item: label, error: err });
        failed.push(label);
      }
    }

    return {
      ok: failed.length === 0,
      detail: failed.length
        ? `Restored ${restored.length}; failed: ${failed.join(', ')}.`
        : `Restored ${restored.length} item(s).`,
      ...(this.dryRun ? { planned: this.recorder.drain() } : {}),
    };
  }

  // ---------------------------------------------------------------- helpers

  private assertWritable(itemType: string): void {
    if (!WRITABLE_ITEM_TYPES.includes(itemType as never)) {
      throw new UnsupportedOperation(
        'setSeoMeta', 'wix',
        `Wix supports reading ${itemType} SEO tags but not writing them yet`,
      );
    }
  }

  /**
   * Read-modify-write, because a Wix write replaces an item's tags in full.
   * Skipping the read would delete every tag the consultant set by hand.
   */
  private async writeTags(
    itemType: string,
    itemId: string,
    transform: (existing: WixTag[]) => WixTag[],
    describes: string,
  ): Promise<ApplyResult> {
    const current = this.dryRun
      ? await this.getItemSeoTags(itemType, itemId).catch(() => null)
      : await this.getItemSeoTags(itemType, itemId);

    const tags = transform(current?.tags ?? []);

    await this.api.seoRequest(`/item-seo-tags/${itemType}/${itemId}`, {
      method: 'PATCH',
      body: {
        itemSeoTags: { itemType, itemId, tags },
        fieldMask: 'tags',
        // Static pages keep a draft; without this the change never goes live.
        ...(DRAFTED_ITEM_TYPES.has(itemType) ? { publish: true } : {}),
      },
      describes,
    });

    return {
      ok: true,
      platformRef: compositeId(itemType, itemId),
      detail: DRAFTED_ITEM_TYPES.has(itemType)
        ? 'Saved to the page draft and published.'
        : 'Applied; this item type is always live.',
      ...(this.dryRun ? { planned: this.recorder.drain() } : {}),
    };
  }

  private async getItemSeoTags(itemType: string, itemId: string): Promise<ItemSeoTags> {
    const res = await this.api.seoRequest<{ itemSeoTags: ItemSeoTags }>(
      `/item-seo-tags/${itemType}/${itemId}`,
    );
    if (!res?.itemSeoTags) {
      throw new ConnectorError(`Wix returned no SEO tags for ${itemType}:${itemId}`, 'NOT_FOUND', false);
    }
    return res.itemSeoTags;
  }

  private async listItemSeoTags(
    itemType: string, limit: number, cursor?: string,
  ): Promise<{ items: ItemSeoTags[]; cursor?: string }> {
    const res = await this.api.seoRequest<{
      itemSeoTags?: ItemSeoTags[];
      pagingMetadata?: { cursors?: { next?: string } };
    }>(`/item-seo-tags/${itemType}`, {
      query: { 'paging.limit': limit, ...(cursor ? { 'paging.cursor': cursor } : {}) },
    });
    return {
      items: res?.itemSeoTags ?? [],
      ...(res?.pagingMetadata?.cursors?.next ? { cursor: res.pagingMetadata.cursors.next } : {}),
    };
  }

  /**
   * Accept either a composite id or a URL.
   *
   * Wix addresses items by type and id, never by URL, so a change recorded
   * against a page URL has to be resolved through the listing first.
   */
  private resolve(id: string): { itemType: string; itemId: string } {
    if (/^https?:\/\//i.test(id)) {
      const found = this.itemsByUrl.get(normaliseUrl(id));
      if (!found) {
        throw new ConnectorError(
          `No Wix item is known for ${id}. Call listPages() first so URLs can be mapped to items.`,
          'UNRESOLVED_URL', false,
        );
      }
      return found;
    }
    return parseCompositeId(id);
  }
}

/** Wix exposes an item's URL on its resolved canonical tag when it has one. */
function itemUrl(item: ItemSeoTags): string {
  const canonical = item.resolvedTags?.find(
    (r) => r.tag.type === 'link' && r.tag.props?.rel === 'canonical',
  )?.tag.props?.href;
  if (canonical) return canonical;
  const own = item.tags?.find((t) => t.type === 'link' && t.props?.rel === 'canonical')?.props?.href;
  return own ?? '';
}

function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    return `${u.origin}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export { type WixCredentials, installUrl, REQUIRED_SCOPES } from './auth.js';
