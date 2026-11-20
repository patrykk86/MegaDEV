# S04E05 · Building Self-Improving Engineering Systems

MegaDEV already records guarded actions, runs domain-agent scenarios, and collects recurring friction. This episode connects those pieces to the [S04E04 Host Desk handoff](../s04e04/host-desk/factory/CHECKLIST.md). One bounded workflow gives the team evidence to improve the system, an independent evaluator checks important promises, and a person decides which tested revision goes live.

| Principle | MegaDEV starting point | Proof to add |
| --- | --- | --- |
| Feedback | The [journal](../tools/journal.mjs) records redacted, hash-chained guarded calls. The factory checklist asks for stored delivery results. | Link a visitor receipt to the saved application record and detect a convincing reply that saved nothing. |
| Evaluation | The [domain-agent lab](../tools/domain-agents.mjs) has `Ask`, `Expect`, and `Never` scenarios. Its [workflow](../.github/workflows/domain-agents.yml) runs current checks for selected PR paths. | Check actual writes and add an independent evaluator that can catch a regression missed by the everyday suite. |
| Distillation | The [friction log](../tools/friction-log.mjs) records reproducible workarounds and routes open findings. | Group related incidents by evidence. Propose a script for repeatable work or an advisory role for recurring judgment. |
| Optimization and governance | MegaDEV has [resumable approvals](../tools/resumable-approval.mjs), and Git identifies and preserves revisions. | Bind a passing verdict and human approval to the same candidate digest. Restore the prior revision on demand. |

## Final lesson scope

Use Codex directly for explicitly requested delegation. Keep the main conversation on
the operator's selected model. For a bounded implementation or test task, prefer
`gpt-6.2-sol` at Low, with Medium for harder work that needs it. For an independent
read-only review, request `gpt-6-luna` at Max when the Codex session exposes that
combination. If the requested model or effort is unavailable, report that to the
operator. Give each worker the task, relevant files, access boundaries, and the
expected result. The main session verifies the result before relying on it.

This is a closeout convention for interactive Codex work. Formal review and security
checks continue to follow [MegaDEV's existing routing policy](../.clinerules).
The booking desk, sealed evaluator, Trainer, and promotion workflow are optional
lesson exercises. The [build guide](BUILD-GUIDE.md) preserves their design for reference.

## Reference exercise

Use a synthetic booking hold in Host Desk as the exercise. A hold is temporary and moves no money. The existing desk models payout and patch-review work, so a booking store and visitor surface are additions to the exercise. Keep the store and fixtures local and synthetic while working through the steps.

The domain-agent registry currently contains Agent-Loop and Memory-Journal. Booking is a proposed domain agent for the exercise. Its first expectations should cover the different lifecycles of a hold and a pending reservation, independent of the language used to describe them.

## Starting checks

Run these commands from the MegaDEV root to validate the registry and establish the everyday scenario baseline.

```powershell
node tools/domain-agents.mjs --validate --scenarios
node --test tools/domain-agents.test.mjs
```

The default scenario run uses local heuristics. It establishes a baseline for the existing agents. The [adapted build guide](BUILD-GUIDE.md) defines the evidence still needed for the booking exercise, sealed evaluation, training and promotion. The [source map](lesson-excerpt.md) connects each step back to the supplied lesson and transcript.

All six everyday scenarios and seven unit tests passed. The generated codebase map lists S04E05. The workspace static gate (`node tools/check.mjs`) remains open due to findings in earlier local artifacts and TypeScript errors in `mega-examples`.
