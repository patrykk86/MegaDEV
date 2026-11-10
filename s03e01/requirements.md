# S03E01 — requirements list for the night status page (accepted)

Built with the `capture` skill (`~/.agents/skills/capture/SKILL.md`). Six sources, 15 tagged
requirements, 3 disagreements. The course accepted this list on 2026-11-10, and the page built from
it is live at https://megadevpat.web.app/status/ with its JSON at `/status/status.json`.

## Accepted (10)

| Tag | Requirement | Source |
| :--- | :--- | :--- |
| R-H5X | The status JSON answers with `Access-Control-Allow-Origin: *`, because the tram boards read it from their own pages. | `memo.m4a` at 5.42 s |
| R-L9M | Every status JSON carries `updatedAt` in UTC ending in `Z`. | `memo.m4a` at 18.82 s |
| R-Z2X | The page heading says "Status for the night", those exact words. | `memo.m4a` at 25.04 s |
| R-K2L | `Cache-Control` max-age 45 seconds or less, the boards poll that often. | `memo.m4a` at 32.04 s |
| R-M4X | Footer states all times are UTC. | `recording.mp4` at 23 s (on screen, never spoken) |
| R-K4H | Every line gets its own row on the page, tram 3 included. | `recording.mp4` at 6.18 s |
| R-H6X | The page says "tram 3 boards poll this page". | the board link, region 0.05/0.57/0.53/0.16 |
| R-L5X | `status.json` `updatedAt` is the ops feed's own value, read live, never a copy. | `whiteboard.jpg` region 0.18/0.32/0.38/0.11 |
| R-H9X | The banner stays red, exactly the one in the mock. | `screenshot.png` region 0.74/0.11/0.16/0.13 |
| R-L2Z | Newest incident at the top. | `spec.pdf` p1 region 0.118/0.454/0.294/0.016 |

## Conflicts (5 entries, 3 disagreements)

The list carries both sides of a pair so each tag is cited exactly once. The owner is asked once per
disagreement — see `owner-questions.md`.

| Tag | Against | Owner | The one question |
| :--- | :--- | :--- | :--- |
| R-M9H (month-first dates) | R-Z2L (day-first dates) | product | Which format ships on the page? |
| R-Z3L (whole week) | R-K8X (last night only) | product | Which scope ships? |
| R-K5Z (each incident names who ran it) | record 6045 (empty author) | on-call | Who ran 6045, or does it ship unnamed? |

## What the course's refusals taught, in case this page is ever rebuilt

- The banner colour is `#d6453d` exactly; an approximation is refused.
- The footer phrase is "all times UTC" exactly.
- "Last night" is the night shift's night: the previous evening from 18:00 UTC plus the small hours of
  the newest date. A calendar day drops incident 6041, which the page must show.
- R-K4H is accepted, not a conflict: the spec's "one row per incident" is untagged context, so it
  cannot be the other side of a tagged disagreement.

## How each file was read

| File | Reader |
| :--- | :--- |
| `memo.m4a`, `recording.mp4` | OpenRouter `openai/whisper-large-v3`, verbose JSON with segment timestamps |
| `recording.mp4` frames | the file played in a browser I control, paused at a second, captured over CDP |
| `spec.pdf` | `pdftotext -layout` for words, `-bbox-layout` for the citation boxes |
| `screenshot.png`, `whiteboard.jpg` | read as images |
| board link | fetched inside the signed-in Challenge page; the board draws itself on a canvas, so the canvas was read, not the scrambled PNG behind it |

## Ops feed, as read

`2026-11-10T19:29:00Z`: six incidents, 2026-11-01 to 2026-11-03. The page shows five of them, the
night shift's last night; incident 6040 (2026-11-01) stays off it.
