/**
 * Mapping between our SeoMeta shape and Wix's tag array.
 *
 * The rule that governs this file: "Setting tags replaces the item's tags in
 * full, so send the complete set you want the item to have." Every write is
 * therefore read-modify-write, and a merge bug here silently deletes tags the
 * consultant set by hand in the Wix editor.
 */

import type { SeoMeta } from '../../core/types.js';

/** A tag as Wix stores it. */
export interface WixTag {
  type: 'title' | 'meta' | 'link' | 'script';
  props?: Record<string, string>;
  children?: string;
  custom?: boolean;
  disabled?: boolean;
}

export interface ItemSeoTags {
  id: string;
  itemType: string;
  itemId: string;
  tags: WixTag[];
  focusKeywords?: string[];
  hasOverride?: boolean;
  resolvedTags?: Array<{ tag: WixTag; source?: string }>;
}

/**
 * Item types we touch.
 *
 * Item types are identical on every site; a site simply has no items of a type
 * whose business solution is not installed, and listing returns empty. So it
 * is safe to ask for all of them.
 *
 * EVENTS_PAGE is deliberately absent from the writable set: Wix documents
 * reading its tags but says setting them is not supported yet.
 */
export const READABLE_ITEM_TYPES = [
  'STATIC_PAGE',
  'BLOG_POST',
  'STORES_PRODUCT',
  'BOOKINGS_SERVICE',
  'EVENTS_PAGE',
  'PORTFOLIO_PROJECTS',
] as const;

export const WRITABLE_ITEM_TYPES = READABLE_ITEM_TYPES.filter((t) => t !== 'EVENTS_PAGE');

/** Item types that keep a draft separate from the published page. */
export const DRAFTED_ITEM_TYPES = new Set(['STATIC_PAGE']);

export const JSON_LD_SCRIPT_TYPE = 'application/ld+json';

const isMeta = (tag: WixTag, name: string) =>
  tag.type === 'meta' && (tag.props?.name === name || tag.props?.property === name);

const isLink = (tag: WixTag, rel: string) => tag.type === 'link' && tag.props?.rel === rel;

const isJsonLd = (tag: WixTag) => tag.type === 'script' && tag.props?.type === JSON_LD_SCRIPT_TYPE;

/** Read our SeoMeta out of a Wix tag array. */
export function tagsToSeoMeta(tags: WixTag[] = []): SeoMeta {
  const meta: SeoMeta = {};
  for (const tag of tags) {
    if (tag.type === 'title' && tag.children) meta.title = tag.children;
    else if (isMeta(tag, 'description') && tag.props?.content) meta.description = tag.props.content;
    else if (isMeta(tag, 'robots') && tag.props?.content) meta.robots = tag.props.content;
    else if (isMeta(tag, 'og:title') && tag.props?.content) meta.ogTitle = tag.props.content;
    else if (isMeta(tag, 'og:description') && tag.props?.content) meta.ogDescription = tag.props.content;
    else if (isLink(tag, 'canonical') && tag.props?.href) meta.canonical = tag.props.href;
  }
  return meta;
}

/**
 * Merge SeoMeta into an existing tag array, preserving every tag we do not own.
 *
 * Anything the consultant set in the Wix editor that we have no concept of —
 * verification tags, custom meta, Open Graph images — survives untouched.
 */
export function applyMetaToTags(existing: WixTag[] = [], meta: SeoMeta): WixTag[] {
  let tags = [...existing];

  const replace = (match: (t: WixTag) => boolean, next: WixTag) => {
    const index = tags.findIndex(match);
    if (index >= 0) tags[index] = { ...tags[index], ...next };
    else tags.push(next);
  };

  if (meta.title !== undefined) {
    replace((t) => t.type === 'title', { type: 'title', children: meta.title });
  }
  if (meta.description !== undefined) {
    replace((t) => isMeta(t, 'description'), {
      type: 'meta', props: { name: 'description', content: meta.description },
    });
  }
  if (meta.robots !== undefined) {
    replace((t) => isMeta(t, 'robots'), {
      type: 'meta', props: { name: 'robots', content: meta.robots },
    });
  }
  if (meta.ogTitle !== undefined) {
    replace((t) => isMeta(t, 'og:title'), {
      type: 'meta', props: { property: 'og:title', content: meta.ogTitle },
    });
  }
  if (meta.ogDescription !== undefined) {
    replace((t) => isMeta(t, 'og:description'), {
      type: 'meta', props: { property: 'og:description', content: meta.ogDescription },
    });
  }
  if (meta.canonical !== undefined) {
    replace((t) => isLink(t, 'canonical'), {
      type: 'link', props: { rel: 'canonical', href: meta.canonical },
    });
  }

  return tags;
}

/**
 * Replace the JSON-LD blocks in a tag array.
 *
 * Ours replace ours: every existing ld+json script is dropped and the new set
 * written, so re-applying a change does not stack duplicate structured data —
 * which search and answer engines treat as an error.
 */
export function applyJsonLdToTags(existing: WixTag[] = [], jsonLd: object | object[]): WixTag[] {
  const blocks = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
  const kept = existing.filter((t) => !isJsonLd(t));
  return [
    ...kept,
    ...blocks.map((block) => ({
      type: 'script' as const,
      props: { type: JSON_LD_SCRIPT_TYPE },
      children: JSON.stringify(block),
    })),
  ];
}

export function extractJsonLd(tags: WixTag[] = []): object[] {
  const out: object[] = [];
  for (const tag of tags.filter(isJsonLd)) {
    if (!tag.children) continue;
    try { out.push(JSON.parse(tag.children) as object); } catch { /* ignore unparseable */ }
  }
  return out;
}

/**
 * The title Wix will actually render for an item.
 *
 * `tags` holds only an item's own overrides. What renders also depends on the
 * site tags and on patterns, which is what `resolvedTags` reports — so for
 * display we prefer the resolved value and fall back to the override.
 */
export function resolvedTitle(item: ItemSeoTags): string {
  const resolved = item.resolvedTags?.find((r) => r.tag.type === 'title')?.tag.children;
  if (resolved) return resolved;
  return tagsToSeoMeta(item.tags).title ?? item.itemId;
}

/** Compose the composite id Wix uses, e.g. "STATIC_PAGE:c1dmp". */
export function compositeId(itemType: string, itemId: string): string {
  return `${itemType}:${itemId}`;
}

export function parseCompositeId(id: string): { itemType: string; itemId: string } {
  const index = id.indexOf(':');
  if (index < 0) {
    // A bare id is assumed to be a static page, the most common case.
    return { itemType: 'STATIC_PAGE', itemId: id };
  }
  return { itemType: id.slice(0, index), itemId: id.slice(index + 1) };
}
