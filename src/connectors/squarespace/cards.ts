/**
 * Squarespace manual instruction cards.
 *
 * Every click path here is taken from Squarespace's own help centre, checked
 * in November 2026, not from memory — these are instructions a consultant
 * follows literally, so a stale panel name wastes their time and ours.
 *
 * Sources, with the dates the articles were last updated:
 *   - Adding SEO descriptions (10 Sep 2026)
 *   - Change how page titles appear in search engines… (8 Oct 2026)
 *   - Customize parts of your site with code injection (16 Sep 2026)
 *   - Create an llms.txt file (22 Jul 2026)
 *   - Request that AI models exclude your site
 */

import type { ManualCard } from '../../core/manual.js';
import type { Change, ChangeField } from '../../core/types.js';

export type SiteVersion = '7.1' | '7.0' | 'unknown';

export type ItemKind = 'page' | 'homepage' | 'blog-post' | 'product' | 'event' | 'portfolio-item';

export interface CardContext {
  siteVersion: SiteVersion;
  itemKind: ItemKind;
  /** Live URL, used for verification after the consultant marks it done. */
  pageUrl?: string;
}

/** Code injection is plan-gated; so is nothing else we use. */
const CODE_INJECTION_PLANS = 'a Core, Plus, Advanced or legacy Squarespace plan';

/**
 * Open the settings panel for whichever kind of item this is.
 * Squarespace's route differs per collection type, and getting it wrong sends
 * people hunting through a panel that does not have the field.
 */
function openItemSettings(kind: ItemKind): string[] {
  switch (kind) {
    case 'blog-post':
      return [
        'Open the Pages panel and click the blog page.',
        'Hover over the post and click Edit. On 7.1, then click the gear icon in the top-right corner.',
      ];
    case 'product':
      return ['Open the Pages panel and click the store page.', 'Double-click the product.'];
    case 'event':
      return [
        'Open the Pages panel and click the calendar page.',
        'Hover over the event and click Edit. On 7.1, then click the gear icon in the top-right corner.',
      ];
    case 'portfolio-item':
      return [
        'Open the Pages panel and click the portfolio page.',
        'Click the ... button on the sub-page, then click Settings.',
      ];
    case 'page':
    default:
      return [
        'Open the Pages panel.',
        'Hover over the page title and click the gear icon to open page settings.',
      ];
  }
}

/**
 * Build the card for a change, or return null when Squarespace genuinely
 * cannot do it — in which case routing sends it to Cloudflare instead of
 * handing someone an impossible instruction.
 */
export function squarespaceCard(
  change: Pick<Change, 'field' | 'after' | 'before' | 'reason' | 'page' | 'target' | 'id'>,
  ctx: CardContext,
): ManualCard | null {
  const base = {
    changeId: change.id,
    platform: 'squarespace' as const,
    field: change.field,
    why: change.reason,
    ...(ctx.pageUrl ? { verifyUrl: ctx.pageUrl } : {}),
  };

  switch (change.field) {
    // ---------------------------------------------------------------- titles
    case 'title':
    case 'seo_title': {
      if (ctx.itemKind === 'homepage') {
        return {
          ...base,
          title: 'Set the homepage SEO title format',
          steps: [
            { text: 'Open the SEO/AI Visibility panel and click SEO Settings. On version 7.0, open the SEO Appearance panel instead.' },
            { text: 'In the Search Appearance area, click the Home tab.' },
            { text: 'Edit the SEO Title Format field.', pastesPayload: true },
            { text: 'Click Save.' },
          ],
          payload: { label: 'Title format to use', text: change.after },
          expected: 'The browser tab for your homepage shows the new title.',
          caveats: [
            'The homepage title is a format, not plain text. %s inserts your site title and ' +
              '| adds custom text after it.',
          ],
        };
      }
      return {
        ...base,
        title: `Set the SEO title for ${prettyPage(change.page)}`,
        steps: [
          ...openItemSettings(ctx.itemKind).map((text) => ({ text })),
          { text: 'Click the SEO tab.' },
          { text: 'Enter the new text in the SEO Title field.', pastesPayload: true },
          { text: 'Click Save.' },
        ],
        payload: { label: 'SEO title', text: change.after },
        expected: `The browser tab shows "${change.after}" followed by your site title.`,
        caveats: [
          'Squarespace builds the tab title from a format. The default is ' +
            '"Page SEO Title — Site Title", so your site name will be appended automatically. ' +
            'Do not type it yourself.',
        ],
      };
    }

    // ----------------------------------------------------------- description
    case 'meta_description': {
      if (ctx.itemKind === 'homepage') {
        return {
          ...base,
          title: 'Set the SEO site description (homepage)',
          steps: [
            { text: 'Open the SEO/AI Visibility panel and click SEO Settings. On version 7.0, open the SEO Appearance panel instead.' },
            { text: 'In the Search Appearance area, click the Home tab.' },
            { text: 'Edit the SEO Site Description field.', pastesPayload: true },
            { text: 'Click Save.' },
          ],
          payload: { label: 'SEO site description', text: change.after },
          expected: 'The homepage source shows the new meta description.',
          caveats: descriptionCaveats(change.after),
        };
      }
      return {
        ...base,
        title: `Set the SEO description for ${prettyPage(change.page)}`,
        steps: [
          ...openItemSettings(ctx.itemKind).map((text) => ({ text })),
          { text: 'Click the SEO tab.' },
          { text: 'Enter the new text in the SEO Description field.', pastesPayload: true },
          { text: 'Click Save.' },
        ],
        payload: { label: 'SEO description', text: change.after },
        expected: 'The page source shows the new meta description.',
        caveats: descriptionCaveats(change.after),
      };
    }

    // --------------------------------------------------------------- JSON-LD
    case 'json_ld': {
      const perPage = ctx.itemKind !== 'homepage';
      return {
        ...base,
        title: perPage
          ? `Add structured data to ${prettyPage(change.page)}`
          : 'Add site-wide structured data',
        requirement: `Code injection requires ${CODE_INJECTION_PLANS}.`,
        steps: perPage
          ? [
              ...openItemSettings(ctx.itemKind).map((text) => ({ text })),
              { text: 'Click the Advanced tab.' },
              { text: 'Paste the snippet into Page Header Code Injection.', pastesPayload: true },
              { text: 'Click Save.' },
            ]
          : [
              { text: 'Open the Code Injection panel (Settings → Advanced → Code Injection).' },
              { text: 'Paste the snippet into the Header field, below anything already there.', pastesPayload: true },
              { text: 'Click Save.' },
            ],
        payload: {
          label: 'Paste this exactly, including the script tags',
          text: `<script type="application/ld+json">\n${formatJsonLd(change.after)}\n</script>`,
        },
        expected: 'Viewing the page source shows the ld+json block inside <head>.',
        caveats: [
          ...(perPage
            ? [
                'Squarespace warns against putting HTML in Page Header Code Injection on 7.1: ' +
                  'it disappears if you later turn off the header\'s transparency. If this schema ' +
                  'applies to the whole site, use the site-wide Header field instead — or apply it ' +
                  'through Cloudflare, which is not affected.',
              ]
            : []),
          'Checkout pages do not support code injection.',
          'Paste below any existing code rather than replacing it.',
        ],
      };
    }

    // -------------------------------------------------------------- llms.txt
    case 'llms_txt': {
      if (ctx.siteVersion === '7.0') return null; // 7.1 only; route to Cloudflare.
      return {
        ...base,
        title: 'Create or update llms.txt',
        requirement: 'Available on Squarespace version 7.1 only.',
        steps: [
          { text: 'Open the SEO/AI Visibility panel.' },
          { text: 'Click SEO Settings, then click the LLMS.txt tab.' },
          { text: 'Paste the text into the field. The file is disabled until it has content.', pastesPayload: true },
          { text: 'Click Save.' },
        ],
        payload: { label: 'llms.txt contents', text: change.after },
        expected: 'yoursite.com/llms.txt returns this text.',
        caveats: ['To turn it off again, use Delete on the same tab, then Save.'],
        ...(base.verifyUrl ? { verifyUrl: rootUrl(change.page, 'llms.txt') } : {}),
      };
    }

    // ------------------------------------------------------------ robots.txt
    case 'robots_txt': {
      // Not a card: Squarespace serves one shared robots.txt that users cannot
      // edit. Offering steps would be a lie. The only lever is the Crawlers
      // panel, which is a different change entirely.
      return null;
    }

    // ------------------------------------------------------------ noindex
    case 'robots_meta': {
      const wantsNoindex = /noindex/i.test(change.after);
      if (!wantsNoindex) return null; // Only the noindex direction has a control.
      return {
        ...base,
        title: `Hide ${prettyPage(change.page)} from search engines`,
        steps: [
          ...openItemSettings(ctx.itemKind).map((text) => ({ text })),
          { text: 'Click the SEO tab.' },
          { text: 'Switch on "Hide this page from search engines".' },
          { text: 'Click Save.' },
        ],
        expected: 'The page source shows a robots meta tag containing noindex.',
        caveats: [
          'This is the only robots directive Squarespace exposes per page. Anything more specific ' +
            'has to go through Cloudflare.',
        ],
      };
    }

    // ----------------------------------------------------------- image alt
    case 'image_alt': {
      return {
        ...base,
        title: `Set image alt text on ${prettyPage(change.page)}`,
        steps: [
          { text: 'Open the page in the editor.' },
          { text: `Click the image${change.target ? ` matching ${change.target}` : ''}, then click the pencil icon to edit it.` },
          { text: 'Open the Design or Image tab and find the alt text field.' },
          { text: 'Enter the alt text.', pastesPayload: true },
          { text: 'Click Apply, then Save.' },
        ],
        payload: { label: 'Alt text', text: change.after },
        expected: 'The image tag in the page source carries the new alt attribute.',
        caveats: [
          'Squarespace reuses the filename as alt text when the field is empty, which is why this ' +
            'is worth setting explicitly.',
        ],
      };
    }

    // ---------------------------------------------------------------- slug
    case 'slug': {
      return {
        ...base,
        title: `Change the URL slug for ${prettyPage(change.page)}`,
        steps: [
          ...openItemSettings(ctx.itemKind).map((text) => ({ text })),
          { text: 'On the General tab, edit the URL Slug field.', pastesPayload: true },
          { text: 'Click Save.' },
        ],
        payload: { label: 'New slug', text: change.after },
        expected: 'The page loads at the new URL.',
        caveats: [
          'Changing a slug breaks every existing link to the page. Add a URL redirect from the old ' +
            'path in Settings → Developer Tools → URL Mappings before you save.',
        ],
      };
    }

    // ------------------------------------------------------------- content
    case 'content_block':
    case 'excerpt': {
      return {
        ...base,
        title: `Update content on ${prettyPage(change.page)}`,
        steps: [
          { text: 'Open the page in the editor.' },
          { text: change.target ? `Find the section matching ${change.target}.` : 'Find the block to change.' },
          { text: 'Replace the text with the wording below.', pastesPayload: true },
          { text: 'Click Save.' },
        ],
        payload: { label: 'New text', text: change.after },
        expected: 'The new wording appears on the live page.',
      };
    }

    // ------------------------------------------------------------- canonical
    case 'canonical':
      // Squarespace manages canonicals itself and exposes no field for them.
      return null;
  }
}

/**
 * The AI-crawler toggle, which is the only part of Squarespace's robots.txt a
 * site owner can influence. Offered on its own rather than as a robots.txt
 * change, because it does something much narrower than it sounds like.
 */
export function crawlerToggleCard(allow: boolean, reason: string): ManualCard {
  return {
    platform: 'squarespace',
    field: 'robots_txt',
    title: allow ? 'Allow AI crawlers to read the site' : 'Block known AI crawlers',
    why: reason,
    steps: [
      { text: 'Open Settings, then click Crawlers.' },
      {
        text: allow
          ? 'Uncheck "Block known artificial intelligence crawlers".'
          : 'Check "Block known artificial intelligence crawlers".',
      },
      { text: 'Save.' },
    ],
    expected: allow
      ? 'yoursite.com/robots.txt no longer lists GPTBot, ClaudeBot, CCBot or Google-Extended as disallowed.'
      : 'yoursite.com/robots.txt disallows those crawlers.',
    caveats: [
      'This checkbox is all-or-nothing: you cannot allow some AI crawlers and block others.',
      'Every Squarespace site shares one robots.txt file, and it cannot be edited directly. ' +
        'A custom robots.txt needs the domain proxied through Cloudflare.',
      'Blocking does not remove anything already scraped.',
    ],
  };
}

function descriptionCaveats(text: string): string[] {
  const caveats = [
    'Squarespace limits SEO descriptions to 400 characters. Aim for 50–300; search engines cut ' +
      'them off around 160.',
  ];
  if (text.length > 400) {
    caveats.unshift(
      `This text is ${text.length} characters and will be rejected. Shorten it to 400 or fewer.`,
    );
  }
  return caveats;
}

function formatJsonLd(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function prettyPage(page: string): string {
  try {
    const path = new URL(page).pathname;
    return path === '/' ? 'the homepage' : path;
  } catch {
    return page;
  }
}

function rootUrl(page: string, file: string): string {
  try {
    return new URL(`/${file}`, page).toString();
  } catch {
    return `/${file}`;
  }
}

/** Fields Squarespace simply cannot do, whatever the plan. */
export const IMPOSSIBLE_FIELDS: ChangeField[] = ['canonical', 'robots_txt'];
