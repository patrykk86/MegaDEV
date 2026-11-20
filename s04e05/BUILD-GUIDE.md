# S04E05 · Build guide for MegaDEV

These steps are reference exercises. The [final lesson scope](LESSON-NOTES.md#final-lesson-scope) covers simple Codex dispatch.

## 1. Prove one visitor workflow locally

1. Start with a synthetic guest and one stay. Give a fresh visitor the address and the goal of finding a price and placing a temporary hold. Record where it gets stuck. Add a short discovery guide such as `llms.txt` with the supported actions and their meaning, then repeat with the same task and a fresh visitor.
2. Add the smallest local booking path. Expose policy lookup, quote and hold. Give the conversational desk only those capabilities. Typed actions can call the same booking service directly, with the same identity, validation and persistence rules. Keep refunds and payouts with the existing owner-reviewed flow.
3. Check request size, visit rate and available model budget before an accepted conversational request can invoke a model. Authenticate and authorize the guest before any hold write. Bind the repeat key to the guest and normalized request. Persist the decision and hold atomically, so retries return the saved outcome and concurrent guests cannot both acquire the same stay.
4. Derive the reference, stay, price and expiry from the saved hold. Record the execution path, outcome, latency and any reported model cost or cache usage in a scrubbed receipt. Route unsupported owner decisions into a structured review record.
5. Score the visitor flow against the store with a fresh fixture per case. Keep the existing lab's text expectations and add an independent assertion for what was saved. Prove the assertion catches a plausible success reply with no row and a repeat that creates two rows. Deployment is a later decision after the local proofs.

| Case | Evidence |
| --- | --- |
| Authorized guest quotes and holds | One saved hold. Confirmation fields equal the stored values. |
| Guest repeats the same request | The reference is stable and the store still contains one hold. |
| Same key with different details | The changed request is handled explicitly and the original hold remains intact. |
| Two guests compete for one stay | Exactly one hold is committed. |
| Visitor is signed out or at the hold limit | The store shows zero new holds. |
| Visitor asks the desk for a refund | The owner review record exists and money state stays unchanged. |
| Visitor exceeds a pre-model limit | The result shows the limit and the model invocation count stays at zero. |

## 2. Seal the cases and run them on changes

1. Write the everyday Booking scenarios in the existing domain-agent format. Have the operator write additional cases for promises that matter, including the distinction between an expiring hold and a pending reservation that has no hold timer.
2. Keep sealed cases and detailed evaluator output under a separate identity or execution environment. On Windows, use an independently permissioned account or an isolated runner with no sealed-case mount for the candidate process. Prove access with two checks. The evaluator can read a synthetic control file, and the candidate process is denied access to that same file. A folder outside the checkout alone gives no access guarantee.
3. Run the candidate with the minimum supplied input and an evaluator controlled by the operator. Release only opaque case IDs and pass counts to the operator-facing summary. Keep prompts, answers and detailed failures inside the evaluator. Repeat model-dependent cases and require every run to pass.
4. In a disposable copy, introduce a plausible glossary edit that gives pending reservations a hold timer. Show that the everyday cases can remain green while the sealed promise fails. Record the candidate revision, evaluator revision and result. A missing or inaccessible suite records an explicit failure to evaluate.
5. Extend the existing domain-agent CI pattern when the evaluator is ready. Select the affected agent from changes to its folder or its declared owned paths, comparing a merge to its first parent. Ensure the workflow triggers for those paths too. Record the result on the candidate revision and leave the code in place for review. An unrelated change should report that no agent was affected.

## 3. Try a bounded Trainer and require two keys

1. Take a baseline of the Booking glossary and everyday scores. Give a tool-free Trainer the role, current glossary, relevant scrubbed memories and everyday case scores. Let code enforce fixed round and spend ceilings and accept only glossary text into a candidate location.
2. Compare each candidate with the baseline on the same everyday cases. Retain the best qualifying improvement. Stop when the ceiling is reached or further rounds give no improvement. Submit the selected candidate once to the sealed evaluator, which keeps its case data and scores out of Trainer inputs.
3. Record the exact candidate digest, baseline revision, evaluator revision and verdict. Require explicit human approval of that digest and recheck the candidate and active baseline before promotion. Save the prior active revision before switching. A changed candidate requires fresh evidence and approval.
4. Dry-run the lifecycle. Exercise missing approval, a modified candidate, unavailable sealed cases, a passing approved candidate, and restoration of the prior revision. Confirm the active revision at each step.

## 4. Find one candidate for the next agent

Review scrubbed [friction records](../tools/friction-log.mjs) alongside relevant [journal](../tools/journal.mjs) receipts. For each recurring problem, cite the observations, describe the work it costs, and check the [domain-agent registry](../agents/) for an existing owner. For repeatable steps, consider a deterministic script. For recurring judgment, draft a role and its expected behavior. The operator picks at most one candidate after reviewing the evidence.
