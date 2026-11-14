/**
 * The one interface every platform implements.
 *
 * Connectors declare what they can actually do. Anything unsupported is not an
 * error: the caller falls through to Cloudflare if connected, and otherwise to
 * a manual instruction card. See `resolveRoute`.
 */

import type {
  Change, ChangeField, ConnectorMethod, PageContent, PageRef, Platform, RootFile, SeoMeta, Snapshot,
} from './types.js';
import { UnsupportedOperation } from './errors.js';
import type { ContentBlock } from '../connectors/cloudflare/changeset.js';

/** What a connector supports. Absent or false means "route elsewhere". */
export type Capabilities = Partial<Record<ConnectorMethod, boolean>>;

export interface ConnectionTest {
  ok: boolean;
  platform: Platform;
  /** Human-readable findings, shown in the Connect Website step. */
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
    /** Set when the check failed and there is a concrete thing to do about it. */
    remedy?: string;
  }>;
}

/** A request a connector would send, captured instead of sent, for dry runs. */
export interface PlannedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Plain-language description of the effect, for the dry-run view. */
  describes: string;
}

export interface ApplyResult {
  ok: boolean;
  platformRef?: string;
  snapshotId?: string;
  /** Populated in dry-run mode; empty otherwise. */
  planned?: PlannedRequest[];
  detail?: string;
}

/**
 * What `updatePage` can change.
 *
 * `blocks` is separate from `content` because the two are applied completely
 * differently: `content` replaces a page body at the origin, while `blocks`
 * addresses elements by selector and is normally applied at the edge. A
 * connector that cannot do one may still do the other.
 */
export type PagePatch = Partial<Pick<PageContent, 'title' | 'slug' | 'excerpt' | 'content'>> & {
  blocks?: ContentBlock[];
};

export interface Connector {
  readonly platform: Platform;
  readonly capabilities: Capabilities;
  /** When true, every method records requests instead of sending them. */
  dryRun: boolean;

  testConnection(): Promise<ConnectionTest>;
  listPages(opts?: { limit?: number; cursor?: string }): Promise<{ pages: PageRef[]; cursor?: string }>;
  getPage(id: string): Promise<PageContent>;
  updatePage(id: string, patch: PagePatch): Promise<ApplyResult>;
  createPage(input: { title: string; slug?: string; content: string; status?: 'draft' | 'published' }): Promise<ApplyResult>;
  setSeoMeta(id: string, meta: SeoMeta): Promise<ApplyResult>;
  injectSchema(id: string, jsonLd: object | object[]): Promise<ApplyResult>;
  setRootFile(file: RootFile, content: string): Promise<ApplyResult>;
  snapshot(scope: { pageIds?: string[]; rootFiles?: RootFile[] }): Promise<Snapshot>;
  rollback(snapshot: Snapshot): Promise<ApplyResult>;
}

/** Which connector method a given change field needs. */
export function methodForField(field: ChangeField): ConnectorMethod {
  switch (field) {
    case 'title':
    case 'slug':
    case 'excerpt':
    case 'content_block':
    case 'image_alt':
      return 'updatePage';
    case 'seo_title':
    case 'meta_description':
    case 'canonical':
    case 'robots_meta':
      return 'setSeoMeta';
    case 'json_ld':
      return 'injectSchema';
    case 'robots_txt':
    case 'llms_txt':
      return 'setRootFile';
  }
}

export type Route =
  | { via: 'native'; connector: Connector }
  | { via: 'cloudflare'; connector: Connector; reason: string }
  | { via: 'manual'; reason: string };

/**
 * Decide how a change gets applied.
 *
 * Order is deliberate: the platform's own API first (it survives a CDN change),
 * Cloudflare second (works for anything served over HTTP), manual last.
 */
export function resolveRoute(
  change: Pick<Change, 'field'>,
  primary: Connector,
  cloudflare?: Connector,
): Route {
  const method = methodForField(change.field);
  if (primary.capabilities[method]) return { via: 'native', connector: primary };

  const reason = `${primary.platform} has no API for ${change.field}`;
  if (cloudflare?.capabilities[method]) return { via: 'cloudflare', connector: cloudflare, reason };

  return { via: 'manual', reason: `${reason}, and no Cloudflare zone is connected` };
}

/** Throw from a connector method that the connector does not support. */
export function unsupported(platform: Platform, method: ConnectorMethod, reason: string): never {
  throw new UnsupportedOperation(method, platform, reason);
}

/** Collects planned requests during a dry run. */
export class DryRunRecorder {
  private requests: PlannedRequest[] = [];
  record(req: PlannedRequest): void { this.requests.push(req); }
  drain(): PlannedRequest[] { const r = this.requests; this.requests = []; return r; }
}
