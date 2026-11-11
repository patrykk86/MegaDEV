# S03E01 — the night status page, verified where it runs

Approach two. Approach one turned six sources into the accepted list (`requirements.v6.md`) and built
the page from it, then verified a **local server** (`site/verify.mjs`). This approach trusts nothing it
has not just fetched: it asserts the deployed page and its JSON against that same list, with the ops
feed as the source of truth.

## Run it

```sh
node s03e01/verify-live.mjs          # a table; exits 0 only when all fourteen hold
node s03e01/verify-live.mjs --json   # the same result, machine-readable
node --test s03e01/verify-live.test.mjs
```

## Result

Fourteen checks hold against https://megadevpat.web.app/status/ and its `status.json`:

| Tag | What it asserts |
| :--- | :--- |
| R-H5X | the JSON answers `Access-Control-Allow-Origin: *` |
| R-L9M | `updatedAt` is UTC and ends in `Z` |
| R-Z2X | the heading is "Status for the night", those exact words |
| R-K2L | `Cache-Control` max-age is 45 seconds or less |
| R-M4X | the footer states all times are UTC |
| R-K4H | every line of last night has its own row, tram 3 included |
| R-H6X | the page says "tram 3 boards poll this page" |
| R-L5X | `updatedAt` equals the ops feed's own value, read live |
| R-H9X | the banner is the red from the mock, `#d6453d` |
| R-L2Z | the newest incident sits at the top |
| R-Z2L | dates ship day first, as the spec writes them |
| R-K8X | only the last night is shown, so record 6040 stays off the page |
| R-K5Z | record 6045 ships unnamed, as product decided |
| AGREE | the page and the JSON report the same instant |

## Why R-L5X is the one that matters

Approach one could not prove it: a local server reads whatever feed it is pointed at, so it agrees with
itself. Here the check is an equality between the deployed `updatedAt` and the feed's own `updatedAt`
fetched in the same run, so a value baked in at build time fails even when the build was correct.

The route it proves: `/status` and `/status/**` are hosting rewrites to the `status` function
(`s02e03/firebase/firebase.json`), and that function reads the feed per request with `cache: 'no-store'`
(`s02e03/firebase/functions/status-core.mjs`).

## A caution learned in this session

Reading `s03e01/ops-feed.json`, a saved snapshot stamped `19:29:00Z`, against a page already serving
`20:44:00Z` looked exactly like a stale deployment. It was a stale snapshot. Only the live feed settles
it, which is why the check fetches the feed rather than a file.

## The negative control

`verify-live.test.mjs` builds a conforming snapshot, asserts that all fourteen pass, then breaks one
requirement per case - fourteen mutations - and asserts the matching check goes red. Without that, a
column of PASS lines is an impression, not evidence. The control caught a flaw in its own fixture first:
the fixture had no tram 3 row in last night, so R-K4H failed against a snapshot that should have passed.

## What the page does with the disagreements

The three unresolved pairs are printed on the page under "Open questions for product", with their
internal tags. The accepted list routes those to an owner instead, and a public status page that shows
requirement ids is a product decision rather than a harness one. Left as deployed and flagged here.

## What is left

The course accepts the list (done on 2026-11-10) and then the page. That step happens on the Challenge
page behind the course sign-in, so it needs the operator.
