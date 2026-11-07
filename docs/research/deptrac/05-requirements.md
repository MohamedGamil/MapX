# Requirement register: architecture rules

Revision 2, 2026-10-31, integrated into `docs/baton/REQUIREMENTS.json` the same day (D013). The JSON register is authoritative for status and task mapping; this document records the acceptance checks and the revision history.

Conventions follow the existing register: `category` is `ARCH`, `priority` P1–P3 (no P0 is claimed for an unapproved milestone), `status` PLANNED, `source` points at this file plus the AR/G ID. MoSCoW: **MUST** = P1, the minimum for a usable Deptrac-equivalent; **SHOULD** = P2; **COULD** = P3.

## MUST (P1): the CI gate

| ID | Requirement | Acceptance (what the verifying task checks) | Delivered by | Verified by |
|---|---|---|---|---|
| REQ-ARCH-001 | Layers are declared in `.mapx/architecture.jsonc` with `path`, `name`(+kind), `role`, `cluster`, `repo`, `language`, `layer` and `all/any/not` selectors; membership is explainable (which selector matched). Overlay layers are target-only. | Every selector has positive and negative fixture rows in PHP, TS and Python; `arch which <element>` prints the matching selector. | M5-02, M5-03 | M5-98 |
| REQ-ARCH-002 | Allow-rules with default deny, `+` transitive allowances, `*`, `!`, per-rule severity and edge-type scope. A `+` cycle is a configuration error naming the cycle. | Fixture rows for each operator; precedence `!` > allow > `+` > `*` tested. | M5-04 | M5-98 |
| REQ-ARCH-003 | Every in-scope dependency is classified as allowed, violation, skipped, uncovered, warning or error by a **named rule**, located at file:line, with a **line-independent fingerprint**. | Recall and precision ≥ 0.95 per kind on the fixture; fingerprints unchanged after inserting blank lines. | M5-04 | M5-98 |
| REQ-ARCH-004 | `mapx check` reports as table or JSON and exits 0 (clean), 1 (violations), 2 (uncovered/unassigned when asked), 3 (config or baseline errors), 4 (stale graph or internal error). | One CLI test per exit code on the built binary; JSON byte-identical across two runs. | M5-05 | M5-18 |
| REQ-ARCH-005 | A baseline turns known violations into skipped findings; stale entries are errors; `--compare <base-report.json>` fails only on fingerprints new since the base. | Generate → re-run → 0 violations; remove the offending import → exit 3; `--compare` fails only on the one injected violation. | M5-06 | M5-18 |
| REQ-ARCH-006 | A labelled polyglot fixture (PHP, TS, Python, Go, plus a two-repo workspace) and a scorer measure recall and precision per finding kind, with a recorded 0.0 baseline before the engine exists. | `score-arch.ts --json` runs on the fixture and the 0.0 baseline is in the M5-01 report. | M5-01 | M5-98 |
| REQ-ARCH-007 | Inferred (heuristic) edges never fail CI by default; `policy.inferred: "error"` promotes them. | Fixture row with an inferred edge → severity warn by default, error when promoted. | M5-04 | M5-98 |
| REQ-ARCH-008 | Without an architecture config, MapX behaviour is unchanged: smells, edge counts, metrics, PageRank and exports. | MapX self-scan regression test: `mapx_smells`, `metrics` and `edges` outputs identical to the pre-M5 run. | M5-16, M5-12 | M5-16 |

## SHOULD (P2): parity with Deptrac's remaining features, plus the MapX-native wins

| ID | Requirement | Acceptance | Delivered by | Verified by |
|---|---|---|---|---|
| REQ-ARCH-009 | CI reporters: SARIF 2.1.0, GitHub annotations (auto-selected under `GITHUB_ACTIONS`), CodeClimate with a severity map, JUnit (suite per layer). | SARIF validates against the vendored schema; golden files per reporter. | M5-07 | M5-18 |
| REQ-ARCH-010 | Introspection: `arch layers --why`, `which`, `unassigned` (exit 2 when non-empty), `deps`, `unused --limit`, `changed [--since ref]`, `allowed <from> <to>`, all with `--json`. | Exact-JSON fixture test per subcommand; legacy `mapx arch` flags unchanged. | M5-08 | M5-08 |
| REQ-ARCH-011 | Hierarchy selectors `extends`, `implements`, `inherits`, `mixes`, `inheritanceDepth` and the `member` selector, evaluated over transitive ancestry. | Transitive `extends` through an intermediate base matched in PHP, TS, Python and Java fixtures. | M5-09 | M5-98 |
| REQ-ARCH-012 | Decorators/attributes and doc tags are captured in symbol metadata for PHP, TS/JS, Python, Java/Kotlin and C#, and usable through `decorator` and `docTag` selectors. | Per-language fixture asserts the metadata; MapX self-scan symbol and edge counts unchanged. | M5-10 | M5-98 |
| REQ-ARCH-013 | Visibility: `private` selectors (rule `private-layer`) and internal markers (rule `internal-element`) from configurable doc tags; language-native markers opt-in. | Fixture rows reach recall/precision 1.0; native markers add only the expected Go and Python findings when enabled. | M5-11 | M5-98 |
| REQ-ARCH-014 | External, builtin and ambient references are persisted **outside `edges`** with ecosystem, package, direct/transitive and dev/prod attribution for npm, Composer, pip and Go; `package`, `builtin`, `ambient` selectors; uncovered reporting. | Vendor-confinement and dev-dependency rows reach 1.0 for the four ecosystems; existing metrics unchanged. | M5-12 (epic) | M5-98 |
| REQ-ARCH-015 | MCP tools `mapx_arch_check`, `_layers`, `_allowed`, `_explain`, `_init` return capped JSON with truncation totals; agent templates instruct a pre-flight `mapx_arch_allowed` before cross-module imports. | Round-trip test per tool; `_init` never writes without `write: true`. | M5-14 | M5-14 |
| REQ-ARCH-016 | Layer graph as DOT, SVG and Mermaid, and a policy-coloured layer DSM, with groups, hidden layers and point-to-group. | Golden outputs; hidden layers absent from drawing but present in counts. | M5-13 | M5-13 |
| REQ-ARCH-017 | Rule-derived smells (`layer-cycle`, `dead-allowance`, `weak-allowance`, `layer-skip`, `unstable-layer-dependency`, `abstractness-distance`, and `vendor-leak`/`undeclared-dependency`/`dev-dependency-in-prod`/`deprecated-usage` once 012/014 land) with a single source for `layer-violation`. | No duplicate layer violations with a config present; positive and negative case per smell. | M5-16 | M5-98 |
| REQ-ARCH-018 | `mapx arch init` proposes a config (and optional baseline) from roles, clusters, framework edges or a shipped preset; dry-run by default. | On the Laravel and NestJS fixtures the proposed config checks with 0 config errors; `--baseline` then `check` exits 0. | M5-17 | M5-17 |
| REQ-ARCH-019 | MapX enforces its own architecture in CI and documents every selector, rule, reporter and exit code. | CI step passes on `develop`; a deliberate forbidden import on a throwaway branch fails it. | M5-18 | M5-18 |

## COULD (P3)

| ID | Requirement | Delivered by |
|---|---|---|
| REQ-ARCH-020 | Dashboard Architecture view: layer diagram with drill-down, layer DSM, findings table, health tiles. Demoted from SHOULD: R06 (no UI tests) and the D006 bundle ceiling make it the costliest surface per unit of value. | M5-15 |
| REQ-ARCH-021 | `--since <git-ref>` ratchet without a base report (requires a second scan at the ref). Deferred: expensive and cache-dependent; `--compare` covers CI. | none yet |
| REQ-ARCH-022 | Inherited-dependency derivation (subclass inherits ancestors' dependencies, reported with `via`). | M5-09 (behind `policy.inheritDependencies`) |
| REQ-ARCH-023 | Custom selectors and rules as user plugins. | none yet |

## Out of scope (recorded so they are not re-litigated)

- New framework entity kinds (e.g. "Symfony Form", "Django admin") beyond what detectors already persist as edges. The `framework` selector is derived from stored `route`, `middleware`, `relation`, `dispatch`, `notify`, `graphql_resolver`, `render` and `http` edges only.
- Replacing MapX's parsers or adding languages. Selectors degrade gracefully (path-based fallback) where a language has no namespaces or inheritance edges.
- Deptrac config import (`deptrac.yaml` → `.mapx/architecture.jsonc`). Cheap to add later as a preset-like converter; not required.

## What changed in this revision (draft 1 → draft 2)

1. **Overlay layers** (AR-03): `Deprecated`, `Vendor`, `DevOnly` are target-only. Draft 1 would have emitted a `multi-layer` warning for every deprecated class, which would have made the warning useless.
2. **`framework` selector grounded in what exists** (AR-04): defined over stored edges, since detectors persist routes, hooks and edges but no per-symbol entity type. Draft 1 listed kinds (`page`, `store`, `component`) nothing emits.
3. **Ratchet redesigned** (AR-10): `--compare <base-report>` is the MUST; `--since <git-ref>` is deferred to COULD because it needs a second scan and its result depends on cache state. `arch changed --since` keeps the cheap git-diff file list.
4. **Element granularity made explicit** (AR-01): symbol layers = own selectors ∪ file's path-based layers; file layers = path-based ∪ its top-level symbols'; no symbol-to-symbol leakage in multi-class files.
5. **`*` and `!` precedence defined** (AR-05): `!` > allow > `+` > `*`; `*` as a key means defaults for every source layer.
6. **Requirements expanded from 4 to 23** with MoSCoW, acceptance checks and a verifying task each, mirroring the structure of the existing `REQ-LAR/HTTP/VUE/QA` entries.
7. **M5-98 no longer hard-blocked on the M5-12 epic** (an epic must be decomposed before it can be DONE; its iterations become the hard dependencies when planned).
8. **Dashboard demoted to P3**; **M5-01 estimate raised** to 10/12/16 h for four languages plus a workspace; **M5-06 reduced** to 5/7/10 h and risk low after dropping the git-ref scan.
9. Removed the claim that `mapx arch init` output should be trusted as-is: it is a proposal for human review (AR-15 already said so; the requirement now says it too).

## Integration scope (applied 2026-10-31)

| Target | Change |
|---|---|
| `docs/research/deptrac/` (new) | Move `01`–`05` and `README.md` from `scratch/deptrac/` (task `sources` already cite this path) |
| `docs/baton/TASKS.json` | Append milestone `M5` and the 19 tasks (all `BACKLOG`; `M5-12` is an epic) |
| `docs/baton/REQUIREMENTS.json` | Append `REQ-ARCH-001` … `023` |
| `docs/baton/DECISIONS.md` | New `D012` recording the owner's answers to the open decisions (ordering vs M3/M4, config path, verb, exit codes, external-refs storage) |
| `docs/baton/RISKS.md` | Scanner contention (M5-12 vs M4-03/M4-04); R06 extended to the Architecture view |
| `docs/baton/iterations/M5-01.md`, `M5-02.md` | First-wave iteration specs |
| `docs/baton/CRITICAL_PATH.md`, `DEPENDENCIES.md`, `MASTER_ROADMAP.md` | Regenerated by `npm run plan:report` |
| `docs/baton/PROJECT_STATE.md`, `HANDOFF.md` | M5 row and "Next" updated |

Not touched: `src/`, `tests/`, `specs/` (D001), `CHANGELOG.md`, `VERSION`.
