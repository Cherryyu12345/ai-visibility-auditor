/**
 * The approval page a client opens from a share link.
 *
 * Deliberately plain: a list of proposed changes, each with what the page says
 * now and what it would say, and two buttons. There is nothing else on this
 * page because the link can do nothing else — it cannot apply a change, see a
 * credential, or reach any change it was not issued for.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const token = location.pathname.replace(/^\/approve\//, '');

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

const FIELD_LABEL = {
  title: 'Page title', seo_title: 'Search result title', meta_description: 'Search result description',
  canonical: 'Canonical URL', robots_meta: 'Search engine instructions', slug: 'Page address',
  excerpt: 'Summary', image_alt: 'Image description', content_block: 'Page content',
  json_ld: 'Structured data', robots_txt: 'robots.txt', llms_txt: 'llms.txt',
};

const pathOf = (url) => { try { return new URL(url).pathname || '/'; } catch { return url; } };

let data = null;
let reviewer = localStorage.getItem('aiva-reviewer') ?? '';

async function api(method, path, body) {
  const res = await fetch(`/api/share/${encodeURIComponent(token)}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) throw new Error(parsed?.error ?? `Request failed (${res.status})`);
  return parsed;
}

function toast(message, bad = false) {
  $('.toast')?.remove();
  const node = el('div', { class: `toast${bad ? ' bad' : ''}` }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 4000);
}

async function load() {
  const root = $('#root');
  try {
    data = await api('GET', '');
  } catch (err) {
    root.replaceChildren(el('div', { class: 'panel' },
      el('h2', {}, 'This link does not work'),
      el('p', { class: 'sub' }, err.message),
      el('p', { class: 'small muted' }, 'Ask whoever sent it for a new one.')));
    return;
  }
  render();
}

function render() {
  const root = $('#root');
  root.replaceChildren();

  const pending = data.changes.filter((c) => c.status === 'draft');
  const decided = data.changes.filter((c) => c.status !== 'draft');

  root.append(el('div', { class: 'panel' },
    el('h2', {}, data.site.name),
    el('p', { class: 'sub' },
      `${data.changes.length} proposed change${data.changes.length === 1 ? '' : 's'} to ${data.site.url}. ` +
      'Nothing happens to the website until you approve it and your consultant applies it.'),
    el('label', { class: 'field', style: 'max-width:320px;margin:0' },
      el('span', {}, 'Your name, for the record'),
      el('input', {
        type: 'text', value: reviewer, placeholder: 'e.g. Priya Shah',
        oninput: (e) => { reviewer = e.target.value; localStorage.setItem('aiva-reviewer', reviewer); },
      })),
  ));

  if (pending.length > 1) {
    root.append(el('div', { class: 'row', style: 'margin:18px 0 12px' },
      el('h3', { style: 'margin:0' }, `${pending.length} waiting for you`),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'primary',
        onclick: async (e) => {
          if (!requireName()) return;
          // Two presses rather than a browser dialog: the button states what
          // it will do, and nothing happens on a stray click.
          if (e.target.dataset.armed !== 'yes') {
            e.target.dataset.armed = 'yes';
            e.target.textContent = `Yes — approve all ${pending.length}`;
            setTimeout(() => {
              if (!e.target.isConnected) return;
              delete e.target.dataset.armed;
              e.target.textContent = 'Approve all';
            }, 5000);
            return;
          }
          for (const change of pending) await decide(change.id, 'approve', false);
          await load();
          toast('All approved. Your consultant will apply them.');
        },
      }, 'Approve all')));
  }

  for (const change of [...pending, ...decided]) root.append(card(change));

  if (!pending.length) {
    root.append(el('div', { class: 'notice ok', style: 'margin-top:18px' },
      'You have been through all of them. Nothing else is needed from you.'));
  }
}

function card(change) {
  const decided = change.status !== 'draft';
  return el('div', { class: 'change' },
    el('header', {},
      el('span', { class: 'where' }, pathOf(change.page)),
      el('span', { class: 'what' }, FIELD_LABEL[change.field] ?? change.field),
      el('span', { class: 'spacer' }),
      decided ? el('span', { class: `pill ${change.status === 'draft' ? '' : 'ok'}` },
        change.status === 'draft' ? 'waiting' : 'approved') : null),
    el('div', { class: 'body' },
      change.reason ? el('p', { class: 'why' }, change.reason) : null,
      el('div', { class: 'diff' },
        el('div', { class: 'before' }, el('h4', {}, 'Now'),
          change.before ? el('pre', {}, change.before) : el('pre', { class: 'none' }, 'nothing there')),
        el('div', { class: 'after' }, el('h4', {}, 'Proposed'), el('pre', {}, change.after)))),
    decided ? null : el('footer', {},
      el('button', { class: 'primary', onclick: () => decide(change.id, 'approve') }, 'Approve'),
      el('button', { onclick: () => decide(change.id, 'reject') }, 'No, leave it as it is')),
  );
}

function requireName() {
  if (reviewer.trim()) return true;
  toast('Add your name first, so the record shows who approved.', true);
  return false;
}

async function decide(changeId, action, reload = true) {
  if (!requireName()) return;
  try {
    await api('POST', `/${action}`, { changeId, name: reviewer.trim() });
    if (reload) { await load(); toast(action === 'approve' ? 'Approved.' : 'Noted — it will not be made.'); }
  } catch (err) {
    toast(err.message, true);
  }
}

void load();
