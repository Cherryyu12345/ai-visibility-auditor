# Squarespace: testing on a real trial account

Squarespace applies nothing automatically, so what needs testing is different
from the other connectors: **are the instructions correct?** A card that sends
someone to a panel that does not exist is worse than no card.

Every click path was taken from Squarespace's help centre in November 2026.
Panel names change. Re-check this list whenever a card looks wrong.

## Setup

1. Create a Squarespace **7.1** trial with: a normal page, a blog page with one
   post, a store with one product, and a portfolio page.
2. Note the plan. **Code injection needs Core, Plus or Advanced** — on a trial
   below that, the JSON-LD cards cannot be followed at all.
3. Connect the site in the app by URL.

## Does the connector read correctly

| # | Action | Expected |
|---|---|---|
| 1 | Run the connection check | Platform confirmed; version detected as 7.1 |
| 2 | Read the "Applying changes" row | Says plainly that nothing is applied automatically |
| 3 | List pages | Pages come from `/sitemap.xml`; blog and shop URLs are typed correctly |
| 4 | Open a page | Current title, description and canonical are read from the live page |

## Do the instructions actually work

Follow each card **literally**, without using prior knowledge. If you have to
improvise, the card is wrong.

| # | Card | Confirm |
|---|---|---|
| 5 | SEO description, ordinary page | Pages panel → hover → gear → SEO tab → SEO Description exists exactly as described |
| 6 | SEO description, homepage | SEO/AI Visibility → SEO Settings → Search Appearance → **Home** tab |
| 7 | SEO description, blog post | Blog page → hover post → Edit → gear (top-right) → SEO tab |
| 8 | SEO description, product | Store page → **double-click** the product → SEO tab |
| 9 | SEO description, portfolio sub-page | `...` → Settings → SEO tab |
| 10 | SEO title | Check the browser tab afterwards: it should read `Your title — Site Title`. **The site name appends itself** — if the card made you type it, that is a bug |
| 11 | JSON-LD, site-wide | Code Injection panel → Header. View source: the block is inside `<head>` |
| 12 | JSON-LD, single page | Page settings → Advanced → Page Header Code Injection |
| 13 | After #12, toggle the header's transparency off in the site styles | **Does the injected code disappear?** Squarespace warns it does on 7.1. If so, the caveat is right and per-page JSON-LD should go through Cloudflare instead |
| 14 | llms.txt | SEO/AI Visibility → SEO Settings → **LLMS.txt** tab. `yoursite.com/llms.txt` returns the text |
| 15 | llms.txt disable | Delete on the same tab, then Save. The URL stops returning it |
| 16 | noindex | Page settings → SEO tab → "Hide this page from search engines" |
| 17 | Slug change | Confirm Settings → Developer Tools → **URL Mappings** is where redirects go |

## Verification behaviour

18. After following a card, press **Mark done**. It must re-fetch the page as a
    crawler and only then record the change. Press it *before* making the change
    and confirm it reports "not verified" with what it found instead.
19. Squarespace caches. If verification fails on the first attempt but the
    change is visible in a browser, note how long it took to appear.

## What should have no card at all

20. A **robots.txt** change offers no steps, and routes to Cloudflare. Confirm
    the UI explains that every Squarespace site shares one uneditable robots.txt.
21. A **canonical** change offers no steps and routes to Cloudflare.
22. The **AI crawler** card is offered separately: Settings → Crawlers →
    "Block known artificial intelligence crawlers". Confirm the checkbox exists
    and that it is genuinely all-or-nothing.

## Version 7.0

23. If you can get a 7.0 site, confirm the cards name the **SEO Appearance**
    panel rather than SEO/AI Visibility, and that llms.txt produces no card and
    routes to Cloudflare.

## Cloudflare combination

24. Work through [CHECKLIST-cloudflare.md](CHECKLIST-cloudflare.md) steps 15–20,
    which cover proxying a Squarespace domain. That is the only way to apply
    canonicals, a custom robots.txt, or per-page JSON-LD without the
    transparency problem.
