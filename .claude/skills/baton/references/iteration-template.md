# Iteration spec template

Save as `iterations/<TASK-ID>.md` next to the plan. Live status, owner and timestamps stay in the plan file, so this document never duplicates them.

```markdown
# <TASK-ID> — <title>

## Identification

Milestone: <id>; priority: <P0–P3>; risk: <low|medium|high>; estimate min/expected/max: <h>/<h>/<h>; role: <expertise>.

## Objective

<The one user-facing or engineering capability this delivers.>

## Dependencies

<Task IDs with type (hard, interface, research, asset, quality, approval) and any approval gate.>

## Scope

<Exactly what is built. Contracts and interfaces first, then the smallest integrated capability.>

## Out of scope

<Related work deliberately excluded, with the task that owns it.>

## Implementation plan

<Files and modules to create or change, and why.>

## Expected outputs

<Files, interfaces, tests, artifacts and reports that will exist afterwards.>

## Acceptance criteria

<Independently checkable statements. Each should name the input, the expected observable result, and the test or measurement that shows it.>

## Verification

Registered commands, all of which must exit 0:

- `<baseline check>`
- `<task-specific test command>`
- `<browser / performance / device command, if relevant>`

Manual or human evaluation, if any: <who and what; never replaced by automation>.

## Recovery

<How to revert; what evidence to preserve.>

## Completion evidence

<Filled at the end. Executed commands and exit codes, test counts, benchmark/report paths, review findings and fixes, known limitations.>

## Follow-up

<Newly unblocked tasks, discoveries, decisions and risks to record.>
```

## Definition of ready (quick check)

- [ ] All mandatory dependencies DONE; gate approved if any; no external blocker.
- [ ] Expected effort is 4–16 h, otherwise it is split.
- [ ] Out-of-scope section names related excluded work.
- [ ] Acceptance criteria are measurable and falsifiable.
- [ ] Task-specific verification commands registered in the plan.
- [ ] Owner assigned; write scope does not overlap other active work.
- [ ] Unknowns resolved or turned into an explicit spike.

## Definition of done (quick check)

- [ ] Every registered command run with a real exit code of 0.
- [ ] New tests shown to fail without the change.
- [ ] Independent review done or explicitly unavailable; P0/P1 findings fixed.
- [ ] Report written with limitations; no invented metrics or approvals.
- [ ] Plan transitioned with evidence; derived reports recomputed.
- [ ] State documents and changelog updated; handoff generated and archived.
