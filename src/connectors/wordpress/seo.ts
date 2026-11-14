/**
 * SEO plugin detection and write strategy.
 *
 * Research finding that drives this file: none of Yoast, Rank Math or All in
 * One SEO reliably expose their fields for REST *writes* by default. WordPress
 * refuses writes to post meta that was not registered with `show_in_rest`, and
 * these plugins generally do not register theirs. There is an unconfirmed
 * report that a recent Yoast registers them natively.
 *
 * So we never assume either way: we probe the live site once at connect time
 * and record what actually worked. Native writes are preferred when available
 * because they need no plugin install; the bridge is the fallback.
 *
 * All in One SEO is a special case — it stores SEO data in its own database
 * table rather than post meta, so post-meta writes cannot work and it always
 * needs the bridge.
 */

import type { WordPressClient } from './client.js';
import { log } from '../../core/logger.js';

export type SeoPlugin = 'yoast' | 'rankmath' | 'aioseo' | 'none';

/** How this site's SEO fields can be written. */
export type SeoStrategy =
  | { kind: 'native-meta'; plugin: SeoPlugin; keys: SeoMetaKeys }
  | { kind: 'bridge'; plugin: SeoPlugin }
  | { kind: 'unavailable'; plugin: SeoPlugin; reason: string };

export interface SeoMetaKeys {
  title: string;
  description: string;
  canonical?: string;
  robots?: string;
}

const META_KEYS: Record<Exclude<SeoPlugin, 'none'>, SeoMetaKeys | null> = {
  yoast: {
    title: '_yoast_wpseo_title',
    description: '_yoast_wpseo_metadesc',
    canonical: '_yoast_wpseo_canonical',
  },
  rankmath: {
    title: 'rank_math_title',
    description: 'rank_math_description',
    canonical: 'rank_math_canonical_url',
    robots: 'rank_math_robots',
  },
  // AIOSEO keeps SEO data in the wp_aioseo_posts table, not post meta.
  aioseo: null,
};

export const BRIDGE_NAMESPACE = 'ai-visibility-bridge/v1';

/** Identify the active SEO plugin from REST namespaces and plugin listing. */
export async function detectSeoPlugin(client: WordPressClient): Promise<SeoPlugin> {
  try {
    const { namespaces } = await client.index();
    if (namespaces.some((n) => n.startsWith('yoast/'))) return 'yoast';
    if (namespaces.some((n) => n.startsWith('rankmath/'))) return 'rankmath';
    if (namespaces.some((n) => n.startsWith('aioseo/'))) return 'aioseo';
  } catch (err) {
    log.debug('REST index unavailable for SEO detection', { error: err });
  }

  // Namespace absence is not proof — Yoast only registers its namespace in some
  // configurations. Fall back to the plugin list, which needs an authenticated
  // user with `activate_plugins`; failure here is normal and not an error.
  try {
    const plugins = await client.request<Array<{ plugin: string; status: string }>>('plugins');
    const active = plugins.filter((p) => p.status === 'active').map((p) => p.plugin.toLowerCase());
    if (active.some((p) => p.includes('wordpress-seo'))) return 'yoast';
    if (active.some((p) => p.includes('seo-by-rank-math'))) return 'rankmath';
    if (active.some((p) => p.includes('all-in-one-seo-pack'))) return 'aioseo';
  } catch {
    log.debug('plugin listing not permitted; relying on namespace detection only');
  }

  return 'none';
}

/** Is our companion plugin installed and responding? */
export async function bridgeAvailable(client: WordPressClient): Promise<boolean> {
  try {
    const res = await client.request<{ ok: boolean }>('status', { namespace: BRIDGE_NAMESPACE });
    return res?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Decide, by experiment, how SEO meta can be written on this site.
 *
 * `probePostId` should be a draft the consultant does not mind us touching; the
 * connector creates and deletes a throwaway draft for this. We write a sentinel
 * value and read it back, because WordPress silently drops writes to
 * unregistered meta rather than erroring — a 200 response proves nothing.
 */
export async function resolveSeoStrategy(
  client: WordPressClient,
  plugin: SeoPlugin,
  probePostId?: number,
): Promise<SeoStrategy> {
  if (plugin === 'none') {
    return await bridgeAvailable(client)
      ? { kind: 'bridge', plugin }
      : { kind: 'unavailable', plugin, reason: 'No SEO plugin is active and the companion plugin is not installed.' };
  }

  const keys = META_KEYS[plugin];

  if (keys && probePostId !== undefined) {
    const sentinel = `aiva-probe-${Date.now()}`;
    try {
      await client.request(`posts/${probePostId}`, {
        method: 'POST',
        body: { meta: { [keys.description]: sentinel } },
        describes: 'Probe whether SEO meta is writable over the core REST API',
      });
      const readBack = await client.request<{ meta?: Record<string, unknown> }>(`posts/${probePostId}`, {
        query: { context: 'edit' },
      });
      if (readBack?.meta?.[keys.description] === sentinel) {
        log.info('SEO meta is natively writable over REST', { plugin });
        return { kind: 'native-meta', plugin, keys };
      }
      log.info('SEO meta write was accepted but did not persist; bridge required', { plugin });
    } catch (err) {
      log.debug('native SEO meta probe failed', { plugin, error: err });
    }
  }

  if (await bridgeAvailable(client)) return { kind: 'bridge', plugin };

  return {
    kind: 'unavailable',
    plugin,
    reason:
      plugin === 'aioseo'
        ? 'All in One SEO stores its data outside post meta, so the companion plugin is required.'
        : `${plugin} does not expose its fields for REST writes on this site, and the companion plugin is not installed.`,
  };
}

export function describeStrategy(s: SeoStrategy): string {
  switch (s.kind) {
    case 'native-meta':
      return `${s.plugin}: writing directly to post meta over the core REST API.`;
    case 'bridge':
      return `${s.plugin === 'none' ? 'No SEO plugin' : s.plugin}: writing via the companion plugin.`;
    case 'unavailable':
      return s.reason;
  }
}
