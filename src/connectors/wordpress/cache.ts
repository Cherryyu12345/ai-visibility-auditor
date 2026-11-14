/**
 * Cache purging after a write.
 *
 * None of the common caching plugins expose a REST endpoint for this, so the
 * purge runs inside WordPress through the companion plugin, which calls each
 * plugin's documented function if that plugin is active.
 *
 * Without the bridge we cannot purge. That is reported honestly rather than
 * silently skipped, because an unpurged cache is the single most common reason
 * a correctly-applied change fails verification.
 */

import type { WordPressClient } from './client.js';
import { BRIDGE_NAMESPACE } from './seo.js';
import { log } from '../../core/logger.js';

export interface PurgeResult {
  attempted: boolean;
  purged: string[];
  detail: string;
}

export async function purgeCaches(client: WordPressClient, postId?: number): Promise<PurgeResult> {
  try {
    const res = await client.request<{ purged: string[] }>('purge-cache', {
      method: 'POST',
      namespace: BRIDGE_NAMESPACE,
      body: postId !== undefined ? { post_id: postId } : {},
      describes: postId ? `Purge caches for post ${postId}` : 'Purge all caches',
    });
    const purged = res?.purged ?? [];
    return {
      attempted: true,
      purged,
      detail: purged.length
        ? `Purged: ${purged.join(', ')}.`
        : 'No caching plugin detected; nothing to purge.',
    };
  } catch (err) {
    log.debug('cache purge unavailable', { error: err });
    return {
      attempted: false,
      purged: [],
      detail:
        'Could not purge caches — the companion plugin is not installed. ' +
        'If the site caches pages, verification may lag behind the change.',
    };
  }
}
