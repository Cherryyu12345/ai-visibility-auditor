/**
 * The publishing engine.
 *
 * Everything the UI does to a live site goes through here, which is where the
 * three rules in the brief are actually enforced:
 *
 *   1. Nothing is applied without approval — `apply` only ever looks at
 *      changes whose stored status is `approved`.
 *   2. Nothing is verified on trust — a change becomes `verified` only after
 *      `verifyChange` re-fetches the page as a crawler and sees it.
 *   3. Everything is recorded — each mutation appends to the append-only
 *      audit log with the actor who caused it.
 */

import {
  methodForField, resolveRoute,
  type ApplyResult, type Connector, type PlannedRequest, type Route,
} from '../core/connector.js';
import { UnsupportedOperation } from '../core/errors.js';
import { log } from '../core/logger.js';
import { markDone, type ManualCard } from '../core/manual.js';
import type { Change, ChangeField, PageRef, RootFile, SeoMeta, Snapshot } from '../core/types.js';
import { verifyChange, verifyRollback, type VerifyOptions, type VerifyResult } from '../core/verify.js';
import { SquarespaceConnector } from '../connectors/squarespace/index.js';
import type { ContentBlock } from '../connectors/cloudflare/changeset.js';
import { Store, StateError } from '../store/store.js';
import type { Batch, Site } from '../store/types.js';
import { buildConnector, primaryKindFor } from './registry.js';
import { genericCard } from './cards.js';

export interface EngineOptions {
  fetchImpl?: typeof fetch;
  /** Shortened in tests so verification does not add real seconds. */
  verifyOptions?: VerifyOptions;
  /**
   * Overrides how a stored connection becomes a live connector.
   *
   * Exists so tests can drive the engine with a connector they control. In
   * production this is always `buildConnector`, which is the only place a
   * credential is ever unsealed.
   */
  connectorFactory?: typeof buildConnector;
}

export interface RoutePlan {
  changeId: string;
  via: Route['via'];
  /** Which connector would do it, for the UI. */
  connector?: string;
  method: string;
  reason?: string;
  card?: ManualCard;
}

export interface ChangeOutcome {
  changeId: string;
  via: Route['via'];
  ok: boolean;
  status: Change['status'];
  detail?: string;
  verify?: VerifyResult;
  planned?: PlannedRequest[];
  card?: ManualCard;
}

export interface ApplyReport {
  batchId?: string;
  dryRun: boolean;
  outcomes: ChangeOutcome[];
  summary: string;
}

interface Connectors {
  primary?: Connector;
  cloudflare?: Connector;
}

export class Engine {
  constructor(
    private readonly store: Store,
    private readonly opts: EngineOptions = {},
  ) {}

  // ------------------------------------------------------------- approvals

  async approve(changeId: string, actor: string): Promise<Change> {
    const change = await this.store.transition(changeId, 'approved');
    await this.store.appendAudit({
      siteId: change.siteId, changeId, actor, action: 'approve',
      detail: { field: change.field, page: change.page },
    });
    return change;
  }

  /**
   * Reject a change.
   *
   * Rejection returns it to `draft` rather than deleting it: the audit log has
   * to be able to show that this change was proposed and turned down, and by
   * whom.
   */
  async reject(changeId: string, actor: string, note?: string): Promise<Change> {
    const change = await this.store.transition(changeId, 'draft', {
      ...(note ? { failureReason: note } : {}),
    });
    await this.store.appendAudit({
      siteId: change.siteId, changeId, actor, action: 'reject',
      detail: { field: change.field, page: change.page, ...(note ? { note } : {}) },
    });
    return change;
  }

  /** Approve every draft change on a site, or a named subset of them. */
  async approveAll(siteId: string, actor: string, only?: string[]): Promise<Change[]> {
    const drafts = this.store.listChanges(siteId, ['draft'])
      .filter((c) => !only || only.includes(c.id));
    const approved: Change[] = [];
    for (const change of drafts) approved.push(await this.approve(change.id, actor));

    await this.store.appendAudit({
      siteId, actor, action: 'approve_all', detail: { count: approved.length },
    });
    return approved;
  }

  // ------------------------------------------------------------------ plan

  /**
   * What would happen to each change, without doing any of it.
   *
   * Drafts are included, not just approved ones: whether a change will be
   * applied by an API or handed to a human is exactly the sort of thing that
   * changes whether someone approves it, so it has to be visible before the
   * decision rather than after.
   *
   * This is the cheap, offline half of dry run: route resolution and card
   * generation only, no requests at all.
   */
  async plan(siteId: string): Promise<RoutePlan[]> {
    const site = this.store.requireSite(siteId);
    const connectors = this.connectorsFor(site, false);
    const changes = this.store.listChanges(siteId, ['draft', 'approved']);

    return changes.map((change) => {
      const route = resolveRoute(change, connectors.primary ?? stub(site), connectors.cloudflare);
      const plan: RoutePlan = {
        changeId: change.id,
        via: route.via,
        method: methodForField(change.field),
        ...(route.via !== 'manual' ? { connector: route.connector.platform } : {}),
        ...(route.via !== 'native' ? { reason: route.reason } : {}),
      };
      if (route.via === 'manual') plan.card = this.cardFor(change, connectors);
      return plan;
    });
  }

  // ----------------------------------------------------------------- apply

  /**
   * Apply every approved change on a site.
   *
   * In dry-run mode no change's status moves and nothing is sent: connectors
   * record the requests they would have made and those are returned instead.
   */
  async apply(siteId: string, actor: string, dryRun = false): Promise<ApplyReport> {
    const site = this.store.requireSite(siteId);
    const approved = this.store.listChanges(siteId, ['approved']);
    if (approved.length === 0) {
      return { dryRun, outcomes: [], summary: 'No approved changes to apply.' };
    }

    const connectors = this.connectorsFor(site, dryRun);
    const pages = new PageIndex(connectors);

    let batch: Batch | undefined;
    if (!dryRun) {
      batch = await this.store.addBatch({
        siteId, changeIds: approved.map((c) => c.id), dryRun,
        status: 'applying', startedAt: new Date(), startedBy: actor, snapshotIds: [],
      });
      await this.store.appendAudit({
        siteId, batchId: batch.id, actor, action: 'apply_start',
        detail: { count: approved.length },
      });
    }

    const outcomes: ChangeOutcome[] = [];
    for (const change of approved) {
      outcomes.push(await this.applyOne(change, site, connectors, pages, dryRun, actor, batch?.id));
    }

    const summary = summarise(outcomes, dryRun);
    if (batch) {
      const anyFailed = outcomes.some((o) => !o.ok);
      const allFailed = outcomes.every((o) => !o.ok);
      await this.store.updateBatch(batch.id, {
        status: allFailed ? 'failed' : anyFailed ? 'partial' : 'done',
        finishedAt: new Date(),
        snapshotIds: outcomes
          .map((o) => this.store.getChange(o.changeId)?.snapshotId)
          .filter((id): id is string => Boolean(id)),
        summary,
      });
      await this.store.appendAudit({
        siteId, batchId: batch.id, actor, action: 'apply_finish', detail: { summary },
      });
    }

    return { ...(batch ? { batchId: batch.id } : {}), dryRun, outcomes, summary };
  }

  private async applyOne(
    change: Change,
    site: Site,
    connectors: Connectors,
    pages: PageIndex,
    dryRun: boolean,
    actor: string,
    batchId?: string,
  ): Promise<ChangeOutcome> {
    const routes = candidateRoutes(change, connectors, site);

    for (const route of routes) {
      if (route.via === 'manual') {
        const card = this.cardFor(change, connectors, route.reason);
        if (!dryRun) {
          await this.store.appendAudit({
            siteId: site.id, changeId: change.id, actor, action: 'routed_manual',
            ...(batchId ? { batchId } : {}),
            detail: { reason: route.reason },
          });
        }
        // Deliberately left `approved`: a manual change has not been applied,
        // and saying otherwise would put a lie in the history.
        return {
          changeId: change.id, via: 'manual', ok: true, status: change.status,
          detail: route.reason, card,
        };
      }

      const connector = route.connector;
      try {
        const pageId = await pages.resolve(connector, change, site);
        let snapshot: Snapshot | undefined;
        if (!dryRun) {
          snapshot = await this.takeSnapshot(connector, change, pageId, site);
        }

        const result = await callConnector(connector, change, pageId);
        const planned = plannedFrom(connector, result);

        if (dryRun) {
          return {
            changeId: change.id, via: route.via, ok: true, status: change.status,
            planned,
            detail: result.detail ?? `Would call ${methodForField(change.field)} via ${connector.platform}.`,
          };
        }

        await this.store.transition(change.id, 'applied', {
          appliedVia: methodForField(change.field),
          ...(result.platformRef ? { platformRef: result.platformRef } : {}),
          ...(snapshot ? { snapshotId: snapshot.id } : {}),
        });
        await this.store.appendAudit({
          siteId: site.id, changeId: change.id, actor, action: 'applied',
          ...(batchId ? { batchId } : {}),
          detail: { via: route.via, connector: connector.platform, field: change.field },
        });

        const verify = await this.verify(change);
        const final = await this.store.transition(
          change.id,
          verify.verified ? 'verified' : 'failed',
          verify.verified ? {} : { failureReason: unverifiedMessage(verify) },
        );
        await this.store.appendAudit({
          siteId: site.id, changeId: change.id, actor,
          action: verify.verified ? 'verified' : 'verify_failed',
          ...(batchId ? { batchId } : {}),
          detail: { found: verify.found, attempts: verify.attempts },
        });

        return {
          changeId: change.id, via: route.via, ok: verify.verified, status: final.status,
          verify,
          ...(verify.verified ? {} : { detail: unverifiedMessage(verify) }),
        };
      } catch (err) {
        // A connector that declares a capability can still refuse a specific
        // change — WordPress will not touch builder-owned content, Wix will
        // not move a slug. That is the same signal as a missing capability,
        // only later, so it falls through the chain rather than failing.
        if (err instanceof UnsupportedOperation) {
          log.info('route refused the change, falling through', {
            changeId: change.id, via: route.via, reason: err.message,
          });
          continue;
        }

        const detail = err instanceof Error ? err.message : String(err);
        if (!dryRun) {
          await this.store.transition(change.id, 'failed', { failureReason: detail });
          await this.store.appendAudit({
            siteId: site.id, changeId: change.id, actor, action: 'apply_failed',
            ...(batchId ? { batchId } : {}),
            detail: { via: route.via, error: detail },
          });
        }
        return { changeId: change.id, via: route.via, ok: false, status: 'failed', detail };
      }
    }

    return {
      changeId: change.id, via: 'manual', ok: false, status: change.status,
      detail: 'No route could apply this change.',
    };
  }

  // -------------------------------------------------------------- manual

  /**
   * Record a manual change as done — but only if the page says it is.
   *
   * This re-fetches the live page and returns `verified: false` with what it
   * actually found when the change is not there, rather than taking the
   * consultant's word for it.
   */
  async markManualDone(changeId: string, actor: string): Promise<{ verify: VerifyResult; change: Change }> {
    const change = this.store.requireChange(changeId);
    if (change.status !== 'approved') {
      throw new StateError(
        `This change is ${change.status}. Only an approved change can be marked done.`,
        'NOT_APPROVED',
      );
    }
    const site = this.store.requireSite(change.siteId);
    const connectors = this.connectorsFor(site, false);
    const card = this.cardFor(change, connectors);

    const verify = await markDone(card, change, this.opts.verifyOptions ?? {});

    let updated = change;
    if (verify.verified) {
      // Straight to verified through applied, so the history shows both: a
      // human applied it, and we confirmed it.
      await this.store.transition(changeId, 'applied', { appliedVia: methodForField(change.field) });
      updated = await this.store.transition(changeId, 'verified');
    }
    await this.store.appendAudit({
      siteId: change.siteId, changeId, actor,
      action: verify.verified ? 'manual_verified' : 'manual_not_visible',
      detail: { found: verify.found, expected: change.after },
    });
    return { verify, change: updated };
  }

  /** The instruction card for a change, whoever has to carry it out. */
  cardFor(change: Change, connectors?: Connectors, reason?: string): ManualCard {
    const site = this.store.requireSite(change.siteId);
    const resolved = connectors ?? this.connectorsFor(site, false);
    const primary = resolved.primary;

    if (primary instanceof SquarespaceConnector) {
      const card = primary.manualCard(change);
      if (card) return card;
    }
    return genericCard(
      change, site.platform,
      reason ?? `${site.platform} has no API for ${change.field}`,
    );
  }

  // -------------------------------------------------------------- rollback

  async rollbackChange(changeId: string, actor: string): Promise<ChangeOutcome> {
    const change = this.store.requireChange(changeId);
    const site = this.store.requireSite(change.siteId);

    if (!change.snapshotId) {
      throw new StateError(
        'There is no snapshot for this change, so it cannot be rolled back automatically.',
        'NO_SNAPSHOT',
      );
    }
    const snapshot = this.store.getSnapshot(change.snapshotId);
    if (!snapshot) throw new StateError('The snapshot for this change is missing.', 'NO_SNAPSHOT');

    const connectors = this.connectorsFor(site, false);
    const connector = connectorForSnapshot(snapshot, connectors);
    if (!connector) {
      throw new StateError(
        'The connector that applied this change is no longer connected, so it cannot undo it.',
        'NOT_CONNECTED',
      );
    }

    try {
      // The stored snapshot is tagged with which connector took it; the
      // connector itself only understands its own payload, so unwrap before
      // handing it back.
      await connector.rollback(unwrapSnapshot(snapshot));

      // And then check. A connector reporting a successful rollback is not
      // evidence that anything was restored — a snapshot whose shape it did
      // not recognise would have it loop over nothing and return success.
      const verify = await this.verifyUndone(change);
      if (!verify.verified) {
        await this.store.appendAudit({
          siteId: site.id, changeId, actor, action: 'rollback_not_visible',
          detail: { found: verify.found, expected: change.before },
        });
        return {
          changeId, via: 'native', ok: false, status: change.status,
          verify,
          detail: `The connector reported a rollback, but the page still reads: ${verify.found ?? '(nothing)'}`,
        };
      }

      const updated = await this.store.transition(changeId, 'rolled_back');
      await this.store.appendAudit({
        siteId: site.id, changeId, actor, action: 'rolled_back',
        detail: { snapshotId: snapshot.id, connector: connector.platform, found: verify.found },
      });
      return { changeId, via: 'native', ok: true, status: updated.status, verify };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.store.appendAudit({
        siteId: site.id, changeId, actor, action: 'rollback_failed', detail: { error: detail },
      });
      return { changeId, via: 'native', ok: false, status: change.status, detail };
    }
  }

  /** Undo a whole batch, newest change first so dependent edits unwind cleanly. */
  async rollbackBatch(batchId: string, actor: string): Promise<ApplyReport> {
    const batch = this.store.getBatch(batchId);
    if (!batch) throw new StateError(`No batch ${batchId}`, 'NOT_FOUND');

    const outcomes: ChangeOutcome[] = [];
    for (const changeId of [...batch.changeIds].reverse()) {
      const change = this.store.getChange(changeId);
      if (!change || !['applied', 'verified', 'failed'].includes(change.status)) continue;
      if (!change.snapshotId) {
        outcomes.push({
          changeId, via: 'manual', ok: false, status: change.status,
          detail: 'No snapshot was taken, so this one has to be undone by hand.',
        });
        continue;
      }
      try {
        outcomes.push(await this.rollbackChange(changeId, actor));
      } catch (err) {
        outcomes.push({
          changeId, via: 'native', ok: false, status: change.status,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = `${outcomes.filter((o) => o.ok).length} of ${outcomes.length} changes rolled back.`;
    await this.store.updateBatch(batchId, {
      status: outcomes.every((o) => o.ok) ? 'rolled_back' : 'partial',
      summary,
    });
    await this.store.appendAudit({
      siteId: batch.siteId, batchId, actor, action: 'rollback_batch', detail: { summary },
    });
    return { batchId, dryRun: false, outcomes, summary };
  }

  // --------------------------------------------------------------- helpers

  /** Live connectors for a site, or none where that kind is not connected. */
  connectorsFor(site: Site, dryRun: boolean): Connectors {
    const build = (kind: ReturnType<typeof primaryKindFor>): Connector | undefined => {
      if (!kind) return undefined;
      const conn = this.store.findConnection(site.id, kind);
      if (!conn) return undefined;
      try {
        const factory = this.opts.connectorFactory ?? buildConnector;
        return factory(conn, site, {
          dryRun,
          ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        });
      } catch (err) {
        log.warn('could not build connector', { kind, error: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    };

    const primary = build(primaryKindFor(site.platform));
    const cloudflare = build('cloudflare');

    // Capabilities WordPress resolves at connect time are stored on the
    // connection; without replaying them a freshly built connector would
    // under-report what it can do and send changes to Cloudflare needlessly.
    const stored = this.store.findConnection(site.id, primaryKindFor(site.platform) ?? 'wordpress');
    if (primary && stored?.capabilities) {
      for (const [method, able] of Object.entries(stored.capabilities)) {
        (primary.capabilities as Record<string, boolean>)[method] = able;
      }
    }
    // Along with how it resolved them. Without this a fresh connector would
    // re-probe the site on every apply; with a stale value it would still be
    // correct, because the connector re-resolves whenever it has none.
    const restorable = primary as { restoreSeoStrategy?: (s: unknown) => void } | undefined;
    if (restorable?.restoreSeoStrategy && stored?.resolvedState) {
      restorable.restoreSeoStrategy(stored.resolvedState);
    }

    return {
      ...(primary ? { primary } : {}),
      ...(cloudflare ? { cloudflare } : {}),
    };
  }

  private async takeSnapshot(
    connector: Connector,
    change: Change,
    pageId: string,
    site: Site,
  ): Promise<Snapshot | undefined> {
    if (!connector.capabilities.snapshot) return undefined;
    try {
      const scope = isRootFileField(change.field)
        ? { rootFiles: [rootFileFor(change.field)] }
        : { pageIds: [pageId] };
      const snapshot = await connector.snapshot(scope);
      // Tag it so rollback can find the right connector later, even if the
      // site has since been reconnected or the primary platform changed.
      const tagged: Snapshot = {
        ...snapshot,
        siteId: site.id,
        changeId: change.id,
        payload: { connector: connector.platform, inner: snapshot.payload },
      };
      await this.store.addSnapshot(tagged);
      return tagged;
    } catch (err) {
      log.warn('snapshot failed; the change will be applied without one', {
        changeId: change.id, error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async verifyUndone(change: Change): Promise<VerifyResult> {
    const opts = this.opts.verifyOptions ?? {};
    const url = isRootFileField(change.field)
      ? new URL(`/${rootFileFor(change.field)}`, change.page).toString()
      : change.page;
    return verifyRollback(url, change.field, change.before, change.after, change.target, opts);
  }

  private async verify(change: Change): Promise<VerifyResult> {
    const opts = this.opts.verifyOptions ?? {};
    const url = isRootFileField(change.field)
      ? new URL(`/${rootFileFor(change.field)}`, change.page).toString()
      : change.page;
    return verifyChange(url, change.field, change.after, change.target, opts);
  }
}

// ------------------------------------------------------------------ routing

/**
 * The ordered list of routes to try, native first.
 *
 * `resolveRoute` answers "what will happen"; this answers "what do we try, and
 * in what order, when the first one refuses". The first entry here is always
 * the same as `resolveRoute`'s answer — there is a test that holds that.
 */
export function candidateRoutes(
  change: Pick<Change, 'field'>,
  connectors: Connectors,
  site: Site,
): Route[] {
  const method = methodForField(change.field);
  const routes: Route[] = [];
  const primaryName = connectors.primary?.platform ?? site.platform;

  if (connectors.primary?.capabilities[method]) {
    routes.push({ via: 'native', connector: connectors.primary });
  }
  const reason = connectors.primary
    ? `${primaryName} has no API for ${change.field}`
    : `no ${primaryName} connection, so there is no API for ${change.field}`;

  if (connectors.cloudflare?.capabilities[method]) {
    routes.push({ via: 'cloudflare', connector: connectors.cloudflare, reason });
  }
  routes.push({
    via: 'manual',
    reason: connectors.cloudflare
      ? `${reason}, and Cloudflare cannot apply it either`
      : `${reason}, and no Cloudflare zone is connected`,
  });
  return routes;
}

/** Stand-in so `resolveRoute` can be used before a primary is connected. */
function stub(site: Site): Connector {
  return { platform: site.platform, capabilities: {}, dryRun: false } as Connector;
}

// ------------------------------------------------------------ field mapping

/** Turn a change into the one connector call that applies it. */
export async function callConnector(
  connector: Connector,
  change: Change,
  pageId: string,
): Promise<ApplyResult> {
  switch (change.field) {
    case 'title':
      return connector.updatePage(pageId, { title: change.after });
    case 'slug':
      return connector.updatePage(pageId, { slug: change.after });
    case 'excerpt':
      return connector.updatePage(pageId, { excerpt: change.after });

    case 'content_block': {
      requireTarget(change);
      const block: ContentBlock = {
        selector: change.target!, mode: 'replace', html: change.after,
      };
      return connector.updatePage(pageId, { blocks: [block] });
    }
    case 'image_alt': {
      requireTarget(change);
      const block: ContentBlock = {
        selector: change.target!, mode: 'setAttribute', attr: 'alt', value: change.after,
      };
      return connector.updatePage(pageId, { blocks: [block] });
    }

    case 'seo_title':
      return connector.setSeoMeta(pageId, { title: change.after });
    case 'meta_description':
      return connector.setSeoMeta(pageId, { description: change.after });
    case 'canonical':
      return connector.setSeoMeta(pageId, { canonical: change.after });
    case 'robots_meta':
      return connector.setSeoMeta(pageId, { robots: change.after });

    case 'json_ld': {
      let parsed: object | object[];
      try {
        parsed = JSON.parse(change.after) as object | object[];
      } catch {
        throw new StateError('The JSON-LD for this change is not valid JSON.', 'BAD_PAYLOAD');
      }
      return connector.injectSchema(pageId, parsed);
    }

    case 'robots_txt':
    case 'llms_txt':
      return connector.setRootFile(rootFileFor(change.field), change.after);
  }
}

function requireTarget(change: Change): void {
  if (!change.target) {
    throw new StateError(
      `A ${change.field} change needs a target selector, and this one has none.`,
      'BAD_PAYLOAD',
    );
  }
}

export function isRootFileField(field: ChangeField): field is 'robots_txt' | 'llms_txt' {
  return field === 'robots_txt' || field === 'llms_txt';
}

function rootFileFor(field: ChangeField): RootFile {
  return field === 'robots_txt' ? 'robots.txt' : 'llms.txt';
}

// ------------------------------------------------------------- page lookup

/** Maps a change's page URL onto whatever id each connector uses for it. */
class PageIndex {
  private cache = new Map<Connector, Map<string, string>>();

  constructor(private readonly connectors: Connectors) {}

  async resolve(connector: Connector, change: Change, site: Site): Promise<string> {
    if (isRootFileField(change.field)) return change.page;

    // Cloudflare addresses pages by path, with nothing to look up.
    if (connector === this.connectors.cloudflare) return change.page;

    const index = await this.indexFor(connector);
    const key = normaliseUrl(change.page);
    const hit = index.get(key) ?? index.get(key.replace(/^https?:\/\/[^/]+/, normaliseUrl(site.url).replace(/\/$/, '')));
    if (hit) return hit;

    throw new StateError(
      `${connector.platform} has no page at ${change.page}. ` +
      'It may have been deleted or moved since the audit ran.',
      'PAGE_NOT_FOUND',
    );
  }

  private async indexFor(connector: Connector): Promise<Map<string, string>> {
    const cached = this.cache.get(connector);
    if (cached) return cached;

    const index = new Map<string, string>();
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page: { pages: PageRef[]; cursor?: string } =
        await connector.listPages(cursor ? { cursor } : {});
      for (const ref of page.pages) index.set(normaliseUrl(ref.url), ref.id);
      cursor = page.cursor;
    } while (cursor && ++guard < 50);

    this.cache.set(connector, index);
    return index;
  }
}

function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : u.pathname;
    return `${u.protocol}//${u.host}${path}`.toLowerCase();
  } catch {
    return url.replace(/\/$/, '').toLowerCase();
  }
}

// --------------------------------------------------------------- utilities

/** Strip the engine's `{ connector, inner }` tag back off a stored snapshot. */
export function unwrapSnapshot(snapshot: Snapshot): Snapshot {
  const payload = snapshot.payload as { connector?: string; inner?: unknown } | undefined;
  if (payload && typeof payload === 'object' && 'inner' in payload && 'connector' in payload) {
    return { ...snapshot, payload: payload.inner };
  }
  return snapshot;
}

function connectorForSnapshot(snapshot: Snapshot, connectors: Connectors): Connector | undefined {
  const payload = snapshot.payload as { connector?: string } | undefined;
  if (payload?.connector === 'custom') return connectors.cloudflare;
  if (connectors.primary && payload?.connector === connectors.primary.platform) return connectors.primary;
  return connectors.primary ?? connectors.cloudflare;
}

function plannedFrom(connector: Connector, result: ApplyResult): PlannedRequest[] {
  if (result.planned?.length) return result.planned;
  const drainable = connector as Connector & { drainPlanned?: () => PlannedRequest[] };
  return typeof drainable.drainPlanned === 'function' ? drainable.drainPlanned() : [];
}

function unverifiedMessage(verify: VerifyResult): string {
  if (verify.found === null) {
    return `Applied, but the page does not show it yet. ${verify.detail ?? ''}`.trim();
  }
  return `Applied, but the page still reads: ${verify.found}`;
}

function summarise(outcomes: ChangeOutcome[], dryRun: boolean): string {
  if (dryRun) {
    const manual = outcomes.filter((o) => o.via === 'manual').length;
    const failed = outcomes.filter((o) => !o.ok && o.via !== 'manual').length;
    const auto = outcomes.length - manual - failed;
    const parts = [`${auto} change${auto === 1 ? '' : 's'} would be sent`];
    // A dry run that could not work out what to send has found a real problem,
    // and saying "would be sent" about it would hide exactly what dry run is
    // for.
    if (failed) parts.push(`${failed} would fail`);
    if (manual) parts.push(`${manual} need doing by hand`);
    return `${parts.join(', ')}. Nothing was sent.`;
  }
  const verified = outcomes.filter((o) => o.status === 'verified').length;
  const manual = outcomes.filter((o) => o.via === 'manual').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const parts = [`${verified} verified`];
  if (failed) parts.push(`${failed} failed`);
  if (manual) parts.push(`${manual} to do by hand`);
  return `${parts.join(', ')}, of ${outcomes.length}.`;
}

/** Re-exported so the API layer need not reach into the core. */
export type { ManualCard, SeoMeta };
