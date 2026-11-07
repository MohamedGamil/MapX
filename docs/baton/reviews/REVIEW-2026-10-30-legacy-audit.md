# BATON review 2026-10-30/31: criterion-level audit of legacy iterations (M0-41)

Scope: the 16 legacy iterations the import review left at baseline-only evidence. These are I01–I12, I17, I18, I20 and I21, imported as M0-01 … M0-12, M0-17, M0-18, M0-20 and M0-21.

Method: three independent review agents, each with a disjoint group and no access to the others' conclusions. They:
- listed every acceptance criterion and deliverable in `specs/iterations/I*.md` and the referenced `specs/features/F*.md`;
- checked each one, preferably by **probing the real CLI on temporary workspaces** (init + scan, then sqlite3 on `.mapx/mapx.db`), otherwise by reading the code with file:line.

The repo was not modified by the auditors. Their probe workspaces and scripts are under the session scratchpad (`audit-a1/`, `audit-a2/`, `audit-a3/`).

One auditor briefly saw a non-compiling `scanner.ts`: my own in-flight M2-07 edit, fixed minutes later. From then on it probed a snapshot copy, and no verdict depends on that edit.

## Summary

**0 of 16 iterations are fully confirmed.** 6 are FALSELY COMPLETE (deliverables missing) and 10 are DEFECTIVE. Most of the reported findings were reproduced with concrete inputs. They become 15 remediation tasks (about 139 h expected), three of which need an owner decision first (D010).

The old `specs/ITERATIONS.md` marked all of these "done" with no verification. This audit confirms risk R01.

| Iteration | Verdict | Main basis (details in the remediation tasks' acceptance criteria) |
| --- | --- | --- |
| I01 F01 verifiability | DEFECTIVE | Column, migration and PHP labelling met. JS/TS untyped member calls are never captured (so 0 inferred edges in TS); verified binding/implements edges are drawn dashed → **M0-01-R1** |
| I02 F03 glob filters | DEFECTIVE | Matcher before I/O, config and CLI patterns met. Re-including excluded files loses edges for good; `dir/*` prunes subdirectories; filtered exports leak cluster names → **M0-02-R1** |
| I03 F02/F04 metrics, edges | FALSELY COMPLETE | `metrics --format/--top`, PageRank column, `edges <file>`, `--direction`, multi `--type`, `--verified-only`, JSON default and absolute paths are all missing → **M0-03-R1** (epic, D010) |
| I04 F05/F06/F10 PHP fundamentals | DEFECTIVE | `use` FQNs parsed but never stored as import edges; same-namespace short names resolve to homonyms; facade map overrides explicit imports; Request/Response treated as scalars; qualified names in extends/implements not captured; Laravel excludes only applied at init → **M0-04-R1**, **M0-02-R1** |
| I05 F07/F08/F09 Laravel structure | FALSELY COMPLETE | **P0**: the scanner drops all reference metadata (relationship and binding types, facade alias); every route edge is `inferred`; resourceType dropped; no middleware edges; relationship display, LLM model section and controller grouping missing → **M0-05-R1**, **M0-03-R1** |
| I06 F11/F12 facades, dispatch | DEFECTIVE | **P0**: parallel scans (the default for more than 10 files) skip PHP post-processing, so facades, dispatch/notify and laravelRole vanish on real apps; `Event::dispatch(new X)` mis-targeted; `$listen` not done → **M0-06-R1** |
| I07 F13 npm | DEFECTIVE | Build, pack and provenance met. The unscoped `mapx` returns 404, yet docs and generated MCP configs run `npx -y mapx`; Node 18 excluded; NPM_TOKEN undocumented; binaries built without `--define` report 0.0.0 → **M0-07-R1** |
| I08 F14/F15/F16 clusters, trace | DEFECTIVE | Leiden merges two cliques joined by one edge; `--depth 0` = `--depth 1`; no penwidth; class-level trace returns 0 edges; fallback SVG styles; PHP directory clusters show 0 files → **M0-08-R1** |
| I09 F17 agent files | FALSELY COMPLETE | `--providers=all` rejected; sentinel before frontmatter (Cursor, Windsurf); `agents list` has no status; edited blocks overwritten silently; the update joins text onto the end line; SSE, slashCommands, Aider and Zed deliverables missing → **M0-09-R1**, **M0-03-R1** |
| I10 F18 workspaces | FALSELY COMPLETE | `--include-peers`, `--no-workspaces`, `status --all`, `export --all`, `deps --cross-repo` and the table columns are missing; JSONC `.code-workspace` ignored; `mapx_workspaces` lacks crossRepoEdgeCount; submodules typed as peers → **M0-03-R1** |
| I11 F19 context tools | DEFECTIVE | Search, context, node, files and status met. Impact: a `try` in a comment downgrades HIGH to LOW; import-only dependants missing; callees print the wrong file:line; stale warning persists after a same-content rewrite → **M0-11-R1** |
| I12 F20 languages | FALSELY COMPLETE | **P0**: import edges are never resolved for Java, Rust, Go, Python, Ruby, or C# `using`. **P0**: the Tier-3 installer is fictional (all grammars bundled; install/uninstall have no effect; no `lang info`; no shebang detection) → **M0-12-R1**, **M0-12-R2** (D010) |
| I17 F33 syntax coverage | FALSELY COMPLETE | JS 3 kinds and Python 4 (≥6 claimed); Ruby `< Base` target; C++ methods unscoped; C# interfaces as extends; Dart no call refs; naming defects (C++ template, Rust duplicates, Swift init, Scala import) → **M0-17-R1**. The Vue component and props gap is owned by M3. |
| I18 F34 TSX | DEFECTIVE (P2 only) | All F34 deliverables met. Anonymous default class methods are unscoped → **M0-18-R1**; untracked new files missed by sync → **M0-11-R1** |
| I20 F36 NestJS | DEFECTIVE | Routes, DI and hooks met. Decorator lookback leaks into the next class (phantom route and hook); GraphQL `@Query(() => T)` names `"("` with no operation type → **M0-20-R1** |
| I21 F37 noise | DEFECTIVE | `<top-level>` filtering met. Globals blacklist misses `.mjs/.cjs/.mts/.cts/.svelte`; try/catch detection is line-based (misses one-line tries, matches comments); new files are never flagged stale → **M0-11-R1** |

## Decisions needed (D010)

1. **Language tiers (M0-12-R2):** implement installable grammars, or amend the spec to "all bundled" and remove install/uninstall.
2. **Promised but unbuilt surface (M0-03-R1):** implement it, or amend the specs.
3. **Impact try/catch downgrade (M0-11-R1):** the spec never asked for it; keep it with AST-accurate detection, or remove it.
4. **Priority:** when should the 139 h of remediation run relative to M3?

## Not reviewed / limitations

- No real Laravel or polyglot application was available. Size claims such as "≥40% fewer files" are UNVERIFIABLE.
- TTY-only flows (`init` prompts) are UNVERIFIABLE.
- I13–I16, I19 and I22 were covered by the import review and their R1 tasks, not re-audited here.
