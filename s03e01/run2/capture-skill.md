---
name: capture
description: >-
  Turns a folder of mixed source files — audio, video, PDF, screenshots, whiteboard photos, board images, plain text — into one requirements list where every tagged requirement is cited to its file and its position in it. Use when several people sent material that must become one agreed list before anything is built. Not for a single file, and not for deciding which side of a disagreement wins.
license: MIT
metadata:
  author: patryk
  version: "1.0.0"
---

# Capture

Several people send what they want in whatever form they had: a voice memo, a screen recording, a spec PDF, a marked-up screenshot, a photo of a whiteboard, a link to a board that renders itself. Each one is easy to read alone. The work that gets skipped is putting them together without losing who asked for what — and that is what this skill produces.

## What it produces

One list, in three parts:

- **accepted** — every tagged requirement, each with the file it came from and where in that file.
- **conflicts** — every pair that cannot both hold, each with the one question that settles it.
- **unreadable** — every file that could not be read, and why. Silence about a file is worse than an honest gap.

A requirement is *tagged* when it carries a short id next to it (`R-7K2`, `R-2M`, any stable token). Untagged lines are context: they shape the build, but they are not what the list is held to.

## The rule that makes the list usable

**No requirement without a citation.** "Where in it" means something a person can open and check in one look:

- a text file or PDF: page, and a box on that page as 0–1 fractions of the page;
- an image: a box as 0–1 fractions of the image;
- a recording: seconds;
- something opened by a link: the link.

A list that says "the spec requires day-first dates" cannot be argued with. A list that says "R-Z2L, spec.pdf page 2 at y≈0.18" can be checked in ten seconds and settled.

## Steps

1. **Inventory before reading.** List every file with its type and size. This is the only moment you can notice what is missing: a source the sender mentioned that never arrived, or a link that points at a page instead of a file.
2. **Read each file with the reader its type needs** (table below). Do not read a PDF as text and stop there — geometry is part of the citation.
3. **Pull the tags.** Match the id pattern across every extracted text, then read the sentence around each one. A tag spoken aloud arrives with punctuation from speech-to-text ("R, K4H"): normalise, then confirm it against the audio, not the transcript alone.
4. **Write the citation at extraction time.** Do it while the reader is open; reconstructing a position later is guesswork.
5. **Look for disagreements, not just for requirements.** Two tags that cannot both hold is a conflict. A tag that a record in the data cannot satisfy is also a conflict — cite the record by its id. Do not count a disagreement between a tag and an untagged aside as a conflict; that is context, and it goes in the note, not in `conflicts`.
6. **Write the one question that settles it**, naming both sides: "R-Z2L says day first; R-M9H says month first like the boards. Which ships?" A question with one side named is a complaint.
7. **Check coverage before you hand it over.** Every file touched, every tag cited exactly once, every conflict naming two things, every unreadable file explained.

## Readers by file type

| Type | Reader | What it gives the citation |
| :--- | :--- | :--- |
| plain text, markdown | read the file | line or section |
| PDF | `pdftotext -layout` for the words, `pdftotext -bbox-layout` for the boxes | page + 0–1 box, from the word boxes |
| screenshot, photo, board image | look at the image itself | 0–1 box around the tag and what it marks |
| audio | speech-to-text with segment timestamps | seconds |
| video, screen share | speech-to-text **and** sampled frames | seconds; frames, because the screen carries what nobody says |
| a link to a live board | fetch it with the session that can open it, then read what it renders | the link |

## Failure modes this skill exists to prevent

- **Trusting the transcript of a screen share.** The recording in front of you may carry a tag nobody speaks: it appears on screen part-way through and only a sampled frame shows it. Sample the frames.
- **Reading the source file of a rendered board.** Boards that draw themselves serve scrambled tiles. Read the canvas the page shows, not the file behind it.
- **Silent gaps.** A recording that transcribes to one long block, an image read at a glance, a PDF's second page never opened. Each one drops a tag and nobody notices until the build is wrong.
- **Resolving the disagreement.** You are not the owner. Where sources disagree, the list records the question; a person with authority answers it.
- **Inventing a tag to fill a gap.** If a sentence reads like a requirement but has no id, it is context. Putting an id on it makes the list lie.

## Output shape

```
accepted:   { tag, source: { file, at?, region? } }
conflicts:  { tag, with, ownerQuestion, source }
unreadable: { file, why }
```

Send the list with the skill's own text beside it, so the next agent can run the same intake without this one.
