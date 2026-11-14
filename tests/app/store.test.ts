import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { canTransition, type ChangeStatus } from '../../src/core/types.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiva-store-'));
  file = join(dir, 'state.json');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function seeded() {
  const store = await Store.open(file);
  const site = await store.addSite({
    name: 'Example', url: 'https://example.test', platform: 'wordpress', platformOverridden: false,
  });
  const [change] = await store.addChanges([{
    siteId: site.id, page: 'https://example.test/', field: 'title',
    before: 'Old', after: 'New', reason: 'r',
  }]);
  return { store, site, change: change! };
}

describe('persistence', () => {
  it('survives a reload with real Dates, not strings', async () => {
    const { store, site, change } = await seeded();
    await store.appendAudit({ siteId: site.id, actor: 'andrew', action: 'approve', changeId: change.id });
    await store.flush();

    const reopened = await Store.open(file);
    const reloaded = reopened.getChange(change.id)!;

    expect(reloaded.createdAt).toBeInstanceOf(Date);
    expect(reloaded.after).toBe('New');
    expect(reopened.listAudit(site.id)[0]!.at).toBeInstanceOf(Date);
    expect(reopened.listSites()[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('starts empty rather than failing when there is no file yet', async () => {
    const store = await Store.open(join(dir, 'does-not-exist.json'));
    expect(store.listSites()).toEqual([]);
  });

  it('writes the state file so only its owner can read it', async () => {
    const { store } = await seeded();
    await store.flush();
    const { stat } = await import('node:fs/promises');
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('the change lifecycle', () => {
  it('allows only the transitions the lifecycle defines', () => {
    expect(canTransition('draft', 'approved')).toBe(true);
    expect(canTransition('approved', 'applied')).toBe(true);
    expect(canTransition('applied', 'verified')).toBe(true);
    expect(canTransition('verified', 'rolled_back')).toBe(true);

    expect(canTransition('draft', 'applied')).toBe(false);
    expect(canTransition('draft', 'verified')).toBe(false);
    expect(canTransition('rolled_back', 'applied')).toBe(false);
    expect(canTransition('verified', 'applied')).toBe(false);
  });

  it('enforces them in the store, not just in the helper', async () => {
    const { store, change } = await seeded();
    for (const bad of ['applied', 'verified', 'rolled_back'] as ChangeStatus[]) {
      await expect(store.transition(change.id, bad)).rejects.toThrow(/cannot become/);
    }
    await store.transition(change.id, 'approved');
    expect(store.getChange(change.id)!.status).toBe('approved');
  });

  it('moves updatedAt but never createdAt', async () => {
    const { store, change } = await seeded();
    const before = change.createdAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const after = await store.transition(change.id, 'approved');
    expect(after.createdAt.getTime()).toBe(before);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('the audit log', () => {
  it('has no way to remove or rewrite an entry', () => {
    const methods = Object.getOwnPropertyNames(Store.prototype);
    const audit = methods.filter((m) => m.toLowerCase().includes('audit'));
    expect(audit.sort()).toEqual(['appendAudit', 'listAudit']);
  });

  it('keeps entries in the order they happened, newest first when listed', async () => {
    const { store, site } = await seeded();
    for (const action of ['approve', 'applied', 'verified']) {
      await store.appendAudit({ siteId: site.id, actor: 'andrew', action });
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(store.listAudit(site.id).map((e) => e.action)).toEqual(['verified', 'applied', 'approve']);
  });

  it("keeps each site's entries to itself", async () => {
    const { store, site } = await seeded();
    const other = await store.addSite({
      name: 'Other', url: 'https://other.test', platform: 'wix', platformOverridden: false,
    });
    await store.appendAudit({ siteId: site.id, actor: 'a', action: 'one' });
    await store.appendAudit({ siteId: other.id, actor: 'b', action: 'two' });

    expect(store.listAudit(site.id).map((e) => e.action)).toEqual(['one']);
    expect(store.listAudit(other.id).map((e) => e.action)).toEqual(['two']);
  });
});

describe('connections', () => {
  it('replaces rather than accumulating when the same kind is reconnected', async () => {
    const { store, site } = await seeded();
    await store.putConnection({ siteId: site.id, kind: 'wordpress', label: 'first', config: {}, secret: null });
    await store.putConnection({ siteId: site.id, kind: 'wordpress', label: 'second', config: {}, secret: null });

    const connections = store.listConnections(site.id);
    expect(connections).toHaveLength(1);
    expect(connections[0]!.label).toBe('second');
  });

  it('leaves other kinds alone', async () => {
    const { store, site } = await seeded();
    await store.putConnection({ siteId: site.id, kind: 'wordpress', label: 'wp', config: {}, secret: null });
    await store.putConnection({ siteId: site.id, kind: 'cloudflare', label: 'cf', config: {}, secret: null });
    expect(store.listConnections(site.id)).toHaveLength(2);
  });
});
