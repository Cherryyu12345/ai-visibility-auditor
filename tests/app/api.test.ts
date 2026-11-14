import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { Engine } from '../../src/app/engine.js';
import { createApi } from '../../src/app/api.js';
import type { Connector } from '../../src/core/connector.js';
import { FAST_VERIFY, FakeConnector, FakeSite } from '../support/fake-connector.js';

process.env.AIVA_MASTER_KEY ??= Buffer.alloc(32, 11).toString('base64');

const PASSWORD = 'abcd EFGH 1234 ijkl MNOP 5678';

let dir: string;
let store: Store;
let api: ReturnType<typeof createApi>;
let connector: FakeConnector;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiva-api-'));
  file = join(dir, 'state.json');
  store = await Store.open(file);
  connector = new FakeConnector();
  const site = new FakeSite();
  const engine = new Engine(store, {
    verifyOptions: { ...FAST_VERIFY, fetchImpl: site.fetch },
    connectorFactory: () => connector as unknown as Connector,
  });
  api = createApi({ store, engine, operator: 'andrew' });
});

afterEach(async () => {
  await store.flush();
  await rm(dir, { recursive: true, force: true });
});

async function makeSite() {
  const res = await api('POST', '/api/sites', {
    url: 'https://example.test', name: 'Example', platform: 'wordpress',
  });
  return (res.body as { site: { id: string } }).site;
}

async function connect(siteId: string) {
  return api('POST', `/api/sites/${siteId}/connections`, {
    kind: 'wordpress',
    config: { siteUrl: 'https://example.test', username: 'editor' },
    secret: { applicationPassword: PASSWORD },
  });
}

describe('credentials', () => {
  it('never returns a stored credential', async () => {
    const site = await makeSite();
    const created = await connect(site.id);
    const listed = await api('GET', `/api/sites/${site.id}/connections`);
    const overview = await api('GET', `/api/sites/${site.id}`);

    for (const payload of [created.body, listed.body, overview.body]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('applicationPassword');
      expect(text).not.toContain('ciphertext');
    }
    expect((listed.body as { connections: Array<{ hasCredential: boolean }> }).connections[0]!.hasCredential).toBe(true);
    // The non-secret half is still there, because the UI has to show it.
    expect(JSON.stringify(listed.body)).toContain('editor');
  });

  it('never writes a credential to disk in the clear', async () => {
    const site = await makeSite();
    await connect(site.id);
    await store.flush();

    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(PASSWORD.replace(/\s/g, ''));
    // It is there, just sealed.
    expect(raw).toContain('ciphertext');
  });

  it('rejects a credential field that connection kind does not take', async () => {
    const site = await makeSite();
    const res = await api('POST', `/api/sites/${site.id}/connections`, {
      kind: 'wordpress',
      config: {},
      secret: { apiToken: 'cf-token-value' },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('cf-token-value');
  });

  it('deletes the credential when disconnected', async () => {
    const site = await makeSite();
    const created = await connect(site.id);
    const id = (created.body as { connection: { id: string } }).connection.id;

    const res = await api('DELETE', `/api/connections/${id}`);
    expect(res.status).toBe(200);
    await store.flush();

    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('ciphertext');
    expect(store.getConnection(id)).toBeUndefined();
    expect(store.listAudit(site.id).some((e) => e.action === 'disconnected')).toBe(true);
  });

  it('records what kind of access was granted without recording the values', async () => {
    const site = await makeSite();
    await connect(site.id);
    const entry = store.listAudit(site.id).find((e) => e.action === 'connected');
    expect(entry?.detail).toMatchObject({ kind: 'wordpress', credential: true });
    expect(JSON.stringify(entry?.detail)).not.toContain('editor');
    expect(JSON.stringify(entry?.detail)).not.toContain(PASSWORD);
  });
});

describe('changes', () => {
  it('imports a fix pack as drafts awaiting approval', async () => {
    const site = await makeSite();
    const res = await api('POST', `/api/sites/${site.id}/changes`, {
      changes: [
        { page: 'https://example.test/about', field: 'title', before: 'Old title', after: 'New', reason: 'r' },
        { page: 'https://example.test/', field: 'meta_description', after: 'Desc', reason: 'r' },
      ],
    });
    expect(res.status).toBe(201);
    expect(store.listChanges(site.id, ['draft'])).toHaveLength(2);
  });

  it('refuses a change with a field it does not understand', async () => {
    const site = await makeSite();
    const res = await api('POST', `/api/sites/${site.id}/changes`, {
      changes: [{ page: 'https://example.test/', field: 'favicon', after: 'x' }],
    });
    expect(res.status).toBe(400);
  });

  it('applies only what has been approved', async () => {
    const site = await makeSite();
    await connect(site.id);
    await api('POST', `/api/sites/${site.id}/changes`, {
      changes: [
        { page: 'https://example.test/about', field: 'title', after: 'Brand new title', reason: 'r' },
        { page: 'https://example.test/about', field: 'title', after: 'Never approved', reason: 'r' },
      ],
    });
    const [first, second] = store.listChanges(site.id);
    await api('POST', `/api/changes/${first!.id}/approve`);

    const res = await api('POST', `/api/sites/${site.id}/apply`, { dryRun: true });
    const report = res.body as { outcomes: Array<{ changeId: string }> };
    expect(report.outcomes.map((o) => o.changeId)).toEqual([first!.id]);
    expect(store.getChange(second!.id)!.status).toBe('draft');
  });
});

describe('errors', () => {
  it('says what is wrong rather than returning a 500', async () => {
    const res = await api('GET', '/api/sites/site_nope');
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toContain('No site');
  });

  it('refuses an unknown route', async () => {
    expect((await api('GET', '/api/nope')).status).toBe(404);
    expect((await api('DELETE', '/api/sites')).status).toBe(405);
  });
});
