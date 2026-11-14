import { describe, it, expect } from 'vitest';
import { WixConnector } from '../../src/connectors/wix/index.js';
import { WixAuth, installUrl } from '../../src/connectors/wix/auth.js';
import { applyMetaToTags, applyJsonLdToTags, tagsToSeoMeta, extractJsonLd } from '../../src/connectors/wix/seo.js';
import { createMockWix, type MockWixOptions } from '../support/mock-wix.js';
import { UnsupportedOperation, ConnectorError } from '../../src/core/errors.js';

const APP_CREDS = {
  kind: 'app' as const,
  clientId: 'app-id-123',
  clientSecret: 'app-secret-abcdefghijk',
  instanceId: 'instance-xyz',
};

const KEY_CREDS = {
  kind: 'api-key' as const,
  apiKey: 'key-abcdefghijklmnop',
  siteId: 'site-1',
};

const withWix = (opts: MockWixOptions = {}, creds: typeof APP_CREDS | typeof KEY_CREDS = APP_CREDS, connOpts = {}) => {
  const mock = createMockWix(opts);
  const wix = new WixConnector(creds, { fetchImpl: mock.fetchImpl, ...connOpts });
  return { wix, mock };
};

describe('auth', () => {
  it('exchanges app credentials for an access token', async () => {
    const mock = createMockWix();
    const auth = new WixAuth(APP_CREDS, mock.fetchImpl);
    expect(await auth.accessToken()).toBe('tok-1');

    const call = mock.state.calls.find((c) => c.path === '/oauth2/token');
    expect(call?.body).toMatchObject({
      grant_type: 'client_credentials',
      client_id: APP_CREDS.clientId,
      instance_id: APP_CREDS.instanceId,
    });
  });

  it('caches the token rather than refetching on every call', async () => {
    const mock = createMockWix();
    const auth = new WixAuth(APP_CREDS, mock.fetchImpl);
    await auth.accessToken();
    await auth.accessToken();
    await auth.accessToken();
    expect(mock.state.tokenRequests).toBe(1);
  });

  it('refreshes a token that is about to expire', async () => {
    // Wix issues 4h tokens; we refresh a minute early, so a 30s TTL is already stale.
    const mock = createMockWix({ tokenTtlSeconds: 30 });
    const auth = new WixAuth(APP_CREDS, mock.fetchImpl);
    await auth.accessToken();
    await auth.accessToken();
    expect(mock.state.tokenRequests).toBe(2);
  });

  it('reports bad app credentials clearly', async () => {
    const mock = createMockWix({ tokenFails: true });
    const auth = new WixAuth(APP_CREDS, mock.fetchImpl);
    await expect(auth.accessToken()).rejects.toThrow(/refused the app credentials/);
  });

  it('builds an install URL carrying the app id and redirect', () => {
    const url = new URL(installUrl('app-id-123', 'https://auditor.test/wix/callback', 'state-1'));
    expect(url.searchParams.get('appId')).toBe('app-id-123');
    expect(url.searchParams.get('redirectUrl')).toBe('https://auditor.test/wix/callback');
    expect(url.searchParams.get('state')).toBe('state-1');
  });
});

describe('testConnection', () => {
  it('passes with an installed app', async () => {
    const { wix } = withWix();
    const result = await wix.testConnection();
    const blocking = result.checks.filter((c) => !c.ok && c.name !== 'Root files');
    expect(blocking, JSON.stringify(blocking)).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('explains why an API key cannot be used', async () => {
    const { wix } = withWix({}, KEY_CREDS);
    const result = await wix.testConnection();
    expect(result.ok).toBe(false);

    const credential = result.checks.find((c) => c.name === 'Credential type');
    expect(credential?.ok).toBe(false);
    expect(credential?.remedy).toMatch(/Install the AI Visibility Auditor app/);
  });

  it('reports that Wix cannot serve robots.txt or llms.txt', async () => {
    const { wix } = withWix();
    const rootFiles = (await wix.testConnection()).checks.find((c) => c.name === 'Root files');
    expect(rootFiles?.ok).toBe(false);
    expect(rootFiles?.remedy).toMatch(/Cloudflare/);
  });

  it('warns that the API is in Developer Preview', async () => {
    const { wix } = withWix();
    const preview = (await wix.testConnection()).checks.find((c) => c.name === 'Developer Preview');
    expect(preview?.detail).toMatch(/may change/);
  });
});

describe('the two documented SEO base paths', () => {
  it('uses the documented path when it answers', async () => {
    const { wix, mock } = withWix({ liveBase: '/seo-metatags-server/v1' });
    await wix.listPages({ limit: 10 });
    expect(mock.state.calls.some((c) => c.path.startsWith('/seo-metatags-server/v1'))).toBe(true);
  });

  it('falls back to the path in the cURL examples when the documented one 404s', async () => {
    const { wix, mock } = withWix({ liveBase: '/promote/seo/v1' });
    const { pages } = await wix.listPages({ limit: 10 });
    expect(pages.length).toBeGreaterThan(0);
    expect(mock.state.calls.some((c) => c.path.startsWith('/promote/seo/v1'))).toBe(true);
  });

  it('remembers which path worked instead of probing every call', async () => {
    const { wix, mock } = withWix({ liveBase: '/promote/seo/v1' });
    await wix.listPages({ limit: 10 });
    const before = mock.state.calls.filter((c) => c.path.startsWith('/seo-metatags-server/v1')).length;
    await wix.getPage('STATIC_PAGE:about');
    const after = mock.state.calls.filter((c) => c.path.startsWith('/seo-metatags-server/v1')).length;
    expect(after).toBe(before);
  });
});

describe('listPages and getPage', () => {
  it('lists items across every type the site has', async () => {
    const { wix } = withWix();
    const { pages } = await wix.listPages({ limit: 50 });
    const types = new Set(pages.map((p) => p.type));
    expect(types).toContain('STATIC_PAGE');
    expect(types).toContain('STORES_PRODUCT');
    expect(types).toContain('BLOG_POST');
  });

  it('reads an item\'s own SEO tags', async () => {
    const { wix } = withWix();
    const page = await wix.getPage('STATIC_PAGE:about');
    expect(page.seo?.title).toBe('About');
    expect(page.id).toBe('STATIC_PAGE:about');
  });

  it('marks Wix pages as not body-writable, because no API reaches the content', async () => {
    const { wix } = withWix();
    expect((await wix.getPage('STATIC_PAGE:about')).contentIsBuilderData).toBe(true);
  });
});

describe('setSeoMeta', () => {
  it('writes a description and preserves tags set by hand in the Wix editor', async () => {
    const { wix, mock } = withWix();
    await wix.setSeoMeta('STATIC_PAGE:about', { description: 'A London clinic.' });

    const stored = mock.state.items.get('STATIC_PAGE:about')!;
    expect(tagsToSeoMeta(stored.tags).description).toBe('A London clinic.');
    expect(tagsToSeoMeta(stored.tags).title).toBe('About');
    // The verification tag must survive a full-replacement write.
    expect(stored.tags.some((t) => t.props?.name === 'google-site-verification')).toBe(true);
  });

  it('sends publish:true for static pages, which keep a draft', async () => {
    const { wix, mock } = withWix();
    await wix.setSeoMeta('STATIC_PAGE:about', { description: 'x' });
    const patch = mock.state.calls.find((c) => c.method === 'PATCH');
    expect((patch?.body as { publish?: boolean }).publish).toBe(true);
  });

  it('omits publish for item types that are always live', async () => {
    const { wix, mock } = withWix();
    await wix.setSeoMeta('STORES_PRODUCT:p1', { description: 'x' });
    const patch = mock.state.calls.find((c) => c.method === 'PATCH');
    expect((patch?.body as { publish?: boolean }).publish).toBeUndefined();
  });

  it('surfaces an actionable message when the page has no published revision', async () => {
    const { wix } = withWix({ noPublishedRevision: true });
    await expect(wix.setSeoMeta('STATIC_PAGE:about', { description: 'x' }))
      .rejects.toThrow(/Publish the page in the Wix editor/);
  });

  it('refuses to write an item type Wix only supports reading', async () => {
    const { wix } = withWix();
    await expect(wix.setSeoMeta('EVENTS_PAGE:e1', { description: 'x' }))
      .rejects.toBeInstanceOf(UnsupportedOperation);
  });
});

describe('injectSchema', () => {
  it('writes structured data and keeps the other tags', async () => {
    const { wix, mock } = withWix();
    await wix.injectSchema('STATIC_PAGE:about', { '@type': 'MedicalClinic', name: 'Clinic' });

    const stored = mock.state.items.get('STATIC_PAGE:about')!;
    expect(extractJsonLd(stored.tags)).toEqual([{ '@type': 'MedicalClinic', name: 'Clinic' }]);
    expect(stored.tags.some((t) => t.type === 'title')).toBe(true);
  });

  it('replaces previous structured data rather than stacking duplicates', async () => {
    const { wix, mock } = withWix();
    await wix.injectSchema('STATIC_PAGE:about', { '@type': 'Stale' });
    await wix.injectSchema('STATIC_PAGE:about', { '@type': 'Fresh' });

    const stored = mock.state.items.get('STATIC_PAGE:about')!;
    expect(extractJsonLd(stored.tags)).toEqual([{ '@type': 'Fresh' }]);
  });
});

describe('what Wix cannot do', () => {
  it('maps a title change onto the SEO title, which is what Wix renders', async () => {
    const { wix, mock } = withWix();
    await wix.updatePage('STATIC_PAGE:about', { title: 'About our clinic' });
    expect(tagsToSeoMeta(mock.state.items.get('STATIC_PAGE:about')!.tags).title).toBe('About our clinic');
  });

  it('refuses slugs, body content, excerpts and content blocks', async () => {
    const { wix } = withWix();
    await expect(wix.updatePage('STATIC_PAGE:about', { slug: 'x' })).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(wix.updatePage('STATIC_PAGE:about', { content: 'x' })).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(wix.updatePage('STATIC_PAGE:about', { excerpt: 'x' })).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(wix.updatePage('STATIC_PAGE:about', {
      blocks: [{ selector: '#x', mode: 'replace', html: 'y' }],
    })).rejects.toBeInstanceOf(UnsupportedOperation);
  });

  it('refuses to create a page or write root files, so routing falls through', async () => {
    const { wix } = withWix();
    await expect(wix.createPage({ title: 't', content: 'c' })).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(wix.setRootFile('robots.txt', 'x')).rejects.toBeInstanceOf(UnsupportedOperation);
  });

  it('declares those capabilities as unsupported so the router never tries', async () => {
    const { wix } = withWix();
    expect(wix.capabilities.createPage).toBe(false);
    expect(wix.capabilities.setRootFile).toBe(false);
    expect(wix.capabilities.setSeoMeta).toBe(true);
  });
});

describe('resolving a URL to an item', () => {
  it('works after listPages has run', async () => {
    const { wix, mock } = withWix();
    await wix.listPages({ limit: 50 });
    await wix.setSeoMeta('https://clinic.wixsite.com/about', { description: 'By URL.' });
    expect(tagsToSeoMeta(mock.state.items.get('STATIC_PAGE:about')!.tags).description).toBe('By URL.');
  });

  it('says what to do when the URL has not been mapped yet', async () => {
    const { wix } = withWix();
    await expect(wix.setSeoMeta('https://clinic.wixsite.com/about', { description: 'x' }))
      .rejects.toThrow(/Call listPages\(\) first/);
  });
});

describe('bulk writes', () => {
  it('applies many items in one call and reports per-item results', async () => {
    const { wix } = withWix();
    const result = await wix.bulkSetSeoMeta([
      { id: 'STATIC_PAGE:about', meta: { description: 'A' } },
      { id: 'STATIC_PAGE:home', meta: { description: 'B' } },
      { id: 'STATIC_PAGE:ghost', meta: { description: 'C' } },
    ]);
    expect(result.applied).toEqual(['STATIC_PAGE:about', 'STATIC_PAGE:home']);
    expect(result.failed).toEqual([{ id: 'STATIC_PAGE:ghost', reason: 'item not found' }]);
  });

  it('refuses a batch that mixes item types, which Wix cannot accept', async () => {
    const { wix } = withWix();
    await expect(wix.bulkSetSeoMeta([
      { id: 'STATIC_PAGE:about', meta: { description: 'A' } },
      { id: 'STORES_PRODUCT:p1', meta: { description: 'B' } },
    ])).rejects.toThrow(/single item type/);
  });

  it('refuses more than Wix\'s limit of 100', async () => {
    const { wix } = withWix();
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `STATIC_PAGE:p${i}`, meta: { description: 'x' } }));
    await expect(wix.bulkSetSeoMeta(many)).rejects.toThrow(/at most 100/);
  });
});

describe('snapshot and rollback', () => {
  it('restores the previous tags', async () => {
    const { wix, mock } = withWix();
    const snap = await wix.snapshot({ pageIds: ['STATIC_PAGE:about'] });

    await wix.setSeoMeta('STATIC_PAGE:about', { title: 'Wrong title' });
    expect(tagsToSeoMeta(mock.state.items.get('STATIC_PAGE:about')!.tags).title).toBe('Wrong title');

    const result = await wix.rollback(snap);
    expect(result.ok, result.detail).toBe(true);
    expect(tagsToSeoMeta(mock.state.items.get('STATIC_PAGE:about')!.tags).title).toBe('About');
  });

  it('resets an item that had no tags, restoring inheritance rather than blanking it', async () => {
    const { wix, mock } = withWix();
    const snap = await wix.snapshot({ pageIds: ['STATIC_PAGE:home'] });

    await wix.setSeoMeta('STATIC_PAGE:home', { description: 'Added.' });
    expect(mock.state.items.get('STATIC_PAGE:home')!.hasOverride).toBe(true);

    await wix.rollback(snap);
    const stored = mock.state.items.get('STATIC_PAGE:home')!;
    expect(stored.tags).toEqual([]);
    expect(stored.hasOverride).toBe(false);
    expect(mock.state.calls.some((c) => c.path.endsWith('/reset'))).toBe(true);
  });
});

describe('tag mapping', () => {
  it('round-trips SeoMeta through Wix tag shapes', () => {
    const meta = {
      title: 'T', description: 'D', canonical: 'https://a.test/c', robots: 'index,follow',
    };
    expect(tagsToSeoMeta(applyMetaToTags([], meta))).toMatchObject(meta);
  });

  it('updates a tag in place instead of adding a second one', () => {
    const once = applyMetaToTags([], { description: 'First' });
    const twice = applyMetaToTags(once, { description: 'Second' });
    expect(twice.filter((t) => t.props?.name === 'description')).toHaveLength(1);
    expect(tagsToSeoMeta(twice).description).toBe('Second');
  });

  it('keeps unrelated tags untouched', () => {
    const existing = [{ type: 'meta' as const, props: { name: 'theme-color', content: '#fff' } }];
    const after = applyMetaToTags(existing, { title: 'T' });
    expect(after).toContainEqual(existing[0]);
  });

  it('serialises JSON-LD as a script tag Wix understands', () => {
    const tags = applyJsonLdToTags([], { '@type': 'Thing' });
    expect(tags[0]).toMatchObject({ type: 'script', props: { type: 'application/ld+json' } });
    expect(JSON.parse(tags[0]!.children!)).toEqual({ '@type': 'Thing' });
  });
});

describe('dry run', () => {
  it('writes nothing and reports what it would send', async () => {
    const { wix, mock } = withWix({}, APP_CREDS, { dryRun: true });
    const before = JSON.stringify([...mock.state.items.values()]);
    const result = await wix.setSeoMeta('STATIC_PAGE:about', { description: 'Must not persist' });

    expect(result.planned?.length).toBeGreaterThan(0);
    expect(result.planned![0]!.method).toBe('PATCH');
    expect(JSON.stringify([...mock.state.items.values()])).toBe(before);
  });

  it('never exposes credentials in the dry-run view', async () => {
    const { wix } = withWix({}, APP_CREDS, { dryRun: true });
    const result = await wix.setSeoMeta('STATIC_PAGE:about', { description: 'x' });
    const serialised = JSON.stringify(result.planned);
    expect(serialised).not.toContain(APP_CREDS.clientSecret);
    expect(serialised).toContain('[redacted]');
  });
});
