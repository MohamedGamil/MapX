# Review report template

Save as `docs/baton/reviews/REVIEW-<yyyy-mm-dd>-<target12>.md`. Keep it factual: every claim should point to a command, a file, or a reproduction.

```markdown
# BATON review <yyyy-mm-dd> — <mode> <base12>..<target12>

Scope: <incremental since REVIEW-… | commit REV | range A..B | full>. Working tree included: <yes/no>.
Environment: <OS, runtime and tool versions>. Reviewer(s): <agent/session; independent reviewers used or unavailable>.

## Summary

<Three to six lines: overall health, counts per verdict, P0/P1 count, realignments made, decisions needed from the user.>

## Re-verification

| Command | Exit | Result vs recorded evidence               |
| ------- | ---- | ----------------------------------------- |
| `<cmd>` | 0    | <counts/checksums match; or what changed> |

## Completion audit

| Item | Verdict                                                 | Basis                                           |
| ---- | ------------------------------------------------------- | ----------------------------------------------- |
| <ID> | CONFIRMED / DEFECTIVE / FALSELY COMPLETE / UNVERIFIABLE | <criterion → test/evidence; or what is missing> |

## Findings

### P0/P1/P2 — <short title> (<ID>, `path:line`)

Scenario: <input → wrong result>. Reproduced: <yes, how / no, why>.
Resolution: <fixed + regression test + mutation check | remediation task <ID>-R1 | needs user decision>.

## Plan deviations

| Deviation                     | Evidence | Realignment                                            |
| ----------------------------- | -------- | ------------------------------------------------------ |
| <e.g. files outside any task> | <paths>  | <plan metadata updated / remediation task / escalated> |

## Realignment verification

<Commands re-run after fixes, with exit codes; plan validation result.>

## Decisions needed

<Only items that genuinely need the user: scope, gates, approvals, purchases. "None" if none.>

## Not reviewed / limitations

<What could not run (devices, credentials, network), sampling choices in large scopes, and anything left for the next review.>
```
