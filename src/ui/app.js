/**
 * The publishing interface.
 *
 * Three tabs, in the order the work actually happens: connect the site,
 * approve the changes, then look at what was done and undo it if needed.
 *
 * No framework and no build step — the whole thing is small enough to read,
 * and a tool that can rewrite a client's live site is better off being
 * readable than being clever.
 */

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  operator: 'operator',
  sites: [],
  siteId: null,
  overview: null,
  changes: [],
  plan: [],
  batches: [],
  audit: [],
  shares: [],
  cards: new Map(),       // changeId -> manual card
  lastReport: null,
  dryRun: false,
  tab: 'connect',
  busy: false,
};

// ----------------------------------------------------------------- plumbing

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text }; }
  if (!res.ok) {
    const err = new Error(parsed?.error || `Request failed (${res.status})`);
    err.payload = parsed;
    throw err;
  }
  return parsed;
}

/**
 * Ask before something irreversible.
 *
 * A browser `confirm()` cannot show what is about to change, and is the kind
 * of dialog people dismiss without reading. This puts the question in the
 * page, with the actual consequence spelled out.
 */
function confirmAction({ title, detail, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    const close = (answer) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(answer); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };

    const confirmButton = el('button', {
      class: danger ? 'danger' : 'primary',
      onclick: () => close(true),
    }, confirmLabel);

    const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(false); } },
      el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
        el('h2', {}, title),
        el('p', {}, detail),
        el('div', { class: 'row end' },
          el('button', { onclick: () => close(false) }, 'Cancel'),
          confirmButton)));

    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    confirmButton.focus();
  });
}

function toast(message, bad = false) {
  const existing = $('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 3800);
}

/** Wrap an action so a failure surfaces as a message rather than a dead button. */
async function run(fn, { busyLabel } = {}) {
  if (state.busy) return;
  state.busy = true;
  if (busyLabel) toast(busyLabel);
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
  }
}

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

const fmtDate = (v) => (v ? new Date(v).toLocaleString() : '—');
const pathOf = (url) => { try { return new URL(url).pathname || '/'; } catch { return url; } };

const FIELD_LABEL = {
  title: 'Page title', seo_title: 'SEO title', meta_description: 'Meta description',
  canonical: 'Canonical URL', robots_meta: 'Robots meta', slug: 'URL slug',
  excerpt: 'Excerpt', image_alt: 'Image alt text', content_block: 'Content block',
  json_ld: 'JSON-LD', robots_txt: 'robots.txt', llms_txt: 'llms.txt',
};

const STATUS_PILL = {
  draft: ['', 'Awaiting approval'],
  approved: ['accent', 'Approved'],
  applied: ['warn', 'Applied, checking'],
  verified: ['ok', 'Verified live'],
  failed: ['bad', 'Failed'],
  rolled_back: ['', 'Rolled back'],
};

// -------------------------------------------------------------- data loading

async function loadSites() {
  const [{ sites }, config] = await Promise.all([api('GET', '/sites'), api('GET', '/config')]);
  state.sites = sites;
  state.operator = config.operator;
  if (!state.siteId && sites.length) state.siteId = sites[0].id;
  if (state.siteId && !sites.some((s) => s.id === state.siteId)) state.siteId = sites[0]?.id ?? null;
}

async function loadSite() {
  if (!state.siteId) {
    state.overview = null;
    state.changes = [];
    return;
  }
  const [overview, changes] = await Promise.all([
    api('GET', `/sites/${state.siteId}`),
    api('GET', `/sites/${state.siteId}/changes`),
  ]);
  state.overview = overview;
  state.changes = changes.changes;

  // The plan tells each change where it would go. It needs connectors, so it
  // is only meaningful once something is connected.
  if (overview.connections.length) {
    try {
      const { plan } = await api('GET', `/sites/${state.siteId}/plan`);
      state.plan = plan;
      for (const entry of plan) if (entry.card) state.cards.set(entry.changeId, entry.card);
    } catch { state.plan = []; }
  } else {
    state.plan = [];
  }
}

async function loadHistory() {
  if (!state.siteId) return;
  const [{ batches }, { audit }, { shares }] = await Promise.all([
    api('GET', `/sites/${state.siteId}/batches`),
    api('GET', `/sites/${state.siteId}/audit`),
    api('GET', `/sites/${state.siteId}/shares`),
  ]);
  state.batches = batches;
  state.audit = audit;
  state.shares = shares;
}

async function refresh() {
  await loadSites();
  await loadSite();
  if (state.tab === 'history') await loadHistory();
  render();
}

// --------------------------------------------------------------- connect tab

const CONNECTOR_FORMS = {
  wordpress: {
    title: 'WordPress',
    access:
      'Create an Application Password for a user with the Editor role. Editor can ' +
      'change page content and SEO fields; it cannot install plugins, change ' +
      'settings or add users.',
    fields: [
      { name: 'siteUrl', label: 'Site URL', fromSite: 'url' },
      { name: 'username', label: 'WordPress username' },
      { name: 'applicationPassword', label: 'Application password', secret: true,
        hint: 'Users → Profile → Application Passwords. Not the login password.' },
    ],
  },
  cloudflare: {
    title: 'Cloudflare',
    access:
      'Create a token scoped to this one zone with Workers Scripts:Edit, ' +
      'Workers KV Storage:Edit, Workers Routes:Edit and Zone:Read. Nothing else, ' +
      'and never a Global API Key.',
    fields: [
      { name: 'domain', label: 'Domain', fromSite: 'host' },
      { name: 'apiToken', label: 'API token', secret: true },
      { name: 'zoneId', label: 'Zone ID', optional: true, hint: 'Optional — looked up from the domain if blank.' },
    ],
  },
  wix: {
    title: 'Wix',
    access:
      'SEO writes need a Wix app installed on the site, not an account API key. ' +
      'Create an app in the Wix Dev Center with SEO.MANAGE-SEO-SETTINGS, install ' +
      'it on the site, and paste the instance ID from the install.',
    variants: [
      { value: 'app', label: 'Wix app (can write SEO)' },
      { value: 'api-key', label: 'Account API key (read-only for SEO)' },
    ],
    fields: [
      { name: 'clientId', label: 'App ID', when: 'app' },
      { name: 'clientSecret', label: 'App secret key', secret: true, when: 'app' },
      { name: 'instanceId', label: 'Instance ID', when: 'app', hint: 'From the App Instance Installed webhook or the install redirect.' },
      { name: 'apiKey', label: 'API key', secret: true, when: 'api-key' },
      { name: 'siteId', label: 'Site ID', when: 'api-key' },
      { name: 'accountId', label: 'Account ID', when: 'api-key', optional: true },
    ],
  },
  squarespace: {
    title: 'Squarespace',
    access:
      'No credential is needed or accepted. Squarespace has no API for page ' +
      'content or SEO, so this connection only reads the public site to check ' +
      'changes after you make them by hand.',
    fields: [
      { name: 'siteUrl', label: 'Site URL', fromSite: 'url' },
      { name: 'siteVersion', label: 'Squarespace version', select: ['unknown', '7.1', '7.0'],
        hint: 'Leave as unknown to detect it from the live site.' },
    ],
  },
};

function renderConnect() {
  const root = $('#tab-connect');
  root.replaceChildren();

  if (!state.overview) {
    root.append(addSitePanel());
    return;
  }

  const { site, connections, primaryKind } = state.overview;

  // --- detected platform -----------------------------------------------
  const detected = el('div', { class: 'panel' },
    el('h2', {}, 'Website'),
    el('p', { class: 'sub' }, `${site.url} — detected as ${platformName(site.platform)}${
      site.platformOverridden ? ' (set by hand)'
        : site.detectionConfidence != null ? ` with ${Math.round(site.detectionConfidence * 100)}% confidence` : ''
    }.`),
  );

  if (!site.platformOverridden && (site.detectionConfidence ?? 0) < 0.55) {
    detected.append(el('div', { class: 'notice warn' },
      'Detection was not confident. Check the platform below before connecting — ' +
      'the wrong one asks for credentials that will not work.'));
  }

  const override = el('select', { style: 'width:auto' },
    ...['wordpress', 'wix', 'squarespace', 'custom', 'unknown'].map((p) =>
      el('option', { value: p, ...(p === site.platform ? { selected: 'selected' } : {}) }, platformName(p))));

  detected.append(el('div', { class: 'row' },
    el('span', { class: 'small muted' }, 'Platform'),
    override,
    el('button', {
      onclick: () => run(async () => {
        await api('PATCH', `/sites/${site.id}`, { platform: override.value });
        await refresh();
        toast('Platform updated.');
      }),
    }, 'Change'),
  ));
  root.append(detected);

  // --- the site's own platform -----------------------------------------
  if (primaryKind) {
    root.append(connectionPanel(primaryKind, connections.find((c) => c.kind === primaryKind), site));
  } else {
    root.append(el('div', { class: 'panel' },
      el('h2', {}, 'No platform connector'),
      el('p', { class: 'sub' },
        `There is no connector for ${platformName(site.platform)} sites. ` +
        'Connect Cloudflare below to apply changes at the edge, or work from manual cards.')));
  }

  // --- Cloudflare -------------------------------------------------------
  root.append(connectionPanel('cloudflare', connections.find((c) => c.kind === 'cloudflare'), site));
}

function addSitePanel() {
  const url = el('input', { type: 'text', placeholder: 'example.com', autofocus: 'autofocus' });
  const name = el('input', { type: 'text', placeholder: 'Optional' });
  const status = el('div');

  const submit = () => run(async () => {
    if (!url.value.trim()) return toast('Enter the website address.', true);
    status.replaceChildren(el('div', { class: 'notice info' }, 'Looking at the site…'));
    const { site, detection } = await api('POST', '/sites', {
      url: url.value.trim(),
      ...(name.value.trim() ? { name: name.value.trim() } : {}),
    });
    state.siteId = site.id;
    await refresh();
    toast(detection?.unreachable
      ? 'Site added, but it could not be fetched. Set the platform by hand.'
      : `Site added — detected ${platformName(site.platform)}.`);
  });

  return el('div', { class: 'panel' },
    el('h2', {}, 'Connect a website'),
    el('p', { class: 'sub' }, 'Enter the address. The platform is detected from the live site, and you can override it.'),
    el('label', { class: 'field' }, el('span', {}, 'Website address'), url),
    el('label', { class: 'field' }, el('span', {}, 'Name'), name),
    status,
    el('div', { class: 'row' }, el('button', { class: 'primary', onclick: submit }, 'Detect and add')),
  );
}

function connectionPanel(kind, existing, site) {
  const spec = CONNECTOR_FORMS[kind];
  const panel = el('div', { class: 'panel' },
    el('h2', {}, spec.title),
    el('p', { class: 'sub' }, spec.access),
  );

  if (existing) {
    panel.append(el('div', { class: 'row' },
      el('span', { class: `pill ${existing.lastTestOk === true ? 'ok' : existing.lastTestOk === false ? 'bad' : ''}` },
        existing.lastTestOk === true ? 'Connected' : existing.lastTestOk === false ? 'Not working' : 'Untested'),
      el('span', { class: 'small' }, existing.label),
      el('span', { class: 'spacer' }),
      el('button', {
        onclick: () => run(async () => {
          toast('Testing…');
          const { test } = await api('POST', `/connections/${existing.id}/test`);
          await refresh();
          toast(test.ok ? 'Connection works.' : 'Connection has problems — see the checks.', !test.ok);
        }),
      }, 'Test connection'),
      el('button', {
        class: 'danger',
        onclick: () => run(async () => {
          if (!await confirmAction({
            title: `Disconnect ${spec.title}?`,
            detail: 'The stored credential is deleted, not just unlinked. You will have to enter it again to reconnect.',
            confirmLabel: 'Disconnect and delete',
            danger: true,
          })) return;
          await api('DELETE', `/connections/${existing.id}`);
          await refresh();
          toast('Disconnected. The stored credential was deleted.');
        }),
      }, 'Disconnect'),
    ));

    if (existing.lastChecks?.length) {
      panel.append(el('ul', { class: 'checks' }, ...existing.lastChecks.map((check) =>
        el('li', {},
          el('span', { class: `mark ${check.ok ? 'ok' : 'bad'}` }, check.ok ? '✓' : '✕'),
          el('span', { class: 'name' }, check.name),
          el('span', {}, check.detail,
            check.remedy ? el('span', { class: 'remedy' }, check.remedy) : null),
        ))));
      panel.append(el('p', { class: 'small muted', style: 'margin-top:10px' },
        `Last tested ${fmtDate(existing.lastTestedAt)}.`));
    }
    return panel;
  }

  // --- not connected: the form -----------------------------------------
  const inputs = new Map();
  let variant = spec.variants?.[0]?.value ?? null;
  const fieldHost = el('div');

  const drawFields = () => {
    fieldHost.replaceChildren();
    inputs.clear();
    for (const field of spec.fields) {
      if (field.when && field.when !== variant) continue;
      const prefill = field.fromSite === 'url' ? site.url
        : field.fromSite === 'host' ? hostOf(site.url) : '';
      const input = field.select
        ? el('select', {}, ...field.select.map((v) => el('option', { value: v }, v)))
        : el('input', {
            type: field.secret ? 'password' : 'text',
            value: prefill,
            ...(field.secret ? { autocomplete: 'new-password' } : {}),
          });
      inputs.set(field.name, { field, input });
      fieldHost.append(el('label', { class: 'field' },
        el('span', {}, field.label + (field.optional ? ' (optional)' : '')),
        input,
        field.hint ? el('em', {}, field.hint) : null));
    }
  };

  if (spec.variants) {
    const picker = el('select', { style: 'width:auto', onchange: (e) => { variant = e.target.value; drawFields(); } },
      ...spec.variants.map((v) => el('option', { value: v.value }, v.label)));
    panel.append(el('label', { class: 'field' }, el('span', {}, 'How is this connected?'), picker));
  }

  drawFields();
  panel.append(fieldHost);

  panel.append(el('div', { class: 'row' },
    el('button', {
      class: 'primary',
      onclick: () => run(async () => {
        const config = {};
        const secret = {};
        for (const [name, { field, input }] of inputs) {
          const value = input.value.trim();
          if (!value) {
            if (field.optional) continue;
            return toast(`${field.label} is needed.`, true);
          }
          (field.secret ? secret : config)[name] = value;
        }
        if (variant) config.identity = variant;

        const { connection } = await api('POST', `/sites/${site.id}/connections`, { kind, config, secret });
        // Test straight away: a connection that has not been tested tells you
        // nothing, and this is the moment the person can still fix it.
        try {
          const { test } = await api('POST', `/connections/${connection.id}/test`);
          toast(test.ok ? 'Connected.' : 'Saved, but the test found problems.', !test.ok);
        } catch (err) {
          toast(`Saved, but the test failed: ${err.message}`, true);
        }
        await refresh();
      }),
    }, 'Connect'),
  ));
  return panel;
}

function platformName(p) {
  return { wordpress: 'WordPress', wix: 'Wix', squarespace: 'Squarespace', custom: 'Custom site', unknown: 'Unknown' }[p] ?? p;
}
function hostOf(url) { try { return new URL(url).hostname; } catch { return url; } }

// --------------------------------------------------------------- changes tab

function renderChanges() {
  const root = $('#tab-changes');
  root.replaceChildren();

  if (!state.overview) {
    root.append(el('div', { class: 'empty' }, 'Connect a website first.'));
    return;
  }

  const drafts = state.changes.filter((c) => c.status === 'draft');
  const approved = state.changes.filter((c) => c.status === 'approved');
  const done = state.changes.filter((c) => ['applied', 'verified', 'failed', 'rolled_back'].includes(c.status));

  root.append(importPanel());

  if (!state.changes.length) {
    root.append(el('div', { class: 'empty' }, 'No changes yet. Import a fix pack above.'));
    return;
  }

  if (state.lastReport) root.append(reportPanel(state.lastReport));

  if (drafts.length) {
    root.append(el('div', { class: 'row', style: 'margin:22px 0 12px' },
      el('h3', { style: 'margin:0' }, `Awaiting approval (${drafts.length})`),
      el('span', { class: 'spacer' }),
      el('button', {
        onclick: () => run(async () => {
          await api('POST', `/sites/${state.siteId}/approve-all`, {});
          await refresh();
          toast(`${drafts.length} change${drafts.length === 1 ? '' : 's'} approved.`);
        }),
      }, 'Approve all'),
      el('button', { onclick: () => shareDialog(drafts.map((c) => c.id)) }, 'Share for approval'),
    ));
    for (const change of drafts) root.append(changeCard(change));
  }

  if (approved.length) {
    root.append(el('h3', {}, `Approved, not yet applied (${approved.length})`));
    for (const change of approved) root.append(changeCard(change));
  }

  if (done.length) {
    root.append(el('h3', {}, `Done (${done.length})`));
    for (const change of done) root.append(changeCard(change));
  }

  root.append(applyBar(approved.length));
}

function applyBar(approvedCount) {
  const dryToggle = el('input', {
    type: 'checkbox', ...(state.dryRun ? { checked: 'checked' } : {}),
    onchange: (e) => { state.dryRun = e.target.checked; },
  });

  return el('div', { class: 'sticky-apply' },
    el('label', { class: 'toggle' }, dryToggle, 'Dry run — show what would be sent, send nothing'),
    el('span', { class: 'spacer' }),
    el('span', { class: 'small muted' },
      approvedCount ? `${approvedCount} approved` : 'Nothing approved yet'),
    el('button', {
      class: 'primary big',
      ...(approvedCount ? {} : { disabled: 'disabled' }),
      onclick: () => run(async () => {
        const dryRun = dryToggle.checked;
        if (!dryRun && !await confirmAction({
          title: `Apply ${approvedCount} change${approvedCount === 1 ? '' : 's'} to the live site?`,
          detail:
            'A snapshot is taken first, so this can be undone from History. ' +
            'Each change is then re-fetched as a crawler, and only counted as verified if the page really shows it.',
          confirmLabel: 'Apply to the live site',
        })) return;
        toast(dryRun ? 'Working out what would be sent…' : 'Applying…');
        const report = await api('POST', `/sites/${state.siteId}/apply`, { dryRun });
        state.lastReport = report;
        await refresh();
        toast(report.summary);
      }),
    }, state.dryRun ? 'Preview what would be sent' : `Apply approved${approvedCount ? ` (${approvedCount})` : ''}`),
  );
}

function reportPanel(report) {
  const panel = el('div', { class: `notice ${report.dryRun ? 'info' : 'ok'}` },
    el('strong', {}, report.dryRun ? 'Dry run — nothing was sent. ' : 'Applied. '),
    report.summary);

  const withPlans = report.outcomes.filter((o) => o.planned?.length);
  if (withPlans.length) {
    const details = el('details', { class: 'planned' },
      el('summary', {}, `Show the ${withPlans.reduce((n, o) => n + o.planned.length, 0)} request(s) that would be sent`));
    for (const outcome of withPlans) {
      for (const req of outcome.planned) {
        details.append(el('pre', {}, `${req.method} ${req.url}\n${req.describes}\n\n` +
          (req.body ? JSON.stringify(req.body, null, 2) : '(no body)')));
      }
    }
    panel.append(details);
  }
  return panel;
}

function changeCard(change) {
  const plan = state.plan.find((p) => p.changeId === change.id);
  const [pillClass, pillText] = STATUS_PILL[change.status] ?? ['', change.status];

  const header = el('header', {},
    el('span', { class: 'where' }, pathOf(change.page)),
    el('span', { class: 'what' }, FIELD_LABEL[change.field] ?? change.field,
      change.target ? ` — ${change.target}` : ''),
    el('span', { class: 'spacer' }),
    plan ? el('span', { class: `pill ${plan.via === 'manual' ? 'warn' : 'accent'}` }, routeLabel(plan)) : null,
    el('span', { class: `pill ${pillClass}` }, pillText),
  );

  const body = el('div', { class: 'body' },
    change.reason ? el('p', { class: 'why' }, change.reason) : null,
    el('div', { class: 'diff' },
      el('div', { class: 'before' },
        el('h4', {}, 'Now'),
        change.before
          ? el('pre', {}, change.before)
          : el('pre', { class: 'none' }, 'nothing there')),
      el('div', { class: 'after' },
        el('h4', {}, 'After this change'),
        el('pre', {}, change.after)),
    ),
  );

  if (change.failureReason) {
    body.append(el('div', { class: 'notice bad', style: 'margin:12px 0 0' }, change.failureReason));
  }

  const card = state.cards.get(change.id);
  if (card && ['draft', 'approved'].includes(change.status)) body.append(manualCard(card, change));

  const footer = el('footer', {});
  if (change.status === 'draft') {
    footer.append(
      el('button', {
        class: 'primary',
        onclick: () => run(async () => {
          await api('POST', `/changes/${change.id}/approve`);
          await refresh();
        }),
      }, 'Approve'),
      el('button', {
        onclick: () => run(async () => {
          await api('POST', `/changes/${change.id}/reject`, { note: 'Rejected in the approval queue.' });
          await refresh();
        }),
      }, 'Reject'),
    );
  } else if (change.status === 'approved') {
    footer.append(el('span', { class: 'small muted' }, 'Approved — included in the next apply.'));
    if (plan?.via === 'manual') {
      footer.append(el('span', { class: 'spacer' }), el('button', {
        onclick: () => run(async () => {
          toast('Checking the live page…');
          const { verify } = await api('POST', `/changes/${change.id}/mark-done`);
          await refresh();
          toast(verify.verified
            ? 'Confirmed on the live page.'
            : `Not visible yet. The page reads: ${verify.found ?? '(nothing)'}`, !verify.verified);
        }),
      }, 'I have done this — check it'));
    }
  } else if (['applied', 'verified', 'failed'].includes(change.status)) {
    footer.append(el('span', { class: 'small muted' }, `Updated ${fmtDate(change.updatedAt)}`));
    if (change.snapshotId) {
      footer.append(el('span', { class: 'spacer' }), el('button', {
        class: 'danger',
        onclick: () => run(async () => {
          const result = await api('POST', `/changes/${change.id}/rollback`);
          await refresh();
          toast(result.ok ? 'Rolled back.' : `Could not roll back: ${result.detail}`, !result.ok);
        }),
      }, 'Roll back'));
    }
  }

  return el('div', { class: 'change' }, header, body, footer.childNodes.length ? footer : null);
}

function routeLabel(plan) {
  if (plan.via === 'native') return `via ${plan.connector}`;
  if (plan.via === 'cloudflare') return 'via Cloudflare';
  return 'by hand';
}

function manualCard(card, change) {
  const wrap = el('div', { style: 'margin-top:14px;padding-top:14px;border-top:1px solid var(--line)' },
    el('div', { class: 'row' },
      el('strong', { class: 'small' }, card.title),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'quiet',
        onclick: async (e) => {
          await navigator.clipboard.writeText(cardToText(card));
          e.target.textContent = 'Copied';
          setTimeout(() => { e.target.textContent = 'Copy as text'; }, 1500);
        },
      }, 'Copy as text')),
  );

  if (card.requirement) {
    wrap.append(el('div', { class: 'notice warn requirement' }, `Requires ${card.requirement}.`));
  }

  wrap.append(el('ol', { class: 'card-steps' },
    ...card.steps.map((step) => el('li', { class: step.pastesPayload ? 'paste' : '' }, step.text))));

  if (card.payload) {
    wrap.append(el('div', { class: 'payload' },
      el('pre', {}, card.payload.text),
      el('button', {
        onclick: async (e) => {
          await navigator.clipboard.writeText(card.payload.text);
          e.target.textContent = 'Copied';
          setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
        },
      }, 'Copy')));
  }

  if (card.expected) wrap.append(el('p', { class: 'small muted', style: 'margin:10px 0 0' }, `You should see: ${card.expected}`));
  if (card.caveats?.length) {
    wrap.append(el('ul', { class: 'caveats' }, ...card.caveats.map((c) => el('li', {}, c))));
  }
  if (change.status === 'draft') {
    wrap.append(el('p', { class: 'small muted', style: 'margin:10px 0 0' },
      'Approve this first — the “check it” button appears once it is approved.'));
  }
  return wrap;
}

function cardToText(card) {
  const lines = [card.title, '='.repeat(card.title.length), ''];
  if (card.why) lines.push(`Why: ${card.why}`, '');
  if (card.requirement) lines.push(`Requires: ${card.requirement}`, '');
  card.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.text}`));
  if (card.payload) lines.push('', `${card.payload.label}:`, '', card.payload.text);
  if (card.expected) lines.push('', `You should see: ${card.expected}`);
  if (card.caveats?.length) lines.push('', 'Watch out for:', ...card.caveats.map((c) => `  - ${c}`));
  return lines.join('\n');
}

function importPanel() {
  const box = el('textarea', {
    placeholder: '[{"page":"https://example.com/about","field":"meta_description","before":null,"after":"…","reason":"…"}]',
  });
  const details = el('details', {},
    el('summary', { class: 'small muted', style: 'cursor:pointer' }, 'Import changes from a fix pack'),
    el('p', { class: 'small muted' },
      'Paste the fix pack as JSON: an array of changes, each with page, field, before, after and reason. ' +
      'They arrive awaiting approval — nothing is sent until you approve and apply.'),
    box,
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', {
        onclick: () => run(async () => {
          let parsed;
          try { parsed = JSON.parse(box.value); } catch { return toast('That is not valid JSON.', true); }
          const { changes } = await api('POST', `/sites/${state.siteId}/changes`, { changes: parsed });
          box.value = '';
          await refresh();
          toast(`${changes.length} change${changes.length === 1 ? '' : 's'} imported.`);
        }),
      }, 'Import')));
  return el('div', { class: 'panel' }, details);
}

async function shareDialog(changeIds) {
  await run(async () => {
    const { token, share } = await api('POST', `/sites/${state.siteId}/shares`, { changeIds });
    const url = `${location.origin}/approve/${token}`;
    const input = el('input', { type: 'text', value: url, readonly: 'readonly' });

    const panel = el('div', { class: 'panel' },
      el('h2', {}, 'Approval link'),
      el('p', { class: 'sub' },
        `Anyone with this link can approve or reject these ${share.changeIds.length} changes without an account. ` +
        'They cannot apply anything, see any credential, or touch any other change. ' +
        `It expires ${fmtDate(share.expiresAt)}.`),
      el('div', { class: 'linkbox' }, input,
        el('button', {
          class: 'primary',
          onclick: async (e) => {
            await navigator.clipboard.writeText(url);
            e.target.textContent = 'Copied';
          },
        }, 'Copy')),
      el('p', { class: 'small muted', style: 'margin-top:10px' },
        'This is the only time the link is shown — it is stored as a hash, so it cannot be recovered.'),
    );
    $('#tab-changes').prepend(panel);
    input.select();
  });
}

// --------------------------------------------------------------- history tab

function renderHistory() {
  const root = $('#tab-history');
  root.replaceChildren();

  if (!state.overview) {
    root.append(el('div', { class: 'empty' }, 'Connect a website first.'));
    return;
  }

  // --- batches ----------------------------------------------------------
  const batchPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Applied batches'),
    el('p', { class: 'sub' }, 'Each run of Apply approved, with one-click rollback of the whole batch.'));

  if (!state.batches.length) {
    batchPanel.append(el('p', { class: 'muted small' }, 'Nothing has been applied yet.'));
  } else {
    for (const batch of state.batches) {
      const canRollback = ['done', 'partial'].includes(batch.status) && batch.snapshotIds.length > 0;
      batchPanel.append(el('div', { class: 'row', style: 'padding:11px 0;border-top:1px solid var(--line)' },
        el('span', { class: `pill ${batch.status === 'done' ? 'ok' : batch.status === 'failed' ? 'bad' : ''}` }, batch.status),
        el('span', { class: 'small' },
          `${batch.changeIds.length} change${batch.changeIds.length === 1 ? '' : 's'} — ${batch.summary ?? ''}`),
        el('span', { class: 'spacer' }),
        el('span', { class: 'small muted' }, `${fmtDate(batch.startedAt)} by ${batch.startedBy}`),
        canRollback ? el('button', {
          class: 'danger',
          onclick: () => run(async () => {
            if (!await confirmAction({
              title: `Roll back ${batch.changeIds.length} change${batch.changeIds.length === 1 ? '' : 's'}?`,
              detail: 'Each one is restored from the snapshot taken before it was applied, newest first.',
              confirmLabel: 'Roll back the batch',
              danger: true,
            })) return;
            const report = await api('POST', `/batches/${batch.id}/rollback`);
            await loadSite(); await loadHistory(); render();
            toast(report.summary);
          }),
        }, 'Roll back batch') : null,
      ));
    }
  }
  root.append(batchPanel);

  // --- share links ------------------------------------------------------
  if (state.shares.length) {
    const sharePanel = el('div', { class: 'panel' },
      el('h2', {}, 'Approval links'),
      el('p', { class: 'sub' }, 'Links issued so someone without an account could approve changes.'));
    for (const share of state.shares) {
      const dead = share.revokedAt || share.expired;
      sharePanel.append(el('div', { class: 'row', style: 'padding:10px 0;border-top:1px solid var(--line)' },
        el('span', { class: `pill ${dead ? '' : 'ok'}` }, share.revokedAt ? 'revoked' : share.expired ? 'expired' : 'live'),
        el('span', { class: 'small' }, `${share.changeIds.length} changes${share.usedBy ? ` — used by ${share.usedBy}` : ''}`),
        el('span', { class: 'spacer' }),
        el('span', { class: 'small muted' }, `expires ${fmtDate(share.expiresAt)}`),
        dead ? null : el('button', {
          onclick: () => run(async () => {
            await api('POST', `/shares/${share.id}/revoke`);
            await loadHistory(); render();
            toast('Link revoked.');
          }),
        }, 'Revoke'),
      ));
    }
    root.append(sharePanel);
  }

  // --- audit ------------------------------------------------------------
  const auditPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Audit log'),
    el('p', { class: 'sub' }, 'Every approval, application and rollback, with who did it. Append-only.'));

  if (!state.audit.length) {
    auditPanel.append(el('p', { class: 'muted small' }, 'Nothing recorded yet.'));
  } else {
    const table = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Action'), el('th', {}, 'Who'), el('th', {}, 'Detail'))));
    const tbody = el('tbody', {});
    for (const entry of state.audit) {
      const change = entry.changeId ? state.changes.find((c) => c.id === entry.changeId) : null;
      tbody.append(el('tr', {},
        el('td', { class: 'when' }, fmtDate(entry.at)),
        el('td', {}, el('strong', {}, entry.action.replace(/_/g, ' '))),
        el('td', { class: 'small' }, entry.actor),
        el('td', { class: 'small muted' },
          [change ? `${pathOf(change.page)} · ${FIELD_LABEL[change.field] ?? change.field}` : null,
            entry.detail ? JSON.stringify(entry.detail) : null].filter(Boolean).join(' — ')),
      ));
    }
    table.append(tbody);
    auditPanel.append(table);
  }
  root.append(auditPanel);
}

// ---------------------------------------------------------------- rendering

function render() {
  $('#operator-pill').textContent = state.operator;

  const picker = $('#site-picker');
  picker.replaceChildren(
    ...state.sites.map((s) => el('option', { value: s.id, ...(s.id === state.siteId ? { selected: 'selected' } : {}) },
      `${s.name} — ${platformName(s.platform)}`)),
    el('option', { value: '__new' }, '+ Add a website'),
  );
  picker.hidden = state.sites.length === 0;

  const pending = state.changes.filter((c) => c.status === 'draft').length;
  $('#count-changes').textContent = String(pending);

  for (const tab of ['connect', 'changes', 'history']) {
    $(`#tab-${tab}`).hidden = tab !== state.tab;
    $(`nav.tabs button[data-tab="${tab}"]`).setAttribute('aria-selected', String(tab === state.tab));
  }

  if (state.tab === 'connect') renderConnect();
  else if (state.tab === 'changes') renderChanges();
  else renderHistory();
}

// -------------------------------------------------------------------- start

$('#site-picker').addEventListener('change', (e) => {
  if (e.target.value === '__new') {
    state.siteId = null;
    state.tab = 'connect';
    state.overview = null;
    state.changes = [];
    render();
    return;
  }
  state.siteId = e.target.value;
  state.lastReport = null;
  void run(async () => { await loadSite(); if (state.tab === 'history') await loadHistory(); render(); });
});

for (const button of document.querySelectorAll('nav.tabs button')) {
  button.addEventListener('click', () => {
    state.tab = button.dataset.tab;
    // Re-read on every tab switch. Changes can be approved from a share link
    // while this page is open, so a tab that only re-rendered cached state
    // would quietly show the wrong queue.
    void run(async () => {
      await loadSite();
      if (state.tab === 'history') await loadHistory();
      render();
    });
  });
}

// Likewise when the window is brought back into focus, which is when someone
// returns from doing a manual change in the site's own admin.
window.addEventListener('focus', () => {
  if (!state.siteId || state.busy) return;
  void run(async () => {
    await loadSite();
    if (state.tab === 'history') await loadHistory();
    render();
  });
});

void run(refresh);
