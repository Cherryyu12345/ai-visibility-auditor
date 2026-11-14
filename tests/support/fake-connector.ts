/**
 * A connector whose behaviour a test can dictate, plus a fake site to verify
 * against.
 *
 * The point of these is that the engine's guarantees — approval gating,
 * verification before `verified`, fall-through on refusal — should hold for
 * *any* connector, so the tests state them against one we control rather than
 * against WordPress's quirks.
 */

import { DryRunRecorder, type ApplyResult, type Capabilities, type Connector, type ConnectionTest, type PagePatch, type PlannedRequest } from '../../src/core/connector.js';
import { UnsupportedOperation } from '../../src/core/errors.js';
import type { PageContent, PageRef, Platform, RootFile, SeoMeta, Snapshot } from '../../src/core/types.js';

export interface FakeOptions {
  platform?: Platform;
  capabilities?: Capabilities;
  /** Methods that throw UnsupportedOperation when actually called. */
  refuses?: string[];
  /** Methods that throw a hard error. */
  errors?: string[];
  dryRun?: boolean;
  pages?: PageRef[];
  /**
   * What rolling back actually does to the world.
   *
   * A connector that reports success without restoring anything is exactly
   * the failure the engine now checks for, so the fake has to be able to do
   * both — and does nothing by default.
   */
  onRollback?: (snapshot: Snapshot) => void;
}

export class FakeConnector implements Connector {
  readonly platform: Platform;
  readonly capabilities: Capabilities;
  dryRun: boolean;

  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly recorder = new DryRunRecorder();
  rolledBack: Snapshot[] = [];
  snapshotCounter = 0;

  private readonly onRollback: ((snapshot: Snapshot) => void) | undefined;
  private readonly refuses: Set<string>;
  private readonly errors: Set<string>;
  private readonly pages: PageRef[];

  constructor(opts: FakeOptions = {}) {
    this.platform = opts.platform ?? 'wordpress';
    this.dryRun = opts.dryRun ?? false;
    this.onRollback = opts.onRollback;
    this.refuses = new Set(opts.refuses ?? []);
    this.errors = new Set(opts.errors ?? []);
    this.pages = opts.pages ?? [
      { id: 'page:1', url: 'https://example.test/about', title: 'About', type: 'page', status: 'published' },
    ];
    this.capabilities = {
      testConnection: true, listPages: true, getPage: true, updatePage: true,
      createPage: true, setSeoMeta: true, injectSchema: true, setRootFile: true,
      snapshot: true, rollback: true,
      ...opts.capabilities,
    };
  }

  drainPlanned(): PlannedRequest[] { return this.recorder.drain(); }

  private enter(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.errors.has(method)) throw new Error(`${method} blew up`);
    if (this.refuses.has(method)) {
      throw new UnsupportedOperation(method as never, this.platform, 'the fake refuses this one');
    }
  }

  private ok(ref: string, describes: string): ApplyResult {
    if (this.dryRun) {
      this.recorder.record({
        method: 'POST', url: `https://api.test/${ref}`, headers: {}, describes,
      });
      return { ok: true, platformRef: ref, planned: this.recorder.drain() };
    }
    return { ok: true, platformRef: ref };
  }

  async testConnection(): Promise<ConnectionTest> {
    this.enter('testConnection');
    return { ok: true, platform: this.platform, checks: [{ name: 'Fake', ok: true, detail: 'fine' }] };
  }

  async listPages(): Promise<{ pages: PageRef[] }> {
    this.enter('listPages');
    return { pages: this.pages };
  }

  async getPage(id: string): Promise<PageContent> {
    this.enter('getPage', id);
    const ref = this.pages.find((p) => p.id === id) ?? this.pages[0]!;
    return { ...ref, slug: '/about', content: '', contentIsBuilderData: false };
  }

  async updatePage(id: string, patch: PagePatch): Promise<ApplyResult> {
    this.enter('updatePage', id, patch);
    return this.ok(id, `update ${Object.keys(patch).join(', ')}`);
  }

  async createPage(input: { title: string }): Promise<ApplyResult> {
    this.enter('createPage', input);
    return this.ok('new', 'create a page');
  }

  async setSeoMeta(id: string, meta: SeoMeta): Promise<ApplyResult> {
    this.enter('setSeoMeta', id, meta);
    return this.ok(id, `set ${Object.keys(meta).join(', ')}`);
  }

  async injectSchema(id: string, jsonLd: object | object[]): Promise<ApplyResult> {
    this.enter('injectSchema', id, jsonLd);
    return this.ok(id, 'inject JSON-LD');
  }

  async setRootFile(file: RootFile, content: string): Promise<ApplyResult> {
    this.enter('setRootFile', file, content);
    return this.ok(file, `write ${file}`);
  }

  async snapshot(scope: { pageIds?: string[]; rootFiles?: RootFile[] }): Promise<Snapshot> {
    this.enter('snapshot', scope);
    return {
      id: `snap-${++this.snapshotCounter}`,
      siteId: 'fake',
      payload: { scope },
      takenAt: new Date(),
    };
  }

  async rollback(snapshot: Snapshot): Promise<ApplyResult> {
    this.enter('rollback', snapshot);
    this.rolledBack.push(snapshot);
    this.onRollback?.(snapshot);
    return { ok: true };
  }
}

/**
 * A fetch that serves one page whose head reflects whatever has been
 * "applied" — so verification in tests exercises the real extractor against
 * real HTML rather than being stubbed out.
 */
export class FakeSite {
  title = 'Old title';
  description = 'Old description';
  jsonLd: string | null = null;
  robotsTxt = 'User-agent: *\nAllow: /';
  /** When true, the site serves stale content: applied, but not visible. */
  stale = false;

  readonly fetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/robots.txt')) {
      return new Response(this.stale ? 'User-agent: *\nAllow: /' : this.robotsTxt, {
        status: 200, headers: { 'content-type': 'text/plain' },
      });
    }
    const body =
      `<!doctype html><html><head><title>${this.title}</title>` +
      `<meta name="description" content="${this.description}">` +
      (this.jsonLd ? `<script type="application/ld+json">${this.jsonLd}</script>` : '') +
      '</head><body><h1>hi</h1></body></html>';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

/** Verification options that keep tests instant rather than retrying for seconds. */
export const FAST_VERIFY = { attempts: 1, initialDelayMs: 0, timeoutMs: 2000 };
