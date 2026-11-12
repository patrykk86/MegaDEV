# S03E04 — the paragraphs the course reply carried

Copied from the `mega-start` reply for 12 Nov 2026 (`lesson.text`), verbatim, with every gap marked. The
reply truncated the middle of the page at 23,246 characters, so the five body sections — Acceptance,
Verification, System Diff, Review, Quality Gates — arrived as the outline only below, and lines that
were cut mid-sentence are marked `[gap]`. The published page is behind the course sign-in, so this file
is the record of what was actually delivered, not a reconstruction of it.

---

Scaling multi-agent development and pushing it toward autonomy without first building trust won't work
and should be avoided, even if it means slowing development for a while. It needs to be clear that
**agents will happily build the wrong things fast**. That includes drifting away from the requirements,
but also finishing too early or too late. What's more, in many cases this behavior won't be wrong at its
core. It simply won't match our expectations and the processes specific to our product.

As in other areas of AI-native product development, verifying outcomes also has to rely heavily on
agents. But depending on our preferences and the product's features, we can build verification around
mechanisms that let us **understand and see the results**.

When this is done well, agents may provide valuable help even with the most critical parts of a system,
where we're often uncomfortable deploying any changes. This also makes possible refactoring that
wouldn't happen without AI due to its complexity and the risk that something will break.

The last thing to know before we start is that many activities we may want to consider for verifying
product outcomes can be designed with agents in mind **only**. It means that notes, artifacts,
evidence, tools and even entire modules may be built only for them. It's worth keeping in mind, because
it is not always obvious.

## Outline

- Acceptance: definition of done, requirements coverage, observable behavior, completion evidence
- Verification: regression tests, browser tests, synthetic scenarios, agent reviewers, deterministic checks
- System Diff: changes to behavior, user experience, data, architecture, complexity, operations
- Review: code, architecture, UX, accessibility, security, performance, maintainability
- Quality Gates: confidence thresholds, release blockers, known risks, rollback readiness, human approval

## Acceptance

`[gap: the reply carried this section only as far as "In lesson **S03E02**, we cov…" and then truncated;
nothing after that fragment arrived]`

---

`[gap: the page's Acceptance, Verification, System Diff, Review and Quality Gates sections were not
carried in the reply, apart from their closing passage and the takeaways below]`

---

Just by looking at the diagram above and thinking about our projects, we should get the first ideas of
what we may want to include. It is also a great exercise to download the repo and chat with an agent
about **[the tools](https://github.com/kody-hq/kody/tree/main/tools)** and their setup. After the
conversation we may want to ask the agent to review our project and suggest the most important quality
gates we may want to set up.

## Takeaways

This lesson should show us that building a process around verifying product outcomes can increase the
quality of the entire product, and our work can have a positive impact on other business areas, but
first and foremost on the users.

And it is clear that the process must be optimized for the software we're building and the way we work.
And even though today we discussed many aspects we may want to consider, it isn't recommended to rush
to build all of this at once. Building even a few pieces, and building them well, is a good start,
because it will show us how the gate behaves and whether it provides enough value or needs some tweaks.

When we think about this, verifying product outcomes with the workflows discussed today is only partly a
technical challenge, as it also requires **taking ownership of the outcome**, and that leads us to
**the mindset of a Product Engineer**.
