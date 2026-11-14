/**
 * Core domain types for the publishing stage.
 *
 * A Change is the single unit of work: one field, on one page, on one site.
 * Nothing reaches a live site except by applying an approved Change, and
 * nothing is marked `verified` except by re-fetching the page and seeing it.
 */

export type Platform = 'wordpress' | 'wix' | 'squarespace' | 'custom' | 'unknown';

/**
 * Lifecycle of a change. Transitions are enforced in `canTransition` below;
 * the status is never set directly by a connector.
 */
export type ChangeStatus =
  | 'draft'
  | 'approved'
  | 'applied'
  | 'verified'
  | 'failed'
  | 'rolled_back';

/** Which part of a page a change touches. Drives routing to a connector method. */
export type ChangeField =
  | 'title'              // <title> / post title
  | 'meta_description'
  | 'seo_title'          // SEO plugin title template, distinct from post title
  | 'canonical'
  | 'robots_meta'
  | 'slug'
  | 'excerpt'
  | 'image_alt'
  | 'content_block'      // a selector-addressed block of body content
  | 'json_ld'
  | 'robots_txt'
  | 'llms_txt';

export interface Change {
  id: string;
  siteId: string;
  /** Absolute URL of the page this change applies to. Root files use the origin. */
  page: string;
  field: ChangeField;
  /** For image_alt and content_block: which element. CSS selector or media ID. */
  target?: string;
  before: string | null;
  after: string;
  /** Why the auditor proposed this. Shown to the consultant on the approval screen. */
  reason: string;
  status: ChangeStatus;
  /** Set once applied, so rollback knows what to undo and how. */
  appliedVia?: ConnectorMethod;
  /** Platform-native identifier resolved at apply time (post ID, item ID, …). */
  platformRef?: string;
  snapshotId?: string;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ConnectorMethod =
  | 'testConnection'
  | 'listPages'
  | 'getPage'
  | 'updatePage'
  | 'createPage'
  | 'setSeoMeta'
  | 'injectSchema'
  | 'setRootFile'
  | 'snapshot'
  | 'rollback';

const TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  draft: ['approved', 'failed'],
  approved: ['applied', 'failed', 'draft'],
  applied: ['verified', 'failed', 'rolled_back'],
  verified: ['rolled_back'],
  failed: ['draft', 'approved'],
  rolled_back: ['draft'],
};

export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** A page as any connector reports it. Connectors map their native shape onto this. */
export interface PageRef {
  /** Platform-native ID. */
  id: string;
  url: string;
  title: string;
  /** 'page' | 'post' | platform-specific collection name. */
  type: string;
  status: 'published' | 'draft' | 'private' | 'unknown';
  modifiedAt?: Date;
}

export interface PageContent extends PageRef {
  slug: string;
  excerpt?: string;
  /** Raw stored content. May be builder data rather than HTML — see `contentIsBuilderData`. */
  content: string;
  /**
   * True when the body lives in page-builder data (Elementor, Divi, WPBakery).
   * When true the content field must NOT be written: doing so silently detaches
   * the builder layout. Callers route such changes elsewhere.
   */
  contentIsBuilderData: boolean;
  builder?: string;
  seo?: SeoMeta;
}

export interface SeoMeta {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  ogTitle?: string;
  ogDescription?: string;
}

export interface Snapshot {
  id: string;
  siteId: string;
  changeId?: string;
  batchId?: string;
  /** Opaque, connector-owned. Must contain everything rollback needs. */
  payload: unknown;
  takenAt: Date;
}

export type RootFile = 'robots.txt' | 'llms.txt';

export interface AuditLogEntry {
  id: string;
  siteId: string;
  changeId?: string;
  batchId?: string;
  action: string;
  /** Who did it: user ID, or `share:<token-id>` for share-link approvals. */
  actor: string;
  detail?: Record<string, unknown>;
  at: Date;
}
