/**
 * Manual instruction cards for platforms that have no card generator of
 * their own.
 *
 * Squarespace has researched, click-by-click cards in its own connector. This
 * is the fallback for every other case: a WordPress site whose SEO plugin
 * refuses REST writes, a Wix page type that is read-only, an unknown platform.
 *
 * These cards are deliberately less specific than Squarespace's, because we
 * have not verified the admin UI of whatever is on the other end. They say
 * what to change and give the exact text, and they do not invent click paths
 * we cannot stand behind.
 */

import type { ManualCard } from '../core/manual.js';
import type { Change, ChangeField, Platform } from '../core/types.js';

const FIELD_NAMES: Record<ChangeField, string> = {
  title: 'page title',
  seo_title: 'SEO title',
  meta_description: 'meta description',
  canonical: 'canonical URL',
  robots_meta: 'robots meta tag',
  slug: 'URL slug',
  excerpt: 'excerpt',
  image_alt: 'image alt text',
  content_block: 'section of page content',
  json_ld: 'JSON-LD structured data',
  robots_txt: 'robots.txt file',
  llms_txt: 'llms.txt file',
};

/** Where in a typical admin this field lives, stated as a hint, not a fact. */
const WHERE: Partial<Record<ChangeField, string>> = {
  seo_title: 'the page’s SEO or metadata settings',
  meta_description: 'the page’s SEO or metadata settings',
  canonical: 'the page’s advanced SEO settings',
  robots_meta: 'the page’s indexing or visibility settings',
  json_ld: 'the page’s custom-code or header-injection setting',
  image_alt: 'the media library entry for the image, or the image block in the editor',
};

export function genericCard(
  change: Pick<Change, 'id' | 'field' | 'page' | 'before' | 'after' | 'reason'> & { target?: string },
  platform: Platform,
  reason: string,
): ManualCard {
  const name = FIELD_NAMES[change.field];
  const isRootFile = change.field === 'robots_txt' || change.field === 'llms_txt';

  const steps = isRootFile
    ? [
        { text: `Open the ${change.field === 'robots_txt' ? 'robots.txt' : 'llms.txt'} file at the root of the site.` },
        { text: 'Replace its contents with the text below.', pastesPayload: true },
        { text: 'Save, then confirm the file is served over HTTPS at the path shown.' },
      ]
    : [
        { text: `Open ${change.page} in the site’s editor.` },
        { text: `Find ${WHERE[change.field] ?? `the ${name} field`}.` },
        ...(change.target ? [{ text: `The change applies to: ${change.target}` }] : []),
        { text: `Replace the ${name} with the text below.`, pastesPayload: true },
        { text: 'Save and publish the page.' },
      ];

  const caveats = [
    'Publish the page — a saved draft is invisible to the crawlers this change is for.',
    'If the site has a cache or CDN, clear it before pressing Mark done.',
  ];
  if (change.before) caveats.push(`The current value is: ${truncate(change.before, 120)}`);

  return {
    changeId: change.id,
    platform,
    field: change.field,
    title: `Set the ${name}${isRootFile ? '' : ` on ${pathOf(change.page)}`}`,
    why: change.reason,
    steps,
    payload: { label: `New ${name}`, text: change.after },
    expected: isRootFile
      ? `The file at ${change.page} contains the text above.`
      : `The ${name} on ${pathOf(change.page)} reads exactly as above.`,
    caveats: [`This is a manual step because ${reason}.`, ...caveats],
    verifyUrl: change.page,
  };
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
