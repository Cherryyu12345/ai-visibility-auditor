# AI Visibility Auditor — publishing stage

Applies approved fix-pack changes to a consultant's live website, then proves
the change is actually visible to an AI crawler.

**Status:** all four connectors are built and tested — WordPress, Cloudflare,
Wix and Squarespace — on top of the shared spine.

## The idea in one paragraph

Every fix becomes a `Change` record. Nothing reaches a live site without
approval. Before applying we take a snapshot; after applying we re-fetch the
page as a plain HTTP client with an AI-crawler user agent, and only mark the
change `verified` if the change is genuinely there. Anything a platform cannot
do falls through to Cloudflare, and failing that to a manual instruction card.

## What research changed

Four assumptions in the original brief did not survive contact with the docs:

| Item | Finding |
|---|---|
| WordPress SEO plugins over REST | Yoast, Rank Math and AIOSEO all leave their fields unregistered for REST writes. We **probe** each site at connect time and prefer native writes where they work, otherwise use the companion plugin. AIOSEO stores data outside post meta, so it always needs the plugin. |
| Squarespace content API | Does not exist. The [official API list](https://support.squarespace.com/hc/en-us/articles/41325887099533-Developer-Tools-APIs-at-Squarespace) is commerce, domains and contacts only; the new MCP server covers domains and commerce. Squarespace is manual cards plus Cloudflare — but it now has a **native llms.txt panel**, which is better than routing that through Cloudflare. |
| Squarespace browser automation | **Dropped.** Squarespace's Acceptable Use Policy §1.6 bars access "by any means other than our publicly supported interfaces", and ToS §1.2 bars sharing account passwords. |
| Wix SEO | Better than expected — the Item SEO Tags API writes title, description, canonical, robots **and JSON-LD**. But it is in Developer Preview, and the auth spike confirmed an API key **cannot** write SEO tags: a Wix app must be installed. |

## WordPress connector

Everything is resolved against the live site rather than assumed. `testConnection`
runs seven checks and each failure carries a concrete remedy:

1. REST API reachable and `wp/v2` present
2. HTTPS (or a local environment — WordPress hides Application Passwords otherwise)
3. Authentication, **distinguishing a wrong password from a stripped `Authorization` header**
4. Edit permission for the connected user
5. Companion plugin present
6. SEO field writability — probed on a throwaway draft that is then deleted
7. Whether WordPress actually serves `robots.txt` (a static file on disk would silently win)

### Things that are easy to get wrong, and what we do

- **Page builders.** Elementor, Divi, WPBakery and Beaver Builder store the body
  outside `post_content`. Writing content there changes nothing, or detaches the
  layout. The connector refuses the write (`UnsafeWrite`) and routes it
  elsewhere. Builder meta is not exposed over core REST, so detection uses the
  companion plugin's computed field, then shortcodes, then fingerprints in the
  rendered HTML.
- **Auth diagnosis.** WordPress returns an identical `401 rest_not_logged_in`
  for a wrong password, a wrong username, a malformed header and no header at
  all. We verified this against a live site. The companion plugin exposes a
  booleans-only endpoint reporting whether PHP received the header; without the
  plugin we say we cannot tell rather than guessing.
- **JSON-LD injection.** Output is re-encoded server-side *with* slash escaping,
  so a `</script>` smuggled into a string value cannot break out of the block.
  There is a test for exactly that.
- **Caches.** Purged after every write via the companion plugin (WP Super Cache,
  W3TC, LiteSpeed, WP Rocket, Autoptimize, Cachify). Without the plugin we
  report that we could not purge rather than silently skipping it.

### Companion plugin

Single PHP file, no build step, readable before installing. Every route requires
an authenticated WordPress user with an explicit capability; there is no shared
secret. The one public route returns booleans only and exists precisely because
it is used when authentication is failing.

```bash
npm run plugin:build   # -> dist/plugin/ai-visibility-bridge.zip
```

## Cloudflare connector

The universal fallback. It rewrites pages as they are served, so it works on any
site behind Cloudflare whatever the underlying platform allows — which makes it
the only route for Squarespace and the escape hatch for locked-down WordPress.

Changes live in KV, one document per URL path, so updating a change is a KV
write and never a redeploy.

### The three rules in the Worker

1. **Fail open.** Any failure — KV unavailable, malformed changeset, an invalid
   selector, a handler throwing — serves the original page untouched. Every
   handler body is individually guarded, because once HTMLRewriter starts
   streaming the headers are already sent and recovery is impossible. Two tests
   cover this: a missing KV binding, and an invalid selector.
2. **Kill switch first.** One KV key disables every rewrite instantly, checked
   before any other work. No redeploy.
3. **Never shadow real content.** Synthetic pages are served only where the
   origin returns 404, so a real page added later always wins.

### What it will not do

`updatePage` refuses slugs (would break the origin), whole-page content
(would discard the real page) and excerpts (a CMS concept absent from served
HTML). Each raises `UnsupportedOperation` with the reason, which routes the
change to a manual card rather than failing silently.

### Onboarding

`checkDomain` reports zone status, proxy state, SSL mode and — for Squarespace —
whether `verify.squarespace.com` is still DNS-only. When the domain is not on
Cloudflare at all it returns ordered migration steps whose **first** item is the
email warning: moving nameservers moves all DNS, and a missed MX record stops
mail silently.

Sources disagree on whether Squarespace needs Full or Full (Strict), so the
checker accepts both and reports which is set rather than asserting one.

### The interface

```bash
npm run build
npm run key:init   # once: creates the master key outside the project
npm start          # http://127.0.0.1:4317
```

Three tabs, in the order the work happens.

**Connect website.** Type the address; the platform is detected from the live
site and shown with its confidence. Detection is a suggestion, never a
decision — when it is below 55% the override is pushed in your face, because
guessing wrong means asking for credentials that cannot work. Each connector
form states the least access that does the job: Editor for WordPress, a
single-zone token with four scopes for Cloudflare, a Wix app rather than an
account key. Connecting runs the connection test immediately and shows every
check with a remedy for the ones that fail, so problems surface while the
person is still sitting there. Disconnect deletes the stored credential.

**Changes.** The approval queue. Each change shows the page, the field, why the
audit proposed it, and the current value beside the proposed one. Every change
also carries a route badge — *via wordpress*, *via Cloudflare* or *by hand* —
**before** it is approved, since whether a change will be applied by an API or
handed to a human is exactly the sort of thing that changes whether someone
approves it. Manual changes show their instruction card inline.

Approve or reject per change, or approve all. **Dry run** resolves every route
and records the exact requests that would be sent, without sending any of them.
**Apply approved** takes a snapshot, applies, and then re-fetches each page as a
crawler to decide whether it worked.

**History.** Every applied batch with one-click rollback, the approval links
that have been issued, and the audit log: every approval, application, manual
check and rollback, with who did it and when.

### Share links

A consultant's client can approve changes without an account. The link is as
narrow as it can be made:

- it names an explicit list of changes and can reach no others;
- it can approve and reject, and nothing else — `apply`, `rollback` and
  `mark-done` return 404 through it, so a leaked link cannot touch a live site;
- it expires, defaulting to 14 days, and can be revoked;
- only a SHA-256 hash is stored, so the database cannot be read to recover a
  working link. It is shown once, at creation.

Approvals made through a link are recorded against `share:<id> (name)` rather
than the operator, so the audit log distinguishes them.

### What the engine guarantees

Three properties hold regardless of which connector is in play, and each has a
test that fails when the code stops enforcing it:

1. **Nothing is applied without approval.** `apply` only ever reads changes
   whose stored status is `approved`, and the store refuses the
   `draft → applied` transition outright.
2. **Nothing is verified on trust.** A change becomes `verified` only after the
   page is re-fetched as a crawler and the new value is actually found. A
   connector reporting success is not enough — and neither is a human pressing
   "I have done this", which re-checks the page and reports what it really says.
   The same applies in reverse: a rollback is only recorded once the page has
   been re-fetched and the old value is back (or, where there was nothing
   before, the new value is gone). This caught a real bug during testing — the
   engine was handing connectors a snapshot wrapped in its own metadata, so
   WordPress looped over an empty list and returned success having restored
   nothing.
3. **Everything is recorded.** The audit log is append-only: `appendAudit` is
   the only way in and there is no delete, which a test asserts by reflecting
   over the store's own methods.

### Connectors work cold

The engine builds a fresh connector for each apply and does not call
`testConnection` first — doing so would re-probe the site on every batch, and
the WordPress probe writes a throwaway draft. So no connector may require a
particular call order: `setSeoMeta` and `injectSchema` resolve what they need
on demand if nobody has told them. What the connection test worked out is also
stored on the connection and replayed, so the common path costs nothing.

This was the second bug the end-to-end run found: every WordPress SEO change
failed at apply time with "Call testConnection() before writing SEO fields",
while the router confidently sent them there because the *capability* had been
replayed from the stored test. Three integration tests now exercise a cold
connector against real WordPress.

### Routing is a chain, not a decision

`resolveRoute` predicts where a change will go. At apply time the engine walks
the whole chain — native, then Cloudflare, then a manual card — and a connector
that throws `UnsupportedOperation` falls through to the next rather than
failing. That matters because a declared capability is not a promise about a
specific change: WordPress will not overwrite builder-owned content, and Wix
will not move a slug, however true `updatePage: true` is in general.

## Testing

The Worker runs on the real Workers runtime (workerd, via Miniflare) — real
HTMLRewriter, real KV, real streaming. The Cloudflare API is mocked, because
there is no account to test against; [CHECKLIST-cloudflare.md](CHECKLIST-cloudflare.md)
covers what the mock cannot.

The test worth knowing about is `tests/worker/end-to-end.test.ts`: the connector
writes a changeset through the mocked API, the **exact source it uploaded** is
booted in workerd with the **exact KV it wrote**, and the result is checked with
the same crawler-UA verifier production uses. That is the one test that catches
the connector and the Worker disagreeing about key names or changeset shape —
a failure mode where each half passes its own tests while the pair does nothing.

## Wix connector

The strongest platform API after WordPress. The [Item SEO Tags API](https://dev.wix.com/docs/api-reference/business-management/seo/item-seo-tags-v1/set-item-seo-tags)
writes titles, descriptions, canonicals, robots directives **and structured
data**, per item, with a bulk call for whole-site batches. Page bodies and root
files have no API, so those route to Cloudflare or a manual card.

### The auth spike, and what it cost

This phase opened with a spike, because the answer decided the connect UX. It
is not the convenient answer.

Wix's [Identities doc](https://dev.wix.com/docs/overview/auth-permissions/identities)
lists five identities, and **"API key admin" is distinct from both "Wix app"
and "Wix user"**. The SEO write method states it works only "when authenticated
as a Wix app or Wix user identity", and the
[auth quick reference](https://dev.wix.com/docs/overview/auth-permissions/auth-quick-reference)
says acting as a Wix user is SDK-only, unavailable over REST.

So writing Wix SEO needs the **Wix app** identity: an app the consultant
installs on their site, authenticated with `client_credentials` against a
specific app instance. A pasted API key will not do it, and **Wix cannot be a
"three or four fields" connect step** like WordPress. It needs a Dev Center app,
scopes, an install flow and an instance id.

We still accept an API key, because a doc sentence is not a test. The connection
check probes a real read and reports what Wix actually said.

### Constraints that shape the code

- **Writes replace an item's tags in full.** Every write is read-modify-write.
  Skip the read and you silently delete the verification tags, Open Graph images
  and custom meta the consultant set by hand. There is a test for this, and it
  has been mutation-checked.
- **Items are addressed by type and id, never by URL.** A change recorded
  against a page URL is resolved through the listing first, with a clear error
  if that has not run.
- **Static pages keep a draft.** Without `publish: true` the change never goes
  live; with it and no published revision, Wix returns `DRAFT_SAVED_NOT_PUBLISHED`,
  which we translate into "publish the page in the Wix editor, then re-apply".
- **`resolvedTags` is not the rendered head.** Wix says so explicitly: site code
  and apps add tags during render. And for static pages, reads return the saved
  revision, not the published one. So the crawler fetch stays the only thing
  that marks a change verified.
- **`EVENTS_PAGE` is readable but not writable**, so it is excluded from the
  writable set and refused before any request is sent.

### A documented contradiction

Wix's reference gives the endpoint as `/seo-metatags-server/v1/item-seo-tags/...`
while every cURL example on the same pages uses `/promote/seo/v1/item-seo-tags/...`.
With no account to settle it, the client tries the documented path, falls back
to the example path on a 404, and remembers which answered. Both are tested.
[CHECKLIST-wix.md](CHECKLIST-wix.md) has it as item 1 to confirm on a real trial.

## Squarespace connector

Writes nothing, by design and by necessity. There is no API for page content or
SEO fields, and driving the admin UI was ruled out on terms-of-service grounds.
What it does instead is the honest version of the job: read the live site, work
out exactly which Squarespace panel each change belongs in, and produce an
instruction card precise enough to follow without thinking — then verify the
result the same way an API write is verified.

Every write capability is declared `false`. That is not a gap worked around
later; it is the accurate declaration that makes the router send each change to
Cloudflare or to a card.

### The cards

Every click path comes from Squarespace's own help centre, checked in November
2026 — these are instructions a consultant follows literally, so a stale panel
name wastes their afternoon. The routes differ per item kind, and getting that
wrong sends people hunting through a panel that lacks the field:

| Item | Route to the SEO tab |
|---|---|
| Page | Pages panel → hover → gear |
| Homepage | SEO/AI Visibility → SEO Settings → Search Appearance → Home |
| Blog post | Blog page → hover post → Edit → gear (7.1) |
| Product | Store page → **double-click** |
| Portfolio sub-page | `...` → Settings |

Three findings changed what the cards say:

- **Squarespace composes `<title>` from a format**, defaulting to
  `Page SEO Title — Site Title`. So the card tells the consultant *not* to type
  the site name — and the verifier was extended to accept that suffix for
  `seo_title`, not just `title`.
- **Per-page code injection is fragile on 7.1.** Squarespace warns that HTML in
  Page Header Code Injection disappears if the header's transparency is later
  turned off. The JSON-LD card carries that warning and points at Cloudflare,
  which is unaffected.
- **llms.txt is now native** (SEO/AI Visibility → SEO Settings → LLMS.txt), on
  7.1 only. Better than Cloudflare for this, so it is a card. On 7.0 there is no
  card and it routes onward.

### What gets no card at all

`robots.txt` and `canonical` return `null` rather than plausible-looking steps.
Every Squarespace site shares one robots.txt that nobody can edit — the Crawlers
checkbox is the only lever, and it is all-or-nothing, so it is offered as its own
separate card rather than dressed up as a robots.txt change. Canonicals are
managed by Squarespace with no field to edit. Both route to Cloudflare.

### Manual changes are still verified

A card's "mark done" does not record the change on trust. It re-fetches the page
as a crawler and only then marks it verified, exactly as an API write is handled.
A consultant who presses the button without doing the work gets "not verified",
along with what the page actually says.

## Testing

```bash
npm test                   # unit, app and Worker tests, no network
npm run test:integration   # boots real WordPress and exercises every method
npm run test:all           # both
npm run typecheck
```

The brief asked for Docker. This machine has no container runtime and
installing one needs admin rights, so the integration suite uses
[WordPress Playground](https://wordpress.org/playground/) instead: genuine
WordPress on genuine PHP compiled to WebAssembly, under Node, nothing to
install. It boots in about 13 seconds. The connector is exercised against a real
REST API and real rendered HTML — not mocks.

To use Docker instead once a runtime is available:

```bash
brew install colima docker docker-compose && colima start
```

## Security

- Credentials are sealed with envelope encryption (AES-256-GCM, per-credential
  data key wrapped by a master key). `AIVA_MASTER_KEY` belongs in a KMS; when it
  is absent the key is read from `~/.config/ai-visibility-auditor/master.key`,
  deliberately outside the project, because a key kept beside its own ciphertext
  is not encryption. The app refuses to start rather than storing anything in
  the clear.
- The server binds to loopback unless `AIVA_HOST` is set deliberately, and warns
  when it is. It holds credentials that can change live websites.
- A credential never leaves the process: the API returns `hasCredential: true`
  and never the value, and the audit log records which fields were supplied,
  never what they were. Both are asserted by tests that scan the whole response
  and the whole state file for the plaintext.
- Two-layer log redaction: by key name, and by registered secret value, so a
  credential pasted into a URL or an error string is scrubbed too.
- Dry-run mode records the exact requests without sending them, and never shows
  the `Authorization` value.

## Layout

```
src/core/        types, connector interface, routing, crypto, logging, verification,
                 manual instruction cards
src/detect/      platform detection from the crawl
src/app/         the publishing engine, HTTP API, server, routing chain
src/store/       append-only audit log, change lifecycle, sealed credentials
src/ui/          the three tabs and the share-link approval page (no build step)
src/connectors/  wordpress/ (client, seo, builders, cache)
                 cloudflare/ (api, onboarding, changeset, worker/)
                 wix/ (auth, api, seo)
                 squarespace/ (cards)
src/plugin/      the companion WordPress plugin
tools/           Playground harness, plugin zip builder
tests/           unit (no network), app (engine, store, API, server, share links),
                 worker (real workerd), integration (real WordPress)
```
