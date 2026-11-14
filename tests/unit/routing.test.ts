import { describe, it, expect } from 'vitest';
import { resolveRoute, methodForField } from '../../src/core/connector.js';
import type { Connector } from '../../src/core/connector.js';
import { canTransition } from '../../src/core/types.js';
import type { Capabilities } from '../../src/core/connector.js';

const stub = (platform: Connector['platform'], capabilities: Capabilities): Connector =>
  ({ platform, capabilities, dryRun: false }) as Connector;

describe('field to method mapping', () => {
  it('routes SEO fields to setSeoMeta and body fields to updatePage', () => {
    expect(methodForField('meta_description')).toBe('setSeoMeta');
    expect(methodForField('canonical')).toBe('setSeoMeta');
    expect(methodForField('title')).toBe('updatePage');
    expect(methodForField('json_ld')).toBe('injectSchema');
    expect(methodForField('llms_txt')).toBe('setRootFile');
  });
});

describe('route resolution', () => {
  it('prefers the platform API when it supports the method', () => {
    const wp = stub('wordpress', { setSeoMeta: true });
    const cf = stub('custom', { setSeoMeta: true });
    const route = resolveRoute({ field: 'meta_description' }, wp, cf);
    expect(route.via).toBe('native');
  });

  it('falls through to Cloudflare when the platform cannot do it', () => {
    const sqsp = stub('squarespace', { setSeoMeta: false });
    const cf = stub('custom', { setSeoMeta: true });
    const route = resolveRoute({ field: 'meta_description' }, sqsp, cf);
    expect(route.via).toBe('cloudflare');
    if (route.via === 'cloudflare') expect(route.reason).toMatch(/squarespace has no API/);
  });

  it('falls through to a manual card when Cloudflare is not connected', () => {
    const sqsp = stub('squarespace', { setSeoMeta: false });
    const route = resolveRoute({ field: 'meta_description' }, sqsp);
    expect(route.via).toBe('manual');
    if (route.via === 'manual') expect(route.reason).toMatch(/no Cloudflare zone/);
  });

  it('falls through to manual when Cloudflare also lacks the method', () => {
    const sqsp = stub('squarespace', { setRootFile: false });
    const cf = stub('custom', { setRootFile: false });
    expect(resolveRoute({ field: 'robots_txt' }, sqsp, cf).via).toBe('manual');
  });
});

describe('change lifecycle', () => {
  it('allows the intended path and nothing else', () => {
    expect(canTransition('draft', 'approved')).toBe(true);
    expect(canTransition('approved', 'applied')).toBe(true);
    expect(canTransition('applied', 'verified')).toBe(true);
    expect(canTransition('verified', 'rolled_back')).toBe(true);
  });

  it('never lets a change skip approval', () => {
    expect(canTransition('draft', 'applied')).toBe(false);
  });

  it('never lets an unapplied change be marked verified', () => {
    expect(canTransition('approved', 'verified')).toBe(false);
    expect(canTransition('draft', 'verified')).toBe(false);
  });

  it('lets a failed change be fixed and retried', () => {
    expect(canTransition('failed', 'approved')).toBe(true);
  });
});
