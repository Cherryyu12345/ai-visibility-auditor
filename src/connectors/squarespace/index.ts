/**
 * Squarespace connector.
 *
 * Squarespace has no API for page content or SEO fields — confirmed against
 * the official API list, which is commerce, domains and contacts only, and
 * against the new MCP server, which covers domains and commerce. Browser
 * automation was ruled out on terms-of-service grounds: the Acceptable Use
 * Policy bars accessing the service by any means other than its publicly
 * supported interfaces, and the Terms bar sharing account passwords.
 *
 * So this connector writes nothing. What it does instead is the honest version
 * of the job: it reads the live site, works out precisely which Squarespace
 * panel each change belongs in, and produces an instruction card exact enough
 * to follow without thinking — then verifies the result the same way it would
 * verify an API write.
 *
 * Everything it cannot express as a card routes to Cloudflare.
 */

import * as cheerio from 'cheerio';

import type {
  ApplyResult, Capabilities, Connector, ConnectionTest, PagePatch,
} from '../../core/connector.js';
import type {
  Change, PageContent, PageRef, Platform, RootFile, SeoMeta, Snapshot,
} from '../../core/types.js';
import { ConnectorError, UnsupportedOperation } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import type { ManualCard } from '../../core/manual.js';
import {
  crawlerToggleCard, squarespaceCard, IMPOSSIBLE_FIELDS,
  type CardContext, type ItemKind, type SiteVersion,
} from './cards.js';

export interface SquarespaceConnectorOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  dryRun?: boolean;
  /** Override detection when the consultant already knows. */
  siteVersion?: SiteVersion;
}

const NO_WRITE_API =
  'Squarespace has no API for page content or SEO fields, and its Acceptable Use Policy ' +
  'rules out driving the admin UI automatically';

export class SquarespaceConnector implements Connector {
  readonly platform: Platform = 'squarespace';

  /**
   * Reads only. Every write capability is false, which is not a limitation
   * this connector works around — it is the accurate description that makes
   * the router send changes to Cloudflare or a manual card.
   */
  readonly capabilities: Capabilities = {
    testConnection: true,
    listPages: true,
    getPage: true,
    snapshot: true,
    updatePage: false,
    createPage: false,
    setSeoMeta: false,
    injectSchema: false,
    setRootFile: false,
    rollback: false,
  };

  dryRun: boolean;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private siteVersion: SiteVersion;

  constructor(private readonly siteUrl: string, opts: SquarespaceConnectorOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.dryRun = opts.dryRun ?? false;
    this.siteVersion = opts.siteVersion ?? 'unknown';
  }

  get origin(): string {
    return new URL(this.siteUrl).origin;
  }

  get detectedVersion(): SiteVersion {
    return this.siteVersion;
  }

  // ---------------------------------------------------------------- connect

  async testConnection(): Promise<ConnectionTest> {
    const checks: ConnectionTest['checks'] = [];

    let html = '';
    try {
      const res = await this.get(this.siteUrl);
      html = await res.text();
      checks.push({
        ok: res.ok,
        name: 'Site reachable',
        detail: res.ok ? `Fetched ${this.siteUrl} (HTTP ${res.status}).` : `HTTP ${res.status}.`,
      });
      if (!res.ok) return { ok: false, platform: this.platform, checks };
    } catch (err) {
      checks.push({
        name: 'Site reachable',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, platform: this.platform, checks };
    }

    const looksSquarespace = /SQUARESPACE_CONTEXT|static1\.squarespace\.com|squarespace-cdn\.com/i.test(html);
    checks.push({
      name: 'Platform',
      ok: looksSquarespace,
      detail: looksSquarespace ? 'Confirmed as a Squarespace site.' : 'This does not look like Squarespace.',
      ...(looksSquarespace ? {} : { remedy: 'Check the URL, or override the platform on the Connect step.' }),
    });

    this.siteVersion = this.siteVersion === 'unknown' ? detectVersion(html) : this.siteVersion;
    checks.push({
      name: 'Squarespace version',
      ok: true,
      detail: this.siteVersion === 'unknown'
        ? 'Could not tell 7.0 from 7.1 reliably, so instructions will cover both.'
        : `Detected version ${this.siteVersion}.`,
      ...(this.siteVersion === 'unknown'
        ? { remedy: 'Set the version on the Connect step to get shorter instructions. ' +
                    'Squarespace shows it under Settings → Site Availability, or in the Help menu.' }
        : {}),
    });

    // llms.txt is genuinely available here, and only on 7.1.
    checks.push({
      name: 'llms.txt',
      ok: this.siteVersion !== '7.0',
      detail: this.siteVersion === '7.0'
        ? 'Version 7.0 has no llms.txt feature; this routes to Cloudflare.'
        : 'Squarespace supports llms.txt natively (SEO/AI Visibility → SEO Settings → LLMS.txt).',
    });

    // The honest summary: this connector applies nothing by itself.
    checks.push({
      name: 'Applying changes',
      ok: false,
      detail: `${NO_WRITE_API}. Changes become instruction cards, or are applied through Cloudflare.`,
      remedy: 'Connect Cloudflare to apply titles, descriptions, canonicals and JSON-LD automatically.',
    });

    const blocking = checks.filter((c) => !c.ok && c.name !== 'Applying changes' && c.name !== 'llms.txt');
    return { ok: blocking.length === 0, platform: this.platform, checks };
  }

  // ------------------------------------------------------------------ reads

  /**
   * Pages come from the sitemap Squarespace generates. It is the only
   * enumeration the platform offers without an admin session.
   */
  async listPages(opts: { limit?: number } = {}): Promise<{ pages: PageRef[] }> {
    const sitemapUrl = new URL('/sitemap.xml', this.origin).toString();
    const pages: PageRef[] = [];

    try {
      const res = await this.get(sitemapUrl);
      if (!res.ok) throw new ConnectorError(`sitemap.xml returned HTTP ${res.status}`, 'NO_SITEMAP', false);
      const xml = await res.text();

      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);
      for (const loc of locs.slice(0, opts.limit ?? 500)) {
        pages.push({
          id: loc,
          url: loc,
          title: new URL(loc).pathname,
          type: guessItemKind(loc),
          status: 'published',
        });
      }
    } catch (err) {
      log.warn('could not read the Squarespace sitemap', { sitemapUrl, error: err });
      throw new ConnectorError(
        `Could not read ${sitemapUrl}. Squarespace has no page-listing API, so the sitemap is ` +
        'the only way to enumerate pages.',
        'NO_SITEMAP', true,
      );
    }

    return { pages };
  }

  async getPage(id: string): Promise<PageContent> {
    const url = id.startsWith('http') ? id : new URL(id, this.origin).toString();
    const res = await this.get(url);
    const html = res.ok ? await res.text() : '';
    const $ = cheerio.load(html);

    return {
      id: url,
      url,
      title: $('head title').first().text(),
      type: guessItemKind(url),
      status: res.ok ? 'published' : 'unknown',
      slug: new URL(url).pathname,
      content: html,
      // Squarespace content is only editable in its own editor.
      contentIsBuilderData: true,
      builder: 'squarespace',
      seo: readSeo($),
    };
  }

  // ----------------------------------------------------------------- writes

  async updatePage(_id: string, _patch: PagePatch): Promise<ApplyResult> {
    throw new UnsupportedOperation('updatePage', 'squarespace', NO_WRITE_API);
  }

  async createPage(_input: { title: string; slug?: string; content: string }): Promise<ApplyResult> {
    throw new UnsupportedOperation('createPage', 'squarespace', NO_WRITE_API);
  }

  async setSeoMeta(_id: string, _meta: SeoMeta): Promise<ApplyResult> {
    throw new UnsupportedOperation('setSeoMeta', 'squarespace', NO_WRITE_API);
  }

  async injectSchema(_id: string, _jsonLd: object | object[]): Promise<ApplyResult> {
    throw new UnsupportedOperation('injectSchema', 'squarespace', NO_WRITE_API);
  }

  async setRootFile(file: RootFile, _content: string): Promise<ApplyResult> {
    throw new UnsupportedOperation(
      'setRootFile', 'squarespace',
      file === 'robots.txt'
        ? 'every Squarespace site shares one robots.txt that cannot be edited; only the Crawlers ' +
          'checkbox changes it, and a custom file needs Cloudflare'
        : 'llms.txt is edited in the SEO/AI Visibility panel, which has no API',
    );
  }

  // --------------------------------------------------------- snapshot/undo

  /**
   * Snapshot what the live page currently serves.
   *
   * Without an API there is nothing else to capture — and this is exactly what
   * a rollback card needs, since restoring means typing the old values back in.
   */
  async snapshot(scope: { pageIds?: string[] }): Promise<Snapshot> {
    const pages: Array<{ url: string; seo: SeoMeta; title: string; jsonLd: string[] }> = [];

    for (const id of scope.pageIds ?? []) {
      const url = id.startsWith('http') ? id : new URL(id, this.origin).toString();
      try {
        const res = await this.get(url);
        if (!res.ok) continue;
        const $ = cheerio.load(await res.text());
        pages.push({
          url,
          title: $('head title').first().text(),
          seo: readSeo($),
          jsonLd: $('script[type="application/ld+json"]').map((_, el) => $(el).text().trim()).get(),
        });
      } catch (err) {
        log.warn('could not snapshot Squarespace page', { url, error: err });
      }
    }

    return {
      id: `sqsp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      siteId: this.origin,
      payload: { pages },
      takenAt: new Date(),
    };
  }

  async rollback(_snapshot: Snapshot): Promise<ApplyResult> {
    throw new UnsupportedOperation(
      'rollback', 'squarespace',
      'nothing was applied automatically, so there is nothing to undo automatically. ' +
      'Use rollbackCards() to produce instructions for restoring the previous values',
    );
  }

  /** Cards that restore a snapshot by hand, for when a change made things worse. */
  rollbackCards(snapshot: Snapshot): ManualCard[] {
    const { pages } = snapshot.payload as {
      pages: Array<{ url: string; seo: SeoMeta; title: string }>;
    };
    const cards: ManualCard[] = [];

    for (const page of pages ?? []) {
      if (page.seo.description !== undefined) {
        const card = this.manualCard({
          id: `rollback:${page.url}:meta_description`,
          field: 'meta_description',
          page: page.url,
          before: null,
          after: page.seo.description,
          reason: 'Restoring the description that was in place before this batch was applied.',
        });
        if (card) cards.push(card);
      }
      if (page.title) {
        const card = this.manualCard({
          id: `rollback:${page.url}:seo_title`,
          field: 'seo_title',
          page: page.url,
          before: null,
          after: page.title,
          reason: 'Restoring the title that was in place before this batch was applied.',
        });
        if (card) cards.push(card);
      }
    }
    return cards;
  }

  // ------------------------------------------------------------------ cards

  /**
   * The instruction card for a change, or null when Squarespace cannot do it
   * at all — in which case the router should send it to Cloudflare rather than
   * hand someone steps that lead nowhere.
   */
  manualCard(
    change: Pick<Change, 'field' | 'after' | 'before' | 'reason' | 'page' | 'id'> & { target?: string },
  ): ManualCard | null {
    const ctx: CardContext = {
      siteVersion: this.siteVersion,
      itemKind: itemKindFor(change.page, this.origin),
      pageUrl: change.page,
    };
    return squarespaceCard(change, ctx);
  }

  /** True when no card exists and Cloudflare is the only remaining route. */
  requiresCloudflare(field: Change['field']): boolean {
    if (IMPOSSIBLE_FIELDS.includes(field)) return true;
    return field === 'llms_txt' && this.siteVersion === '7.0';
  }

  /** The AI-crawler checkbox, Squarespace's only robots.txt lever. */
  crawlerCard(allow: boolean, reason: string): ManualCard {
    return crawlerToggleCard(allow, reason);
  }

  // ---------------------------------------------------------------- helpers

  private async get(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Distinguish 7.0 from 7.1.
 *
 * The panel names differ between them, so a wrong guess sends someone to a
 * panel that does not exist. When the markers are absent we return 'unknown'
 * and the cards name both routes, which is slower to follow but never wrong.
 */
export function detectVersion(html: string): SiteVersion {
  const context = html.match(/Static\.SQUARESPACE_CONTEXT\s*=\s*(\{[\s\S]*?\});/);
  if (context?.[1]) {
    const explicit = context[1].match(/"templateVersion"\s*:\s*"?(7\.\d)"?/);
    if (explicit?.[1] === '7.1' || explicit?.[1] === '7.0') return explicit[1] as SiteVersion;
    // 7.1 sites are built on the shared "universal" template family.
    if (/"templateId"\s*:\s*"[^"]*"/.test(context[1]) && /universal/i.test(context[1])) return '7.1';
  }
  if (/sqs-layout|sqs-block-content/i.test(html) && /fluid-engine|sqs-layout-\w+/i.test(html)) {
    // Fluid Engine only exists on 7.1.
    if (/fluid-engine/i.test(html)) return '7.1';
  }
  return 'unknown';
}

function readSeo($: cheerio.CheerioAPI): SeoMeta {
  const seo: SeoMeta = {};
  const description = $('head meta[name="description"]').attr('content');
  const canonical = $('head link[rel="canonical"]').attr('href');
  const robots = $('head meta[name="robots"]').attr('content');
  if (description) seo.description = description;
  if (canonical) seo.canonical = canonical;
  if (robots) seo.robots = robots;
  return seo;
}

function guessItemKind(url: string): string {
  return itemKindFor(url, new URL(url).origin);
}

/**
 * Work out which Squarespace settings panel a URL belongs to.
 *
 * The path is the only signal we have without an admin session, so this is a
 * heuristic — and the card for a mis-guessed kind sends someone to the wrong
 * panel. The UI should let the consultant correct it.
 */
export function itemKindFor(url: string, origin: string): ItemKind {
  let path: string;
  try {
    path = new URL(url, origin).pathname.replace(/\/+$/, '');
  } catch {
    path = url;
  }
  if (path === '' || path === '/') return 'homepage';

  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return 'page';

  const parent = segments[0]!.toLowerCase();
  if (/^(blog|news|journal|articles?|insights)$/.test(parent)) return 'blog-post';
  if (/^(shop|store|products?)$/.test(parent)) return 'product';
  if (/^(events?|calendar)$/.test(parent)) return 'event';
  if (/^(portfolio|work|projects?)$/.test(parent)) return 'portfolio-item';

  return 'page';
}

export { squarespaceCard, crawlerToggleCard } from './cards.js';
export type { CardContext, ItemKind, SiteVersion } from './cards.js';
