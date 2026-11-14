/**
 * In-memory Cloudflare API, shaped to the endpoints verified in the API
 * reference. Used because we have no Cloudflare account to test against; the
 * real-account checklist in the README covers what this cannot.
 */

export interface MockOptions {
  zoneName?: string;
  zoneStatus?: string;
  zonePaused?: boolean;
  sslMode?: string | null;
  proxied?: boolean;
  /** Include a DNS-only verify.squarespace.com record. */
  squarespaceVerify?: 'dns-only' | 'proxied' | 'absent';
  tokenStatus?: string;
  /** Simulate a zone that is not on the account. */
  zoneMissing?: boolean;
}

export interface MockState {
  kv: Map<string, string>;
  namespaces: Array<{ id: string; title: string }>;
  scripts: Map<string, { source: string; metadata: Record<string, unknown> }>;
  routes: Array<{ id: string; pattern: string; script: string }>;
  calls: Array<{ method: string; path: string }>;
}

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

const fail = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }), {
    status, headers: { 'content-type': 'application/json' },
  });

export function createMockCloudflare(opts: MockOptions = {}) {
  const {
    zoneName = 'clinic.test',
    zoneStatus = 'active',
    zonePaused = false,
    sslMode = 'full',
    proxied = true,
    squarespaceVerify = 'absent',
    tokenStatus = 'active',
    zoneMissing = false,
  } = opts;

  const ZONE_ID = 'zone-123';
  const ACCOUNT_ID = 'acct-456';

  const state: MockState = {
    kv: new Map(),
    namespaces: [],
    scripts: new Map(),
    routes: [],
    calls: [],
  };

  const zone = {
    id: ZONE_ID,
    name: zoneName,
    status: zoneStatus,
    paused: zonePaused,
    name_servers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
    account: { id: ACCOUNT_ID, name: 'Test account' },
  };

  const dnsRecords = [
    { id: 'r1', type: 'A', name: zoneName, content: '1.2.3.4', proxied },
    { id: 'r2', type: 'CNAME', name: `www.${zoneName}`, content: zoneName, proxied },
    { id: 'r3', type: 'MX', name: zoneName, content: 'mail.example.com', proxied: false },
    ...(squarespaceVerify === 'absent'
      ? []
      : [{
          id: 'r4',
          type: 'CNAME',
          name: `verify.${zoneName}`,
          content: 'verify.squarespace.com',
          proxied: squarespaceVerify === 'proxied',
        }]),
  ];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace('/client/v4', '');
    state.calls.push({ method, path });

    if (!String(init?.headers && (init.headers as Record<string, string>).authorization).startsWith('Bearer ')) {
      return fail(401, 9109, 'Invalid access token');
    }

    // --- tokens
    if (path === '/user/tokens/verify') return ok({ status: tokenStatus });

    // --- zones
    if (path === '/zones' && method === 'GET') {
      const name = url.searchParams.get('name');
      if (zoneMissing || (name && name !== zoneName)) return ok([]);
      return ok([zone]);
    }
    if (path === `/zones/${ZONE_ID}` && method === 'GET') return ok(zone);
    if (path === `/zones/${ZONE_ID}/settings/ssl`) {
      return sslMode === null ? fail(403, 9109, 'Insufficient permissions') : ok({ value: sslMode });
    }
    if (path === `/zones/${ZONE_ID}/dns_records`) return ok(dnsRecords);

    // --- worker routes
    if (path === `/zones/${ZONE_ID}/workers/routes` && method === 'GET') return ok(state.routes);
    if (path === `/zones/${ZONE_ID}/workers/routes` && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const route = { id: `route-${state.routes.length + 1}`, pattern: body.pattern, script: body.script };
      state.routes.push(route);
      return ok(route);
    }
    const routeDelete = path.match(new RegExp(`^/zones/${ZONE_ID}/workers/routes/(.+)$`));
    if (routeDelete && method === 'DELETE') {
      state.routes = state.routes.filter((r) => r.id !== routeDelete[1]);
      return ok({ id: routeDelete[1] });
    }

    // --- KV namespaces
    if (path === `/accounts/${ACCOUNT_ID}/storage/kv/namespaces` && method === 'GET') {
      return ok(state.namespaces);
    }
    if (path === `/accounts/${ACCOUNT_ID}/storage/kv/namespaces` && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const ns = { id: `ns-${state.namespaces.length + 1}`, title: body.title };
      state.namespaces.push(ns);
      return ok(ns);
    }

    // --- KV keys and values
    const keysMatch = path.match(/^\/accounts\/[^/]+\/storage\/kv\/namespaces\/([^/]+)\/keys$/);
    if (keysMatch) {
      const prefix = url.searchParams.get('prefix') ?? '';
      return ok([...state.kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })));
    }

    const valueMatch = path.match(/^\/accounts\/[^/]+\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/);
    if (valueMatch) {
      const key = decodeURIComponent(valueMatch[2]!);
      if (method === 'PUT') {
        state.kv.set(key, String(init?.body ?? ''));
        return ok(null);
      }
      if (method === 'DELETE') {
        state.kv.delete(key);
        return ok(null);
      }
      const value = state.kv.get(key);
      if (value === undefined) return new Response('key not found', { status: 404 });
      return new Response(value, { status: 200 });
    }

    // --- worker scripts
    const scriptMatch = path.match(/^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)$/);
    if (scriptMatch && method === 'PUT') {
      const form = init?.body as FormData;
      const metadataPart = form.get('metadata');
      const metadata = JSON.parse(await (metadataPart as Blob).text());
      const entry = metadata.main_module as string;
      const source = await (form.get(entry) as Blob).text();
      state.scripts.set(scriptMatch[1]!, { source, metadata });
      return ok({ id: scriptMatch[1] });
    }
    if (scriptMatch && method === 'DELETE') {
      state.scripts.delete(scriptMatch[1]!);
      return ok({ id: scriptMatch[1] });
    }

    return fail(404, 7003, `No route for ${method} ${path}`);
  };

  return { fetchImpl, state, ZONE_ID, ACCOUNT_ID, zoneName };
}
