import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { Engine, candidateRoutes, unwrapSnapshot } from '../../src/app/engine.js';
import { resolveRoute, methodForField } from '../../src/core/connector.js';
import type { Connector } from '../../src/core/connector.js';
import type { ChangeField } from '../../src/core/types.js';
import type { Connection, Site } from '../../src/store/types.js';
import { FAST_VERIFY, FakeConnector, FakeSite } from '../support/fake-connector.js';

process.env.AIVA_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');

const PAGE = 'https://example.test/about';

async function setup(opts: {
  primary?: FakeConnector | null;
  cloudflare?: FakeConnector | null;
} = {}) {
  const store = Store.ephemeral();
  const site = await store.addSite({
    name: 'Example', url: 'https://example.test', platform: 'wordpress', platformOverridden: false,
  });

  const primary = opts.primary === undefined ? new FakeConnector() : opts.primary;
  const cloudflare = opts.cloudflare ?? null;

  if (primary) await connection(store, site, 'wordpress');
  if (cloudflare) await connection(store, site, 'cloudflare');

  const fakeSite = new FakeSite();
  const engine = new Engine(store, {
    verifyOptions: { ...FAST_VERIFY, fetchImpl: fakeSite.fetch },
    connectorFactory: (conn, _site, buildOpts) => {
      const connector = conn.kind === 'cloudflare' ? cloudflare! : primary!;
      connector.dryRun = buildOpts?.dryRun ?? false;
      return connector as unknown as Connector;
    },
  });

  return { store, site, engine, primary, cloudflare, fakeSite };
}

function connection(store: Store, site: Site, kind: Connection['kind']) {
  return store.putConnection({
    siteId: site.id, kind, label: `${kind} test`, config: {}, secret: null,
  });
}

/** What FakeSite serves before anything is applied, so `before` is truthful. */
const CURRENT: Partial<Record<ChangeField, string>> = {
  title: 'Old title',
  seo_title: 'Old title',
  meta_description: 'Old description',
};

async function addChange(store: Store, siteId: string, field: ChangeField, after: string, target?: string) {
  const [change] = await store.addChanges([{
    siteId, page: PAGE, field, before: CURRENT[field] ?? null, after,
    reason: 'Because the audit said so.',
    ...(target ? { target } : {}),
  }]);
  return change!;
}

describe('approval gating', () => {
  it('leaves a draft change alone when Apply runs', async () => {
    const { store, site, engine, primary } = await setup();
    await addChange(store, site.id, 'title', 'Brand new title');

    const report = await engine.apply(site.id, 'tester');

    expect(report.outcomes).toHaveLength(0);
    expect(primary!.calls.filter((c) => c.method === 'updatePage')).toHaveLength(0);
    expect(store.listChanges(site.id)[0]!.status).toBe('draft');
  });

  it('refuses to move a draft change straight to applied', async () => {
    const { store, site } = await setup();
    const change = await addChange(store, site.id, 'title', 'x');
    await expect(store.transition(change.id, 'applied')).rejects.toThrow(/draft cannot become applied/);
  });

  it('records who approved what, and when', async () => {
    const { store, site, engine } = await setup();
    const change = await addChange(store, site.id, 'title', 'New');
    await engine.approve(change.id, 'priya@example.test');

    const entry = store.listAudit(site.id).find((e) => e.action === 'approve');
    expect(entry?.actor).toBe('priya@example.test');
    expect(entry?.changeId).toBe(change.id);
    expect(entry?.at).toBeInstanceOf(Date);
  });
});

describe('applying', () => {
  it('only marks a change verified once the live page shows it', async () => {
    const { store, site, engine, primary, fakeSite } = await setup();
    const change = await addChange(store, site.id, 'title', 'Brand new title');
    await engine.approve(change.id, 'tester');

    // The connector reports success, but the site has not changed.
    const failed = await engine.apply(site.id, 'tester');
    expect(primary!.calls.some((c) => c.method === 'updatePage')).toBe(true);
    expect(failed.outcomes[0]!.status).toBe('failed');
    expect(store.getChange(change.id)!.failureReason).toContain('Old title');

    // Now the page really does say it.
    fakeSite.title = 'Brand new title';
    await store.transition(change.id, 'approved');
    const passed = await engine.apply(site.id, 'tester');
    expect(passed.outcomes[0]!.status).toBe('verified');
  });

  it('takes a snapshot before touching the site', async () => {
    const { store, site, engine, primary, fakeSite } = await setup();
    fakeSite.title = 'Brand new title';
    const change = await addChange(store, site.id, 'title', 'Brand new title');
    await engine.approve(change.id, 'tester');
    await engine.apply(site.id, 'tester');

    const order = primary!.calls.map((c) => c.method);
    expect(order.indexOf('snapshot')).toBeLessThan(order.indexOf('updatePage'));
    expect(store.getChange(change.id)!.snapshotId).toBeTruthy();
  });

  it('maps each field onto the right connector call', async () => {
    const { store, site, engine, primary, fakeSite } = await setup();
    fakeSite.title = 'T';
    fakeSite.description = 'D';
    fakeSite.jsonLd = '{"@type":"FAQPage"}';

    for (const [field, after] of [
      ['title', 'T'], ['meta_description', 'D'], ['json_ld', '{"@type":"FAQPage"}'],
    ] as Array<[ChangeField, string]>) {
      const change = await addChange(store, site.id, field, after);
      await engine.approve(change.id, 'tester');
    }
    await engine.apply(site.id, 'tester');

    const methods = primary!.calls.map((c) => c.method);
    expect(methods).toContain('updatePage');
    expect(methods).toContain('setSeoMeta');
    expect(methods).toContain('injectSchema');
  });

  it('reports a hard connector failure without claiming anything was verified', async () => {
    const { store, site, engine } = await setup({ primary: new FakeConnector({ errors: ['updatePage'] }) });
    const change = await addChange(store, site.id, 'title', 'New');
    await engine.approve(change.id, 'tester');

    const report = await engine.apply(site.id, 'tester');
    expect(report.outcomes[0]!.ok).toBe(false);
    expect(store.getChange(change.id)!.status).toBe('failed');
    expect(report.summary).toContain('1 failed');
  });
});

describe('dry run', () => {
  it('sends nothing, changes nothing, and shows what it would have sent', async () => {
    const { store, site, engine, primary } = await setup();
    const change = await addChange(store, site.id, 'title', 'Brand new title');
    await engine.approve(change.id, 'tester');

    const report = await engine.apply(site.id, 'tester', true);

    expect(report.dryRun).toBe(true);
    expect(report.outcomes[0]!.planned?.length).toBeGreaterThan(0);
    expect(store.getChange(change.id)!.status).toBe('approved');
    expect(store.listBatches(site.id)).toHaveLength(0);
    // Nothing that mutates the site was called; the snapshot is skipped too.
    expect(primary!.calls.some((c) => c.method === 'snapshot')).toBe(false);
  });
});

describe('routing', () => {
  it('agrees with resolveRoute about where a change goes first', async () => {
    const fields: ChangeField[] = [
      'title', 'slug', 'excerpt', 'image_alt', 'content_block', 'seo_title',
      'meta_description', 'canonical', 'robots_meta', 'json_ld', 'robots_txt', 'llms_txt',
    ];
    const primary = new FakeConnector({ capabilities: { setSeoMeta: false, setRootFile: false } });
    const cloudflare = new FakeConnector({ platform: 'custom' });
    const { site } = await setup({ primary, cloudflare });

    for (const field of fields) {
      const connectors = { primary: primary as unknown as Connector, cloudflare: cloudflare as unknown as Connector };
      const chain = candidateRoutes({ field }, connectors, site);
      const single = resolveRoute({ field }, connectors.primary, connectors.cloudflare);
      expect(chain[0]!.via, `first candidate for ${field}`).toBe(single.via);
      // There is always somewhere for a change to go, even if it is a human.
      expect(chain[chain.length - 1]!.via).toBe('manual');
    }
  });

  it('falls through to Cloudflare when the platform refuses at apply time', async () => {
    // The capability says yes; the call says no. That happens for real —
    // WordPress will not overwrite builder-owned content.
    const primary = new FakeConnector({ refuses: ['updatePage'] });
    const cloudflare = new FakeConnector({ platform: 'custom' });
    const { store, site, engine, fakeSite } = await setup({ primary, cloudflare });
    fakeSite.title = 'Brand new title';

    const change = await addChange(store, site.id, 'title', 'Brand new title');
    await engine.approve(change.id, 'tester');
    const report = await engine.apply(site.id, 'tester');

    expect(report.outcomes[0]!.via).toBe('cloudflare');
    expect(cloudflare.calls.some((c) => c.method === 'updatePage')).toBe(true);
    expect(store.getChange(change.id)!.status).toBe('verified');
  });

  it('falls all the way to a manual card when nothing can do it', async () => {
    const primary = new FakeConnector({ refuses: ['updatePage'] });
    const { store, site, engine } = await setup({ primary });

    const change = await addChange(store, site.id, 'title', 'Brand new title');
    await engine.approve(change.id, 'tester');
    const report = await engine.apply(site.id, 'tester');

    const outcome = report.outcomes[0]!;
    expect(outcome.via).toBe('manual');
    expect(outcome.card?.payload?.text).toBe('Brand new title');
    // A manual change has not been applied, so it must not claim it has.
    expect(store.getChange(change.id)!.status).toBe('approved');
  });

  it('routes everything to Cloudflare when the platform is not connected at all', async () => {
    const cloudflare = new FakeConnector({ platform: 'custom' });
    const { site } = await setup({ primary: null, cloudflare });
    const chain = candidateRoutes(
      { field: 'meta_description' },
      { cloudflare: cloudflare as unknown as Connector },
      site,
    );
    expect(chain[0]!.via).toBe('cloudflare');
  });
});

describe('manual changes', () => {
  it('will not mark a manual change done when the page does not show it', async () => {
    const primary = new FakeConnector({ capabilities: { setSeoMeta: false } });
    const { store, site, engine } = await setup({ primary });
    const change = await addChange(store, site.id, 'meta_description', 'A better description');
    await engine.approve(change.id, 'tester');

    const { verify } = await engine.markManualDone(change.id, 'tester');

    expect(verify.verified).toBe(false);
    expect(verify.found).toBe('Old description');
    expect(store.getChange(change.id)!.status).toBe('approved');
    expect(store.listAudit(site.id).some((e) => e.action === 'manual_not_visible')).toBe(true);
  });

  it('marks it verified once the page really says it', async () => {
    const primary = new FakeConnector({ capabilities: { setSeoMeta: false } });
    const { store, site, engine, fakeSite } = await setup({ primary });
    const change = await addChange(store, site.id, 'meta_description', 'A better description');
    await engine.approve(change.id, 'tester');
    fakeSite.description = 'A better description';

    const { verify } = await engine.markManualDone(change.id, 'tester');

    expect(verify.verified).toBe(true);
    expect(store.getChange(change.id)!.status).toBe('verified');
  });

  it('will not accept a manual change that was never approved', async () => {
    const primary = new FakeConnector({ capabilities: { setSeoMeta: false } });
    const { store, site, engine } = await setup({ primary });
    const change = await addChange(store, site.id, 'meta_description', 'x');
    await expect(engine.markManualDone(change.id, 'tester')).rejects.toThrow(/Only an approved change/);
  });
});

describe('rollback', () => {
  /** A connector whose rollback genuinely puts the page back. */
  async function restorable() {
    const fakeSite = new FakeSite();
    const primary = new FakeConnector({
      onRollback: () => { fakeSite.title = 'Old title'; fakeSite.description = 'Old description'; },
    });
    const ctx = await setup({ primary });
    // Point verification at the same site the fake restores.
    const engine = new Engine(ctx.store, {
      verifyOptions: { ...FAST_VERIFY, fetchImpl: fakeSite.fetch },
      connectorFactory: () => primary as unknown as Connector,
    });
    return { ...ctx, engine, primary, fakeSite };
  }

  it('undoes one change, checks the page, and records it', async () => {
    const { store, site, engine, primary, fakeSite } = await restorable();
    fakeSite.title = 'Brand new title';
    const change = await addChange(store, site.id, 'title', 'Brand new title');
    await engine.approve(change.id, 'tester');
    await engine.apply(site.id, 'tester');

    const result = await engine.rollbackChange(change.id, 'tester');

    expect(result.ok).toBe(true);
    expect(result.verify?.verified).toBe(true);
    expect(primary.rolledBack).toHaveLength(1);
    expect(store.getChange(change.id)!.status).toBe('rolled_back');
    expect(store.listAudit(site.id).some((e) => e.action === 'rolled_back')).toBe(true);
  });

  it('refuses to call it rolled back when the page has not changed', async () => {
    // The connector says it worked. The page says otherwise, and the page wins
    // — this is the same rule as for applying.
    const { store, site, engine, primary, fakeSite } = await setup();
    fakeSite.title = 'Brand new title';
    const change = await addChange(store, site.id, 'title', 'Brand new title');
    await engine.approve(change.id, 'tester');
    await engine.apply(site.id, 'tester');

    const result = await engine.rollbackChange(change.id, 'tester');

    expect(primary!.rolledBack).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Brand new title');
    expect(store.getChange(change.id)!.status).toBe('verified');
    expect(store.listAudit(site.id).some((e) => e.action === 'rollback_not_visible')).toBe(true);
  });

  it('hands the connector its own snapshot payload, not the engine wrapper', async () => {
    const { store, site, engine, primary, fakeSite } = await restorable();
    fakeSite.title = 'Brand new title';
    const change = await addChange(store, site.id, 'title', 'Brand new title');
    await engine.approve(change.id, 'tester');
    await engine.apply(site.id, 'tester');
    await engine.rollbackChange(change.id, 'tester');

    const given = primary.rolledBack[0]!.payload as Record<string, unknown>;
    expect(given).not.toHaveProperty('inner');
    expect(given).not.toHaveProperty('connector');
    // What the fake stored when the snapshot was taken.
    expect(given).toHaveProperty('scope');
  });

  it('undoes a whole batch, newest change first', async () => {
    const { store, site, engine, primary, fakeSite } = await restorable();
    fakeSite.title = 'Brand new title';
    fakeSite.description = 'A better description';

    const first = await addChange(store, site.id, 'title', 'Brand new title');
    const second = await addChange(store, site.id, 'meta_description', 'A better description');
    for (const c of [first, second]) await engine.approve(c.id, 'tester');
    const report = await engine.apply(site.id, 'tester');

    const rollback = await engine.rollbackBatch(report.batchId!, 'tester');

    expect(rollback.outcomes.map((o) => o.changeId)).toEqual([second.id, first.id]);
    expect(rollback.outcomes.every((o) => o.ok)).toBe(true);
    expect(primary.rolledBack).toHaveLength(2);
    expect(store.getBatch(report.batchId!)!.status).toBe('rolled_back');
  });

  it('says so rather than pretending when there is no snapshot', async () => {
    const { store, site, engine } = await setup();
    const change = await addChange(store, site.id, 'title', 'x');
    await expect(engine.rollbackChange(change.id, 'tester')).rejects.toThrow(/no snapshot/i);
  });
});

describe('root files', () => {
  it('verifies robots.txt against the file, not the page', async () => {
    const { store, site, engine, primary, fakeSite } = await setup();
    fakeSite.robotsTxt = 'User-agent: *\nAllow: /\nSitemap: https://example.test/sitemap.xml';
    const change = await addChange(store, site.id, 'robots_txt', 'Sitemap: https://example.test/sitemap.xml');
    await engine.approve(change.id, 'tester');

    const report = await engine.apply(site.id, 'tester');

    expect(report.outcomes[0]!.status).toBe('verified');
    const call = primary!.calls.find((c) => c.method === 'setRootFile');
    expect(call?.args[0]).toBe('robots.txt');
  });
});

describe('method mapping', () => {
  it('has a connector method for every field', () => {
    const fields: ChangeField[] = [
      'title', 'meta_description', 'seo_title', 'canonical', 'robots_meta', 'slug',
      'excerpt', 'image_alt', 'content_block', 'json_ld', 'robots_txt', 'llms_txt',
    ];
    for (const field of fields) expect(methodForField(field)).toBeTruthy();
  });
});

describe('the plan', () => {
  it('says where a change will go before it is approved, not after', async () => {
    // On a platform with no write API every change is a manual card, and
    // someone deciding whether to approve needs to know that first.
    const primary = new FakeConnector({ capabilities: { setSeoMeta: false } });
    const { store, site, engine } = await setup({ primary });
    const change = await addChange(store, site.id, 'meta_description', 'A better description');

    const plan = await engine.plan(site.id);

    expect(store.getChange(change.id)!.status).toBe('draft');
    expect(plan).toHaveLength(1);
    expect(plan[0]!.via).toBe('manual');
    expect(plan[0]!.card?.payload?.text).toBe('A better description');
  });

  it('leaves out changes that are already done', async () => {
    const { store, site, engine, fakeSite } = await setup();
    fakeSite.title = 'Brand new title';
    const change = await addChange(store, site.id, 'title', 'Brand new title');
    await engine.approve(change.id, 'tester');
    await engine.apply(site.id, 'tester');

    expect(await engine.plan(site.id)).toHaveLength(0);
  });
});
