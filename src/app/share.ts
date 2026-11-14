/**
 * Approval links for people without an account.
 *
 * The consultant's client needs to approve copy changes to their own site
 * without being made to create a login. That is a reasonable thing to want and
 * an easy thing to get wrong, so this link is as narrow as it can be:
 *
 *   - it names an explicit list of changes, and can touch no others;
 *   - it can approve or reject, and nothing else — applying stays with the
 *     account holder, so a link that leaks cannot change a live site;
 *   - it expires, and can be revoked;
 *   - only a hash of it is stored, so the database cannot be read to recover
 *     a working link.
 */

import { createHash, randomBytes } from 'node:crypto';
import { safeEqual } from '../core/crypto.js';
import { registerSecret } from '../core/logger.js';
import type { Store } from '../store/store.js';
import { StateError } from '../store/store.js';
import type { ShareToken } from '../store/types.js';

export const DEFAULT_TTL_DAYS = 14;

export interface IssuedLink {
  /** Shown once, at creation. Never stored and never recoverable. */
  token: string;
  share: ShareToken;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueShareLink(
  store: Store,
  siteId: string,
  changeIds: string[],
  createdBy: string,
  ttlDays = DEFAULT_TTL_DAYS,
): Promise<IssuedLink> {
  if (changeIds.length === 0) {
    throw new StateError('A share link needs at least one change to approve.', 'EMPTY_SHARE');
  }
  // Every id is checked against this site: a link can never be widened by
  // passing in a change that belongs to somebody else's site.
  for (const id of changeIds) {
    const change = store.requireChange(id);
    if (change.siteId !== siteId) {
      throw new StateError('That change belongs to a different site.', 'WRONG_SITE');
    }
  }

  const token = randomBytes(32).toString('base64url');
  registerSecret(token);

  const share = await store.addShareToken({
    siteId,
    changeIds: [...changeIds],
    tokenHash: hashToken(token),
    createdBy,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
  });

  await store.appendAudit({
    siteId, actor: createdBy, action: 'share_link_created',
    detail: { shareId: share.id, changes: changeIds.length, expiresAt: share.expiresAt.toISOString() },
  });

  return { token, share };
}

export class InvalidShareLink extends Error {
  constructor(message: string, readonly code: 'UNKNOWN' | 'EXPIRED' | 'REVOKED') {
    super(message);
    this.name = 'InvalidShareLink';
  }
}

/**
 * Find the share link a token belongs to.
 *
 * The comparison is constant-time against each stored hash, so the time this
 * takes says nothing about how much of a guessed token was right.
 */
export function resolveShareLink(store: Store, token: string): ShareToken {
  const hash = hashToken(token);
  let found: ShareToken | undefined;
  for (const candidate of store.allShareTokens()) {
    if (safeEqual(candidate.tokenHash, hash)) found = candidate;
  }
  if (!found) throw new InvalidShareLink('This approval link is not valid.', 'UNKNOWN');
  if (found.revokedAt) throw new InvalidShareLink('This approval link has been revoked.', 'REVOKED');
  if (found.expiresAt.getTime() < Date.now()) {
    throw new InvalidShareLink('This approval link has expired.', 'EXPIRED');
  }
  return found;
}

export async function revokeShareLink(store: Store, shareId: string, actor: string): Promise<ShareToken> {
  const updated = await store.updateShareToken(shareId, { revokedAt: new Date() });
  await store.appendAudit({
    siteId: updated.siteId, actor, action: 'share_link_revoked', detail: { shareId },
  });
  return updated;
}

/** The actor string recorded for anything done through a link. */
export function shareActor(share: ShareToken): string {
  return share.usedBy ? `share:${share.id} (${share.usedBy})` : `share:${share.id}`;
}
