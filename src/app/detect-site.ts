/**
 * Detecting a site's platform when it is first connected.
 *
 * Detection is a suggestion, never a decision: the Connect step shows what was
 * found and the evidence for it, and the consultant can override. Guessing
 * wrong and proceeding silently would mean asking for the wrong credentials.
 */

import { resolveCname } from 'node:dns/promises';
import {
  AMBIGUOUS_BELOW, classifyUndetected, detectFromCrawl, probeWordPress,
  type DetectionResult,
} from '../detect/platform.js';
import { log } from '../core/logger.js';

export interface SiteDetection extends DetectionResult {
  url: string;
  /** True when the site could not be fetched at all. */
  unreachable?: boolean;
  detail?: string;
  restUrl?: string;
}

export async function detectSite(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SiteDetection> {
  const normalised = normaliseSiteUrl(url);

  let html = '';
  let headers: Record<string, string> = {};
  try {
    const res = await fetchImpl(normalised, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    html = await res.text();
    res.headers.forEach((value, key) => { headers[key] = value; });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      url: normalised, platform: 'unknown', confidence: 0, signals: [], ambiguous: true,
      unreachable: true, detail: `Could not fetch ${normalised}: ${detail}`,
    };
  }

  let cnameChain: string[] | undefined;
  try {
    cnameChain = await resolveCname(new URL(normalised).hostname);
  } catch {
    // No CNAME is ordinary — an apex record is an A record. Detection works
    // without it; it is only ever an extra signal.
  }

  const result = detectFromCrawl({
    url: normalised, html, headers,
    ...(cnameChain?.length ? { cnameChain } : {}),
  });

  // A live REST root beats every inferred signal, so confirm it rather than
  // asking for WordPress credentials on the strength of a /wp-content/ link.
  if (result.platform === 'wordpress' || result.confidence < AMBIGUOUS_BELOW) {
    const probe = await probeWordPress(normalised, fetchImpl);
    if (probe.isWordPress) {
      return {
        ...result, url: normalised, platform: 'wordpress',
        confidence: Math.max(result.confidence, 0.95),
        ambiguous: false,
        signals: [
          ...result.signals,
          { platform: 'wordpress', weight: 6, source: 'probe', evidence: probe.detail },
        ],
        ...(probe.restUrl ? { restUrl: probe.restUrl } : {}),
      };
    }
    if (result.platform === 'wordpress') {
      log.info('markup looked like WordPress but the REST root did not answer', { url: normalised });
      return {
        ...result, url: normalised, ambiguous: true,
        detail:
          'The markup looks like WordPress but /wp-json/ did not answer. ' +
          'A security plugin may be blocking the REST API, which the connector needs.',
      };
    }
  }

  if (result.platform === 'unknown') {
    return { ...result, url: normalised, platform: classifyUndetected(html) };
  }
  return { ...result, url: normalised };
}

export function normaliseSiteUrl(url: string): string {
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const parsed = new URL(withScheme);
  parsed.hash = '';
  parsed.search = '';
  return parsed.origin;
}
