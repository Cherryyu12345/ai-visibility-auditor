import { describe, it, expect } from 'vitest';
import { CloudflareConnector, WORKER_SCRIPT_NAME, KV_NAMESPACE_TITLE } from '../../src/connectors/cloudflare/index.js';
import { createMockCloudflare } from '../support/mock-cloudflare.js';
import { UnsupportedOperation } from '../../src/core/errors.js';
import { migrationSteps } from '../../src/connectors/cloudflare/onboarding.js';
import { KV_KEYS, pathOf } from '../../src/connectors/cloudflare/changeset.js';

const connect = (mockOpts = {}, connOpts = {}) => {
  const mock = createMockCloudflare(mockOpts);
  const cf = new CloudflareConnector(
    { apiToken: 'cf-token-abcdefghijklmnop', domain: mock.zoneName },
    { fetchImpl: mock.fetchImpl, ...connOpts },
  );
  return { cf, mock };
};

const deployed = async (mockOpts = {}, connOpts = {}) => {
  const ctx = connect(mockOpts, connOpts);
  await ctx.cf.deploy();
  return ctx;
};

describe('testConnection', () => {
  it('reports ready for a correctly configured zone', async () => {
    const { cf } = await deployed();
    const result = await cf.testConnection();
    expect(result.checks.filter((c) => !c.ok), JSON.stringify(result.checks)).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('flags an unproxied zone, because a Worker route would never fire', async () => {
    const { cf } = await deployed({ proxied: false });
    const result = await cf.testConnection();
    const proxy = result.checks.find((c) => c.name === 'Proxy (orange cloud)');
    expect(proxy?.ok).toBe(false);
    expect(proxy?.remedy).toMatch(/orange cloud/);
  });

  it('flags Flexible SSL, which causes redirect loops', async () => {
    const { cf } = await deployed({ sslMode: 'flexible' });
    const ssl = (await cf.testConnection()).checks.find((c) => c.name === 'SSL mode');
    expect(ssl?.ok).toBe(false);
    expect(ssl?.remedy).toMatch(/Full/);
  });

  it('accepts both Full and Full (Strict), since sources disagree on which Squarespace needs', async () => {
    expect((await (await deployed({ sslMode: 'full' })).cf.testConnection())
      .checks.find((c) => c.name === 'SSL mode')?.ok).toBe(true);
    expect((await (await deployed({ sslMode: 'strict' })).cf.testConnection())
      .checks.find((c) => c.name === 'SSL mode')?.ok).toBe(true);
  });

  it('does not fail the connection when the token cannot read zone settings', async () => {
    const { cf } = await deployed({ sslMode: null });
    const ssl = (await cf.testConnection()).checks.find((c) => c.name === 'SSL mode');
    expect(ssl?.detail).toMatch(/Could not read/);
  });

  it('reports a pending zone with the nameservers to set', async () => {
    const { cf } = connect({ zoneStatus: 'pending' });
    const status = (await cf.testConnection()).checks.find((c) => c.name === 'Zone status');
    expect(status?.ok).toBe(false);
    expect(status?.remedy).toMatch(/ns1\.cloudflare\.com/);
  });

  it('notices a paused zone', async () => {
    const { cf } = connect({ zonePaused: true });
    expect((await cf.testConnection()).checks.find((c) => c.name === 'Zone paused')?.ok).toBe(false);
  });

  it('reports the Worker as not deployed before deploy runs', async () => {
    const { cf } = connect();
    const w = (await cf.testConnection()).checks.find((c) => c.name === 'Worker deployed');
    expect(w?.ok).toBe(false);
  });
});

describe('Squarespace onboarding', () => {
  it('fails the check when verify.squarespace.com is proxied', async () => {
    const { cf } = await deployed({ squarespaceVerify: 'proxied' }, { platform: 'squarespace' });
    const check = (await cf.testConnection()).checks.find((c) => c.name === 'Squarespace domain verification');
    expect(check?.ok).toBe(false);
    expect(check?.remedy).toMatch(/DNS-only/);
  });

  it('passes when the verify record is DNS-only, but still warns it is unsupported', async () => {
    const { cf } = await deployed({ squarespaceVerify: 'dns-only' }, { platform: 'squarespace' });
    const check = (await cf.testConnection()).checks.find((c) => c.name === 'Squarespace domain verification');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/does not officially support/);
  });
});

describe('migration guidance', () => {
  it('warns about email records before anything else', async () => {
    const { cf } = connect({ zoneMissing: true });
    const report = await cf.onboarding();
    expect(report.level).toBe('not-on-cloudflare');
    expect(report.migrationSteps?.[0]).toMatch(/MX/);
    expect(report.migrationSteps?.[0]).toMatch(/email stops arriving/);
  });

  it('adds the verify-record step for Squarespace', () => {
    const steps = migrationSteps('clinic.test', 'squarespace').join('\n');
    expect(steps).toMatch(/verify\.squarespace\.com/);
    expect(steps).toMatch(/grey cloud/);
  });
});

describe('deploy', () => {
  it('creates the KV namespace, uploads an ES-module Worker and routes it', async () => {
    const { cf, mock } = connect();
    const result = await cf.deploy();

    expect(mock.state.namespaces.map((n) => n.title)).toContain(KV_NAMESPACE_TITLE);

    const script = mock.state.scripts.get(WORKER_SCRIPT_NAME);
    expect(script).toBeDefined();
    expect(script!.metadata.main_module).toBe('worker.js');
    expect(script!.metadata.compatibility_date).toBeTruthy();
    expect(script!.source).toContain('HTMLRewriter');

    const bindings = script!.metadata.bindings as Array<Record<string, string>>;
    expect(bindings[0]).toMatchObject({ type: 'kv_namespace', name: 'CHANGESETS' });

    expect(mock.state.routes).toEqual([
      expect.objectContaining({ pattern: `${mock.zoneName}/*`, script: WORKER_SCRIPT_NAME }),
    ]);
    expect(result.routePattern).toBe(`${mock.zoneName}/*`);
  });

  it('is idempotent: redeploying reuses the namespace and does not duplicate the route', async () => {
    const { cf, mock } = connect();
    await cf.deploy();
    await cf.deploy();
    expect(mock.state.namespaces).toHaveLength(1);
    expect(mock.state.routes).toHaveLength(1);
  });

  it('refuses writes before deployment rather than failing obscurely', async () => {
    const { cf } = connect();
    await expect(cf.setSeoMeta('/about', { description: 'x' })).rejects.toThrow(/Deploy the Worker first/);
  });
});

describe('changeset writes', () => {
  it('stores SEO fields under the page path and bumps the version', async () => {
    const { cf, mock } = await deployed();
    await cf.setSeoMeta('/about', { title: 'About us', description: 'A clinic.' });

    const raw = mock.state.kv.get(KV_KEYS.changeset('/about'))!;
    const cs = JSON.parse(raw);
    expect(cs.title).toBe('About us');
    expect(cs.metaDescription).toBe('A clinic.');
    expect(cs.version).toBe(1);

    await cf.setSeoMeta('/about', { canonical: 'https://clinic.test/about' });
    const updated = JSON.parse(mock.state.kv.get(KV_KEYS.changeset('/about'))!);
    expect(updated.version).toBe(2);
    expect(updated.title).toBe('About us');          // preserved
    expect(updated.canonical).toBe('https://clinic.test/about');
  });

  it('accepts a full URL as well as a path', async () => {
    const { cf, mock } = await deployed();
    await cf.setSeoMeta('https://clinic.test/treatments/', { description: 'x' });
    expect(mock.state.kv.has(KV_KEYS.changeset('/treatments'))).toBe(true);
  });

  it('stores JSON-LD', async () => {
    const { cf, mock } = await deployed();
    await cf.injectSchema('/about', { '@type': 'MedicalClinic' });
    expect(JSON.parse(mock.state.kv.get(KV_KEYS.changeset('/about'))!).jsonLd).toEqual({ '@type': 'MedicalClinic' });
  });

  it('merges content blocks by selector rather than appending duplicates', async () => {
    const { cf, mock } = await deployed();
    await cf.updatePage('/about', { blocks: [{ selector: '#hero', mode: 'replace', html: 'First' }] });
    await cf.updatePage('/about', { blocks: [{ selector: '#hero', mode: 'replace', html: 'Second' }] });

    const cs = JSON.parse(mock.state.kv.get(KV_KEYS.changeset('/about'))!);
    expect(cs.blocks).toHaveLength(1);
    expect(cs.blocks[0].html).toBe('Second');
  });

  it('stores root files', async () => {
    const { cf, mock } = await deployed();
    await cf.setRootFile('llms.txt', '# Clinic');
    expect(mock.state.kv.get(KV_KEYS.rootFile('llms.txt'))).toBe('# Clinic');
  });

  it('stores a synthetic page', async () => {
    const { cf, mock } = await deployed();
    await cf.createPage({ title: 'Our approach', content: '<p>How we work.</p>' });
    const html = mock.state.kv.get(KV_KEYS.page('/our-approach'))!;
    expect(html).toContain('<title>Our approach</title>');
    expect(html).toContain('How we work.');
  });
});

describe('what Cloudflare refuses to do', () => {
  it('refuses to change a slug, which would break the origin', async () => {
    const { cf } = await deployed();
    await expect(cf.updatePage('/about', { slug: 'new' })).rejects.toBeInstanceOf(UnsupportedOperation);
  });

  it('refuses to replace a whole page body', async () => {
    const { cf } = await deployed();
    await expect(cf.updatePage('/about', { content: '<p>all new</p>' })).rejects.toThrow(/content blocks instead/);
  });

  it('refuses excerpts, which do not exist in served HTML', async () => {
    const { cf } = await deployed();
    await expect(cf.updatePage('/about', { excerpt: 'x' })).rejects.toBeInstanceOf(UnsupportedOperation);
  });
});

describe('kill switch', () => {
  it('sets and clears a single key', async () => {
    const { cf, mock } = await deployed();
    await cf.setKillSwitch(true);
    expect(mock.state.kv.get(KV_KEYS.killSwitch)).toBe('1');
    expect(await cf.isKillSwitchOn()).toBe(true);

    await cf.setKillSwitch(false);
    expect(mock.state.kv.has(KV_KEYS.killSwitch)).toBe(false);
    expect(await cf.isKillSwitchOn()).toBe(false);
  });
});

describe('snapshot and rollback', () => {
  it('restores a previous changeset', async () => {
    const { cf, mock } = await deployed();
    await cf.setSeoMeta('/about', { description: 'Original' });

    const snap = await cf.snapshot({ pageIds: ['/about'] });
    await cf.setSeoMeta('/about', { description: 'Changed' });
    expect(JSON.parse(mock.state.kv.get(KV_KEYS.changeset('/about'))!).metaDescription).toBe('Changed');

    const result = await cf.rollback(snap);
    expect(result.ok).toBe(true);
    expect(JSON.parse(mock.state.kv.get(KV_KEYS.changeset('/about'))!).metaDescription).toBe('Original');
  });

  it('deletes a key that did not exist when the snapshot was taken', async () => {
    const { cf, mock } = await deployed();
    const snap = await cf.snapshot({ pageIds: ['/new-page'] });

    await cf.setSeoMeta('/new-page', { description: 'Added' });
    expect(mock.state.kv.has(KV_KEYS.changeset('/new-page'))).toBe(true);

    await cf.rollback(snap);
    expect(mock.state.kv.has(KV_KEYS.changeset('/new-page'))).toBe(false);
  });

  it('restores root files too', async () => {
    const { cf, mock } = await deployed();
    await cf.setRootFile('robots.txt', 'original');
    const snap = await cf.snapshot({ rootFiles: ['robots.txt'] });
    await cf.setRootFile('robots.txt', 'changed');
    await cf.rollback(snap);
    expect(mock.state.kv.get(KV_KEYS.rootFile('robots.txt'))).toBe('original');
  });
});

describe('listPages', () => {
  it('reports only the URLs that have changes', async () => {
    const { cf } = await deployed();
    await cf.setSeoMeta('/about', { description: 'a' });
    await cf.setSeoMeta('/contact', { description: 'b' });
    const { pages } = await cf.listPages();
    expect(pages.map((p) => p.id).sort()).toEqual(['/about', '/contact']);
  });
});

describe('dry run', () => {
  it('writes nothing and reports what it would send', async () => {
    const { cf, mock } = await deployed();
    const dry = new CloudflareConnector(
      { apiToken: 'cf-token-abcdefghijklmnop', domain: mock.zoneName },
      { fetchImpl: mock.fetchImpl, dryRun: true },
    );
    const before = new Map(mock.state.kv);
    const result = await dry.setSeoMeta('/about', { description: 'Must not be written' });

    expect(result.planned?.length).toBeGreaterThan(0);
    expect(result.planned![0]!.method).toBe('PUT');
    expect(mock.state.kv).toEqual(before);
  });

  it('never exposes the API token', async () => {
    const { cf, mock } = await deployed();
    const dry = new CloudflareConnector(
      { apiToken: 'cf-token-abcdefghijklmnop', domain: mock.zoneName },
      { fetchImpl: mock.fetchImpl, dryRun: true },
    );
    const result = await dry.setRootFile('robots.txt', 'x');
    const serialised = JSON.stringify(result.planned);
    expect(serialised).not.toContain('cf-token-abcdefghijklmnop');
    expect(serialised).toContain('[redacted]');
  });
});

describe('path normalisation', () => {
  it('treats a trailing slash as the same page', () => {
    expect(pathOf('https://a.test/about/')).toBe('/about');
    expect(pathOf('/about')).toBe('/about');
    expect(pathOf('https://a.test/')).toBe('/');
  });
});

describe('synthetic page construction', () => {
  it('wraps a fragment so it has a title, which is the whole point', async () => {
    const { cf, mock } = await deployed();
    await cf.createPage({ title: 'Our approach', content: '<p>How we work.</p>' });
    const html = mock.state.kv.get(KV_KEYS.page('/our-approach'))!;
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<title>Our approach</title>');
  });

  it('leaves a complete document alone', async () => {
    const { cf, mock } = await deployed();
    const doc = '<!doctype html><html><head><title>Mine</title></head><body>x</body></html>';
    await cf.createPage({ title: 'Ignored', slug: '/custom', content: doc });
    expect(mock.state.kv.get(KV_KEYS.page('/custom'))).toBe(doc);
  });

  it('escapes the title it injects', async () => {
    const { cf, mock } = await deployed();
    await cf.createPage({ title: 'A & B <script>', slug: '/x', content: '<p>hi</p>' });
    const html = mock.state.kv.get(KV_KEYS.page('/x'))!;
    expect(html).toContain('A &amp; B &lt;script&gt;');
  });
});
