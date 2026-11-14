/**
 * Manual instruction cards.
 *
 * The last stop in the routing chain: when neither the platform nor Cloudflare
 * can apply a change, a human does it. A card is only useful if it is precise
 * enough to follow without thinking — the exact text to paste, the exact
 * sequence of clicks, and the caveats that would otherwise waste an hour.
 *
 * Crucially, a manual change is still verified the same way an automated one
 * is. "Mark done" does not mark a change applied on trust: it re-fetches the
 * page as a crawler and only then records it.
 */

import type { Change, ChangeField, Platform } from './types.js';
import { verifyChange, type VerifyOptions, type VerifyResult } from './verify.js';

export interface ManualStep {
  /** One action. Written imperatively: "Click the SEO tab." */
  text: string;
  /** Set when this step is where the payload gets pasted. */
  pastesPayload?: boolean;
}

export interface ManualCard {
  changeId?: string;
  platform: Platform;
  field: ChangeField;
  /** One line naming the job, e.g. "Set the SEO description for /about". */
  title: string;
  /** Why this change was proposed, carried through from the audit. */
  why: string;
  steps: ManualStep[];
  /** The exact text to paste, with a label for the copy button. */
  payload?: { label: string; text: string };
  /** What the person should see when it worked. */
  expected?: string;
  /** Things that will otherwise cost them time. */
  caveats?: string[];
  /** A plan or version requirement that blocks this entirely. */
  requirement?: string;
  /** Page to re-fetch when they press "mark done". */
  verifyUrl?: string;
}

/**
 * Complete a manual change.
 *
 * Returns `verified: false` rather than throwing when the change is not
 * visible, so the UI can say "we could not see it yet" instead of either
 * failing loudly or silently accepting the claim.
 */
export async function markDone(
  card: ManualCard,
  change: Pick<Change, 'field' | 'after' | 'target'>,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  if (!card.verifyUrl) {
    return {
      verified: false,
      found: null,
      attempts: 0,
      detail: 'This change has no page to check, so it cannot be verified automatically.',
    };
  }
  return verifyChange(card.verifyUrl, change.field, change.after, change.target, opts);
}

/** Render a card as plain text, for copying into an email or a ticket. */
export function cardToText(card: ManualCard): string {
  const lines: string[] = [card.title, '='.repeat(card.title.length), ''];
  if (card.why) lines.push(`Why: ${card.why}`, '');
  if (card.requirement) lines.push(`Requires: ${card.requirement}`, '');

  card.steps.forEach((step, i) => lines.push(`${i + 1}. ${step.text}`));

  if (card.payload) {
    lines.push('', `${card.payload.label}:`, '', card.payload.text, '');
  }
  if (card.expected) lines.push('', `You should see: ${card.expected}`);
  if (card.caveats?.length) {
    lines.push('', 'Watch out for:');
    for (const caveat of card.caveats) lines.push(`  - ${caveat}`);
  }
  return lines.join('\n');
}
