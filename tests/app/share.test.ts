import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { Engine } from '../../src/app/engine.js';
import { createApi } from '../../src/app/api.js';
import { hashToken } from '../../src/app/share.js';
import type { Connector } from '../../src/core/connector.js';
import { FAST_VERIFY, FakeConnector, FakeSite } from '../support/fake-connector.js';

process.env.AIVA_MASTER_KEY ??= Buffer.alloc(32, 13).toString('base64');

let dir: string;
let file: string;
let store: Store;
let api: ReturnType<typeof createApi>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiva-share-'));
  file = join(dir, 'state.json');
  store = await Store.open(file);
  const site = new FakeSite();
  const engine = new Engine(store, {
    verifyOptions: { ...FAST_VERIFY, fetchImpl: site.fetch },
    connectorFactory: () => new FakeConnector() as unknown as Connector,
  });
  api = createApi({ store, engine, operator: 'andrew' });
});

afterEach(async () => {
  await store.flush();
  await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const siteRes = await api('POST', '/api/sites', {
    url: 'https://example.test', name: 'Example', platform: 'wordpress',
  });
  const site = (siteRes.body as { site: { id: string } }).site;

  await api('POST', `/api/sites/${site.id}/connections`, {
    kind: 'wordpress',
    config: { siteUrl: 'https://example.test', username: 'editor' },
    secret: { applicationPassword: 'super secret password here' },
  });

  await api('POST', `/api/sites/${site.id}/changes`, {
    changes: [
      { page: 'https://example.test/about', field: 'title', before: 'Old', after: 'Shared one', reason: 'r' },
      { page: 'https://example.test/', field: 'meta_description', after: 'Not shared', reason: 'r' },
    ],
  });
  const changes = store.listChanges(site.id);
  const shared = changes[0]!;
  const other = changes[1]!;

  const shareRes = await api('POST', `/api/sites/${site.id}/shares`, { changeIds: [shared.id] });
  const { token, share } = shareRes.body as { token: string; share: { id: string } };
  return { site, shared, other, token, shareId: share.id };
}

describe('issuing a link', () => {
  it('stores only a hash, never the link itself', async () => {
    const { token } = await fixture();
    await store.flush();

    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashToken(token));
  });

  it('records that a link was issued, and for how many changes', async () => {
    const { site } = await fixture();
    const entry = store.listAudit(site.id).find((e) => e.action === 'share_link_created');
    expect(entry?.detail).toMatchObject({ changes: 1 });
  });
});

describe('what the link can see', () => {
  it('shows the named changes and nothing else about the site', async () => {
    const { token, shared, other } = await fixture();
    const res = await api('GET', `/api/share/${token}`);
    const body = res.body as { changes: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(body.changes.map((c) => c.id)).toEqual([shared.id]);

    const text = JSON.stringify(body);
    expect(text).not.toContain(other.id);
    expect(text).not.toContain('connection');
    expect(text).not.toContain('super secret password here');
    expect(text).not.toContain('ciphertext');
  });

  it('refuses an unknown token', async () => {
    await fixture();
    const res = await api('GET', '/api/share/not-a-real-token');
    expect(res.status).toBe(403);
  });
});

describe('what the link can do', () => {
  it('approves a change and records the reviewer by name', async () => {
    const { token, shared, site } = await fixture();
    const res = await api('POST', `/api/share/${token}/approve`, {
      changeId: shared.id, name: 'Priya Shah',
    });

    expect(res.status).toBe(200);
    expect(store.getChange(shared.id)!.status).toBe('approved');
    const entry = store.listAudit(site.id).find((e) => e.action === 'approve' && e.changeId === shared.id);
    expect(entry?.actor).toContain('Priya Shah');
    expect(entry?.actor).toMatch(/^share:/);
  });

  it('cannot touch a change the link was not issued for', async () => {
    const { token, other } = await fixture();
    const res = await api('POST', `/api/share/${token}/approve`, { changeId: other.id, name: 'Mal' });

    expect(res.status).toBe(403);
    expect(store.getChange(other.id)!.status).toBe('draft');
  });

  it('cannot apply anything, whatever it asks for', async () => {
    const { token, shared, site } = await fixture();
    await api('POST', `/api/share/${token}/approve`, { changeId: shared.id, name: 'Priya' });

    for (const path of ['apply', 'rollback', 'mark-done', '']) {
      const res = await api('POST', `/api/share/${token}/${path}`, { changeId: shared.id, name: 'Priya' });
      expect(res.status, `share link must not expose ${path || '(root POST)'}`).toBe(404);
    }
    // And the change is still only approved: nothing reached the site.
    expect(store.getChange(shared.id)!.status).toBe('approved');
    expect(store.listBatches(site.id)).toHaveLength(0);
  });
});

describe('expiry and revocation', () => {
  it('stops working once revoked', async () => {
    const { token, shareId, shared } = await fixture();
    await api('POST', `/api/shares/${shareId}/revoke`);

    const res = await api('POST', `/api/share/${token}/approve`, { changeId: shared.id, name: 'Priya' });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('REVOKED');
    expect(store.getChange(shared.id)!.status).toBe('draft');
  });

  it('stops working once expired', async () => {
    const { token, shareId, shared } = await fixture();
    await store.updateShareToken(shareId, { expiresAt: new Date(Date.now() - 1000) });

    const res = await api('GET', `/api/share/${token}`);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('EXPIRED');
    expect(store.getChange(shared.id)!.status).toBe('draft');
  });
});
