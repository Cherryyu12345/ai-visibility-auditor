/**
 * Onboarding checker.
 *
 * Tells the consultant whether a domain is ready for the edge Worker, and if
 * not, what to do — in plain language, because moving nameservers is the
 * riskiest thing we ever ask anyone to do.
 *
 * Research that shaped the Squarespace path: Squarespace does not support
 * being proxied through Cloudflare and will not troubleshoot it. In practice
 * it works when every record is proxied EXCEPT verify.squarespace.com, which
 * must stay DNS-only or Squarespace's domain validation fails. Sources
 * disagree on Full versus Full (Strict), so we report the current mode and let
 * the consultant decide rather than asserting one is correct.
 */

import type { CloudflareApi, DnsRecord, Zone } from './api.js';
import type { Platform } from '../../core/types.js';

export type ReadinessLevel = 'ready' | 'action-needed' | 'not-on-cloudflare' | 'blocked';

export interface OnboardingCheck {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
  /** Raised when getting this wrong can break something the client cares about. */
  warning?: string;
}

export interface OnboardingReport {
  level: ReadinessLevel;
  domain: string;
  zoneId?: string;
  accountId?: string;
  checks: OnboardingCheck[];
  /** Ordered, plain-language steps when the domain is not on Cloudflare yet. */
  migrationSteps?: string[];
}

const VERIFY_HOST = 'verify.squarespace.com';

export async function checkDomain(
  api: CloudflareApi,
  domain: string,
  platform: Platform = 'unknown',
): Promise<OnboardingReport> {
  const checks: OnboardingCheck[] = [];

  // 1. Is the token usable at all?
  try {
    const token = await api.verifyToken();
    checks.push({
      name: 'API token',
      ok: token?.status === 'active',
      detail: token?.status === 'active' ? 'Token is active.' : `Token status: ${token?.status ?? 'unknown'}.`,
      ...(token?.status === 'active' ? {} : { remedy: 'Create a new scoped token and reconnect.' }),
    });
  } catch (err) {
    return {
      level: 'blocked',
      domain,
      checks: [{
        name: 'API token',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        remedy:
          'Create a token with: Zone → Zone → Read, Zone → Workers Routes → Edit, ' +
          'Account → Workers Scripts → Edit, Account → Workers KV Storage → Edit. ' +
          'Scope it to this one zone.',
      }],
    };
  }

  // 2. Is the domain on this Cloudflare account?
  const zones = await api.listZones(domain);
  const zone = zones.find((z) => z.name === domain) ?? zones[0];

  if (!zone) {
    return {
      level: 'not-on-cloudflare',
      domain,
      checks: [
        ...checks,
        {
          name: 'Zone',
          ok: false,
          detail: `${domain} is not on this Cloudflare account.`,
          remedy: 'Add the site to Cloudflare and move its nameservers, then reconnect.',
        },
      ],
      migrationSteps: migrationSteps(domain, platform),
    };
  }

  // 3. Zone active?
  const active = zone.status === 'active';
  checks.push({
    name: 'Zone status',
    ok: active,
    detail: active ? 'Zone is active on Cloudflare.' : `Zone status is "${zone.status}".`,
    ...(active ? {} : {
      remedy:
        `Cloudflare is waiting for the nameservers to change. Set them at your registrar to: ` +
        `${(zone.name_servers ?? []).join(', ') || 'the values shown in your Cloudflare dashboard'}. ` +
        'It can take a few hours.',
    }),
  });

  if (zone.paused) {
    checks.push({
      name: 'Zone paused',
      ok: false,
      detail: 'Cloudflare is paused for this zone, so no Worker will run.',
      remedy: 'Un-pause the zone in the Cloudflare dashboard (Overview → Advanced).',
    });
  }

  // 4. Proxy state. A Worker route only fires on proxied records.
  const records = await api.listDnsRecords(zone.id);
  const webRecords = records.filter(
    (r) => ['A', 'AAAA', 'CNAME'].includes(r.type) && (r.name === domain || r.name === `www.${domain}`),
  );
  const proxied = webRecords.filter((r) => r.proxied);

  checks.push({
    name: 'Proxy (orange cloud)',
    ok: proxied.length > 0,
    detail: proxied.length > 0
      ? `${proxied.length} of ${webRecords.length} web record(s) are proxied.`
      : 'No web records are proxied, so traffic bypasses Cloudflare entirely.',
    ...(proxied.length > 0 ? {} : {
      remedy: `Switch the ${domain} and www records to proxied (orange cloud) in Cloudflare's DNS tab.`,
    }),
  });

  // 5. SSL mode.
  const ssl = await api.getSslMode(zone.id);
  const sslOk = ssl === 'full' || ssl === 'strict';
  checks.push({
    name: 'SSL mode',
    ok: sslOk,
    detail: ssl ? `Encryption mode is "${ssl}".` : 'Could not read the SSL setting (the token may lack Zone Settings → Read).',
    ...(ssl === 'flexible' ? {
      remedy: 'Set SSL/TLS encryption mode to Full. "Flexible" causes redirect loops and certificate errors.',
    } : {}),
    ...(ssl === 'off' ? { remedy: 'Set SSL/TLS encryption mode to Full.' } : {}),
  });

  // 6. Squarespace-specific checks.
  if (platform === 'squarespace') {
    const verifyRecord = records.find((r) => r.content.includes(VERIFY_HOST) || r.name.startsWith('verify.'));
    const verifyProxied = verifyRecord?.proxied === true;

    checks.push({
      name: 'Squarespace domain verification',
      ok: !verifyProxied,
      detail: verifyRecord
        ? verifyProxied
          ? `The ${VERIFY_HOST} record is proxied, which stops Squarespace validating the domain.`
          : `The ${VERIFY_HOST} record is correctly DNS-only.`
        : `No ${VERIFY_HOST} record found — check the domain is still connected in Squarespace.`,
      ...(verifyProxied ? {
        remedy: `Set the ${VERIFY_HOST} CNAME to DNS-only (grey cloud). Leave every other web record proxied.`,
      } : {}),
      warning:
        'Squarespace does not officially support being proxied through Cloudflare and will not ' +
        'troubleshoot it. Use SSL mode Full, keep the verify record DNS-only, and test the site ' +
        'end to end after enabling the proxy.',
    });
  }

  const blocking = checks.filter((c) => !c.ok);
  return {
    level: blocking.length === 0 ? 'ready' : 'action-needed',
    domain,
    zoneId: zone.id,
    accountId: zone.account?.id,
    checks,
  };
}

/**
 * Plain-language nameserver migration.
 *
 * The email warning comes first and is not optional: moving nameservers moves
 * ALL DNS, and a missing MX record silently stops a business receiving email.
 * That is the single most damaging thing that can go wrong here.
 */
export function migrationSteps(domain: string, platform: Platform): string[] {
  const steps = [
    'BEFORE ANYTHING ELSE — write down the current DNS records at your existing provider, ' +
      'especially MX (email delivery), any TXT records for SPF, DKIM and DMARC, and any ' +
      'CNAMEs for services like email marketing. Moving nameservers moves all DNS. If an MX ' +
      'record is missed, email stops arriving and there is no error message.',
    `Create a free Cloudflare account and choose "Add a site", entering ${domain}.`,
    'Cloudflare will scan your existing DNS. Compare what it found against the list you wrote ' +
      'down, and add anything missing BEFORE continuing. Pay particular attention to MX and TXT records.',
    'Cloudflare gives you two nameservers. Sign in to the registrar where the domain was bought ' +
      'and replace the existing nameservers with those two.',
    'Wait for Cloudflare to report the zone as Active. This usually takes under an hour but can ' +
      'take up to 24.',
    'In SSL/TLS, set the encryption mode to Full.',
  ];

  if (platform === 'squarespace') {
    steps.push(
      `In the DNS tab, make sure the ${VERIFY_HOST} record stays DNS-only (grey cloud). ` +
        'If it is proxied, Squarespace cannot validate the domain and the site will show as ' +
        'not connected.',
      'Proxy (orange cloud) the root and www records only. Then load the site, check pages, ' +
        'forms and the checkout if there is one. Squarespace will not help debug a proxied setup, ' +
        'so if anything breaks, turn the proxy off and tell us.',
    );
  } else {
    steps.push('Proxy (orange cloud) the root and www records, then check the site loads normally.');
  }

  steps.push('Come back here and reconnect — the checker will confirm everything is in place.');
  return steps;
}
