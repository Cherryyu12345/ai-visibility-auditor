/**
 * Platform detection from the crawl.
 *
 * Signals are scored rather than matched first-wins, because sites routinely
 * carry misleading traces — a WordPress site migrated to Squarespace keeps old
 * asset URLs in cached pages, a Wix site can proxy a custom domain. The caller
 * always gets a confidence figure and the evidence, and the user can override.
 */

import type { Platform } from '../core/types.js';

export interface DetectionSignal {
  platform: Platform;
  /** Relative strength. Headers and live endpoints outweigh body text. */
  weight: number;
  source: string;
  evidence: string;
}

export interface DetectionResult {
  platform: Platform;
  /** 0–1. Below `AMBIGUOUS_BELOW` the UI should ask rather than assume. */
  confidence: number;
  signals: DetectionSignal[];
  /** True when two platforms scored close together — show the override prominently. */
  ambiguous: boolean;
}

export const AMBIGUOUS_BELOW = 0.55;

export interface CrawlInput {
  url: string;
  html: string;
  headers: Record<string, string>;
  /** Optional: resolved CNAME chain, when DNS was looked up. */
  cnameChain?: string[];
}

const HEADER_RULES: Array<{ header: string; pattern: RegExp; platform: Platform; weight: number }> = [
  { header: 'x-powered-by', pattern: /wordpress|w3 total cache|wp engine/i, platform: 'wordpress', weight: 3 },
  { header: 'x-pingback', pattern: /xmlrpc\.php/i, platform: 'wordpress', weight: 4 },
  { header: 'link', pattern: /wp-json/i, platform: 'wordpress', weight: 5 },
  { header: 'server', pattern: /^Pepyaka/i, platform: 'wix', weight: 4 },
  { header: 'x-wix-request-id', pattern: /./, platform: 'wix', weight: 5 },
  { header: 'x-wix-published-version', pattern: /./, platform: 'wix', weight: 5 },
  { header: 'x-seen-by', pattern: /wix/i, platform: 'wix', weight: 3 },
  { header: 'server', pattern: /Squarespace/i, platform: 'squarespace', weight: 5 },
  { header: 'x-contextid', pattern: /./, platform: 'squarespace', weight: 2 },
];

const BODY_RULES: Array<{ pattern: RegExp; platform: Platform; weight: number; label: string }> = [
  { pattern: /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i, platform: 'wordpress', weight: 5, label: 'generator meta' },
  { pattern: /\/wp-content\//i, platform: 'wordpress', weight: 3, label: 'wp-content asset' },
  { pattern: /\/wp-includes\//i, platform: 'wordpress', weight: 3, label: 'wp-includes asset' },
  { pattern: /\/wp-json\//i, platform: 'wordpress', weight: 4, label: 'wp-json reference' },
  { pattern: /static\.wixstatic\.com|static\.parastorage\.com/i, platform: 'wix', weight: 4, label: 'Wix CDN asset' },
  { pattern: /<meta[^>]+content=["']Wix\.com Website Builder/i, platform: 'wix', weight: 5, label: 'generator meta' },
  { pattern: /wix-warmup-data|wixBiSession/i, platform: 'wix', weight: 4, label: 'Wix runtime bootstrap' },
  { pattern: /static1\.squarespace\.com|squarespace-cdn\.com/i, platform: 'squarespace', weight: 4, label: 'Squarespace CDN asset' },
  { pattern: /<!--\s*This is Squarespace\.|Squarespace\.afterBodyLoad/i, platform: 'squarespace', weight: 5, label: 'Squarespace runtime marker' },
  { pattern: /window\.Static\.SQUARESPACE_CONTEXT/i, platform: 'squarespace', weight: 5, label: 'Squarespace context object' },
];

const CNAME_RULES: Array<{ pattern: RegExp; platform: Platform; weight: number }> = [
  { pattern: /ext-?(cust|sq)\.squarespace\.com/i, platform: 'squarespace', weight: 5 },
  { pattern: /wixdns\.net|www\d*\.wixsite\.com/i, platform: 'wix', weight: 5 },
  { pattern: /wpengine|kinsta|wordpress\.com/i, platform: 'wordpress', weight: 3 },
];

export function detectFromCrawl(input: CrawlInput): DetectionResult {
  const signals: DetectionSignal[] = [];
  const headers = Object.fromEntries(
    Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );

  for (const rule of HEADER_RULES) {
    const value = headers[rule.header];
    if (value && rule.pattern.test(value)) {
      signals.push({
        platform: rule.platform,
        weight: rule.weight,
        source: `header:${rule.header}`,
        evidence: value.slice(0, 120),
      });
    }
  }

  for (const rule of BODY_RULES) {
    const m = input.html.match(rule.pattern);
    if (m) {
      signals.push({
        platform: rule.platform,
        weight: rule.weight,
        source: `body:${rule.label}`,
        evidence: m[0].slice(0, 120),
      });
    }
  }

  for (const cname of input.cnameChain ?? []) {
    for (const rule of CNAME_RULES) {
      if (rule.pattern.test(cname)) {
        signals.push({ platform: rule.platform, weight: rule.weight, source: 'dns:cname', evidence: cname });
      }
    }
  }

  return score(signals);
}

function score(signals: DetectionSignal[]): DetectionResult {
  if (signals.length === 0) {
    return { platform: 'unknown', confidence: 0, signals, ambiguous: false };
  }

  const totals = new Map<Platform, number>();
  for (const s of signals) totals.set(s.platform, (totals.get(s.platform) ?? 0) + s.weight);

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const [topPlatform, topScore] = ranked[0]!;
  const runnerUp = ranked[1]?.[1] ?? 0;
  const sum = ranked.reduce((acc, [, v]) => acc + v, 0);

  const confidence = Math.min(1, (topScore / sum) * Math.min(1, topScore / 8));
  const ambiguous = runnerUp > 0 && topScore - runnerUp <= 2;

  return { platform: topPlatform, confidence: Number(confidence.toFixed(2)), signals, ambiguous };
}

/**
 * Confirm WordPress by asking the site directly. A reachable REST root is the
 * only signal that actually predicts whether the connector will work, so it
 * outranks everything inferred from markup.
 */
export async function probeWordPress(
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ isWordPress: boolean; restUrl?: string; detail: string }> {
  const candidate = new URL('/wp-json/', siteUrl).toString();
  try {
    const res = await fetchImpl(candidate, { headers: { accept: 'application/json' }, redirect: 'follow' });
    if (!res.ok) return { isWordPress: false, detail: `REST root returned HTTP ${res.status}` };
    const body = (await res.json()) as { namespaces?: string[] };
    if (Array.isArray(body.namespaces) && body.namespaces.includes('wp/v2')) {
      return { isWordPress: true, restUrl: candidate, detail: 'wp/v2 namespace present' };
    }
    return { isWordPress: false, detail: 'REST root reachable but wp/v2 namespace missing' };
  } catch (err) {
    return { isWordPress: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * "custom" is a conclusion, not a default: it means we looked and found a real
 * site with no builder fingerprint. `unknown` means we could not tell.
 */
export function classifyUndetected(html: string): Platform {
  return html.trim().length > 500 ? 'custom' : 'unknown';
}
