import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { Engine } from '../../src/app/engine.js';
import { createAppServer } from '../../src/app/server.js';
import type { Connector } from '../../src/core/connector.js';
import { FakeConnector } from '../support/fake-connector.js';

process.env.AIVA_MASTER_KEY ??= Buffer.alloc(32, 17).toString('base64');

let base: string;
let app: ReturnType<typeof createAppServer>;

beforeAll(async () => {
  const store = Store.ephemeral();
  const engine = new Engine(store, {
    connectorFactory: () => new FakeConnector() as unknown as Connector,
  });
  app = createAppServer({ store, engine, operator: 'andrew', port: 0 });
  const { host, port } = await app.listen();
  base = `http://${host}:${port}`;
});

afterAll(async () => { await app.close(); });

describe('serving the interface', () => {
  it('serves the app at the root', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('AI Visibility Auditor');
  });

  it('serves the approval page for any share path, so the token stays in the URL', async () => {
    const res = await fetch(`${base}/approve/some-token-value`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('for your approval');
  });

  it('serves the stylesheet and script with the right types', async () => {
    for (const [path, type] of [['/styles.css', 'text/css'], ['/app.js', 'text/javascript']]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain(type!);
    }
  });
});

describe('not serving anything else', () => {
  it('refuses to walk out of the UI directory', async () => {
    // Node normalises `..` in the request line, so the encoded form is the
    // one that actually reaches a naive join.
    for (const path of [
      '/../app/api.js',
      '/..%2f..%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/../../.aiva/state.json',
    ]) {
      const res = await fetch(`${base}${path}`);
      expect([400, 404], `${path} returned ${res.status}`).toContain(res.status);
      const body = await res.text();
      expect(body).not.toContain('"dependencies"');
      expect(body).not.toContain('ciphertext');
    }
  });

  it('refuses a body that is not JSON', async () => {
    const res = await fetch(`${base}/api/sites`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('sets the headers that stop a response being sniffed or leaked', async () => {
    const res = await fetch(`${base}/api/config`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('the API over HTTP', () => {
  it('round-trips a site through the real server', async () => {
    const created = await fetch(`${base}/api/sites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.test', platform: 'wordpress' }),
    });
    expect(created.status).toBe(201);

    const listed = await (await fetch(`${base}/api/sites`)).json() as { sites: unknown[] };
    expect(listed.sites).toHaveLength(1);
  });
});
