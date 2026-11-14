/**
 * The fallback chain, with the real connectors rather than stubs.
 *
 * Each connector declares its capabilities honestly, and the router turns those
 * declarations into a route. This test exists because the declarations and the
 * router are written in different files and could drift apart — in which case
 * a change would be sent to a connector that throws, instead of falling through.
 */

import { describe, it, expect } from 'vitest';
import { resolveRoute } from '../../src/core/connector.js';
import { SquarespaceConnector } from '../../src/connectors/squarespace/index.js';
import { WixConnector } from '../../src/connectors/wix/index.js';
import { CloudflareConnector } from '../../src/connectors/cloudflare/index.js';
import { WordPressConnector } from '../../src/connectors/wordpress/index.js';

const cloudflare = () =>
  new CloudflareConnector({ apiToken: 'cf-token-abcdefghijk', domain: 'clinic.test' });

const squarespace = () => new SquarespaceConnector('https://clinic.test');
const wix = () => new WixConnector({
  kind: 'app', clientId: 'a', clientSecret: 'secret-value-12345', instanceId: 'i',
});
const wordpress = () => new WordPressConnector({
  siteUrl: 'https://clinic.test', username: 'admin', applicationPassword: 'aaaa bbbb cccc dddd',
});

describe('Squarespace falls through', () => {
  it('sends a meta description to Cloudflare, since Squarespace has no write API', () => {
    const route = resolveRoute({ field: 'meta_description' }, squarespace(), cloudflare());
    expect(route.via).toBe('cloudflare');
  });

  it('sends it to a manual card when Cloudflare is not connected', () => {
    const route = resolveRoute({ field: 'meta_description' }, squarespace());
    expect(route.via).toBe('manual');
    if (route.via === 'manual') expect(route.reason).toMatch(/squarespace has no API/);
  });

  it('and the manual card for that change actually exists', () => {
    const card = squarespace().manualCard({
      id: 'c1', field: 'meta_description', page: 'https://clinic.test/about',
      before: null, after: 'New description.', reason: 'Missing description.',
    });
    expect(card).not.toBeNull();
    expect(card!.steps.length).toBeGreaterThan(2);
  });

  it('has no card for a canonical, and Cloudflare picks it up instead', () => {
    const sqsp = squarespace();
    expect(sqsp.manualCard({
      id: 'c2', field: 'canonical', page: 'https://clinic.test/about',
      before: null, after: 'https://clinic.test/about', reason: 'Duplicate URLs.',
    })).toBeNull();
    expect(resolveRoute({ field: 'canonical' }, sqsp, cloudflare()).via).toBe('cloudflare');
  });
});

describe('Wix falls through only for what it genuinely cannot do', () => {
  it('keeps SEO changes native', () => {
    expect(resolveRoute({ field: 'meta_description' }, wix(), cloudflare()).via).toBe('native');
    expect(resolveRoute({ field: 'json_ld' }, wix(), cloudflare()).via).toBe('native');
  });

  it('sends root files onward, because Wix has no API for them', () => {
    expect(resolveRoute({ field: 'llms_txt' }, wix(), cloudflare()).via).toBe('cloudflare');
    expect(resolveRoute({ field: 'robots_txt' }, wix()).via).toBe('manual');
  });
});

describe('WordPress before testConnection has resolved capabilities', () => {
  it('routes SEO onward until the live probe says otherwise', () => {
    // setSeoMeta starts false and is only enabled once testConnection confirms
    // a working write path. Until then the safe route is Cloudflare.
    expect(resolveRoute({ field: 'meta_description' }, wordpress(), cloudflare()).via).toBe('cloudflare');
  });

  it('keeps page edits native from the start, since core REST always allows them', () => {
    expect(resolveRoute({ field: 'title' }, wordpress(), cloudflare()).via).toBe('native');
  });
});

describe('every connector agrees on the interface', () => {
  it('declares a capability for each method the router can ask about', () => {
    for (const connector of [wordpress(), cloudflare(), wix(), squarespace()]) {
      for (const method of ['updatePage', 'setSeoMeta', 'injectSchema', 'setRootFile'] as const) {
        expect(
          typeof connector.capabilities[method],
          `${connector.platform}.${method} must declare a capability`,
        ).toBe('boolean');
      }
    }
  });

  it('never leaves a change with nowhere to go', () => {
    const fields = [
      'title', 'meta_description', 'seo_title', 'canonical', 'robots_meta',
      'slug', 'excerpt', 'image_alt', 'content_block', 'json_ld', 'robots_txt', 'llms_txt',
    ] as const;

    for (const field of fields) {
      for (const primary of [wordpress(), wix(), squarespace()]) {
        const route = resolveRoute({ field }, primary, cloudflare());
        expect(['native', 'cloudflare', 'manual']).toContain(route.via);
      }
    }
  });
});
