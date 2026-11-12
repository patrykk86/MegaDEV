# Out of office (S03E03) — where it stands

Written 2026-11-11 at the end of the working session. Everything below is what actually ran, not a plan.

## Live

- **API:** https://sched-prod-api-production.test8674.workers.dev — `GET /incidents`, `GET /incidents/{id}`,
  `?status=` and `?since=` filters. Reads `FEED_URL` from the round's feed, set per deploy with
  `wrangler deploy --env production --var FEED_URL:<url>`; `[env.production]` does not inherit top-level vars.
- **Source:** `s03e03/starter/sched-prod-api/src/index.js` (starter untouched otherwise: `contract/`, `decisions/`,
  `research/`, `wrangler.toml`, `package.json`).
- **Deploy:** `cd s03e03/starter/sched-prod-api; npx wrangler deploy --env production --var FEED_URL:<feed>`
  with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from `.env`.

## The agent

`s03e03/ooe-runner.mjs` — polls the tracker every 25 s, marks each issue, decides per the grown
`triage` skill, ships to the Worker, reads the live answer, writes one ship line per issue.

```sh
node s03e03/ooe-runner.mjs --base https://hq.mega.dev/challenges/out-of-office/tracker \
  --token-file .runs/ooe/tracker.token \
  --live https://sched-prod-api-production.test8674.workers.dev \
  --feed <the round's feed url> --max-minutes 30 --poll 25000
```

- `--once` runs one cycle; `--selftest` makes one model call and writes nothing; `--build-issue <n>` builds
  from the owner's signed record with no room to re-decide.
- Machine-local state, logs and receipts in `.runs/ooe/` (gitignored): `state.json`, `result.json`,
  `tracker.token`, `round.txt`, `runner.log`, `tracker.log.jsonl`, `versions/`.

## Rules the course enforced, learned the hard way today

1. A record must carry `issue: <n>` in its frontmatter, and the owner's signature must exist **before** any
   close, decline or ship line. Missing the `issue:` line is `no_record`; work before the answer is
   `built_before_answer`; work before the signature is `no_record`.
2. A round is refused permanently at its first violation, and claims are budgeted per day. An iteration
   costs one open plus one claim, so read `decisions/TEMPLATE.md` before round one.

## Where it stopped

Round 5 delivered all six issues (one shipped live from the owner's answer, two closes and one decline
resting on records the owner signed, one close on "already ships", one decline on the contract's 404 line)
and the claim was refused with **"No claims left today"**. Not a verdict on the work.

Next step, tomorrow: `claim-challenge` with `{ "round": <receipt in .runs/ooe/round.txt>, "url": <live> }`.
If the round has expired, press Start over on the Challenge page, open a new round, redeploy with the new
`FEED_URL`, clear `.runs/ooe/state.json`, and run the same command.
