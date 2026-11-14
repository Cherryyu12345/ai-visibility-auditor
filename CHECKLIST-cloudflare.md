# Cloudflare: testing on a real account

The automated suite runs the Worker on the real Workers runtime (workerd, via
Miniflare) and the Cloudflare API against an in-memory mock. That covers the
Worker's behaviour and the request shapes, but **not** these, which need a real
account and a throwaway domain. Work top to bottom; each step says what should
happen.

## Setup

1. Create an API token (My Profile → API Tokens → Create Token → Custom token):
   - Zone → **Zone** → Read
   - Zone → **Workers Routes** → Edit
   - Account → **Workers Scripts** → Edit
   - Account → **Workers KV Storage** → Edit
   - Zone → **Zone Settings** → Read *(optional; without it the SSL check
     reports "could not read" instead of failing)*
   - Zone Resources: **Include → Specific zone → your test domain only**
2. Connect the test domain in the app and run the connection check.

## Checks

| # | Action | Expected |
|---|---|---|
| 1 | Run the connection check before deploying | Every check passes except "Worker deployed", which offers Deploy |
| 2 | Press Deploy | KV namespace `ai-visibility-auditor-changesets` appears; Worker `ai-visibility-auditor` appears; route `yourdomain.com/*` appears |
| 3 | Load the site | Identical to before. Deploying alone changes nothing |
| 4 | Apply a meta description change, then view source | New description present; `x-aiva-version: 1` response header |
| 5 | Apply a second change to the same page | `x-aiva-version: 2`; both changes present |
| 6 | Fetch `/robots.txt` | Served from the edge, `content-type: text/plain` |
| 7 | Fetch `/llms.txt` | Served, even though the origin 404s it |
| 8 | Turn the kill switch on, reload | Original page, instantly, no redeploy |
| 9 | Turn it off, reload | Changes back |
| 10 | Roll back a change | Page reverts; verification confirms |
| 11 | Set SSL mode to Flexible, re-run the check | "SSL mode" fails with the Full remedy |
| 12 | Grey-cloud the root record, re-run the check | "Proxy (orange cloud)" fails |
| 13 | Press Disconnect / Undeploy | Route and Worker gone; site serves unmodified |

## Fail-open check (do this one deliberately)

14. In the Cloudflare dashboard, edit the deployed Worker and add `throw new
    Error('boom')` as the first line of `fetch`. Reload the site.
    **Expected: the site still loads**, unchanged. Cloudflare serves the origin
    when a Worker throws before returning a response.
    Then press Deploy again to restore the real script.

## Squarespace-specific (needs a Squarespace trial on the test domain)

15. Before proxying: confirm `verify.squarespace.com` CNAME exists and is
    DNS-only (grey cloud).
16. Proxy the root and www records only. Leave verify DNS-only.
17. Set SSL mode to **Full** (not Flexible, not Strict initially).
18. Load the site, click through several pages, submit a form, and if there is
    a store, complete a test checkout.
19. Re-run the connection check — the Squarespace verification check should
    pass and still show the "not officially supported" warning.
20. In Squarespace: Settings → Domains → confirm the domain still shows as
    connected and verified.

**If anything breaks at 18–20, grey-cloud everything and stop.** Squarespace
will not help debug a proxied setup. The manual-card route is the fallback.

## Email safety (only when moving nameservers)

21. Before changing nameservers, export the existing DNS and confirm Cloudflare
    imported every **MX** record and every **TXT** record (SPF, DKIM, DMARC).
22. After the zone goes active, send a test email to an address on the domain
    and confirm it arrives.
