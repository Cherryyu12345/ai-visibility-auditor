import { describe, it, expect, vi } from 'vitest';
import { extractField, matches, verifyChange } from '../../src/core/verify.js';

const page = (head: string, body = '') => `<html><head>${head}</head><body>${body}</body></html>`;

describe('extracting fields from served HTML', () => {
  it('reads title, description, canonical and robots', () => {
    const html = page(
      '<title>Clinic</title><meta name="description" content="We do X."><link rel="canonical" href="https://a.test/"><meta name="robots" content="index,follow">',
    );
    expect(extractField(html, 'title')).toBe('Clinic');
    expect(extractField(html, 'meta_description')).toBe('We do X.');
    expect(extractField(html, 'canonical')).toBe('https://a.test/');
    expect(extractField(html, 'robots_meta')).toBe('index,follow');
  });

  it('returns null when a tag is absent rather than an empty string', () => {
    expect(extractField(page('<title>x</title>'), 'meta_description')).toBeNull();
  });

  it('reads an image alt by selector', () => {
    const html = page('', '<img id="hero" src="a.png" alt="A clinic room">');
    expect(extractField(html, 'image_alt', '#hero')).toBe('A clinic room');
  });

  it('collects every JSON-LD block', () => {
    const html = page(
      '<script type="application/ld+json">{"@type":"A"}</script><script type="application/ld+json">{"@type":"B"}</script>',
    );
    expect(extractField(html, 'json_ld')).toContain('"@type":"A"');
    expect(extractField(html, 'json_ld')).toContain('"@type":"B"');
  });
});

describe('matching', () => {
  it('ignores whitespace differences', () => {
    expect(matches('title', '  Clinic   name ', 'Clinic name')).toBe(true);
  });

  it('matches JSON-LD regardless of key order', () => {
    const found = '{"name":"A","@type":"Clinic"}';
    expect(matches('json_ld', found, '{"@type":"Clinic","name":"A"}')).toBe(true);
  });

  it('finds our JSON-LD among several blocks', () => {
    const found = '{"@type":"Other"}\n{"@type":"Clinic","name":"A"}';
    expect(matches('json_ld', found, '{"@type":"Clinic","name":"A"}')).toBe(true);
  });

  it('rejects JSON-LD that is merely similar', () => {
    expect(matches('json_ld', '{"@type":"Clinic","name":"B"}', '{"@type":"Clinic","name":"A"}')).toBe(false);
  });

  it('treats robots.txt as a containment check, since other rules may coexist', () => {
    expect(matches('robots_txt', 'User-agent: *\nAllow: /\nUser-agent: GPTBot\nAllow: /', 'User-agent: GPTBot\nAllow: /')).toBe(true);
  });

  it('never matches when nothing was found', () => {
    expect(matches('title', null, 'anything')).toBe(false);
  });
});

describe('verifyChange', () => {
  it('sends an AI-crawler user agent and no-cache headers', async () => {
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['user-agent']).toMatch(/AIVisibilityAuditor/);
      expect(headers['cache-control']).toBe('no-cache');
      return new Response(page('<title>New title</title>'), { status: 200 });
    });
    const r = await verifyChange('https://a.test/', 'title', 'New title', undefined, { fetchImpl: fetchImpl as never });
    expect(r.verified).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it('retries a stale cache and succeeds once it clears', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      return new Response(page(call < 3 ? '<title>Old</title>' : '<title>New</title>'), { status: 200 });
    });
    const r = await verifyChange('https://a.test/', 'title', 'New', undefined, {
      fetchImpl: fetchImpl as never, initialDelayMs: 1,
    });
    expect(r.verified).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it('reports what it found instead when the change is not visible', async () => {
    const fetchImpl = vi.fn(async () => new Response(page('<title>Old</title>'), { status: 200 }));
    const r = await verifyChange('https://a.test/', 'title', 'New', undefined, {
      fetchImpl: fetchImpl as never, attempts: 2, initialDelayMs: 1,
    });
    expect(r.verified).toBe(false);
    expect(r.found).toBe('Old');
    expect(r.detail).toMatch(/did not match/);
  });

  it('does not throw when the site is unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await verifyChange('https://a.test/', 'title', 'New', undefined, {
      fetchImpl: fetchImpl as never, attempts: 1,
    });
    expect(r.verified).toBe(false);
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });
});

describe('title matching tolerates theme suffixes', () => {
  it('accepts a site-name suffix after a separator', () => {
    expect(matches('title', 'About our clinic – Clinic Name', 'About our clinic')).toBe(true);
    expect(matches('title', 'About our clinic | Clinic Name', 'About our clinic')).toBe(true);
  });

  it('still accepts an exact match', () => {
    expect(matches('title', 'About our clinic', 'About our clinic')).toBe(true);
  });

  it('rejects an unrelated title that merely contains the text', () => {
    expect(matches('title', 'Old About our clinic page', 'About our clinic')).toBe(false);
  });

  it('rejects a longer title with no separator', () => {
    expect(matches('title', 'About our clinic extended', 'About our clinic')).toBe(false);
  });
});

describe('seo_title tolerates the same suffix as title', () => {
  it("accepts Squarespace's default \"Page SEO Title — Site Title\" format", () => {
    expect(matches('seo_title', 'About our clinic — The Clinic', 'About our clinic')).toBe(true);
  });

  it('accepts the hyphen form used for collection items', () => {
    expect(matches('seo_title', 'Easy Vegan Recipes - Healthy Living', 'Easy Vegan Recipes')).toBe(true);
  });

  it('still rejects an unrelated title', () => {
    expect(matches('seo_title', 'Completely different', 'About our clinic')).toBe(false);
  });
});
