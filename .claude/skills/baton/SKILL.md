---
name: baton
description: Runs MapX's BATON loop (Baseline, Architect, Task, Observe, Next) on docs/baton/TASKS.json. It finds ready work, promotes items whose blockers have cleared, plans them into bounded iterations with fixtures and registered verification commands, then implements, verifies with real evidence, and hands off. Use when resuming or continuing MapX development, picking the next work item, planning or refining a task or milestone, or adding work to the plan. Not for one-off edits unrelated to the plan; reviewing delivered work is the baton-review skill.
---

# BATON for MapX

BATON turns the dependency plan into one verified iteration at a time:

- **Baseline:** establish the true state.
- **Architect:** promote eligible work and plan it until it is ready to start.
- **Task:** implement one bounded iteration.
- **Observe:** verify it with real evidence.
- **Next:** update state, recompute, hand off.

`docs/baton/TASKS.json` is the source of truth for status, dependencies, gates and evidence. Handoffs, summaries, CHANGELOG lines and agent reports are claims; check them against code and command output. `specs/` is frozen history (D001); cite `specs/features/F*.md` as design input through a task's `sources`, and never update `specs/ITERATIONS.md`.

Project instructions (`CLAUDE.md`, `AGENTS.md`) override this skill wherever they differ.

## Control plane

| What | Where |
| --- | --- |
| Plan, gates | `docs/baton/TASKS.json` |
| Requirement trace (report item → tasks) | `docs/baton/REQUIREMENTS.json` |
| Iteration specs | `docs/baton/iterations/<ID>.md` ([template](references/iteration-template.md)) |
| Evidence and reports | `docs/baton/reports/<ID>.md` |
| State | `PROJECT_STATE.md`, `HANDOFF.md`, `handoffs/`, `DECISIONS.md`, `RISKS.md`, `CHANGELOG.md` in `docs/baton/` |
| Generated (never hand-edit) | `CRITICAL_PATH.md`, `ITERATION_QUEUE.md`, `DEPENDENCIES.md`, `MASTER_ROADMAP.md`, `MILESTONES.md`, `reports/critical-path.json` |
| Gate approvals | `docs/baton/approvals/<GATE>.md` |

Commands (the plan tool owns every status field; never hand-edit `status`, `history`, `evidence`, `startedAt` or `completedAt`):

```sh
npm run plan:validate                 # schema, DAG, gate and evidence invariants
npm run plan:scan                     # READY / PROMOTABLE / NEXT WAVE / BLOCKED + plan gaps
npm run plan:ready                    # eligible items, ranked
npm run plan:transition -- <ID> <STATUS> [evidence.json] [--owner NAME]
npm run plan:report                   # regenerate derived reports and criticalPath flags
npm run plan:handoff                  # write HANDOFF.md
npm run check                         # plan:validate + typecheck + vitest + skill tests
```

The scanner is also usable directly: `node .claude/skills/baton/scripts/baton-scan.mjs [TASKS.json] [--json]`.

**Task ids** follow `M<n>-<nn>`, with remediation as `M<n>-<nn>-R<k>`. Milestones are declared in `TASKS.json` `milestones`. They are units of work, not releases (D007). Dependency types are `hard`, `interface`, `research`, `fixture`, `quality` and `approval`.

## 1. Baseline

1. **Check for concurrent writers before writing.** Look for other agent processes, files modified in the last few minutes, a git index changing between two looks, and IN_PROGRESS items owned by someone else. If another agent is active in the same scope, stop, report it and ask.
2. **Read the state.** Read `PROJECT_STATE.md` and `HANDOFF.md`, and run `git status -sb` and `git log --oneline -5`. MapX works on `develop`; feature branches are `feat/<id>-<slug>`.
3. **Validate the plan and scan it.** Run `npm run plan:validate`, then `npm run plan:scan`. Fix plan errors first.
4. **Run the baseline.** If `node_modules` is missing, run `npm ci --legacy-peer-deps` first. Then run `npm run check`. If it fails, fixing the baseline is the current iteration.
5. **Note drift** between the plan, the state documents and the code, to fix in step 7.

## 2. Promote

An item moves BACKLOG/BLOCKED → READY only when every one of these holds:

- all hard dependencies are DONE;
- its gate, if any, is APPROVED with a record in `approvals/`;
- no `blockingConditions` remain;
- it is not an epic.

Use `npm run plan:transition -- <ID> READY`. Never approve a gate yourself.

For BLOCKED NOW items:
- **Gate:** ask for approval only once reviewable evidence exists.
- **External condition** (for example "Owner decision: …"): ask the user that exact question. Record the answer in `DECISIONS.md`, then clear the condition with a structured edit of `blockingConditions`.
- **Epic:** decompose it.

## 3. Plan (Architect)

An item is ready to start only when all of these hold:

- **Bounded:** 4–16 h expected. Split anything larger into separately verifiable tasks with explicit dependencies, and log the split in `CHANGELOG.md`.
- **Fixture first:** parser, detector and resolution work is measured against a labelled synthetic fixture under `tests/fixtures/<area>/`, with a scorer in `scripts/eval/` where recall or precision matters (see `scripts/eval/score-routes.ts` and its floors in `tests/laravel-routes-fixture.test.ts`). Never use private or pilot source code in fixtures.
- **Prove behaviour end to end:** prefer `tests/helpers/e2e.ts` (temp workspace → real `mapx init`/`scan` → query `.mapx/mapx.db`) over tests that mock the store, since mocked-store tests have hidden real defects here.
- **Concrete scope:** one objective, an explicit out-of-scope list naming the tasks that own the excluded work, and the files touched (`affectedFiles`).
- **Falsifiable acceptance:** each criterion names an input, an observable output and the test that shows it. Reject vague wording such as "works well", "robust", "properly" or "optimized".
- **Commands registered before starting:** task-specific `npx vitest run tests/<file>.test.ts` and scorer commands, not just `npm test`.
- **Blast radius known:** run `npx tsx src/main.ts impact <symbol>` (or the `mapx_impact` MCP tool) on the symbols you expect to change, and note the result in the spec.
- **Unknowns settled** by the cheapest evidence, such as a probe script, a fixture scan or a source read. Record the decision, and escalate only genuine owner decisions.

Write the spec with [references/iteration-template.md](references/iteration-template.md). New tasks go into `TASKS.json` as BACKLOG through careful structured edits (keep every required field; `npm run plan:validate` must pass), and are then promoted with the tool.

## 4. Select and start

Rank by:
1. critical path (`*` in the scan);
2. priority;
3. most downstream work unblocked;
4. lower risk.

Allow one active iteration per owner. Parallel work needs disjoint `affectedFiles` (the scanner flags overlaps), stable interfaces and one integration owner.

Start with `npm run plan:transition -- <ID> IN_PROGRESS --owner <name>`, then branch if the user wants branches.

## 5. Task

- Implement the smallest integrated change that meets the acceptance criteria, following the surrounding code. Detectors live in `src/frameworks/detectors/`, parsers in `src/parsers/languages/`, tree-sitter queries in `queries/<lang>/`, and resolution in `src/core/scanner.ts`.
- Keep CLI and MCP in step: a new `mapx` command or flag usually needs its `src/mcp.ts` tool or parameter, `docs/cli-reference.md` and `docs/mcp-integration.md`.
- Bump the store schema version and add a migration for any change to the SQLite schema.
- Don't mix in unrelated work, add dependencies for future tasks, or update `VERSION` outside a release task.
- After changing files, re-scan MapX itself (`npx tsx src/main.ts scan .` or `mapx_sync`) when you rely on its graph for later steps.

## 6. Observe

1. **Run every registered command and capture real exit codes.** zsh has no `PIPESTATUS` (it uses `pipestatus`), so re-run without pipes when the code matters.
2. **Prove the tests can fail.** Temporarily revert the fix, confirm the new test fails, restore the fix, and record this mutation check in the report.
3. **Get an independent review when available.** Use a fresh agent given the acceptance criteria and the diff, not your conclusions, and ask for reproduced findings ranked P0/P1/P2. Fix P0 and P1 before DONE.
4. **Keep scorer numbers honest.** Report recall and precision exactly as the scorer prints them, before and after. Never tune a fixture label to pass.
5. **Write `docs/baton/reports/<ID>.md`:** what was delivered, each command with its exit code and counts, the mutation check, review findings and fixes, and limitations.
6. **Close the iteration.** Write an evidence file such as `/tmp/<ID>-evidence.json` containing `[{"command": "...", "exitCode": 0, "artifact": "docs/baton/reports/<ID>.md"}]`, with one entry per registered command. Then transition IN_PROGRESS → VERIFYING → DONE, passing the evidence file on DONE. If verification fails, transition to FAILED or stay open, and do not start dependent work.

**Defects after DONE:** DONE is terminal. Add `<ID>-R1` as a hard dependency of the unstarted dependents, and add a dated defect section to the report and to `CHANGELOG.md`.

## 7. Next

1. Run `npm run plan:report` (it also refreshes the `criticalPath` flags).
2. Update `PROJECT_STATE.md`, plus `DECISIONS.md`, `RISKS.md` and `CHANGELOG.md` when they changed. For user-visible changes, add an entry to the root `CHANGELOG.md` under Unreleased that ends with the task id, e.g. `(M1-03)`. `npm run check` fails on any Unreleased entry without a known task id (`scripts/baton/check-changelog-coverage.mjs`).
3. Run `npm run plan:handoff`, then copy `HANDOFF.md` to `handoffs/<date>-<ID>.md`.
4. Re-scan and loop.

**Stop when** a gate or owner decision is needed, a blocker or failure remains, the session limit is near, or the user asked for one iteration. Leave the repository passing `npm run check`, and say what is next and what the user must provide.

## Approval boundaries

Ask first for:
- `npm publish`, tags, version bumps and releases. Releases are **owner-initiated** (D007): never request the `G-RELEASE` gate, never propose a release because a milestone finished, and leave user-visible changes under CHANGELOG `[Unreleased]`. Gates marked `ownerInitiated` in TASKS.json are the owner's to raise;
- pushing, or any destructive git operation;
- changes to approved scope or milestones;
- new runtime dependencies with non-permissive licences.

Commit only when the user asks. Routine reversible implementation details need no approval.
