/**
 * AI Visibility Auditor edge Worker.
 *
 * Applies approved changes to pages as they are served, using HTMLRewriter so
 * the origin is never modified. This is how we fix sites whose platform has no
 * write API at all — Squarespace, locked-down WordPress, hand-built sites.
 *
 * Three rules govern everything here:
 *
 *   1. FAIL OPEN. If anything goes wrong — KV unavailable, malformed changeset,
 *      a handler throwing — the visitor gets the original page, untouched. A
 *      broken Worker must never take a client's website down. Every handler
 *      body is individually guarded, because once HTMLRewriter has begun
 *      streaming, headers are already sent and recovery is impossible.
 *
 *   2. KILL SWITCH FIRST. A single KV key disables all rewriting instantly,
 *      with no redeploy. It is checked before any other work.
 *
 *   3. NEVER SHADOW REAL CONTENT. Synthetic pages are served only where the
 *      origin returns 404, so a page added later at the same path always wins.
 *
 * Deliberately dependency-free and uploaded as readable source, so a consultant
 * can see exactly what runs on their client's domain.
 */

const KILL_SWITCH_KEY = 'killswitch';
const MARKER_ATTR = 'data-aiva';

export default {
  /**
   * @param {Request} request
   * @param {{ CHANGESETS: KVNamespace }} env
   */
  async fetch(request, env) {
    // Anything before the try is kept trivial, because an error here has no
    // origin response to fall back to.
    let originResponse;
    try {
      // 1. Kill switch, before any other work.
      const disabled = await kvGet(env, KILL_SWITCH_KEY);
      if (disabled) return fetch(request);

      const url = new URL(request.url);

      // 2. Root files are served directly: the origin usually has no robots.txt
      //    worth keeping, and llms.txt almost never exists at all.
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt') {
        const body = await kvGet(env, `rootfile:${url.pathname.slice(1)}`);
        if (body !== null) {
          return new Response(body, {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'public, max-age=300',
              'x-aiva-applied': url.pathname.slice(1),
            },
          });
        }
      }

      originResponse = await fetch(request);

      // 3. Synthetic pages fill 404s only, so they can never shadow real content.
      if (originResponse.status === 404) {
        const page = await kvGet(env, `page:${normalisePath(url.pathname)}`);
        if (page !== null) {
          return new Response(page, {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'x-aiva-applied': 'synthetic-page',
            },
          });
        }
        return originResponse;
      }

      // 4. Only HTML is rewritten.
      const contentType = originResponse.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) return originResponse;

      const raw = await kvGet(env, `changeset:${normalisePath(url.pathname)}`);
      if (raw === null) return originResponse;

      let changeSet;
      try {
        changeSet = JSON.parse(raw);
      } catch {
        return originResponse; // Malformed changeset: serve the page unchanged.
      }

      return rewrite(originResponse, changeSet);
    } catch (err) {
      // Fail open. If we already have the origin response, serve it; otherwise
      // go back to the origin directly rather than returning an error page.
      if (originResponse) return originResponse;
      try {
        return await fetch(request);
      } catch {
        return new Response('Upstream unavailable', { status: 502 });
      }
    }
  },
};

/** KV read that never throws; a KV outage must not break the site. */
async function kvGet(env, key) {
  try {
    if (!env || !env.CHANGESETS) return null;
    return await env.CHANGESETS.get(key, 'text');
  } catch {
    return null;
  }
}

/** Trailing slashes are not meaningful for a changeset key. */
function normalisePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/** Escape a string for safe inclusion in a double-quoted HTML attribute. */
function attr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Serialise JSON-LD for embedding in a <script> block.
 *
 * Escaping "<" is what stops a "</script>" inside a string value from
 * terminating the block and turning a content change into stored XSS.
 */
function jsonLdPayload(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Apply a changeset to an HTML response.
 *
 * Head tags are handled in two places: if the tag already exists we edit it in
 * place; if the document reaches </head> without one, we append it. That is
 * why state is tracked across handlers — HTMLRewriter streams, so we cannot
 * know whether a tag exists until the head has gone past.
 */
function rewrite(response, changeSet) {
  const applied = [];
  const seen = { title: false, description: false, canonical: false, robots: false };

  /** Wrap a handler so a bug in it can never break the page mid-stream. */
  const guard = (name, fn) => (...args) => {
    try {
      fn(...args);
    } catch {
      // Swallow: a failed single rewrite is a missed improvement, not an outage.
    }
  };

  let rewriter = new HTMLRewriter();

  if (typeof changeSet.title === 'string') {
    rewriter = rewriter.on('head title', {
      element: guard('title', (el) => {
        seen.title = true;
        el.setInnerContent(changeSet.title);
        applied.push('title');
      }),
    });
  }

  if (typeof changeSet.metaDescription === 'string') {
    rewriter = rewriter.on('head meta[name="description"]', {
      element: guard('description', (el) => {
        seen.description = true;
        el.setAttribute('content', changeSet.metaDescription);
        applied.push('meta_description');
      }),
    });
  }

  if (typeof changeSet.canonical === 'string') {
    rewriter = rewriter.on('head link[rel="canonical"]', {
      element: guard('canonical', (el) => {
        seen.canonical = true;
        el.setAttribute('href', changeSet.canonical);
        applied.push('canonical');
      }),
    });
  }

  if (typeof changeSet.robots === 'string') {
    rewriter = rewriter.on('head meta[name="robots"]', {
      element: guard('robots', (el) => {
        seen.robots = true;
        el.setAttribute('content', changeSet.robots);
        applied.push('robots_meta');
      }),
    });
  }

  // Remove JSON-LD we injected previously, so updates replace rather than stack.
  if (changeSet.jsonLd) {
    rewriter = rewriter.on(`script[${MARKER_ATTR}]`, {
      element: guard('ld-cleanup', (el) => el.remove()),
    });
  }

  // Everything that was missing gets appended just before </head>.
  rewriter = rewriter.on('head', {
    element: guard('head', (el) => {
      el.onEndTag(
        guard('head-end', (endTag) => {
          const additions = [];

          if (typeof changeSet.title === 'string' && !seen.title) {
            additions.push(`<title>${attr(changeSet.title)}</title>`);
            applied.push('title');
          }
          if (typeof changeSet.metaDescription === 'string' && !seen.description) {
            additions.push(`<meta name="description" content="${attr(changeSet.metaDescription)}">`);
            applied.push('meta_description');
          }
          if (typeof changeSet.canonical === 'string' && !seen.canonical) {
            additions.push(`<link rel="canonical" href="${attr(changeSet.canonical)}">`);
            applied.push('canonical');
          }
          if (typeof changeSet.robots === 'string' && !seen.robots) {
            additions.push(`<meta name="robots" content="${attr(changeSet.robots)}">`);
            applied.push('robots_meta');
          }
          if (changeSet.jsonLd) {
            const blocks = Array.isArray(changeSet.jsonLd) ? changeSet.jsonLd : [changeSet.jsonLd];
            for (const block of blocks) {
              additions.push(
                `<script type="application/ld+json" ${MARKER_ATTR}="1">${jsonLdPayload(block)}</script>`,
              );
            }
            applied.push('json_ld');
          }

          if (additions.length) endTag.before(additions.join(''), { html: true });
        }),
      );
    }),
  });

  // Selector-addressed content blocks.
  for (const block of Array.isArray(changeSet.blocks) ? changeSet.blocks : []) {
    if (!block || typeof block.selector !== 'string') continue;
    rewriter = rewriter.on(block.selector, {
      element: guard('block', (el) => {
        switch (block.mode) {
          case 'append':
            if (typeof block.html === 'string') el.append(block.html, { html: true });
            break;
          case 'prepend':
            if (typeof block.html === 'string') el.prepend(block.html, { html: true });
            break;
          case 'setAttribute':
            if (typeof block.attr === 'string' && typeof block.value === 'string') {
              el.setAttribute(block.attr, block.value);
            }
            break;
          case 'remove':
            el.remove();
            break;
          case 'replace':
          default:
            if (typeof block.html === 'string') el.setInnerContent(block.html, { html: true });
            break;
        }
        applied.push(`block:${block.selector}`);
      }),
    });
  }

  const transformed = rewriter.transform(response);

  // Headers are mutable on the transformed response and tell the verifier (and
  // anyone debugging) exactly what the edge did.
  const out = new Response(transformed.body, transformed);
  out.headers.set('x-aiva-version', String(changeSet.version ?? 0));
  // Rewritten HTML must not be cached as if it were the origin's own.
  out.headers.set('cache-control', 'no-store');
  return out;
}
