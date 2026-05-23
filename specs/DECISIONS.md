# Architecture Decision Record (ADR) Log

Significant design decisions made during planning or implementation. Each entry records the context, the options considered, the decision taken, and the consequences.

---

## Template

```
## ADR-XXX — <short title>

| Field | Value |
|-------|-------|
| Date | YYYY-MM-DD |
| Status | proposed / accepted / superseded / deprecated |
| Iteration | IXX |
| Supersedes | ADR-XXX (if applicable) |

### Context
<!-- What situation or constraint triggered this decision? -->

### Options considered
1. **Option A** — description, pros, cons
2. **Option B** — description, pros, cons

### Decision
<!-- What was chosen and why. -->

### Consequences
<!-- What becomes easier, harder, or constrained as a result. -->
```

---

## ADR-001 — `verifiability` stored as TEXT column, not separate table

| Field | Value |
|-------|-------|
| Date | 2026-05-22 |
| Status | `accepted` |
| Iteration | I01 |
| Supersedes | — |

### Context

F01 needs to distinguish verified edges from inferred ones. Two structural options exist: annotate the existing `edges` row, or create a parallel `edge_labels` table.

### Options considered

1. **TEXT column on `edges`** — `ALTER TABLE edges ADD COLUMN verifiability TEXT DEFAULT 'verified'`. Simple, zero join cost at query time, backward-compatible default.
2. **Separate `edge_labels` table** — normalised, but requires a join for every query that filters by verifiability and complicates the write path.

### Decision

Option 1 (TEXT column). The set of values is small and stable (`verified`, `inferred`). A column default of `'verified'` keeps all existing edges valid with no data migration.

### Consequences

- All existing queries continue to work unchanged.
- `mapx metrics --verified-only` is a single `WHERE verifiability = 'verified'` clause.
- If a third label is ever needed the column approach scales without schema restructuring.

---

## ADR-002 — Glob patterns matched at discovery time, not parse time

| Field | Value |
|-------|-------|
| Date | 2026-05-22 |
| Status | `accepted` |
| Iteration | I02 |
| Supersedes | — |

### Context

F03 adds `--include`/`--exclude` glob support. The question is where in the pipeline to apply the filter: before or after reading file content.

### Options considered

1. **Discovery-time filtering** — skip paths during directory walk before any `fs.readFile` call.
2. **Parse-time filtering** — read all files, discard results after parsing if path matches an exclude pattern.

### Decision

Option 1 (discovery-time). Excluded files should incur zero I/O cost. This is especially important for large `vendor/` or `dist/` directories that may already be partially covered by default excludes but need project-specific overrides.

### Consequences

- Scanner `walkDirectory` must accept a compiled glob matcher before yielding paths.
- Config-level patterns (from `.mapx/config.json`) and CLI flag patterns must be merged before the walk begins.
- Files excluded at discovery time will not appear in `status` change tracking either, which is the desired behaviour.

---

## ADR-003 — Canonical schema version sequence for all planned iterations

| Field | Value |
|-------|-------|
| Date | 2026-05-22 |
| Status | `accepted` |
| Iteration | Cross-cutting (I01, I08, I10, I13) |
| Supersedes | — |

### Context

Multiple specs claimed the same schema version number (particularly v3 being claimed by both F01/I01 and F14/I08 and F21/I13). This caused confusion during planning and would cause migration failures at runtime. A canonical, non-conflicting version sequence was needed.

### Options considered

1. **Claim versions as features merge** — let each PR bump the version to the next available integer at merge time. Flexible, but requires coordination and could lead to re-ordering.
2. **Pre-assign a canonical sequence during planning** — assign schema versions upfront to all features that require migrations, regardless of merge order. Merge order must respect the sequence.

### Decision

Option 2 (pre-assigned canonical sequence). The following version assignments are canonical and must not be reordered:

| Schema Version | Feature | Iteration | Migration |
|---------------|---------|-----------|-----------|
| **v2** | baseline | — | existing schema (`CURRENT_SCHEMA_VERSION = 2` in `store.ts`) |
| **v3** | F01 | I01 | `ALTER TABLE edges ADD COLUMN verifiability TEXT DEFAULT 'verified'` |
| **v4** | F14 | I08 | add `clusters` table, `cluster_membership` table, `namespace` on `files` |
| **v5** | F18 | I10 | `ALTER TABLE edges ADD COLUMN target_repo TEXT` |
| **v6** | F21 | I13 | `ALTER TABLE edges ADD COLUMN metadata TEXT` |

Features that do not require schema migrations (e.g. F02, F03, F05–F13, F15–F17, F19–F20, F22–F28) do not bump the version.

### Consequences

- Specs for F01, F14, F18, F21 have been updated to use their assigned version numbers.
- Iteration ordering constraints: I01 must merge before I08; I08 must merge before I10; I10 must merge before I13 (or the migration chain must be applied as a combined migration if iterations are squash-merged out of order).
- Any future feature that requires a schema migration takes **v7** and must be documented in this ADR.
- The `store.ts` constant `CURRENT_SCHEMA_VERSION` must be updated to match the highest version after all planned iterations are merged (v6).
