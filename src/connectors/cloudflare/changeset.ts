/**
 * The document the Worker reads from KV.
 *
 * Shared between the connector (which writes it) and the Worker (which applies
 * it). Keeping it small and declarative is what lets changes be updated
 * without redeploying the Worker.
 */

export interface ContentBlock {
  /** CSS selector, as HTMLRewriter understands it. */
  selector: string;
  mode: 'replace' | 'append' | 'prepend' | 'setAttribute' | 'remove';
  html?: string;
  attr?: string;
  value?: string;
}

export interface ChangeSet {
  title?: string;
  metaDescription?: string;
  canonical?: string;
  robots?: string;
  /** Appended to the head and marked, so a later update replaces it. */
  jsonLd?: object | object[];
  blocks?: ContentBlock[];
  /** Bumped on every write; surfaced as the x-aiva-version response header. */
  version: number;
  updatedAt: string;
}

export const KV_KEYS = {
  killSwitch: 'killswitch',
  changeset: (pathname: string) => `changeset:${normalisePath(pathname)}`,
  rootFile: (file: 'robots.txt' | 'llms.txt') => `rootfile:${file}`,
  page: (pathname: string) => `page:${normalisePath(pathname)}`,
} as const;

/** Must match the Worker's own normalisation, or lookups silently miss. */
export function normalisePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/** Path component of a URL, for use as a changeset key. */
export function pathOf(url: string): string {
  try {
    return normalisePath(new URL(url).pathname);
  } catch {
    return normalisePath(url.startsWith('/') ? url : `/${url}`);
  }
}

export function emptyChangeSet(): ChangeSet {
  return { version: 0, updatedAt: new Date(0).toISOString() };
}
