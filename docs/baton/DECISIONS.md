# Decisions

Planning and architecture decisions made under BATON. Earlier decisions are in `specs/DECISIONS.md`.

## D001 — Adopt BATON; TASKS.json is the source of truth (2026-10-30)

MapX moves from `specs/ITERATIONS.md` plus per-iteration markdown to the BATON control plane used in OmniStrike:
- `docs/baton/TASKS.json` holds status, dependencies, gates and evidence;
- `scripts/baton/` (`npm run plan:*`) owns every status change;
- `docs/baton/iterations/<ID>.md` holds each iteration's spec.

`specs/` stays as frozen history and design reference. Feature specs `specs/features/F*.md` are cited from task `sources`.
Why: the old log marked I01–I22 done with no recorded verification. Per-iteration files contradicted it (I18, I19, I22), and post-I22 work had no iterations at all.

## D002 — Legacy iterations imported as DONE on baseline evidence (2026-10-30)

I01–I22 become M0-01 … M0-22 (`legacyId` keeps the old id). Their evidence is the baseline run at import (`reports/M0-BASELINE.md`), not per-criterion proof. Disputed items get remediation tasks (`<ID>-R1`). Terminal DONE states are never rewritten.

## D003 — Skills live in `.claude/skills/` (2026-10-30)

OmniStrike keeps skills in `.agents/skills/` and symlinks them from `.claude/skills/`. In MapX, `.agents/` is gitignored because `mapx agents generate` writes there (`src/agents/templates.ts`). So `baton` and `baton-review` live directly in `.claude/skills/`, and AGENTS.md points other harnesses to them.

## D004 — Milestones follow releases; fixtures before fixes (2026-10-30)

M1 (0.4.0), M2 (0.5.0) and M3 (0.6.0) each start with a labelled synthetic fixture and a recall/precision scorer (M1-01, M2-02, M3-01). Fix tasks depend on their fixture, so each gain is measured, following the report's suggestion to re-measure after every release. Publishing a release requires an owner-approved gate (`G-REL-x.y.z`).

## D005 — Do not ship source maps in the npm package (2026-10-30)

Owner decision: stop shipping the 7.8 MB `dist/ui/main.js.map`. UI source maps become opt-in with `MAPX_UI_SOURCEMAP=1` for local debugging. The bundle-size target (I15's <200 KB gzipped) is still open as M0-15-R2.

## D006 — Dashboard bundle target re-baselined to a 720 KiB ceiling (2026-10-30)

Owner decision: set a new target instead of reducing the bundle to I15's <200 KB gzipped. `dist/ui/main.js` measured 690,760 bytes gzipped, mostly Cytoscape and its layout plugins. The new target is a **regression ceiling of 737,280 bytes (720 KiB) gzipped**, about 6.7% headroom, enforced by default in `scripts/check-package.ts` and in CI. Raising it needs a new decision entry with the measured cause.

## D007 — Releases are owner-initiated, not milestone-driven (2026-10-30)

Owner decision: 0.4.0 is not released at the end of M1. A release happens only when the owner, after several iterations, judges that the accumulated changes warrant one, and signs off manually. Consequences:
- milestones carry no release version;
- the release task (M1-99) is DEFERRED;
- gate `G-REL-0.4.0` becomes `G-RELEASE` with `ownerInitiated: true`.

Agents never request this gate, never bump `VERSION` and never publish. Unreleased work keeps accumulating under CHANGELOG `[Unreleased]`.

## D008 — HTTP call-site contract: `.mapx/http-calls.json` (2026-10-30)

Frontend HTTP calls are persisted like routes, in `.mapx/http-calls.json`. It holds one record per client call site:

```
{ file, line, method, rawUrl, url, pattern?, route: { method, path, handlerSymbol?, handlerFile } | null }
```

- **`url`** is resolved: base URL joined with axios semantics, constants and template parts substituted, and unknown parts written as `{}`.
- **`route`** is the paired backend route; `null` means unmatched.
- **Writers:** M2-03 writes `file`, `line`, `method` and `rawUrl`; M2-04 and M2-05 fill `url`; M2-06 fills `route` and adds `http` edges.
- **Scorer:** `scripts/eval/score-http.ts` reads only this file, so the scorer (M2-02) can be built before any extractor exists.

Why: it mirrors `routes.json` (M1), keeps each stage independently testable, and lets the fixture record a 0.3.5 baseline of 0 now.

## D009 — Owner Q&A on clearing open issues (2026-10-30)

- **Scope before the next work item (M3-01):** fix M2-07 (the HTTP review P2s), M0-22-R2 (CLI search truncation), M0-40 (type-check tests and scripts, R04), M0-41 (full criterion-level audit of the legacy iterations, R01) and M0-39 (tests for untested 0.3.x features).
- **Root repo:** when sub-repos are registered, the workspace root `.` stays registered. It indexes files outside every sub-repo; the nested-repo fix (M0-23) already prevents double indexing. No change.
- **Commits:** one commit per task on `develop`.

## D010 — Owner Q&A on the legacy audit (2026-10-31)

Context: the M0-41 audit found 0 of 16 legacy iterations fully confirmed (`reviews/REVIEW-2026-10-30-legacy-audit.md`).

- **Language tiers (M0-12-R2):** all grammars are bundled. Amend I12/F20 accordingly: `lang list` reports every grammar as bundled; add `lang info`; `lang install`/`uninstall` become clear messages ("all grammars are bundled") instead of copying files nothing reads; add shebang detection.
- **Specified-but-unbuilt CLI/MCP surface (epic M0-03-R1):** implement everything as specified. The epic is decomposed into M0-03-R2, M0-05-R2, M0-09-R2 and M0-10-R1.
- **Impact try/catch downgrade (M0-11-R1):** remove it. Risk depends on call depth and test files only, as F19 specifies.
- **Ordering:** the whole remediation backlog, P2 included, is done before M3. M3-01 has a hard dependency on every remediation task.

## D011 — Distribution facts (M0-07-R1, 2026-10-31)

The package is `@mgamil/mapx` (the unscoped `mapx` is not ours), and the supported Node floor is 20.18 (`engines`; better-sqlite3 12 requires it). F13's "npm install -g mapx" and "Node 18" are superseded by these facts. Generated configs and docs use the scoped name.

## D012 — metrics and edges output contract (owner Q&A, 2026-10-31)

Context: review 2026-10-31 found `metrics` and `edges` output diverging from F02/F04 (task M0-03-R3). The owner compared samples and chose:

- **`metrics --format json` / `mapx_metrics`:** F02's envelope with camelCase keys, matching `export --format json`: `{ dir, generatedAt, summary: { files, edges, density }, files: [{ path, language, inDegree, outDegree, totalDegree, instability, pagerank }] }`.
- **`metrics` text:** F02's ranked table (`RANK FILE IN OUT TOTAL INSTABILITY`) under a `Files | Edges | Graph density` header with the instability legend; `--top` defaults to 20 (`--top 0` lists every file); `--exclude <glob,...>` is added.
- **`edges <file> --format json` / `mapx_edges`:** F04's `{ file, direction, incoming[], outgoing[] }` with camelCase keys, keeping `targetRepo` and `line`. Incoming rows carry `sourceFile`, outgoing rows `targetFile`. Without a file (`--from`/`--to`) the flat edge list stays.
- **`edges <file>` text:** F04's `Incoming (n)` / `Outgoing (n)` sections with ←/→ arrows, and a clear message when there are no edges.

camelCase supersedes F02/F04's snake_case keys; everything else follows the specs.

## D013 — Milestone M5, architecture rules (Deptrac-inspired), 2026-10-31

Context: the owner asked for an analysis of Deptrac (PHP architecture-conformance tool) and its abstraction for MapX's 22 languages, frameworks, CLI/MCP and dashboard, then instructed integration of the result into the plan. The research pack is `docs/research/deptrac/` (01 capabilities, 02 abstract feature model AR-01…AR-19, 03 gap analysis G1–G11, 04 phased plan, 05 requirement register REQ-ARCH-001…023). The seven open items were proposed with defaults and the owner instructed integration without overriding them, so the defaults stand; each can be revised by editing the affected tasks before they start.

- **Adopted:** milestone M5 with 19 tasks (M5-01 … M5-18, M5-98; M5-12 is an epic to decompose per ecosystem) and requirements REQ-ARCH-001…023 (P1 MUST = the CI gate, P2 SHOULD, P3 COULD; no P0 is claimed). Expected effort 183 h, MUST set about 65 h.
- **Ordering:** M3 stays the owner's stated next milestone (PROJECT_STATE "Next"); M5 Phase A (M5-01 … M5-06) lives in new `src/arch/`, `tests/` and `schemas/` paths and may run as a parallel lane. The only ordering constraints are the real ones, recorded as `interface` dependencies: M5-10 → M3-04 (TS/Vue extraction path), M5-12 → M4-03 (`src/core/scanner.ts`), M5-18 → M4-01 (`.github/workflows/ci.yml`). The computed critical path is now M5's chain (62 h); that reflects effort, not precedence over M3.
- **Config:** `.mapx/architecture.jsonc`, views under `.mapx/architecture/*.jsonc`, next to `config.json`, `routes.json` and `http-calls.json`.
- **Verb:** `mapx check` is the CI gate; introspection lives under `mapx arch <sub>` and the existing `mapx arch` flags stay unchanged.
- **Exit codes:** 0 clean, 1 violations, 2 uncovered/unassigned when asked, 3 config or baseline error, 4 stale graph or internal error (AR-17), instead of Deptrac's single 1.
- **Inferred edges:** warn by default; `policy.inferred: "error"` promotes them (REQ-ARCH-007).
- **External references (G3):** stored outside `edges`, in a separate table with ecosystem, package, direct/transitive and dev/prod attribution, so existing metrics, PageRank and exports are unchanged (REQ-ARCH-008, REQ-ARCH-014).
- **Ratchet:** `--compare <base-report.json>` is the MUST; `--since <git-ref>` is COULD (REQ-ARCH-021, no task yet).
- **Research home:** `docs/research/deptrac/`; task `sources` cite it. `specs/` stays frozen (D001).

## D014 — Final gaps before M3 (owner Q&A, 2026-10-31)

- **Continue (amends F17):** MapX writes Continue's documented layout instead of `.continue/mapx.yaml`, which Continue never loads: `.continue/mcpServers/mapx.yaml` for the MCP server and `.continue/prompts/*.md` for the slash commands. A leftover `.continue/mapx.yaml` written by mapx is migrated or reported. Task M0-09-R4.
- **`.fish` (F20):** bundle a licence-compatible tree-sitter fish grammar and extract `function` definitions and calls. If no usable WASM build exists, fall back to file-level indexing and record that here. Task M0-12-R5.
- **M1-05-R3:** promoted from P3 to P2 and made an M3-01 dependency (D010 applies).
