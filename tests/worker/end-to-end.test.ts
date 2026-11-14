/**
 * Connector → KV → Worker → verification, with nothing faked in the middle.
 *
 * This is the test that catches the most likely silent failure in the whole
 * Cloudflare path: the connector and the Worker disagreeing about KV key names
 * or the changeset shape. Each half passes its own tests while the pair does
 * nothing at all.
 *
 * So the Worker here is the exact source the connector uploaded, the KV
 * contents are exactly what the connector wrote, and the final assertions go
 * through the same crawler-UA verifier production uses.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import { CloudflareConnector, WORKER_SCRIPT_NAME } from '../../src/connectors/cloudflare/index.js';
import { createMockCloudflare } from '../support/mock-cloudflare.js';
import { verifyChange, verifyRootFile } from '../../src/core/verify.js';

const ORIGIN_PAGE = `<!doctype html><html><head>
<title>Old title</title>
<meta name="description" content="Old description">
</head><body><main><h1 id="hero">Old heading</h1></main></body></html>`;

let mf: Miniflare | undefined;
afterEach(async () => { await mf?.dispose(); mf = undefined; });

/** Boot the Worker exactly as uploaded, with exactly the KV the connector wrote. */
async function edgeFor(mock: ReturnType<typeof createMockCloudflare>) {
  const uploaded = mock.state.scripts.get(WORKER_SCRIPT_NAME);
  expect(uploaded, 'connector should have uploaded the Worker').toBeDefined();

  // Pass the uploaded source directly rather than via a temp file: workerd
  // resolves script paths relative to its own working directory and refuses a
  // path that climbs out of it, which anything under the OS temp dir does.
  mf = new Miniflare({
    modules: true,
    script: uploaded!.source,
    kvNamespaces: ['CHANGESETS'],
    compatibilityDate: '2025-01-01',
    outboundService: (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/not-there') {
        return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } });
      }
      if (url.pathname === '/robots.txt') {
        return new Response('origin robots', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(ORIGIN_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });

  const ns = (await mf.getKVNamespace('CHANGESETS')) as unknown as {
    put(key: string, value: string): Promise<void>;
  };
  for (const [key, value] of mock.state.kv) await ns.put(key, value);

  const url = await mf.ready;
  return { baseUrl: url.origin };
}

async function connected() {
  const mock = createMockCloudflare();
  const cf = new CloudflareConnector(
    { apiToken: 'cf-token-abcdefghijklmnop', domain: mock.zoneName },
    { fetchImpl: mock.fetchImpl },
  );
  await cf.deploy();
  return { cf, mock };
}

describe('connector and Worker agree end to end', () => {
  it('a meta description written by the connector is visible to a crawler', async () => {
    const { cf, mock } = await connected();
    await cf.setSeoMeta('/about', { description: 'A London clinic offering consultations.' });

    const { baseUrl } = await edgeFor(mock);
    const result = await verifyChange(
      `${baseUrl}/about`,
      'meta_description',
      'A London clinic offering consultations.',
      undefined,
      { attempts: 1 },
    );
    expect(result.verified, `found: ${result.found}`).toBe(true);
  });

  it('a title written by the connector replaces the origin title', async () => {
    const { cf, mock } = await connected();
    await cf.setSeoMeta('/about', { title: 'About our clinic' });

    const { baseUrl } = await edgeFor(mock);
    const result = await verifyChange(`${baseUrl}/about`, 'title', 'About our clinic', undefined, { attempts: 1 });
    expect(result.verified, `found: ${result.found}`).toBe(true);
  });

  it('JSON-LD survives the whole round trip and parses', async () => {
    const { cf, mock } = await connected();
    const jsonLd = { '@context': 'https://schema.org', '@type': 'MedicalClinic', name: 'The Clinic' };
    await cf.injectSchema('/about', jsonLd);

    const { baseUrl } = await edgeFor(mock);
    const result = await verifyChange(`${baseUrl}/about`, 'json_ld', JSON.stringify(jsonLd), undefined, { attempts: 1 });
    expect(result.verified, `found: ${result.found}`).toBe(true);
  });

  it('a content block written by the connector is applied by selector', async () => {
    const { cf, mock } = await connected();
    await cf.updatePage('/about', {
      blocks: [{ selector: '#hero', mode: 'replace', html: 'Consultant-led aesthetic care' }],
    });

    const { baseUrl } = await edgeFor(mock);
    const html = await (await fetch(`${baseUrl}/about`)).text();
    expect(html).toContain('Consultant-led aesthetic care');
    expect(html).not.toContain('Old heading');
  });

  it('robots.txt written by the connector is served instead of the origin', async () => {
    const { cf, mock } = await connected();
    await cf.setRootFile('robots.txt', 'User-agent: GPTBot\nAllow: /');

    const { baseUrl } = await edgeFor(mock);
    const result = await verifyRootFile(baseUrl, 'robots.txt', 'User-agent: GPTBot', { attempts: 1 });
    expect(result.verified).toBe(true);
  });

  it('llms.txt is served even though the origin has no such concept', async () => {
    const { cf, mock } = await connected();
    await cf.setRootFile('llms.txt', '# The Clinic\n\n> Aesthetic clinic in London.');

    const { baseUrl } = await edgeFor(mock);
    const res = await fetch(`${baseUrl}/llms.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Aesthetic clinic in London');
  });

  it('a synthetic page fills a 404 but never shadows a real page', async () => {
    const { cf, mock } = await connected();
    await cf.createPage({ title: 'Our approach', slug: '/not-there', content: '<p>How we work.</p>' });
    await cf.createPage({ title: 'Shadow attempt', slug: '/about', content: '<p>Should not appear.</p>' });

    const { baseUrl } = await edgeFor(mock);

    const filled = await fetch(`${baseUrl}/not-there`);
    expect(filled.status).toBe(200);
    expect(await filled.text()).toContain('How we work.');

    const real = await fetch(`${baseUrl}/about`);
    const html = await real.text();
    expect(html).toContain('Old title');
    expect(html).not.toContain('Should not appear.');
  });

  it('the kill switch reverts the site to its unmodified self', async () => {
    const { cf, mock } = await connected();
    await cf.setSeoMeta('/about', { title: 'Changed title' });
    await cf.setKillSwitch(true);

    const { baseUrl } = await edgeFor(mock);
    const html = await (await fetch(`${baseUrl}/about`)).text();
    expect(html).toContain('Old title');
    expect(html).not.toContain('Changed title');
  });

  it('rolling back a change removes it from the served page', async () => {
    const { cf, mock } = await connected();
    await cf.setSeoMeta('/about', { title: 'Original' });
    const snap = await cf.snapshot({ pageIds: ['/about'] });
    await cf.setSeoMeta('/about', { title: 'Mistake' });
    await cf.rollback(snap);

    const { baseUrl } = await edgeFor(mock);
    const result = await verifyChange(`${baseUrl}/about`, 'title', 'Original', undefined, { attempts: 1 });
    expect(result.verified, `found: ${result.found}`).toBe(true);
  });

  it('a trailing slash in the request still finds the changeset', async () => {
    const { cf, mock } = await connected();
    await cf.setSeoMeta('/about', { title: 'Slash tolerant' });

    const { baseUrl } = await edgeFor(mock);
    const html = await (await fetch(`${baseUrl}/about/`)).text();
    expect(html).toContain('<title>Slash tolerant</title>');
  });
});
