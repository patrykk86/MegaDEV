# S03E01 run 2 — log

Every request, reply and reading for this run, in order. Tokens are masked.

## What this run is

- `start-challenge` for `c0000000-0000-4000-8000-0000005e03e1` returned a run-2 brief: pack
  `pack-a9e32a26.zip`, list first, then the page deployed on Cloudflare Workers.
- The Challenge page reports `Solved Tue 10 Nov · run 2 in progress`, so run 1 is already solved.

## Pack

- Downloaded to `run2/pack/`. Six files.
- **The pack is byte-identical to run 1's**: every SHA-256 matches (`memo.m4a`, `recording.mp4`,
  `screenshot.png`, `spec.pdf`, `whiteboard.jpg`, `board-link.txt`). So the sources are the same
  material under a new pack id, and run 1's accepted list is the correct starting point rather than a
  guess. Every citation below was still re-checked in this run.

## The source that lives only on the Challenge page

- `board-link.txt` says the board's link is on the Challenge page, not in the pack.
- `run2/links.js` over CDP listed the page's links and found the `tram 3 board` link. The signed link
  is refused as a direct navigation (it lands back on the Challenge page), so `run2/click-board.js`
  follows it as a click from the page.
- The board renders to a canvas, so the text is empty and the canvas is the source: `canvas-grab.js`
  returned a 47,763-byte PNG (`run2/board.png`). It reads: `R-H6X status page: say "tram 3 boards poll
  this page"`. Region measured on the canvas: `0.05/0.66/0.52/0.14`.

## Readings and what each one gave

| Source | Reader | Tags found |
| :--- | :--- | :--- |
| `memo.m4a` | segment transcript | R-H5X `5.42` ("RH5, X"), R-L9M `18.82` ("RL9, M"), R-Z2X `25.04`, R-K2L `32.04` |
| `recording.mp4` | word timestamps plus sampled frames | R-K4H `6.18`; R-M4X on screen at `23` ("R-M4X footer: all times UTC", frame-23) |
| `spec.pdf` | page text with boxes | R-L2Z p1, R-K5Z p1, R-Z2L p2, R-K8X p2 |
| `screenshot.png` | the image itself | R-H9X, R-M9H |
| `whiteboard.jpg` | the image itself | R-L5X, R-Z3L |
| the board (link only on the page) | its canvas | R-H6X |

Nothing was unreadable: six sources, six readers, no gap.

## Claim

## Claim result

- Step one **accepted on the first attempt**. Status `progress`, a receipt issued for step two.
- The course's own line: `no guesses in it. one of them answered you.` It asks for no action; `next` is
  step two.
- The receipt is held in this session only, and is passed inside `answer` to the step-two claim. It is
  not written here, and no token is written to any file in this folder.

## Build (step two)

- `run2/worker/core.mjs` — the core the course already accepted, copied byte for byte from
  `s02e03/firebase/functions/status-core.mjs` rather than retyped, so the page keeps the exact banner
  colour, footer words and scope rules that passed in run 1.
- `run2/worker/index.mjs` — the Worker: `GET /` is the page, `GET /status.json` is the data, both read
  the feed per request, both carry `Access-Control-Allow-Origin: *` and `Cache-Control: max-age=45`.
- `run2/worker/wrangler.toml` — name `night-status`, no bindings, no secrets, `workers_dev = true`.
- `run2/worker/verify-local.mjs` — runs the handler in plain Node against the live feed, reusing the
  fourteen checks from `s03e01/verify-live.mjs`.

Result: **14/14**, routes `/` 200, `/nope` 404, `POST /` 405.

## Blocked on the host

- No `wrangler` on this machine (not on PATH, not in `node_modules`, not in the npm prefix).
- No `CLOUDFLARE_API_TOKEN` or `CF_*` value in `.env`, and none anywhere in the workspace.
- So the Worker is proven locally and not deployed. Needs: approval to install wrangler, and a Cloudflare
  account reached either by `wrangler login` or by a `CLOUDFLARE_API_TOKEN` with Workers edit rights.
