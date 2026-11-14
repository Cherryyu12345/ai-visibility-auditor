/**
 * Records the publishing stage owns, beyond the per-change domain types.
 *
 * Credentials never appear here in the clear: a Connection holds a sealed
 * blob and a `config` map that is, by construction, the non-secret half.
 */

import type { SealedSecret } from '../core/crypto.js';
import type { AuditLogEntry, Change, Platform, Snapshot } from '../core/types.js';

export interface Site {
  id: string;
  name: string;
  /** Origin of the live site. Everything else is relative to this. */
  url: string;
  platform: Platform;
  /** 0–1 from detection; absent when the platform was set by hand. */
  detectionConfidence?: number;
  platformOverridden: boolean;
  createdAt: Date;
}

export type ConnectionKind = 'wordpress' | 'wix' | 'squarespace' | 'cloudflare';

export interface Connection {
  id: string;
  siteId: string;
  kind: ConnectionKind;
  /** Shown in the UI, e.g. "example.com as editor". Never contains a secret. */
  label: string;
  /**
   * Non-secret connection fields: site URL, username, zone id, instance id.
   * Anything that would be damaging to leak belongs in `secret`.
   */
  config: Record<string, string>;
  /** Null for connections that need no credential, such as Squarespace. */
  secret: SealedSecret | null;
  createdAt: Date;
  lastTestedAt?: Date;
  lastTestOk?: boolean;
  /** Serialised ConnectionTest.checks from the last test, for the Connect tab. */
  lastChecks?: Array<{ name: string; ok: boolean; detail: string; remedy?: string }>;
  /** Capabilities as resolved by the last successful test. */
  capabilities?: Record<string, boolean>;
  /**
   * Connector-owned state worked out during the connection test that would
   * otherwise have to be probed again on every apply — for WordPress, how its
   * SEO fields can be written. Opaque here; only the connector reads it.
   */
  resolvedState?: unknown;
}

export type BatchStatus = 'applying' | 'done' | 'partial' | 'failed' | 'rolled_back';

export interface Batch {
  id: string;
  siteId: string;
  changeIds: string[];
  dryRun: boolean;
  status: BatchStatus;
  startedAt: Date;
  finishedAt?: Date;
  startedBy: string;
  /** Snapshot taken for the whole batch, so one click undoes all of it. */
  snapshotIds: string[];
  summary?: string;
}

/**
 * A link that lets a consultant approve changes without an account.
 *
 * Deliberately narrow: one batch of changes, approve or reject only, expiring.
 * It can never apply anything — applying stays with the account holder, so a
 * leaked link cannot touch a live site.
 */
export interface ShareToken {
  id: string;
  siteId: string;
  changeIds: string[];
  /** SHA-256 of the token. The token itself is shown once and never stored. */
  tokenHash: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  /** Name the recipient typed, recorded against each approval they make. */
  usedBy?: string;
}

export interface Database {
  sites: Site[];
  connections: Connection[];
  changes: Change[];
  batches: Batch[];
  snapshots: Snapshot[];
  shareTokens: ShareToken[];
  audit: AuditLogEntry[];
}

export function emptyDatabase(): Database {
  return {
    sites: [], connections: [], changes: [],
    batches: [], snapshots: [], shareTokens: [], audit: [],
  };
}
