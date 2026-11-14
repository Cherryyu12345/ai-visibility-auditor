/**
 * In-memory Wix API.
 *
 * Models the behaviours that actually bite: tags being replaced in full, the
 * draft/published split on static pages, the identity rule that refuses API
 * keys, and the two contradictory SEO base paths in Wix's own docs.
 */

import type { ItemSeoTags, WixTag } from '../../src/connectors/wix/seo.js';

export interface MockWixOptions {
  /** Which base path answers; the other 404s. Mirrors the doc contradiction. */
  liveBase?: '/seo-metatags-server/v1' | '/promote/seo/v1';
  /** Refuse SEO calls made with an API key, as the identity rule implies. */
  apiKeyForbidden?: boolean;
  /** Static pages have no published revision, so publish:true fails. */
  noPublishedRevision?: boolean;
  tokenFails?: boolean;
  tokenTtlSeconds?: number;
}

export interface MockWixState {
  items: Map<string, ItemSeoTags>;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  tokenRequests: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const wixError = (status: number, message: string, code?: string) =>
  json({ message, ...(code ? { details: { applicationError: { code } } } : {}) }, status);

function item(itemType: string, itemId: string, tags: WixTag[] = []): ItemSeoTags {
  return {
    id: `${itemType}:${itemId}`,
    itemType,
    itemId,
    tags,
    focusKeywords: [],
    hasOverride: tags.length > 0,
    resolvedTags: [
      { tag: { type: 'title', children: tags.find((t) => t.type === 'title')?.children ?? `${itemId} | Site` }, source: 'TAG' },
      { tag: { type: 'link', props: { rel: 'canonical', href: `https://clinic.wixsite.com/${itemId}` } }, source: 'PATTERN' },
    ],
  };
}

export function createMockWix(opts: MockWixOptions = {}) {
  const {
    liveBase = '/seo-metatags-server/v1',
    apiKeyForbidden = true,
    noPublishedRevision = false,
    tokenFails = false,
    tokenTtlSeconds = 14_400,
  } = opts;

  const state: MockWixState = { items: new Map(), calls: [], tokenRequests: 0 };

  // Seed a site: two static pages (one with hand-set tags), a product, a post.
  state.items.set('STATIC_PAGE:home', item('STATIC_PAGE', 'home'));
  state.items.set('STATIC_PAGE:about', item('STATIC_PAGE', 'about', [
    { type: 'title', children: 'About' },
    // A tag the consultant set by hand that we must never delete.
    { type: 'meta', props: { name: 'google-site-verification', content: 'abc123' } },
  ]));
  state.items.set('STORES_PRODUCT:p1', item('STORES_PRODUCT', 'p1'));
  state.items.set('BLOG_POST:b1', item('BLOG_POST', 'b1'));
  state.items.set('EVENTS_PAGE:e1', item('EVENTS_PAGE', 'e1'));

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ method, path, body });

    // --- token
    if (path === '/oauth2/token') {
      state.tokenRequests++;
      if (tokenFails) return json({ message: 'invalid client' }, 401);
      return json({ access_token: `tok-${state.tokenRequests}`, token_type: 'Bearer', expires_in: tokenTtlSeconds });
    }

    const authHeader = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const isApiKey = authHeader.startsWith('key-');
    if (!authHeader) return json({ message: 'missing credentials' }, 401);
    if (isApiKey && apiKeyForbidden && path.includes('item-seo-tags')) {
      return wixError(403, 'This method requires a Wix app or Wix user identity.');
    }

    // --- SEO base path discovery
    const base = Object.values(['/seo-metatags-server/v1', '/promote/seo/v1']).find((b) => path.startsWith(b));
    if (!base) return json({ message: `no route for ${path}` }, 404);
    if (base !== liveBase) return json({ message: 'not found' }, 404);

    const suffix = path.slice(base.length);

    // --- bulk set
    const bulk = suffix.match(/^\/bulk\/item-seo-tags\/([^/]+)\/set$/);
    if (bulk && method === 'POST') {
      const itemType = bulk[1]!;
      const results = (body.entries ?? []).map((entry: { itemSeoTags: ItemSeoTags }) => {
        const id = `${itemType}:${entry.itemSeoTags.itemId}`;
        const existing = state.items.get(id);
        if (!existing) {
          return { itemMetadata: { id, success: false, error: { description: 'item not found' } } };
        }
        existing.tags = entry.itemSeoTags.tags;
        existing.hasOverride = existing.tags.length > 0;
        return { itemMetadata: { id, success: true } };
      });
      return json({ results });
    }

    // --- reset
    const reset = suffix.match(/^\/item-seo-tags\/([^/]+)\/([^/]+)\/reset$/);
    if (reset && method === 'POST') {
      const id = `${reset[1]}:${reset[2]}`;
      const existing = state.items.get(id);
      if (!existing) return json({ message: 'not found' }, 404);
      existing.tags = [];
      existing.hasOverride = false;
      return json({ itemSeoTags: existing });
    }

    // --- get / patch one item
    const single = suffix.match(/^\/item-seo-tags\/([^/]+)\/([^/]+)$/);
    if (single) {
      const itemType = single[1]!;
      const id = `${itemType}:${single[2]}`;
      const existing = state.items.get(id);

      if (method === 'GET') {
        if (!existing) return json({ message: 'not found' }, 404);
        return json({ itemSeoTags: existing });
      }
      if (method === 'PATCH') {
        if (!existing) return json({ message: 'not found' }, 404);
        if (body.itemSeoTags?.language) {
          return wixError(400, 'language not supported', 'LANGUAGE_NOT_SUPPORTED');
        }
        if (noPublishedRevision && body.publish && itemType === 'STATIC_PAGE') {
          return wixError(400, 'draft saved but not published', 'DRAFT_SAVED_NOT_PUBLISHED');
        }
        // Wix replaces tags in full.
        existing.tags = body.itemSeoTags?.tags ?? [];
        existing.hasOverride = existing.tags.length > 0;
        return json({ itemSeoTags: existing });
      }
    }

    // --- list by type
    const list = suffix.match(/^\/item-seo-tags\/([^/]+)$/);
    if (list && method === 'GET') {
      const itemType = list[1]!;
      const items = [...state.items.values()].filter((i) => i.itemType === itemType);
      return json({ itemSeoTags: items, pagingMetadata: { cursors: {} } });
    }

    return json({ message: `no route for ${method} ${path}` }, 404);
  };

  return { fetchImpl, state };
}
