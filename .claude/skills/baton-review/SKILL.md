---
name: baton-review
description: Reviews delivered MapX work against docs/baton/TASKS.json. It re-runs the registered verification of completed items, hunts bugs in changes since the last reviewed commit, exposes items falsely marked DONE (including legacy imports M0-01…M0-22), checks scorer and fixture claims, and realigns plan drift with remediation tasks. It records the reviewed commit automatically unless given an explicit commit or range, or asked for a full review. Use when asked to review, audit or double-check completed work, verify completion claims or check alignment with the plan. Not for planning or implementing new work; the baton skill does that.
---

# BATON review for MapX

A review answers three questions about delivered work, fixes what it can, and records where it stopped:

1. **Is it correct?** Look for bugs and regressions in what changed.
2. **Is it really done?** Every DONE item must meet its acceptance criteria with real evidence.
3. **Is it on plan?** Check dependencies, gates, scope and state documents.

`docs/baton/TASKS.json` is the source of truth. Reports, handoffs, CHANGELOG lines and agent summaries are claims to test. Project instructions (`CLAUDE.md`, `AGENTS.md`) override this skill.

## Choose the scope

The helper is read-only until `record`, and needs only git and Node ≥ 18:

```sh
S=.claude/skills/baton-review/scripts/review-scope.mjs
node $S scope [--json]              # since the last review (default)
node $S scope --commit REV          # one commit, when asked
node $S scope --range A..B          # a range, when asked
node $S scope --full                # whole repository, when asked
```

- **Default (incremental):** reviews everything since the marker in `docs/baton/reviews/state.json` (backed by `refs/baton-review/last`).
- **Uncommitted and untracked work is included** through a temporary index; your tree, index and branches are untouched.
- **An explicit commit, range or "full review" overrides the marker,** and doesn't move it unless the user asks.
- **Output:** the base and target, changed files with owning tasks, DONE items to re-verify, files no task accounts for, and plan-integrity findings. **Keep the printed `target` SHA**; recording needs it.
- **Legacy items:** M0-01 … M0-22 (`legacyId` I01–I22) carry baseline-only evidence (D002). In a full review, audit them criterion by criterion against `specs/iterations/<legacyId>.md` and the feature specs in their `sources`. Integrity lines saying "DONE … reached without VERIFYING" are expected for these imports.

## 1. Baseline

1. **Check for concurrent writers first** (other agent processes, very recent file changes, a changing index, someone else's IN_PROGRESS work). Don't review a moving target.
2. **Validate the plan** with `npm run plan:validate`.
3. **Scope it.** Run `scope`, then read `PROJECT_STATE.md`, `HANDOFF.md`, and the iteration specs and reports of the tasks in scope.
4. **Run the baseline once:** `npm run check` (run `npm ci --legacy-peer-deps` first if `node_modules` is missing). A failure is the first finding.

## 2. Re-verify completed work

For each item in `doneToReverify` (every DONE item in full mode):

- **Run each distinct registered command once** and share the result. Capture real exit codes; zsh uses `pipestatus`, so avoid pipes when the code matters.
- **Compare with the recorded evidence:**
  - test counts in `reports/<ID>.md`;
  - scorer recall and precision (`scripts/eval/score-*.ts --json`) against the numbers the report claims;
  - generated artifacts.
  A number that changed, or a pass that now fails, is a **regression**.

## 3. Bug review of the delivered change

Read `git diff BASE TARGET -- <task paths>` per task. The MapX hot spots:

- **Extraction correctness at boundaries:** regex detectors (`src/frameworks/detectors/*`) on multi-line calls, nested groups, comments and strings containing code, and Windows paths.
- **Resolution precision:** name-based resolution in `src/core/scanner.ts` across languages and repos, unknown source language, and missing `sourcePath`.
- **Data paths that silently drop fields:** a detector writes `metadata.x` while the edge builder reads `x`; the schema, store and graph disagree; or the scan summary disagrees with the stored rows.
- **Incremental scans:** stale edges after a file is deleted or renamed; framework edges cleared per repo.
- **CLI ↔ MCP parity:** a flag added to one but not the other; docs out of date.
- **Worker threads:** errors swallowed in `parse-worker.ts`, ordering and determinism of results.
- **Tests that pass without proving the claim:** components mocked out (for example an exporter that is only `vi.mock`ed), assertions on counts rather than identities, and snapshots of wrong behaviour.

Rules for findings:

- **Prefer independent reviewers** when available: give each a fresh agent, a disjoint task group, the acceptance criteria and the code, without your conclusions.
- **Every finding needs a concrete scenario** (input → wrong output) and a reproduction status. The cheapest repro is usually a probe script under the scratchpad calling a detector or parser directly, or a two-repo workspace scanned with `mapx scan . --all` and queried with `sqlite3 .mapx/mapx.db`.
- **Rank findings:** **P0** blocks acceptance, **P1** fix now, **P2** follow-up.
- **Mutation-check suspicious tests:** break the protected code, confirm the test fails, then restore it.

## 4. Completion audit

Give every DONE item in scope exactly one verdict:

| Verdict | Meaning |
| --- | --- |
| CONFIRMED | Every criterion maps to a test or measurement that exercises it and passes now |
| DEFECTIVE | Criteria met, but a bug exists (P0/P1/P2) |
| FALSELY COMPLETE | A criterion is unmet, or a claimed output does not exist |
| UNVERIFIABLE | Evidence is missing, unregistered, irreproducible, or not about the criterion |
| UNVERIFIED | Not examined in this review (say why); never silently promoted to CONFIRMED |

Check each item for:

- **Evidence:** registered commands with exit 0 and an existing artifact.
- **Tests on the real component:** not a mock.
- **Honest claims:** language, framework and tool counts match the code; size and performance numbers are measured (`gzip -c … | wc -c`, scorer output), not quoted from specs.
- **Consistent docs:** `README.md`, `docs/*.md` and the `CLAUDE.md`/`AGENTS.md` generated blocks agree with the code.

## 5. Deviation audit

Start from the script's integrity findings and unmapped files, then look for:

- work started with dependencies, gates or decomposition outstanding;
- WIP violations;
- unplanned work: changed files no task claims, CHANGELOG features with no task, or edits to `specs/` after D001;
- work listed under an item's own "Out of scope";
- specs contradicting the plan (paths, commands, criteria);
- stale `PROJECT_STATE.md` or `HANDOFF.md`;
- decisions taken without a `DECISIONS.md` entry;
- estimates far off.

## 6. Realign

| Class | Action |
| --- | --- |
| Mechanical drift | Fix directly: `affectedFiles`, commands, state documents, wrong numbers, missing changelog or decision entries. Then run `npm run plan:report` and `plan:handoff`. |
| DEFECTIVE, small and in scope | Fix it with a regression test, mutation-check it, re-run the item's commands, and add a dated "post-acceptance defect" section to its report. |
| DEFECTIVE and large, or FALSELY COMPLETE | Never rewrite DONE. Add `<ID>-R1` (BACKLOG or READY) whose acceptance covers the unmet criteria, and make it a hard dependency of the unstarted dependents. Mark the report "COMPLETION DISPUTED" and log it in `CHANGELOG.md`. |
| UNVERIFIABLE | Re-run and record the evidence if possible; otherwise treat it as FALSELY COMPLETE. |
| Scope change, gate bypass, approval issue, dependents already started | Stop, then present the evidence and the options to the user. |

Afterwards, re-run `npm run plan:validate` and `npm run check`.

## 7. Report and record

1. **Write the report** to `docs/baton/reviews/REVIEW-<yyyy-mm-dd>-<target12>.md` using [references/review-report-template.md](references/review-report-template.md).
2. **Record the marker** only after the report is written and the realignment is verified:

   ```sh
   node .claude/skills/baton-review/scripts/review-scope.mjs record --report docs/baton/reviews/REVIEW-….md --from <scoped target> [--full | --commit REV --advance | --range A..B --advance]
   ```

   Pass the same scope flags you reviewed with. The drift list it prints must contain only this review's own edits.
3. **Update the state documents** if the plan changed. Commit only when the user asks. `reviews/state.json` is meant to be committed; the ref is local.

## Boundaries

- Never fabricate approvals, evidence, verdicts or scorer numbers.
- If a check could not run, say so; never quietly downgrade a criterion to reach CONFIRMED.
- Ask first for destructive git operations, publishing, and changes to approved scope or gates.
