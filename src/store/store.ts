/**
 * Persistence.
 *
 * A single JSON file, written atomically and serialised through one promise
 * chain. That is enough for a tool that manages one consultant's change queue,
 * and it keeps the whole publishing stage dependency-free and inspectable —
 * you can read the file and see exactly what is stored, which matters when
 * part of what is stored is encrypted credentials.
 *
 * The audit log is append-only: `appendAudit` is the only way in, and nothing
 * in this class removes or rewrites an entry.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuditLogEntry, Change, ChangeStatus, Snapshot } from '../core/types.js';
import { canTransition } from '../core/types.js';
import { log } from '../core/logger.js';
import {
  emptyDatabase, type Batch, type Connection, type Database, type ShareToken, type Site,
} from './types.js';

/** Fields that hold Dates, by collection, so a reload restores real Dates. */
const DATE_FIELDS: Record<keyof Database, string[]> = {
  sites: ['createdAt'],
  connections: ['createdAt', 'lastTestedAt'],
  changes: ['createdAt', 'updatedAt'],
  batches: ['startedAt', 'finishedAt'],
  snapshots: ['takenAt'],
  shareTokens: ['createdAt', 'expiresAt', 'revokedAt'],
  audit: ['at'],
};

export class StateError extends Error {
  constructor(message: string, readonly code = 'STATE') {
    super(message);
    this.name = 'StateError';
  }
}

export class Store {
  private db: Database = emptyDatabase();
  /** Serialises writes so two concurrent requests cannot interleave a save. */
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<Store> {
    const store = new Store(file);
    await store.load();
    return store;
  }

  /** In-memory store for tests. Never touches disk. */
  static ephemeral(): Store {
    return new Store('');
  }

  private async load(): Promise<void> {
    if (!this.file) return;
    try {
      const raw = await readFile(this.file, 'utf8');
      this.db = revive(JSON.parse(raw) as Database);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.db = emptyDatabase();
        return;
      }
      throw err;
    }
  }

  private save(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const snapshot = JSON.stringify(this.db, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      // Write-then-rename: a crash mid-write leaves the previous file intact
      // rather than a truncated one, which for a credential store matters.
      const tmp = join(dirname(this.file), `.${randomUUID()}.tmp`);
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    }).catch((err) => {
      log.error('failed to persist state', { error: err instanceof Error ? err.message : String(err) });
    });
    return this.writing;
  }

  /** Resolves once every queued write has hit disk. */
  async flush(): Promise<void> {
    await this.writing;
  }

  // ------------------------------------------------------------------ sites

  listSites(): Site[] {
    return [...this.db.sites];
  }

  getSite(id: string): Site | undefined {
    return this.db.sites.find((s) => s.id === id);
  }

  requireSite(id: string): Site {
    const site = this.getSite(id);
    if (!site) throw new StateError(`No site ${id}`, 'NOT_FOUND');
    return site;
  }

  async addSite(site: Omit<Site, 'id' | 'createdAt'>): Promise<Site> {
    const created: Site = { ...site, id: `site_${randomUUID().slice(0, 8)}`, createdAt: new Date() };
    this.db.sites.push(created);
    await this.save();
    return created;
  }

  async updateSite(id: string, patch: Partial<Omit<Site, 'id' | 'createdAt'>>): Promise<Site> {
    const site = this.requireSite(id);
    Object.assign(site, patch);
    await this.save();
    return site;
  }

  // ------------------------------------------------------------ connections

  listConnections(siteId: string): Connection[] {
    return this.db.connections.filter((c) => c.siteId === siteId);
  }

  getConnection(id: string): Connection | undefined {
    return this.db.connections.find((c) => c.id === id);
  }

  findConnection(siteId: string, kind: Connection['kind']): Connection | undefined {
    return this.db.connections.find((c) => c.siteId === siteId && c.kind === kind);
  }

  async putConnection(conn: Omit<Connection, 'id' | 'createdAt'>): Promise<Connection> {
    // One connection per kind per site: reconnecting replaces rather than
    // accumulating stale credentials nobody remembers granting.
    const existing = this.findConnection(conn.siteId, conn.kind);
    if (existing) {
      this.db.connections = this.db.connections.filter((c) => c.id !== existing.id);
    }
    const created: Connection = { ...conn, id: `conn_${randomUUID().slice(0, 8)}`, createdAt: new Date() };
    this.db.connections.push(created);
    await this.save();
    return created;
  }

  async updateConnection(id: string, patch: Partial<Connection>): Promise<Connection> {
    const conn = this.getConnection(id);
    if (!conn) throw new StateError(`No connection ${id}`, 'NOT_FOUND');
    Object.assign(conn, patch);
    await this.save();
    return conn;
  }

  /**
   * Delete a connection and its credential.
   *
   * This is what the Disconnect button calls. The sealed blob is dropped with
   * the record, so after this the stored file contains nothing that could be
   * decrypted back into a password or token.
   */
  async deleteConnection(id: string): Promise<boolean> {
    const before = this.db.connections.length;
    this.db.connections = this.db.connections.filter((c) => c.id !== id);
    const removed = this.db.connections.length < before;
    if (removed) await this.save();
    return removed;
  }

  // ---------------------------------------------------------------- changes

  listChanges(siteId: string, status?: ChangeStatus[]): Change[] {
    return this.db.changes.filter(
      (c) => c.siteId === siteId && (!status || status.includes(c.status)),
    );
  }

  getChange(id: string): Change | undefined {
    return this.db.changes.find((c) => c.id === id);
  }

  requireChange(id: string): Change {
    const change = this.getChange(id);
    if (!change) throw new StateError(`No change ${id}`, 'NOT_FOUND');
    return change;
  }

  async addChanges(changes: Array<Omit<Change, 'id' | 'createdAt' | 'updatedAt' | 'status'>>): Promise<Change[]> {
    const now = new Date();
    const created = changes.map((c) => ({
      ...c,
      id: `chg_${randomUUID().slice(0, 8)}`,
      status: 'draft' as ChangeStatus,
      createdAt: now,
      updatedAt: now,
    }));
    this.db.changes.push(...created);
    await this.save();
    return created;
  }

  /**
   * Move a change to a new status, refusing transitions the lifecycle forbids.
   *
   * Every status change in the system goes through here, which is what makes
   * "nothing is applied without approval" a property of the store rather than
   * a convention each call site has to remember.
   */
  async transition(id: string, to: ChangeStatus, patch: Partial<Change> = {}): Promise<Change> {
    const change = this.requireChange(id);
    if (change.status !== to && !canTransition(change.status, to)) {
      throw new StateError(
        `A change that is ${change.status} cannot become ${to}.`,
        'BAD_TRANSITION',
      );
    }
    Object.assign(change, patch, { status: to, updatedAt: new Date() });
    await this.save();
    return change;
  }

  async patchChange(id: string, patch: Partial<Change>): Promise<Change> {
    const change = this.requireChange(id);
    Object.assign(change, patch, { updatedAt: new Date() });
    await this.save();
    return change;
  }

  // --------------------------------------------------------------- batches

  listBatches(siteId: string): Batch[] {
    return this.db.batches
      .filter((b) => b.siteId === siteId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  getBatch(id: string): Batch | undefined {
    return this.db.batches.find((b) => b.id === id);
  }

  async addBatch(batch: Omit<Batch, 'id'>): Promise<Batch> {
    const created: Batch = { ...batch, id: `bat_${randomUUID().slice(0, 8)}` };
    this.db.batches.push(created);
    await this.save();
    return created;
  }

  async updateBatch(id: string, patch: Partial<Batch>): Promise<Batch> {
    const batch = this.getBatch(id);
    if (!batch) throw new StateError(`No batch ${id}`, 'NOT_FOUND');
    Object.assign(batch, patch);
    await this.save();
    return batch;
  }

  // -------------------------------------------------------------- snapshots

  async addSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    this.db.snapshots.push(snapshot);
    await this.save();
    return snapshot;
  }

  getSnapshot(id: string): Snapshot | undefined {
    return this.db.snapshots.find((s) => s.id === id);
  }

  // ------------------------------------------------------------ share links

  async addShareToken(token: Omit<ShareToken, 'id'>): Promise<ShareToken> {
    const created: ShareToken = { ...token, id: `shr_${randomUUID().slice(0, 8)}` };
    this.db.shareTokens.push(created);
    await this.save();
    return created;
  }

  listShareTokens(siteId: string): ShareToken[] {
    return this.db.shareTokens.filter((t) => t.siteId === siteId);
  }

  allShareTokens(): ShareToken[] {
    return [...this.db.shareTokens];
  }

  async updateShareToken(id: string, patch: Partial<ShareToken>): Promise<ShareToken> {
    const token = this.db.shareTokens.find((t) => t.id === id);
    if (!token) throw new StateError(`No share link ${id}`, 'NOT_FOUND');
    Object.assign(token, patch);
    await this.save();
    return token;
  }

  // ------------------------------------------------------------- audit log

  /** The only way to write the audit log. There is deliberately no delete. */
  async appendAudit(entry: Omit<AuditLogEntry, 'id' | 'at'>): Promise<AuditLogEntry> {
    const created: AuditLogEntry = { ...entry, id: `aud_${randomUUID()}`, at: new Date() };
    this.db.audit.push(created);
    await this.save();
    return created;
  }

  listAudit(siteId: string, limit = 500): AuditLogEntry[] {
    return this.db.audit
      .filter((e) => e.siteId === siteId)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit);
  }
}

function revive(raw: Database): Database {
  const db = { ...emptyDatabase(), ...raw };
  for (const [collection, fields] of Object.entries(DATE_FIELDS) as Array<[keyof Database, string[]]>) {
    for (const row of db[collection] as unknown as Array<Record<string, unknown>>) {
      for (const field of fields) {
        const value = row[field];
        if (typeof value === 'string') row[field] = new Date(value);
      }
    }
  }
  return db;
}
