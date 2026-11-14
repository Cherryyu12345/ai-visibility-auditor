import { describe, it, expect, vi } from 'vitest';
import { SquarespaceConnector, itemKindFor, detectVersion } from '../../src/connectors/squarespace/index.js';
import { markDone, cardToText } from '../../src/core/manual.js';
import { UnsupportedOperation } from '../../src/core/errors.js';

const ORIGIN = 'https://clinic.test';

const PAGE_HTML = (title = 'About — The Clinic', description = 'Old description') => `<!doctype html>
<html><head>
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${ORIGIN}/about">
<script>Static.SQUARESPACE_CONTEXT = {"templateVersion":"7.1","templateId":"universal"};</script>
</head><body class="fluid-engine"><p>Hi</p></body></html>`;

const SITEMAP = `<?xml version="1.0"?>
<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/about</loc></url>
<url><loc>${ORIGIN}/blog/first-post</loc></url><url><loc>${ORIGIN}/shop/cream</loc></url></urlset>`;

function mockSite(opts: { html?: string; sitemapStatus?: number; pageStatus?: number } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    if (url.endsWith('/sitemap.xml')) {
      return new Response(SITEMAP, {
        status: opts.sitemapStatus ?? 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    return new Response(opts.html ?? PAGE_HTML(), {
      status: opts.pageStatus ?? 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as unknown as typeof fetch;
}

const connect = (opts: Parameters<typeof mockSite>[0] = {}, connOpts = {}) =>
  new SquarespaceConnector(ORIGIN, { fetchImpl: mockSite(opts), ...connOpts });

const change = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  field: 'meta_description' as const,
  page: `${ORIGIN}/about`,
  before: 'Old description',
  after: 'A London clinic offering consultant-led care.',
  reason: 'The page has no description, so answer engines invent one.',
  ...over,
});

describe('testConnection', () => {
  it('confirms the platform and detects the version', async () => {
    const sqsp = connect();
    const result = await sqsp.testConnection();
    expect(result.checks.find((c) => c.name === 'Platform')?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'Squarespace version')?.detail).toMatch(/7\.1/);
  });

  it('says plainly that it applies nothing by itself', async () => {
    const applying = (await connect().testConnection()).checks.find((c) => c.name === 'Applying changes');
    expect(applying?.ok).toBe(false);
    expect(applying?.detail).toMatch(/no API for page content/);
    expect(applying?.remedy).toMatch(/Cloudflare/);
  });

  it('still reports a usable connection, since cards are the expected outcome', async () => {
    expect((await connect().testConnection()).ok).toBe(true);
  });

  it('reports llms.txt as available on 7.1 and unavailable on 7.0', async () => {
    const on71 = (await connect().testConnection()).checks.find((c) => c.name === 'llms.txt');
    expect(on71?.ok).toBe(true);

    const on70 = (await connect({}, { siteVersion: '7.0' }).testConnection())
      .checks.find((c) => c.name === 'llms.txt');
    expect(on70?.ok).toBe(false);
  });

  it('admits when it cannot tell the version apart', async () => {
    const plain = connect({ html: '<html><head><title>x</title></head><body>static1.squarespace.com</body></html>' });
    const version = (await plain.testConnection()).checks.find((c) => c.name === 'Squarespace version');
    expect(version?.detail).toMatch(/Could not tell/);
    expect(version?.remedy).toMatch(/Set the version/);
  });
});

describe('reads', () => {
  it('lists pages from the sitemap, the only enumeration available', async () => {
    const { pages } = await connect().listPages();
    expect(pages.map((p) => p.url)).toContain(`${ORIGIN}/about`);
    expect(pages.find((p) => p.url.includes('/blog/'))?.type).toBe('blog-post');
  });

  it('explains itself when the sitemap cannot be read', async () => {
    await expect(connect({ sitemapStatus: 404 }).listPages())
      .rejects.toThrow(/no page-listing API/);
  });

  it('reads the live head of a page', async () => {
    const page = await connect().getPage('/about');
    expect(page.seo?.description).toBe('Old description');
    expect(page.contentIsBuilderData).toBe(true);
  });
});

describe('every write is refused, which is what routes changes onward', () => {
  it('refuses all of them with a reason', async () => {
    const sqsp = connect();
    await expect(sqsp.updatePage('/about', { title: 'x' })).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(sqsp.createPage({ title: 'x', content: 'y' })).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(sqsp.setSeoMeta('/about', { description: 'x' })).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(sqsp.injectSchema('/about', {})).rejects.toBeInstanceOf(UnsupportedOperation);
    await expect(sqsp.rollback({ id: 's', siteId: ORIGIN, payload: {}, takenAt: new Date() }))
      .rejects.toBeInstanceOf(UnsupportedOperation);
  });

  it('explains the robots.txt situation specifically', async () => {
    await expect(connect().setRootFile('robots.txt', 'x'))
      .rejects.toThrow(/shares one robots\.txt that cannot be edited/);
  });

  it('declares those capabilities false so the router never tries', () => {
    const sqsp = connect();
    expect(sqsp.capabilities.setSeoMeta).toBe(false);
    expect(sqsp.capabilities.injectSchema).toBe(false);
    expect(sqsp.capabilities.getPage).toBe(true);
  });
});

describe('instruction cards', () => {
  it('routes an SEO description to the page SEO tab', () => {
    const card = connect().manualCard(change())!;
    const steps = card.steps.map((s) => s.text).join(' | ');
    expect(steps).toMatch(/Pages panel/);
    expect(steps).toMatch(/gear icon/);
    expect(steps).toMatch(/SEO tab/);
    expect(steps).toMatch(/SEO Description/);
    expect(card.payload?.text).toBe(change().after);
  });

  it('routes the homepage description to the SEO/AI Visibility panel instead', () => {
    const card = connect().manualCard(change({ page: `${ORIGIN}/` }))!;
    expect(card.title).toMatch(/homepage/i);
    expect(card.steps.map((s) => s.text).join(' ')).toMatch(/SEO\/AI Visibility panel/);
    expect(card.steps.map((s) => s.text).join(' ')).toMatch(/Home tab/);
  });

  it('warns when a description exceeds the 400-character limit Squarespace enforces', () => {
    const card = connect().manualCard(change({ after: 'x'.repeat(420) }))!;
    expect(card.caveats?.[0]).toMatch(/420 characters and will be rejected/);
  });

  it('tells the consultant not to type the site name into the SEO title', () => {
    const card = connect().manualCard(change({ field: 'seo_title', after: 'About our clinic' }))!;
    expect(card.caveats?.join(' ')).toMatch(/Page SEO Title — Site Title/);
    expect(card.caveats?.join(' ')).toMatch(/Do not type it yourself/);
  });

  it('uses the right panel for a blog post, which differs from a page', () => {
    const card = connect().manualCard(change({ page: `${ORIGIN}/blog/first-post` }))!;
    const steps = card.steps.map((s) => s.text).join(' ');
    expect(steps).toMatch(/click the blog page/);
    expect(steps).toMatch(/Hover over the post and click Edit/);
  });

  it('uses double-click for a product', () => {
    const card = connect().manualCard(change({ page: `${ORIGIN}/shop/cream` }))!;
    expect(card.steps.map((s) => s.text).join(' ')).toMatch(/Double-click the product/);
  });

  it('wraps JSON-LD in script tags and names the plan requirement', () => {
    const card = connect().manualCard(change({
      field: 'json_ld',
      after: '{"@type":"MedicalClinic","name":"The Clinic"}',
    }))!;
    expect(card.payload?.text).toMatch(/^<script type="application\/ld\+json">/);
    expect(card.payload?.text).toMatch(/<\/script>$/);
    expect(card.requirement).toMatch(/Core, Plus, Advanced/);
  });

  it('carries the header-transparency warning for per-page code injection', () => {
    const card = connect().manualCard(change({ field: 'json_ld', after: '{}' }))!;
    expect(card.caveats?.join(' ')).toMatch(/turn off the header's transparency/);
    expect(card.steps.map((s) => s.text).join(' ')).toMatch(/Page Header Code Injection/);
  });

  it('sends site-wide JSON-LD to the Code Injection header instead', () => {
    const card = connect().manualCard(change({ field: 'json_ld', after: '{}', page: `${ORIGIN}/` }))!;
    expect(card.steps.map((s) => s.text).join(' ')).toMatch(/Code Injection panel/);
    expect(card.caveats?.join(' ')).not.toMatch(/transparency/);
  });

  it('routes llms.txt to the panel Squarespace added for it', () => {
    const card = connect().manualCard(change({ field: 'llms_txt', after: '# Clinic' }))!;
    const steps = card.steps.map((s) => s.text).join(' ');
    expect(steps).toMatch(/SEO\/AI Visibility panel/);
    expect(steps).toMatch(/LLMS\.txt tab/);
    expect(card.verifyUrl).toBe(`${ORIGIN}/llms.txt`);
  });

  it('has no llms.txt card on 7.0, so it falls through to Cloudflare', () => {
    const sqsp = connect({}, { siteVersion: '7.0' });
    expect(sqsp.manualCard(change({ field: 'llms_txt', after: '# x' }))).toBeNull();
    expect(sqsp.requiresCloudflare('llms_txt')).toBe(true);
  });

  it('produces no card for robots.txt or canonical, which Squarespace cannot do at all', () => {
    const sqsp = connect();
    expect(sqsp.manualCard(change({ field: 'robots_txt', after: 'User-agent: *' }))).toBeNull();
    expect(sqsp.manualCard(change({ field: 'canonical', after: 'https://x.test/' }))).toBeNull();
    expect(sqsp.requiresCloudflare('robots_txt')).toBe(true);
    expect(sqsp.requiresCloudflare('canonical')).toBe(true);
  });

  it('offers the noindex toggle but nothing for other robots directives', () => {
    const sqsp = connect();
    const noindex = sqsp.manualCard(change({ field: 'robots_meta', after: 'noindex,nofollow' }))!;
    expect(noindex.steps.map((s) => s.text).join(' ')).toMatch(/Hide this page from search engines/);
    expect(sqsp.manualCard(change({ field: 'robots_meta', after: 'index,follow' }))).toBeNull();
  });

  it('warns that changing a slug breaks links, and says where to add the redirect', () => {
    const card = connect().manualCard(change({ field: 'slug', after: 'about-us' }))!;
    expect(card.caveats?.join(' ')).toMatch(/URL Mappings/);
    expect(card.caveats?.join(' ')).toMatch(/breaks every existing link/);
  });
});

describe('the AI crawler checkbox', () => {
  it('is offered separately and is honest about being all-or-nothing', () => {
    const card = connect().crawlerCard(true, 'The site currently blocks AI crawlers.');
    expect(card.steps.map((s) => s.text).join(' ')).toMatch(/Settings, then click Crawlers/);
    expect(card.caveats?.join(' ')).toMatch(/all-or-nothing/);
    expect(card.caveats?.join(' ')).toMatch(/shares one robots\.txt/);
  });
});

describe('marking a manual change done', () => {
  it("does not take the consultant's word for it: it re-fetches as a crawler", async () => {
    const card = connect().manualCard(change())!;
    const fetchImpl = vi.fn(async () => new Response(PAGE_HTML('t', 'Old description'), {
      status: 200, headers: { 'content-type': 'text/html' },
    }));

    const result = await markDone(card, change(), { fetchImpl: fetchImpl as never, attempts: 1 });
    expect(result.verified).toBe(false);
    expect(result.found).toBe('Old description');
  });

  it('verifies once the change is actually live', async () => {
    const c = change();
    const card = connect().manualCard(c)!;
    const fetchImpl = vi.fn(async () => new Response(PAGE_HTML('t', c.after), {
      status: 200, headers: { 'content-type': 'text/html' },
    }));

    const result = await markDone(card, c, { fetchImpl: fetchImpl as never, attempts: 1 });
    expect(result.verified).toBe(true);
  });

  it('says so when there is nothing to check', async () => {
    const card = { ...connect().manualCard(change())!, verifyUrl: undefined };
    const result = await markDone(card, change());
    expect(result.verified).toBe(false);
    expect(result.detail).toMatch(/cannot be verified automatically/);
  });
});

describe('snapshot and rollback by hand', () => {
  it('captures what the live page serves', async () => {
    const snap = await connect().snapshot({ pageIds: ['/about'] });
    const { pages } = snap.payload as { pages: Array<{ seo: { description?: string } }> };
    expect(pages[0]?.seo.description).toBe('Old description');
  });

  it('turns a snapshot into cards that restore the old values', async () => {
    const sqsp = connect();
    const snap = await sqsp.snapshot({ pageIds: ['/about'] });
    const cards = sqsp.rollbackCards(snap);

    const description = cards.find((c) => c.field === 'meta_description');
    expect(description?.payload?.text).toBe('Old description');
    expect(description?.why).toMatch(/Restoring/);
  });
});

describe('working out which panel a URL belongs to', () => {
  it('maps paths to Squarespace item kinds', () => {
    expect(itemKindFor(`${ORIGIN}/`, ORIGIN)).toBe('homepage');
    expect(itemKindFor(`${ORIGIN}/about`, ORIGIN)).toBe('page');
    expect(itemKindFor(`${ORIGIN}/blog/post`, ORIGIN)).toBe('blog-post');
    expect(itemKindFor(`${ORIGIN}/shop/item`, ORIGIN)).toBe('product');
    expect(itemKindFor(`${ORIGIN}/events/party`, ORIGIN)).toBe('event');
    expect(itemKindFor(`${ORIGIN}/portfolio/piece`, ORIGIN)).toBe('portfolio-item');
  });

  it('treats an unrecognised nested path as an ordinary page', () => {
    expect(itemKindFor(`${ORIGIN}/services/botox`, ORIGIN)).toBe('page');
  });
});

describe('version detection', () => {
  it('reads the version from the Squarespace context when present', () => {
    expect(detectVersion('Static.SQUARESPACE_CONTEXT = {"templateVersion":"7.1"};')).toBe('7.1');
    expect(detectVersion('Static.SQUARESPACE_CONTEXT = {"templateVersion":"7.0"};')).toBe('7.0');
  });

  it('infers 7.1 from Fluid Engine, which only exists there', () => {
    expect(detectVersion('<div class="fluid-engine sqs-layout"><p>x</p></div>')).toBe('7.1');
  });

  it('returns unknown rather than guessing', () => {
    expect(detectVersion('<html><body>nothing useful</body></html>')).toBe('unknown');
  });
});

describe('card rendering', () => {
  it('renders as plain text for pasting into an email', () => {
    const text = cardToText(connect().manualCard(change())!);
    expect(text).toMatch(/^Set the SEO description/);
    expect(text).toMatch(/1\. Open the Pages panel/);
    expect(text).toMatch(/SEO description:/);
    expect(text).toMatch(/Watch out for:/);
  });
});
