/**
 * Post-apply verification.
 *
 * A change is only `verified` when a plain HTTP client — no JavaScript, with an
 * AI crawler's user agent — fetches the page and sees it. That is the whole
 * point of the product: what an answer engine can read, not what a browser
 * renders after hydration.
 *
 * Caches sit between us and the truth, so verification retries with backoff
 * rather than failing on the first stale response.
 */

import * as cheerio from 'cheerio';
import type { ChangeField } from './types.js';
import { log } from './logger.js';

/**
 * Default crawler identity. Honest about what it is: this is our auditor
 * checking a site its owner has connected, not a crawler pretending to be
 * someone else's. The AI-crawler token is included because some sites vary
 * their output by it, which is exactly what we need to observe.
 */
export const DEFAULT_CRAWLER_UA =
  'Mozilla/5.0 (compatible; AIVisibilityAuditor/0.1; +https://example.invalid/bot) ClaudeBot-compatible';

export interface VerifyOptions {
  userAgent?: string;
  /** Total attempts, spaced by increasing delay. Caches usually clear inside 3. */
  attempts?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * What counts as success.
   *
   * `present` (the default) waits for the page to show `expected`. `absent`
   * waits for it to stop showing it, which is how a rollback is checked: the
   * value we put there has to be gone from the served page.
   */
  mode?: 'present' | 'absent';
}

export interface VerifyResult {
  verified: boolean;
  /** What we actually found on the page, for the failure message in the UI. */
  found: string | null;
  attempts: number;
  status?: number;
  detail?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull the current value of a field out of fetched HTML. */
export function extractField(html: string, field: ChangeField, target?: string): string | null {
  const $ = cheerio.load(html);
  switch (field) {
    case 'title':
    case 'seo_title':
      return $('head title').first().text() || null;
    case 'meta_description':
      return $('head meta[name="description"]').first().attr('content') ?? null;
    case 'canonical':
      return $('head link[rel="canonical"]').first().attr('href') ?? null;
    case 'robots_meta':
      return $('head meta[name="robots"]').first().attr('content') ?? null;
    case 'json_ld': {
      const blocks = $('script[type="application/ld+json"]')
        .map((_, el) => $(el).text().trim())
        .get();
      return blocks.length ? blocks.join('\n') : null;
    }
    case 'image_alt': {
      if (!target) return null;
      const img = $(target).first();
      return img.length ? img.attr('alt') ?? '' : null;
    }
    case 'content_block': {
      if (!target) return null;
      const el = $(target).first();
      return el.length ? el.html() : null;
    }
    case 'slug':
    case 'excerpt':
      // Not independently observable in the served HTML; verified via the API read-back.
      return null;
    case 'robots_txt':
    case 'llms_txt':
      return html;
  }
}

/** True when the page genuinely reflects `expected` for this field. */
export function matches(field: ChangeField, found: string | null, expected: string): boolean {
  if (found === null) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

  if (field === 'json_ld') {
    // The page may carry several JSON-LD blocks; ours only needs to be present
    // and parse to the same structure. Key order must not matter.
    let want: unknown;
    try { want = JSON.parse(expected); } catch { return norm(found).includes(norm(expected)); }
    for (const block of found.split(/\n(?=\{|\[)/)) {
      try {
        if (stableStringify(JSON.parse(block)) === stableStringify(want)) return true;
      } catch { /* skip unparseable block */ }
    }
    return false;
  }

  if (field === 'robots_txt' || field === 'llms_txt') {
    return norm(found).includes(norm(expected));
  }

  if (field === 'title' || field === 'seo_title') {
    // Themes and platforms routinely append the site name: Squarespace's
    // default page title format is literally "Page SEO Title — Site Title". Accept
    // that, but only as a suffix after a recognised separator, so an unrelated
    // title that merely contains the string does not pass.
    const f = norm(found);
    const e = norm(expected);
    if (f === e) return true;
    return new RegExp(`^${escapeRegExp(e)}\\s*[–—\\-|·•:]\\s*\\S`).test(f);
  }

  return norm(found) === norm(expected);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`;
}

/**
 * Fetch `url` as a non-JS AI crawler and check the field now equals `expected`.
 * Never throws for an unverified change — returns `verified: false` with detail.
 */
export async function verifyChange(
  url: string,
  field: ChangeField,
  expected: string,
  target?: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const {
    userAgent = DEFAULT_CRAWLER_UA,
    attempts = 3,
    initialDelayMs = 1500,
    timeoutMs = 20_000,
    fetchImpl = fetch,
    mode = 'present',
  } = opts;

  let found: string | null = null;
  let status: number | undefined;
  let detail: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(initialDelayMs * 2 ** (attempt - 2));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml',
          // Ask intermediaries for a fresh copy; they may ignore it, hence retries.
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      status = res.status;
      if (!res.ok) {
        detail = `HTTP ${res.status} fetching ${url}`;
        continue;
      }
      const html = await res.text();
      found = extractField(html, field, target);
      const present = matches(field, found, expected);
      if (mode === 'absent' ? !present : present) {
        return { verified: true, found, attempts: attempt, status };
      }
      detail = mode === 'absent'
        ? `Page served, but ${field} still shows the value that was supposed to be removed`
        : `Page served, but ${field} did not match`;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
      log.debug('verification attempt failed', { url, field, attempt, error: detail });
    } finally {
      clearTimeout(timer);
    }
  }

  return { verified: false, found, attempts, status, detail };
}

/** Verify a root file by fetching it from the site origin. */
export async function verifyRootFile(
  siteOrigin: string,
  file: 'robots.txt' | 'llms.txt',
  expected: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const url = new URL(`/${file}`, siteOrigin).toString();
  return verifyChange(url, file === 'robots.txt' ? 'robots_txt' : 'llms_txt', expected, undefined, opts);
}

/**
 * Check that a rollback really undid something.
 *
 * A connector reporting a successful rollback is not evidence — the same
 * reason we never trust one about an apply. Where the previous value is known
 * we wait for the page to show it again; where there was nothing before, the
 * test is that what we put there is gone.
 */
export async function verifyRollback(
  url: string,
  field: ChangeField,
  before: string | null,
  after: string,
  target?: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  if (before !== null && before.trim() !== '') {
    return verifyChange(url, field, before, target, opts);
  }
  return verifyChange(url, field, after, target, { ...opts, mode: 'absent' });
}
