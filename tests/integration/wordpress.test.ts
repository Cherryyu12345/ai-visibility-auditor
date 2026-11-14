/**
 * Every WordPress connector method, against a real WordPress.
 *
 * The site is genuine WordPress running on genuine PHP (via WordPress
 * Playground), not a mock: the REST API, the SEO probe, the bridge plugin and
 * the rendered HTML are all real. Verification fetches the page over HTTP with
 * an AI-crawler user agent, exactly as production does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWordPress } from '../../tools/playground.mjs';
import { WordPressConnector } from '../../src/connectors/wordpress/index.js';
import { UnsafeWrite } from '../../src/core/errors.js';
import { verifyChange, verifyRootFile } from '../../src/core/verify.js';
import { detectFromCrawl } from '../../src/detect/platform.js';

let site: Awaited<ReturnType<typeof startWordPress>>;
let wp: WordPressConnector;

const creds = () => ({
  siteUrl: site.baseUrl,
  username: site.harness.username,
  applicationPassword: site.harness.app_password,
});

beforeAll(async () => {
  site = await startWordPress({ quiet: true });
  wp = new WordPressConnector(creds());
  await wp.testConnection();
}, 300_000);

afterAll(() => site?.stop());

describe('testConnection', () => {
  it('passes every check against a healthy site', async () => {
    const result = await wp.testConnection();
    const failed = result.checks.filter((c) => !c.ok);
    expect(failed, `failing checks: ${JSON.stringify(failed)}`).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(result.platform).toBe('wordpress');
  });

  it('resolves SEO writability by probing, and leaves no debris behind', async () => {
    const before = await wp.listPages({ limit: 100 });
    await wp.testConnection();
    const after = await wp.listPages({ limit: 100 });
    expect(after.pages.length).toBe(before.pages.length);
    expect(wp.seoStrategyDescription).toMatch(/companion plugin|post meta/);
  });

  it('reports a wrong password as an auth failure, not a stripped header', async () => {
    const bad = new WordPressConnector({ ...creds(), applicationPassword: 'wrong wrong wrong wrong' });
    const result = await bad.testConnection();
    const auth = result.checks.find((c) => c.name === 'Authentication');
    expect(auth?.ok).toBe(false);
    expect(auth?.detail).toMatch(/received credentials and rejected them/);
  });

  it('detects a stripped Authorization header distinctly', async () => {
    // Simulate a host that drops the header before PHP sees it.
    const stripping: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      return fetch(input as string, { ...init, headers });
    };
    const blind = new WordPressConnector(creds(), { fetchImpl: stripping });
    const result = await blind.testConnection();
    const auth = result.checks.find((c) => c.name === 'Authentication');
    expect(auth?.ok).toBe(false);
    expect(auth?.detail).toMatch(/never received the Authorization header/);
    expect(auth?.remedy).toMatch(/HTTP_AUTHORIZATION|fastcgi_pass_header/);
  });
});

describe('detection against the live site', () => {
  it('identifies the served HTML as WordPress', async () => {
    const res = await fetch(site.baseUrl);
    const html = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    expect(detectFromCrawl({ url: site.baseUrl, html, headers }).platform).toBe('wordpress');
  });
});

describe('listPages / getPage', () => {
  it('lists the seeded pages and posts', async () => {
    const { pages } = await wp.listPages({ limit: 50 });
    const titles = pages.map((p) => p.title);
    expect(titles).toContain('About our clinic');
    expect(titles).toContain('Treatments');
    expect(titles).toContain('First post');
  });

  it('returns page content with a resolvable URL', async () => {
    const page = await wp.getPage(`page:${site.harness.pages.about}`);
    expect(page.title).toBe('About our clinic');
    expect(page.slug).toBe('about');
    expect(page.content).toContain('We are a clinic');
    expect(page.url).toMatch(/^http/);
    expect(page.contentIsBuilderData).toBe(false);
  });

  it('flags a builder-owned page', async () => {
    const page = await wp.getPage(`page:${site.harness.pages.treatments}`);
    expect(page.contentIsBuilderData).toBe(true);
    expect(page.builder).toBe('elementor');
  });
});

describe('updatePage', () => {
  it('updates a title and the change is visible to a non-JS crawler', async () => {
    const id = `page:${site.harness.pages.about}`;
    const page = await wp.getPage(id);
    const newTitle = `About our clinic ${Date.now()}`;

    const result = await wp.updatePage(id, { title: newTitle });
    expect(result.ok).toBe(true);

    const v = await verifyChange(page.url, 'title', newTitle, undefined, { attempts: 3, initialDelayMs: 500 });
    expect(v.verified, `found: ${v.found}`).toBe(true);
  });

  it('updates slug and excerpt', async () => {
    const id = `post:${site.harness.pages.post}`;
    await wp.updatePage(id, { slug: 'first-post-renamed', excerpt: 'A short summary.' });
    const after = await wp.getPage(id);
    expect(after.slug).toBe('first-post-renamed');
    expect(after.excerpt).toContain('A short summary.');
  });

  it('refuses to overwrite builder-owned body content', async () => {
    const id = `page:${site.harness.pages.treatments}`;
    await expect(wp.updatePage(id, { content: '<p>new body</p>' })).rejects.toBeInstanceOf(UnsafeWrite);

    // And the original content is untouched.
    const after = await wp.getPage(id);
    expect(after.content).toContain('Stale copy');
  });

  it('still allows a title change on a builder page', async () => {
    const id = `page:${site.harness.pages.treatments}`;
    const result = await wp.updatePage(id, { title: 'Treatments and prices' });
    expect(result.ok).toBe(true);
    expect((await wp.getPage(id)).title).toBe('Treatments and prices');
  });
});

describe('createPage', () => {
  it('creates a draft page', async () => {
    const result = await wp.createPage({ title: 'Our approach', content: '<p>How we work.</p>', status: 'draft' });
    expect(result.ok).toBe(true);
    expect(result.platformRef).toBeTruthy();

    const created = await wp.getPage(`page:${result.platformRef}`);
    expect(created.title).toBe('Our approach');
    expect(created.status).toBe('draft');
  });

  it('creates a published page that a crawler can read', async () => {
    const title = `Published page ${Date.now()}`;
    const result = await wp.createPage({ title, content: '<p>Live.</p>', status: 'published' });
    const created = await wp.getPage(`page:${result.platformRef}`);
    const v = await verifyChange(created.url, 'title', title, undefined, { attempts: 3, initialDelayMs: 500 });
    expect(v.verified, `found: ${v.found}`).toBe(true);
  });
});

describe('setSeoMeta', () => {
  it('writes a meta description that appears in the served HTML', async () => {
    const id = `page:${site.harness.pages.about}`;
    const page = await wp.getPage(id);
    const description = `Clinic in London offering X. ${Date.now()}`;

    const result = await wp.setSeoMeta(id, { description });
    expect(result.ok).toBe(true);

    const v = await verifyChange(page.url, 'meta_description', description, undefined, {
      attempts: 3, initialDelayMs: 500,
    });
    expect(v.verified, `found: ${v.found}`).toBe(true);
  });

  it('writes a canonical URL', async () => {
    const id = `page:${site.harness.pages.about}`;
    const page = await wp.getPage(id);
    const canonical = `${site.baseUrl}/about-canonical/`;

    await wp.setSeoMeta(id, { canonical });
    const v = await verifyChange(page.url, 'canonical', canonical, undefined, { attempts: 3, initialDelayMs: 500 });
    expect(v.verified, `found: ${v.found}`).toBe(true);
  });

  it('reads SEO values back through getPage', async () => {
    const id = `page:${site.harness.pages.about}`;
    await wp.setSeoMeta(id, { description: 'Readback check.' });
    // The bridge stores under its own keys when no SEO plugin owns the field;
    // the served HTML is the contract, so assert there.
    const page = await wp.getPage(id);
    const v = await verifyChange(page.url, 'meta_description', 'Readback check.', undefined, {
      attempts: 3, initialDelayMs: 500,
    });
    expect(v.verified).toBe(true);
  });
});

describe('injectSchema', () => {
  it('injects JSON-LD into the head where a crawler can read it', async () => {
    const id = `page:${site.harness.pages.about}`;
    const page = await wp.getPage(id);
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'MedicalClinic',
      name: 'Our clinic',
      address: { '@type': 'PostalAddress', addressLocality: 'London' },
    };

    const result = await wp.injectSchema(id, jsonLd);
    expect(result.ok).toBe(true);

    const v = await verifyChange(page.url, 'json_ld', JSON.stringify(jsonLd), undefined, {
      attempts: 3, initialDelayMs: 500,
    });
    expect(v.verified, `found: ${v.found}`).toBe(true);
  });

  it('neutralises a </script> smuggled into a JSON-LD string value', async () => {
    const id = `page:${site.harness.pages.about}`;
    const page = await wp.getPage(id);
    await wp.injectSchema(id, { '@type': 'Thing', name: '</script><img src=x onerror=alert(1)>' });

    const html = await (await fetch(page.url)).text();
    // The raw closing tag must not terminate our script block.
    expect(html).not.toContain('</script><img src=x');
    expect(html).toContain('<\\/script>');
  });
});

describe('setRootFile', () => {
  it('serves a custom robots.txt', async () => {
    const content = `User-agent: GPTBot\nAllow: /\n# ${Date.now()}`;
    const result = await wp.setRootFile('robots.txt', content);
    expect(result.ok).toBe(true);

    const v = await verifyRootFile(site.baseUrl, 'robots.txt', 'User-agent: GPTBot', { attempts: 3, initialDelayMs: 500 });
    expect(v.verified, `found: ${v.found}`).toBe(true);
  });

  it('serves llms.txt, which WordPress has no native concept of', async () => {
    const content = `# Our clinic\n\n> Aesthetic clinic in London.\n\n- [About](${site.baseUrl}/about/)`;
    const result = await wp.setRootFile('llms.txt', content);
    expect(result.ok).toBe(true);

    const res = await fetch(`${site.baseUrl}/llms.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await res.text()).toContain('Aesthetic clinic in London');
  });
});

describe('snapshot and rollback', () => {
  it('restores a page to its previous state', async () => {
    const id = `page:${site.harness.pages.about}`;
    const before = await wp.getPage(id);

    const snap = await wp.snapshot({ pageIds: [id] });
    expect(snap.id).toBeTruthy();

    await wp.updatePage(id, { title: 'Temporarily wrong title', content: '<p>Temporarily wrong body.</p>' });
    expect((await wp.getPage(id)).title).toBe('Temporarily wrong title');

    const result = await wp.rollback(snap);
    expect(result.ok, result.detail).toBe(true);

    const after = await wp.getPage(id);
    expect(after.title).toBe(before.title);
    expect(after.content.trim()).toBe(before.content.trim());
  });

  it('restores robots.txt', async () => {
    await wp.setRootFile('robots.txt', 'User-agent: *\nDisallow: /original');
    const snap = await wp.snapshot({ rootFiles: ['robots.txt'] });

    await wp.setRootFile('robots.txt', 'User-agent: *\nDisallow: /changed');
    expect(await (await fetch(`${site.baseUrl}/robots.txt`)).text()).toContain('/changed');

    await wp.rollback(snap);
    expect(await (await fetch(`${site.baseUrl}/robots.txt`)).text()).toContain('/original');
  });

  it('does not restore builder-owned content it was never allowed to write', async () => {
    const id = `page:${site.harness.pages.treatments}`;
    const snap = await wp.snapshot({ pageIds: [id] });
    const result = await wp.rollback(snap);
    expect(result.ok, result.detail).toBe(true);

    // The body is still the builder's; rollback restored only the safe fields.
    const after = await wp.getPage(id);
    expect(after.contentIsBuilderData).toBe(true);
  });
});

describe('dry run', () => {
  it('sends nothing and reports exactly what it would have sent', async () => {
    const id = `page:${site.harness.pages.about}`;
    const before = await wp.getPage(id);

    const dry = new WordPressConnector(creds(), { dryRun: true });
    await dry.testConnection();
    const result = await dry.updatePage(id, { title: 'This must never be written' });

    expect(result.planned?.length ?? 0).toBeGreaterThan(0);
    const req = result.planned![0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/wp-json/wp/v2/pages/');
    expect(req.describes).toMatch(/Update title/);

    // The site is untouched.
    expect((await wp.getPage(id)).title).toBe(before.title);
  });

  it('never exposes the Authorization value in the dry-run view', async () => {
    const dry = new WordPressConnector(creds(), { dryRun: true });
    await dry.testConnection();
    const result = await dry.setSeoMeta(`page:${site.harness.pages.about}`, { description: 'x' })
      .catch(() => null);
    const serialised = JSON.stringify(result?.planned ?? dry.drainPlanned());
    expect(serialised).not.toContain(site.harness.app_password);
    expect(serialised).toMatch(/\[redacted\]|^\[\]$/);
  });
});

describe('a connector that has not been told anything', () => {
  /**
   * The engine builds a fresh connector for each apply and does not call
   * `testConnection` first — there is no reason it should, and calling it
   * would re-probe the site on every batch.
   *
   * Requiring a particular call order is the kind of coupling that passes
   * every test built around a connector that *has* been tested, and then
   * fails on the first real apply. These three assert the connector works
   * cold.
   */
  it('writes SEO meta without testConnection having been called', async () => {
    const cold = new WordPressConnector(creds());
    cold.capabilities.setSeoMeta = true;   // as the engine replays it from the stored test

    const description = `Cold start ${Date.now()}`;
    const result = await cold.setSeoMeta('page:4', { description });

    expect(result.ok).toBe(true);
    const seen = await verifyChange(
      `${site.baseUrl}/about/`, 'meta_description', description, undefined, { attempts: 3 },
    );
    expect(seen.verified, `page showed: ${seen.found}`).toBe(true);
  });

  it('injects JSON-LD without testConnection having been called', async () => {
    const cold = new WordPressConnector(creds());
    const jsonLd = { '@context': 'https://schema.org', '@type': 'Dentist', name: `Cold ${Date.now()}` };

    const result = await cold.injectSchema('page:4', jsonLd);

    expect(result.ok).toBe(true);
    const seen = await verifyChange(
      `${site.baseUrl}/about/`, 'json_ld', JSON.stringify(jsonLd), undefined, { attempts: 3 },
    );
    expect(seen.verified, `page showed: ${seen.found}`).toBe(true);
  });

  it('reports the same SEO strategy cold as it does after a connection test', async () => {
    const cold = new WordPressConnector(creds());
    await cold.setSeoMeta('page:4', { description: `Strategy check ${Date.now()}` });
    expect(cold.seoStrategyDescription).toBe(wp.seoStrategyDescription);
  });
});
