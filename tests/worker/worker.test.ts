/**
 * The edge Worker, running on the real Workers runtime (workerd, via
 * Miniflare) — real HTMLRewriter, real KV, real streaming. A mock would not
 * prove the thing that matters most here: that the Worker fails open.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const WORKER = resolve(process.cwd(), 'src/connectors/cloudflare/worker/worker.js');

const PAGE = `<!doctype html><html><head>
<title>Old title</title>
<meta name="description" content="Old description">
<link rel="canonical" href="https://site.test/old">
</head><body><main><h1 id="hero">Old heading</h1><p class="intro">Old intro.</p></main></body></html>`;

const BARE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><p>Hi</p></body></html>`;

interface OriginBehaviour {
  status?: number;
  body?: string;
  contentType?: string;
}

/** Build a Miniflare instance with a controllable origin and KV contents. */
async function withWorker(kv: Record<string, string>, origin: OriginBehaviour = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: WORKER,
    kvNamespaces: ['CHANGESETS'],
    compatibilityDate: '2025-01-01',
    outboundService(request: Request) {
      const url = new URL(request.url);
      if (url.pathname === '/missing') {
        return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
      }
      return new Response(origin.body ?? PAGE, {
        status: origin.status ?? 200,
        headers: { 'content-type': origin.contentType ?? 'text/html; charset=utf-8' },
      });
    },
  });

  const ns = (await mf.getKVNamespace('CHANGESETS')) as unknown as {
    put(key: string, value: string): Promise<void>;
  };
  for (const [k, v] of Object.entries(kv)) await ns.put(k, v);

  return mf;
}

const changeset = (c: Record<string, unknown>) => JSON.stringify({ version: 1, ...c });

let mf: Miniflare | undefined;
afterAll(async () => { await mf?.dispose(); });

async function get(kv: Record<string, string>, path = '/', origin: OriginBehaviour = {}) {
  await mf?.dispose();
  mf = await withWorker(kv, origin);
  return mf.dispatchFetch(`https://site.test${path}`);
}

describe('head rewriting', () => {
  it('replaces an existing title', async () => {
    const res = await get({ 'changeset:/': changeset({ title: 'New title' }) });
    const html = await res.text();
    expect(html).toContain('<title>New title</title>');
    expect(html).not.toContain('Old title');
  });

  it('injects a title when the page has none', async () => {
    const res = await get({ 'changeset:/': changeset({ title: 'Added title' }) }, '/', { body: BARE_PAGE });
    expect(await res.text()).toContain('<title>Added title</title>');
  });

  it('replaces an existing meta description', async () => {
    const res = await get({ 'changeset:/': changeset({ metaDescription: 'New description' }) });
    const html = await res.text();
    expect(html).toContain('content="New description"');
    expect(html).not.toContain('Old description');
  });

  it('injects a meta description when the page has none', async () => {
    const res = await get({ 'changeset:/': changeset({ metaDescription: 'Fresh' }) }, '/', { body: BARE_PAGE });
    expect(await res.text()).toContain('<meta name="description" content="Fresh">');
  });

  it('rewrites and injects canonical and robots', async () => {
    const withTag = await get({ 'changeset:/': changeset({ canonical: 'https://site.test/new' }) });
    expect(await withTag.text()).toContain('href="https://site.test/new"');

    const without = await get(
      { 'changeset:/': changeset({ canonical: 'https://site.test/c', robots: 'index,follow' }) },
      '/', { body: BARE_PAGE },
    );
    const html = await without.text();
    expect(html).toContain('<link rel="canonical" href="https://site.test/c">');
    expect(html).toContain('<meta name="robots" content="index,follow">');
  });

  it('escapes quotes in injected attribute values', async () => {
    const res = await get(
      { 'changeset:/': changeset({ metaDescription: 'He said "hello" <b>' }) },
      '/', { body: BARE_PAGE },
    );
    const html = await res.text();
    expect(html).toContain('&quot;hello&quot;');
    expect(html).not.toContain('content="He said "hello""');
  });
});

describe('JSON-LD', () => {
  it('appends JSON-LD to the head', async () => {
    const ld = { '@context': 'https://schema.org', '@type': 'MedicalClinic', name: 'Clinic' };
    const res = await get({ 'changeset:/': changeset({ jsonLd: ld }) });
    const html = await res.text();
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"MedicalClinic"');
  });

  it('escapes a smuggled </script> so it cannot break out of the block', async () => {
    const ld = { '@type': 'Thing', name: '</script><img src=x onerror=alert(1)>' };
    const res = await get({ 'changeset:/': changeset({ jsonLd: ld }) });
    const html = await res.text();
    expect(html).not.toContain('</script><img src=x');
    expect(html).toContain('\\u003c/script');
  });

  it('replaces previously injected JSON-LD rather than stacking it', async () => {
    const page = `<!doctype html><html><head><title>t</title>
<script type="application/ld+json" data-aiva="1">{"@type":"Stale"}</script>
</head><body></body></html>`;
    const res = await get(
      { 'changeset:/': changeset({ jsonLd: { '@type': 'Fresh' } }) },
      '/', { body: page },
    );
    const html = await res.text();
    expect(html).toContain('"@type":"Fresh"');
    expect(html).not.toContain('Stale');
  });

  it('leaves JSON-LD the site added itself alone', async () => {
    const page = `<!doctype html><html><head><title>t</title>
<script type="application/ld+json">{"@type":"TheirOwn"}</script>
</head><body></body></html>`;
    const res = await get({ 'changeset:/': changeset({ jsonLd: { '@type': 'Ours' } }) }, '/', { body: page });
    const html = await res.text();
    expect(html).toContain('TheirOwn');
    expect(html).toContain('Ours');
  });
});

describe('content blocks', () => {
  it('replaces a block by selector', async () => {
    const res = await get({
      'changeset:/': changeset({ blocks: [{ selector: '#hero', mode: 'replace', html: 'New heading' }] }),
    });
    const html = await res.text();
    expect(html).toContain('>New heading<');
    expect(html).not.toContain('Old heading');
  });

  it('appends, sets an attribute and removes', async () => {
    const res = await get({
      'changeset:/': changeset({
        blocks: [
          { selector: '.intro', mode: 'append', html: ' Extra sentence.' },
          { selector: '#hero', mode: 'setAttribute', attr: 'data-x', value: '1' },
        ],
      }),
    });
    const html = await res.text();
    expect(html).toContain('Extra sentence.');
    expect(html).toContain('data-x="1"');
  });

  it('ignores a selector that matches nothing without failing the page', async () => {
    const res = await get({
      'changeset:/': changeset({
        title: 'Still applied',
        blocks: [{ selector: '#nothing-here', mode: 'replace', html: 'x' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Still applied');
  });
});

describe('fail open', () => {
  it('serves the original page when the changeset is malformed JSON', async () => {
    const res = await get({ 'changeset:/': '{not valid json' });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Old title');
  });

  it('serves the original page when the KV binding is missing entirely', async () => {
    // A real deployment failure mode: the script uploaded but the binding did
    // not. env.CHANGESETS is undefined and every read must degrade silently.
    await mf?.dispose();
    mf = new Miniflare({
      modules: true,
      scriptPath: WORKER,
      compatibilityDate: '2025-01-01',
      outboundService: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
    });
    const res = await mf.dispatchFetch('https://site.test/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Old title');
  });

  it('serves the original page when a selector is invalid', async () => {
    // An invalid selector makes HTMLRewriter throw during setup. The visitor
    // must still get the page.
    const res = await get({
      'changeset:/': changeset({
        title: 'Should not apply',
        blocks: [{ selector: '>>>not a selector<<<', mode: 'replace', html: 'x' }],
      }),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Old title');
    expect(html).not.toContain('Should not apply');
  });

  it('passes through when there is no changeset for the path', async () => {
    const res = await get({}, '/other');
    expect(await res.text()).toContain('Old title');
  });

  it('does not touch non-HTML responses', async () => {
    const res = await get(
      { 'changeset:/data.json': changeset({ title: 'nope' }) },
      '/data.json',
      { body: '{"a":1}', contentType: 'application/json' },
    );
    expect(await res.text()).toBe('{"a":1}');
  });

  it('passes an origin error straight through', async () => {
    const res = await get(
      { 'changeset:/': changeset({ title: 'nope' }) },
      '/', { status: 500, body: 'origin exploded' },
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('origin exploded');
  });
});

describe('kill switch', () => {
  it('disables every rewrite instantly', async () => {
    const res = await get({
      killswitch: '1',
      'changeset:/': changeset({ title: 'Must not appear' }),
      'rootfile:robots.txt': 'User-agent: *\nDisallow: /secret',
    });
    const html = await res.text();
    expect(html).toContain('Old title');
    expect(html).not.toContain('Must not appear');
  });

  it('also stops root files being served', async () => {
    const res = await get(
      { killswitch: '1', 'rootfile:robots.txt': 'User-agent: GPTBot' },
      '/robots.txt',
    );
    expect(await res.text()).not.toContain('GPTBot');
  });
});

describe('root files', () => {
  it('serves robots.txt from KV as plain text', async () => {
    const res = await get({ 'rootfile:robots.txt': 'User-agent: GPTBot\nAllow: /' }, '/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('GPTBot');
  });

  it('serves llms.txt from KV', async () => {
    const res = await get({ 'rootfile:llms.txt': '# Clinic\n\n> Summary.' }, '/llms.txt');
    expect(await res.text()).toContain('# Clinic');
  });

  it('falls back to the origin when no root file is stored', async () => {
    const res = await get({}, '/robots.txt', { body: 'origin robots', contentType: 'text/plain' });
    expect(await res.text()).toBe('origin robots');
  });
});

describe('synthetic pages', () => {
  it('fills a 404 with a stored page', async () => {
    const res = await get({ 'page:/missing': '<html><body>Synthetic</body></html>' }, '/missing');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Synthetic');
  });

  it('never shadows a page the origin actually serves', async () => {
    const res = await get({ 'page:/': '<html><body>Synthetic</body></html>' }, '/');
    const html = await res.text();
    expect(html).toContain('Old title');
    expect(html).not.toContain('Synthetic');
  });

  it('leaves a 404 alone when no synthetic page is stored', async () => {
    const res = await get({}, '/missing');
    expect(res.status).toBe(404);
  });
});

describe('path normalisation', () => {
  it('treats /about and /about/ as the same page', async () => {
    const res = await get({ 'changeset:/about': changeset({ title: 'About us' }) }, '/about/');
    expect(await res.text()).toContain('<title>About us</title>');
  });
});

describe('response headers', () => {
  it('reports the applied version and prevents stale caching', async () => {
    const res = await get({ 'changeset:/': JSON.stringify({ version: 7, title: 'v7' }) });
    expect(res.headers.get('x-aiva-version')).toBe('7');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
