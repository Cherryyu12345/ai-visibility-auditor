# Wix: testing on a real trial account

The automated suite runs against a mocked Wix API, because we have no Wix
account. The mock encodes what the docs say; this checklist is how we find out
where the docs are wrong. **Work through it before connecting any client site.**

## The two things most likely to be wrong

1. **Which SEO base path is live.** Wix's reference documents the endpoint as
   `/seo-metatags-server/v1/item-seo-tags/...` but every cURL example on the
   same pages uses `/promote/seo/v1/item-seo-tags/...`. The client tries the
   documented one and falls back to the other on a 404. **Record which one
   actually answers** — the connection check reports it.
2. **Whether an API key really cannot write SEO tags.** The docs say the method
   needs "a Wix app or Wix user identity", and list "API key admin" as a third,
   separate identity. If an API key turns out to work, the connect flow gets far
   simpler and this should be revisited.

## Setup

1. Create a Wix trial site with a few static pages, a blog post and a store product.
2. In the [Wix Dev Center](https://dev.wix.com), create an app. Note the **App
   ID** and **App Secret**.
3. Add permission scopes: **SEO → Manage SEO Settings** and **SEO → View SEO
   Settings**.
4. Add an **App Instance Installed** webhook pointing at the app, so the
   instance id arrives on install.
5. Install the app on the trial site via its install URL. Capture the
   **instance id**.
6. Connect in the app using App ID + App Secret + instance id.

## Checks

| # | Action | Expected |
|---|---|---|
| 1 | Run the connection check | Passes; "SEO read access" names the base path that answered |
| 2 | Try connecting with an API key instead | "Credential type" fails and explains the identity rule. **If it succeeds, tell us** |
| 3 | List pages | Static pages, the blog post and the product all appear |
| 4 | Set a meta description on a static page | Applied; `publish: true` was sent |
| 5 | View the live page source | New description present. **It may lag — Wix caches** |
| 6 | Set a description in the Wix editor by hand, then apply a title change from here | The hand-set description **survives**. This is the big one: Wix replaces tags in full |
| 7 | Apply structured data | One `ld+json` block on the live page |
| 8 | Apply structured data again | Still **one** block, not two |
| 9 | Set a description on a store product | Applied with no `publish` flag; live immediately |
| 10 | Create an unpublished static page, then apply to it | Fails with `DRAFT_SAVED_NOT_PUBLISHED` and the "publish it first" message |
| 11 | Roll back a page that previously had tags | Previous tags restored |
| 12 | Roll back a page that had **no** tags | Item resets to inherited tags, not blank ones. Check the Wix SEO panel shows inherited values again |
| 13 | Bulk-apply to 3+ static pages, one with a bad id | Good ones apply; the bad one is reported, the rest unaffected |
| 14 | Try a multilingual site's secondary language | Expected to fail with `LANGUAGE_NOT_SUPPORTED` |
| 15 | Try to set tags on an `EVENTS_PAGE` | Refused before any request is sent |

## Verification behaviour to watch

16. After each applied change, confirm the change is marked **verified** only
    once the crawler fetch sees it. Wix's own `resolvedTags` is **not** a
    literal copy of the rendered head — site code and apps add tags during
    render — so `resolvedTags` agreeing is not sufficient and we do not rely
    on it.
17. For static pages, `tags` reads back the **saved revision**, never the
    published one. So a read-back that looks right does not prove the live page
    changed. Only the crawler fetch does.

## Token handling

18. Leave a connection idle for over four hours, then apply a change. It should
    succeed — the token refreshes automatically.
19. Revoke the app in the Wix site's dashboard, then apply a change. Expect a
    clear auth failure, not a hang or a generic 500.

## Scope failures

20. Remove the Manage SEO Settings scope and reinstall. A write should fail with
    a 403 naming the missing scope.
