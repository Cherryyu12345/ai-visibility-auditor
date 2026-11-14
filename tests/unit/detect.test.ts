import { describe, it, expect } from 'vitest';
import { detectFromCrawl, classifyUndetected, AMBIGUOUS_BELOW } from '../../src/detect/platform.js';

const crawl = (html: string, headers: Record<string, string> = {}, cnameChain?: string[]) =>
  detectFromCrawl({ url: 'https://site.test/', html, headers, ...(cnameChain ? { cnameChain } : {}) });

describe('platform detection', () => {
  it('identifies WordPress from the generator meta and assets', () => {
    const r = crawl('<meta name="generator" content="WordPress 6.7" /><link href="/wp-content/x.css">');
    expect(r.platform).toBe('wordpress');
    expect(r.confidence).toBeGreaterThan(AMBIGUOUS_BELOW);
  });

  it('identifies Wix from its request-id header and CDN assets', () => {
    const r = crawl('<img src="https://static.wixstatic.com/a.png">', { 'X-Wix-Request-Id': 'abc' });
    expect(r.platform).toBe('wix');
  });

  it('identifies Squarespace from its runtime context object', () => {
    const r = crawl('<script>window.Static.SQUARESPACE_CONTEXT = {};</script>', { Server: 'Squarespace' });
    expect(r.platform).toBe('squarespace');
  });

  it('uses the CNAME chain when the markup is uninformative', () => {
    const r = crawl('<html><body>Hello</body></html>', {}, ['ext-cust.squarespace.com']);
    expect(r.platform).toBe('squarespace');
  });

  it('reports unknown rather than guessing when there are no signals', () => {
    const r = crawl('<html><body>Plain site</body></html>');
    expect(r.platform).toBe('unknown');
    expect(r.confidence).toBe(0);
  });

  it('flags a migrated site carrying traces of both platforms as ambiguous', () => {
    // Squarespace site whose cached markup still references old wp-content assets.
    const r = crawl(
      '<link href="/wp-content/old.css"><script>window.Static.SQUARESPACE_CONTEXT={}</script>',
    );
    expect(r.ambiguous || r.confidence < 1).toBe(true);
    expect(r.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('returns the evidence that drove the decision', () => {
    const r = crawl('<meta name="generator" content="WordPress 6.7" />');
    expect(r.signals[0]?.source).toContain('generator');
    expect(r.signals[0]?.evidence).toContain('WordPress');
  });

  it('distinguishes a real custom site from an empty response', () => {
    expect(classifyUndetected('x'.repeat(600))).toBe('custom');
    expect(classifyUndetected('')).toBe('unknown');
  });
});
