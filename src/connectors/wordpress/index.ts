/**
 * WordPress connector.
 *
 * Capabilities are resolved against the live site rather than declared up
 * front, because what WordPress can do depends on which plugins are active and
 * whether the companion bridge is installed. `testConnection` performs that
 * resolution and is the only place that mutates `capabilities`.
 */

import type {
  ApplyResult, Capabilities, Connector, ConnectionTest, PagePatch, PlannedRequest,
} from '../../core/connector.js';
import { DryRunRecorder } from '../../core/connector.js';
import type { PageContent, PageRef, Platform, RootFile, SeoMeta, Snapshot } from '../../core/types.js';
import { ConnectorError, UnsafeWrite, UnsupportedOperation } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { WordPressClient, type WpCredentials, type WpClientOptions } from './client.js';
import { BRIDGE_NAMESPACE, bridgeAvailable, detectSeoPlugin, resolveSeoStrategy, describeStrategy, type SeoPlugin, type SeoStrategy } from './seo.js';
import { detectBuilder, detectBuilderFromHtml, builderBlockMessage } from './builders.js';
import { purgeCaches, type PurgeResult } from './cache.js';

interface WpPost {
  id: number;
  link: string;
  slug: string;
  status: string;
  type: string;
  modified_gmt?: string;
  title?: { raw?: string; rendered?: string };
  excerpt?: { raw?: string; rendered?: string };
  content?: { raw?: string; rendered?: string };
  meta?: Record<string, unknown>;
  /** Added by the companion plugin: authoritative builder ownership. */
  aiva_builder?: { builder: string | null; content_is_builder_data: boolean; evidence: string | null };
}

export interface WordPressConnectorOptions extends WpClientOptions {
  dryRun?: boolean;
  /** Post types to treat as pages. Defaults to pages and posts. */
  postTypes?: string[];
}

export class WordPressConnector implements Connector {
  readonly platform: Platform = 'wordpress';
  readonly capabilities: Capabilities = {
    testConnection: true,
    listPages: true,
    getPage: true,
    updatePage: true,
    createPage: true,
    snapshot: true,
    rollback: true,
    // Resolved against the live site in testConnection().
    setSeoMeta: false,
    injectSchema: false,
    setRootFile: false,
  };

  dryRun: boolean;

  private readonly client: WordPressClient;
  private readonly recorder = new DryRunRecorder();
  private readonly postTypes: string[];

  private seoStrategy: SeoStrategy | null = null;
  private hasBridge = false;
  private bridgeChecked = false;
  private lastPurge: PurgeResult | null = null;

  constructor(creds: WpCredentials, opts: WordPressConnectorOptions = {}) {
    this.dryRun = opts.dryRun ?? false;
    this.postTypes = opts.postTypes ?? ['pages', 'posts'];
    this.client = new WordPressClient(creds, {
      ...opts,
      dryRunSink: this.dryRun ? (r) => this.recorder.record(r) : opts.dryRunSink,
    });
  }

  /** Planned requests captured during a dry run, then cleared. */
  drainPlanned(): PlannedRequest[] {
    return this.recorder.drain();
  }

  get seoStrategyDescription(): string {
    return this.seoStrategy ? describeStrategy(this.seoStrategy) : 'not yet resolved';
  }

  /**
   * The resolved SEO strategy, so the caller can store it and hand it back to
   * a later connector instead of probing the site again.
   */
  get resolvedSeoStrategy(): SeoStrategy | null {
    return this.seoStrategy;
  }

  /** Restore a strategy resolved by an earlier connection test. */
  restoreSeoStrategy(strategy: SeoStrategy | null | undefined): void {
    if (strategy) this.seoStrategy = strategy;
  }

  /**
   * Resolve how SEO fields can be written on this site.
   *
   * `testConnection` does this as part of its checks, but a connector built
   * fresh to apply a batch has not run it. Requiring a particular call order
   * is the kind of thing that works in tests and fails in production, so the
   * write methods resolve it themselves when they need it.
   */
  private async ensureSeoStrategy(): Promise<SeoStrategy> {
    if (this.seoStrategy) return this.seoStrategy;
    const plugin = await detectSeoPlugin(this.client);
    this.seoStrategy = await this.probeSeoStrategy(plugin);
    log.info('resolved the SEO write strategy on demand', {
      strategy: describeStrategy(this.seoStrategy),
    });
    return this.seoStrategy;
  }

  /** Same, for the companion plugin: one cheap GET, cached per connector. */
  private async ensureBridge(): Promise<boolean> {
    if (this.bridgeChecked) return this.hasBridge;
    this.hasBridge = await bridgeAvailable(this.client);
    this.bridgeChecked = true;
    return this.hasBridge;
  }

  // ---------------------------------------------------------------- connection

  async testConnection(): Promise<ConnectionTest> {
    const checks: ConnectionTest['checks'] = [];

    // 1. REST reachable.
    let restOk = false;
    try {
      const idx = await this.client.index();
      restOk = idx.namespaces?.includes('wp/v2') ?? false;
      checks.push({
        name: 'REST API',
        ok: restOk,
        detail: restOk ? 'wp/v2 namespace is available.' : 'REST root responded but wp/v2 is missing.',
        ...(restOk ? {} : { remedy: 'Check that the REST API is not disabled by a security plugin.' }),
      });
    } catch (err) {
      checks.push({
        name: 'REST API',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        remedy: 'Confirm the site URL, and that /wp-json/ is reachable from the public internet.',
      });
      return { ok: false, platform: this.platform, checks };
    }

    // 2. HTTPS. Application Passwords are only offered over TLS (or locally).
    const isHttps = this.client.siteUrl.startsWith('https://');
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(this.client.siteUrl);
    checks.push({
      name: 'HTTPS',
      ok: isHttps || isLocal,
      detail: isHttps
        ? 'Site is served over HTTPS.'
        : isLocal
          ? 'Local site — WordPress allows Application Passwords without TLS here.'
          : 'Site is served over plain HTTP.',
      ...(isHttps || isLocal
        ? {}
        : { remedy: 'WordPress hides Application Passwords on non-HTTPS sites. Enable TLS first.' }),
    });

    // 3. Authentication, distinguishing a bad password from a stripped header.
    const auth = await this.client.diagnoseAuth();
    checks.push({
      name: 'Authentication',
      ok: auth.ok,
      detail: auth.reason,
      ...(auth.remedy ? { remedy: auth.remedy } : {}),
    });
    if (!auth.ok) return { ok: false, platform: this.platform, checks };

    // 4. Edit capability.
    let canEdit = false;
    try {
      const me = await this.client.request<{ capabilities?: Record<string, boolean> }>('users/me', {
        query: { context: 'edit' },
      });
      canEdit = Boolean(me?.capabilities?.edit_pages || me?.capabilities?.edit_posts);
      checks.push({
        name: 'Edit permission',
        ok: canEdit,
        detail: canEdit ? 'The connected user can edit content.' : 'The connected user cannot edit content.',
        ...(canEdit ? {} : { remedy: 'Connect as a user with the Editor or Administrator role.' }),
      });
    } catch (err) {
      checks.push({ name: 'Edit permission', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }

    // 5. Companion plugin.
    this.hasBridge = await bridgeAvailable(this.client);
    this.bridgeChecked = true;
    checks.push({
      name: 'Companion plugin',
      ok: this.hasBridge,
      detail: this.hasBridge
        ? 'ai-visibility-bridge is active.'
        : 'Not installed. SEO meta, JSON-LD and robots.txt/llms.txt may be unavailable.',
      ...(this.hasBridge ? {} : { remedy: 'Install the companion plugin zip from the Connect step.' }),
    });

    // 6. SEO plugin and how its fields can be written — probed, not assumed.
    const plugin = await detectSeoPlugin(this.client);
    this.seoStrategy = await this.probeSeoStrategy(plugin);
    checks.push({
      name: 'SEO fields',
      ok: this.seoStrategy.kind !== 'unavailable',
      detail: describeStrategy(this.seoStrategy),
      ...(this.seoStrategy.kind === 'unavailable'
        ? { remedy: 'Install the companion plugin to write SEO fields.' }
        : {}),
    });

    // 7. Root-file control. WordPress only serves robots.txt when no static file
    //    exists on disk; a real file always wins and our filter never runs.
    const rootFileOk = this.hasBridge && (await this.rootFileWritable());
    checks.push({
      name: 'robots.txt / llms.txt',
      ok: rootFileOk,
      detail: rootFileOk
        ? 'WordPress serves these paths, so they can be written.'
        : this.hasBridge
          ? 'A static file on disk is shadowing WordPress, so writes here would not take effect.'
          : 'Requires the companion plugin.',
      ...(rootFileOk
        ? {}
        : { remedy: 'Apply these through Cloudflare, or edit the file on the server directly.' }),
    });

    this.capabilities.setSeoMeta = this.seoStrategy.kind !== 'unavailable';
    this.capabilities.injectSchema = this.hasBridge;
    this.capabilities.setRootFile = rootFileOk;

    const ok = checks.every((c) => c.ok || c.name === 'Companion plugin' || c.name === 'robots.txt / llms.txt');
    return { ok, platform: this.platform, checks };
  }

  /**
   * Probe native SEO writability against a throwaway draft, then remove it.
   * A probe that leaves debris behind is not acceptable on a client's site.
   */
  private async probeSeoStrategy(plugin: SeoPlugin): Promise<SeoStrategy> {
    if (plugin === 'none') return resolveSeoStrategy(this.client, plugin);
    if (this.dryRun) return resolveSeoStrategy(this.client, plugin);

    let probeId: number | undefined;
    try {
      const draft = await this.client.request<WpPost>('posts', {
        method: 'POST',
        body: { title: 'AI Visibility Auditor connection check', status: 'draft' },
        describes: 'Create a temporary draft to test whether SEO fields are writable',
      });
      probeId = draft?.id;
      return await resolveSeoStrategy(this.client, plugin, probeId);
    } catch (err) {
      log.debug('SEO probe draft could not be created', { error: err });
      return resolveSeoStrategy(this.client, plugin);
    } finally {
      if (probeId !== undefined) {
        try {
          await this.client.request(`posts/${probeId}`, {
            method: 'DELETE',
            query: { force: 'true' },
            describes: 'Remove the temporary probe draft',
          });
        } catch (err) {
          log.warn('could not remove probe draft; it remains in the trash', { probeId, error: err });
        }
      }
    }
  }

  private async rootFileWritable(): Promise<boolean> {
    try {
      const res = await this.client.request<{ robots_txt_served_by_wordpress: boolean }>('root-files/status', {
        namespace: BRIDGE_NAMESPACE,
      });
      return res?.robots_txt_served_by_wordpress === true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------- reads

  async listPages(opts: { limit?: number; cursor?: string } = {}): Promise<{ pages: PageRef[]; cursor?: string }> {
    const perPage = Math.min(opts.limit ?? 50, 100);
    const page = opts.cursor ? Number(opts.cursor) : 1;
    const pages: PageRef[] = [];

    for (const type of this.postTypes) {
      const items = await this.client.request<WpPost[]>(type, {
        query: { per_page: perPage, page, status: 'publish,draft,private', _fields: 'id,link,slug,status,type,title,modified_gmt' },
      });
      for (const p of items ?? []) pages.push(this.toPageRef(p));
    }

    return {
      pages,
      ...(pages.length === perPage * this.postTypes.length ? { cursor: String(page + 1) } : {}),
    };
  }

  async getPage(id: string): Promise<PageContent> {
    const { type, numericId } = this.parseId(id);
    const post = await this.client.request<WpPost>(`${type}/${numericId}`, { query: { context: 'edit' } });
    const builder = await this.resolveBuilder(post);

    return {
      ...this.toPageRef(post),
      slug: post.slug,
      excerpt: post.excerpt?.raw ?? '',
      content: post.content?.raw ?? '',
      contentIsBuilderData: builder.contentIsBuilderData,
      ...(builder.builder ? { builder: builder.builder } : {}),
      seo: this.readSeoFromMeta(post.meta),
    };
  }

  // ------------------------------------------------------------------- writes

  async updatePage(id: string, patch: PagePatch): Promise<ApplyResult> {
    const { type, numericId } = this.parseId(id);

    // Selector-addressed blocks cannot be applied safely to stored content:
    // the stored HTML is not what the theme renders, so a selector that
    // matches the live page may match nothing here. Decline, so routing falls
    // through to Cloudflare, which rewrites the rendered page.
    if (patch.blocks?.length) {
      throw new UnsupportedOperation(
        'updatePage', 'wordpress',
        'selector-addressed content blocks must be applied to the rendered page, not stored content',
      );
    }

    // Refuse a content write the builder owns, rather than silently no-op.
    if (patch.content !== undefined) {
      const current = await this.getPage(id);
      if (current.contentIsBuilderData) {
        throw new UnsafeWrite(
          builderBlockMessage(
            { builder: (current.builder ?? null) as never, contentIsBuilderData: true, evidence: current.builder ?? 'builder data' },
            current.url,
          ),
          { pageId: id, builder: current.builder },
        );
      }
    }

    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.slug !== undefined) body.slug = patch.slug;
    if (patch.excerpt !== undefined) body.excerpt = patch.excerpt;
    if (patch.content !== undefined) body.content = patch.content;

    await this.client.request(`${type}/${numericId}`, {
      method: 'POST',
      body,
      describes: `Update ${Object.keys(body).join(', ')} on ${type}/${numericId}`,
    });

    this.lastPurge = await purgeCaches(this.client, numericId);
    return this.result(String(numericId), this.lastPurge.detail);
  }

  async createPage(input: {
    title: string; slug?: string; content: string; status?: 'draft' | 'published';
  }): Promise<ApplyResult> {
    const created = await this.client.request<WpPost>('pages', {
      method: 'POST',
      body: {
        title: input.title,
        content: input.content,
        ...(input.slug ? { slug: input.slug } : {}),
        status: input.status === 'published' ? 'publish' : 'draft',
      },
      describes: `Create page "${input.title}" as ${input.status ?? 'draft'}`,
    });
    return this.result(created?.id !== undefined ? String(created.id) : undefined, 'Page created.');
  }

  async setSeoMeta(id: string, meta: SeoMeta): Promise<ApplyResult> {
    const strategy = await this.ensureSeoStrategy();
    if (strategy.kind === 'unavailable') {
      throw new UnsupportedOperation('setSeoMeta', 'wordpress', strategy.reason);
    }

    const { type, numericId } = this.parseId(id);

    if (strategy.kind === 'native-meta') {
      const { keys } = strategy;
      const metaPatch: Record<string, string> = {};
      if (meta.title !== undefined) metaPatch[keys.title] = meta.title;
      if (meta.description !== undefined) metaPatch[keys.description] = meta.description;
      if (meta.canonical !== undefined && keys.canonical) metaPatch[keys.canonical] = meta.canonical;
      if (meta.robots !== undefined && keys.robots) metaPatch[keys.robots] = meta.robots;

      await this.client.request(`${type}/${numericId}`, {
        method: 'POST',
        body: { meta: metaPatch },
        describes: `Set ${Object.keys(metaPatch).join(', ')} on ${type}/${numericId}`,
      });
    } else {
      await this.client.request('seo-meta', {
        method: 'POST',
        namespace: BRIDGE_NAMESPACE,
        body: { post_id: numericId, ...meta },
        describes: `Set SEO meta on post ${numericId} via the companion plugin`,
      });
    }

    this.lastPurge = await purgeCaches(this.client, numericId);
    return this.result(String(numericId), this.lastPurge.detail);
  }

  async injectSchema(id: string, jsonLd: object | object[]): Promise<ApplyResult> {
    if (!await this.ensureBridge()) {
      throw new UnsupportedOperation(
        'injectSchema', 'wordpress',
        'JSON-LD injection needs the companion plugin, which is not installed.',
      );
    }
    const { numericId } = this.parseId(id);
    await this.client.request('schema', {
      method: 'POST',
      namespace: BRIDGE_NAMESPACE,
      body: { post_id: numericId, json_ld: jsonLd },
      describes: `Inject JSON-LD into the head of post ${numericId}`,
    });
    this.lastPurge = await purgeCaches(this.client, numericId);
    return this.result(String(numericId), this.lastPurge.detail);
  }

  async setRootFile(file: RootFile, content: string): Promise<ApplyResult> {
    if (!this.capabilities.setRootFile) {
      throw new UnsupportedOperation(
        'setRootFile', 'wordpress',
        'WordPress is not serving this path — a static file on disk takes precedence, ' +
        'so a write here would report success without changing anything.',
      );
    }
    await this.client.request('root-files', {
      method: 'POST',
      namespace: BRIDGE_NAMESPACE,
      body: { file, content },
      describes: `Set the contents of ${file}`,
    });
    this.lastPurge = await purgeCaches(this.client);
    return this.result(file, this.lastPurge.detail);
  }

  // ---------------------------------------------------------- snapshot/rollback

  async snapshot(scope: { pageIds?: string[]; rootFiles?: RootFile[] }): Promise<Snapshot> {
    const pages: Array<PageContent & { nativeMeta?: Record<string, unknown> }> = [];
    for (const id of scope.pageIds ?? []) {
      const page = await this.getPage(id);
      pages.push(page);
    }

    const rootFiles: Partial<Record<RootFile, string>> = {};
    for (const file of scope.rootFiles ?? []) {
      try {
        const res = await this.client.request<{ content: string }>('root-files', {
          namespace: BRIDGE_NAMESPACE,
          query: { file },
        });
        rootFiles[file] = res?.content ?? '';
      } catch (err) {
        log.warn('could not snapshot root file; rollback for it will be unavailable', { file, error: err });
      }
    }

    return {
      id: `wp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      siteId: this.client.siteUrl,
      payload: { pages, rootFiles, seoStrategy: this.seoStrategy?.kind ?? null },
      takenAt: new Date(),
    };
  }

  async rollback(snapshot: Snapshot): Promise<ApplyResult> {
    const payload = snapshot.payload as {
      pages?: PageContent[];
      rootFiles?: Partial<Record<RootFile, string>>;
    };

    const restored: string[] = [];
    const failed: string[] = [];

    for (const page of payload.pages ?? []) {
      try {
        const patch: Partial<Pick<PageContent, 'title' | 'slug' | 'excerpt' | 'content'>> = {
          title: page.title,
          slug: page.slug,
          excerpt: page.excerpt ?? '',
        };
        // Only restore the body when we were allowed to write it in the first place.
        if (!page.contentIsBuilderData) patch.content = page.content;

        // page.id already carries its type prefix (e.g. "page:42").
        await this.updatePage(page.id, patch);
        if (page.seo && this.capabilities.setSeoMeta) {
          await this.setSeoMeta(page.id, page.seo);
        }
        restored.push(page.id);
      } catch (err) {
        log.error('rollback failed for page', { pageId: page.id, error: err });
        failed.push(page.id);
      }
    }

    for (const [file, content] of Object.entries(payload.rootFiles ?? {})) {
      try {
        await this.setRootFile(file as RootFile, content);
        restored.push(file);
      } catch (err) {
        log.error('rollback failed for root file', { file, error: err });
        failed.push(file);
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

  // ------------------------------------------------------------------ helpers

  /**
   * Work out whether a page's body belongs to a builder.
   *
   * Core REST will not tell us: builder meta keys are not registered with
   * `show_in_rest`, so `post.meta` comes back without them and a builder page
   * looks exactly like an ordinary one. Three sources, strongest first:
   *   1. the companion plugin's computed field (reads meta server-side),
   *   2. shortcodes left in post_content (catches Divi and WPBakery),
   *   3. fingerprints in the rendered HTML (catches Elementor without the plugin).
   */
  private async resolveBuilder(post: WpPost) {
    if (post.aiva_builder) {
      return {
        builder: (post.aiva_builder.builder ?? null) as ReturnType<typeof detectBuilder>['builder'],
        contentIsBuilderData: post.aiva_builder.content_is_builder_data,
        ...(post.aiva_builder.evidence ? { evidence: post.aiva_builder.evidence } : {}),
      };
    }

    const fromPost = detectBuilder({ meta: post.meta, content: post.content?.raw });
    if (fromPost.contentIsBuilderData) return fromPost;

    if (post.link && post.status === 'publish') {
      try {
        const res = await (globalThis.fetch)(post.link, { redirect: 'follow' });
        if (res.ok) {
          const fromHtml = detectBuilderFromHtml(await res.text());
          if (fromHtml.contentIsBuilderData) return fromHtml;
        }
      } catch (err) {
        log.debug('could not fetch rendered page for builder detection', { url: post.link, error: err });
      }
    }

    return fromPost;
  }

  private result(platformRef?: string, detail?: string): ApplyResult {
    return {
      ok: true,
      ...(platformRef ? { platformRef } : {}),
      ...(detail ? { detail } : {}),
      ...(this.dryRun ? { planned: this.recorder.drain() } : {}),
    };
  }

  private toPageRef(p: WpPost): PageRef {
    return {
      id: `${p.type ?? 'page'}:${p.id}`,
      url: p.link,
      title: p.title?.raw ?? p.title?.rendered ?? '',
      type: p.type ?? 'page',
      status:
        p.status === 'publish' ? 'published'
        : p.status === 'draft' ? 'draft'
        : p.status === 'private' ? 'private'
        : 'unknown',
      ...(p.modified_gmt ? { modifiedAt: new Date(`${p.modified_gmt}Z`) } : {}),
    };
  }

  /** Ids are `type:numericId`, e.g. `page:42`. Bare numbers are treated as pages. */
  private parseId(id: string): { type: string; numericId: number } {
    const [maybeType, maybeId] = id.includes(':') ? id.split(':') : ['page', id];
    const numericId = Number(maybeId);
    if (!Number.isFinite(numericId)) {
      throw new ConnectorError(`Not a valid WordPress page id: ${id}`, 'BAD_ID', false);
    }
    const type = maybeType === 'post' ? 'posts' : maybeType === 'page' ? 'pages' : `${maybeType}s`;
    return { type, numericId };
  }

  private readSeoFromMeta(meta?: Record<string, unknown>): SeoMeta | undefined {
    if (!meta) return undefined;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = meta[k];
        if (typeof v === 'string' && v.length) return v;
      }
      return undefined;
    };
    const seo: SeoMeta = {};
    const title = pick('_yoast_wpseo_title', 'rank_math_title');
    const description = pick('_yoast_wpseo_metadesc', 'rank_math_description');
    const canonical = pick('_yoast_wpseo_canonical', 'rank_math_canonical_url');
    const robots = pick('rank_math_robots');
    if (title) seo.title = title;
    if (description) seo.description = description;
    if (canonical) seo.canonical = canonical;
    if (robots) seo.robots = robots;
    return Object.keys(seo).length ? seo : undefined;
  }
}

export { type WpCredentials } from './client.js';
