/**
 * Turning stored connections into live connectors.
 *
 * Credentials are unsealed here and nowhere else in the app layer, and the
 * unsealed values are handed straight to a connector constructor — which
 * registers them with the log redactor — rather than being held, returned or
 * put into any record.
 */

import { open } from '../core/crypto.js';
import { log } from '../core/logger.js';
import type { Connector } from '../core/connector.js';
import type { Platform } from '../core/types.js';
import { WordPressConnector } from '../connectors/wordpress/index.js';
import { CloudflareConnector } from '../connectors/cloudflare/index.js';
import { WixConnector } from '../connectors/wix/index.js';
import { SquarespaceConnector } from '../connectors/squarespace/index.js';
import type { WixCredentials } from '../connectors/wix/auth.js';
import type { SiteVersion } from '../connectors/squarespace/cards.js';
import type { Connection, ConnectionKind, Site } from '../store/types.js';
import { StateError } from '../store/store.js';

export interface BuildOptions {
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
}

/** Which connection kind serves as a site's primary connector. */
export function primaryKindFor(platform: Platform): ConnectionKind | null {
  switch (platform) {
    case 'wordpress': return 'wordpress';
    case 'wix': return 'wix';
    case 'squarespace': return 'squarespace';
    default: return null;
  }
}

/**
 * Build a connector for one connection.
 *
 * Throws rather than returning a half-configured connector: a connector that
 * silently has no credentials would fail at apply time, which is the worst
 * possible moment to discover it.
 */
export function buildConnector(conn: Connection, site: Site, opts: BuildOptions = {}): Connector {
  const dryRun = opts.dryRun ?? false;
  const fetchOpt = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};

  switch (conn.kind) {
    case 'wordpress': {
      const secret = unseal(conn, ['applicationPassword']);
      return new WordPressConnector(
        {
          siteUrl: conn.config.siteUrl ?? site.url,
          username: conn.config.username ?? '',
          applicationPassword: secret.applicationPassword!,
        },
        { dryRun, ...fetchOpt },
      );
    }

    case 'cloudflare': {
      const secret = unseal(conn, ['apiToken']);
      return new CloudflareConnector(
        {
          apiToken: secret.apiToken!,
          ...(conn.config.zoneId ? { zoneId: conn.config.zoneId } : {}),
          ...(conn.config.domain ? { domain: conn.config.domain } : { domain: hostOf(site.url) }),
        },
        { dryRun, platform: site.platform, ...fetchOpt },
      );
    }

    case 'wix': {
      const creds = wixCredentials(conn);
      return new WixConnector(creds, { dryRun, ...fetchOpt });
    }

    case 'squarespace': {
      const version = conn.config.siteVersion as SiteVersion | undefined;
      return new SquarespaceConnector(conn.config.siteUrl ?? site.url, {
        dryRun,
        ...(version ? { siteVersion: version } : {}),
        ...fetchOpt,
      });
    }
  }
}

function wixCredentials(conn: Connection): WixCredentials {
  if (conn.config.identity === 'api-key') {
    const secret = unseal(conn, ['apiKey']);
    return {
      kind: 'api-key',
      apiKey: secret.apiKey!,
      siteId: conn.config.siteId ?? '',
      ...(conn.config.accountId ? { accountId: conn.config.accountId } : {}),
    };
  }
  const secret = unseal(conn, ['clientSecret']);
  return {
    kind: 'app',
    clientId: conn.config.clientId ?? '',
    clientSecret: secret.clientSecret!,
    instanceId: conn.config.instanceId ?? '',
  };
}

function unseal(conn: Connection, required: string[]): Record<string, string> {
  if (!conn.secret) {
    throw new StateError(`The ${conn.kind} connection has no stored credential.`, 'NO_CREDENTIAL');
  }
  let secret: Record<string, string>;
  try {
    secret = open(conn.secret);
  } catch (err) {
    log.error('could not decrypt a stored credential', {
      connectionId: conn.id,
      kind: conn.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new StateError(
      `The stored ${conn.kind} credential could not be decrypted. ` +
      'This usually means AIVA_MASTER_KEY has changed. Disconnect and reconnect to store it again.',
      'UNDECRYPTABLE',
    );
  }
  for (const field of required) {
    if (!secret[field]) {
      throw new StateError(`The ${conn.kind} credential is missing ${field}.`, 'NO_CREDENTIAL');
    }
  }
  return secret;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
