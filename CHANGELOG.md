# Changelog

All notable changes to mapx are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow [Semantic Versioning](https://semver.org/).

Unreleased work is tracked under **[Unreleased]**. When a version is released, move its entries from Unreleased and add a release date.

---

## [Unreleased]

### Added (I11 — Smart Context & Search Tools)
- Added `ContextBuilder` API for intelligent, token-budgeted prompt context generation.
- Added 7 new MCP tools: `mapx_search`, `mapx_context`, `mapx_callers`, `mapx_callees`, `mapx_impact`, `mapx_node`, and `mapx_files`.
- Added 6 new CLI commands: `mapx search`, `mapx callers`, `mapx callees`, `mapx impact`, `mapx node`, and `mapx files`.
- Enhanced `mapx status` CLI and `mapx_status` MCP tool with language breakdown, PageRank top files/symbols lists, and Git stale index detection with upgrade recommendations.

### Planned (I01 — Edge Verifiability)
- Add `verifiability` column (`verified` | `inferred`) to `edges` table
- Bump store schema version with automatic migration for existing databases
- PHP parser labels dynamic/untyped calls as `inferred`
- JS/TS parsers label untyped method calls as `inferred`
- Common framework method filter list (`save`, `delete`, `on`, `emit`, …)
- JSON export includes `verifiability` per edge
- DOT/SVG export renders inferred edges as dashed lines
- `mapx status` edge breakdown shows verified/inferred counts

### Planned (I02 — Glob Filters)
- `mapx scan --exclude <glob,...>` — skip matching files before any I/O
- `mapx scan --include <glob,...>` — allowlist; only process matching files
- `mapx export --exclude / --include` — filter output without re-scanning
- Config-level `excludePatterns` / `includePatterns` in `.mapx/config.json`
- CLI flag patterns extend (not replace) config defaults
- `mapx status` displays active exclude/include patterns
- `mapx init` suggests language-appropriate default excludes

### Planned (I03 — Metrics + Edge Querying)
- `mapx metrics` command — per-file coupling table (in-degree, out-degree, instability, PageRank)
- `mapx metrics --format=json` — machine-readable coupling output
- `mapx metrics --verified-only` — exclude inferred edges from counts
- `mapx_metrics` MCP tool
- `mapx edges <file>` command — structured edge neighbourhood for a single file
- `mapx edges --direction <incoming|outgoing|both>` — directional filter
- `mapx edges --type <edge-type,...>` — edge type filter
- `mapx edges --format=json` — JSON output (MCP default)
- `mapx_edges` MCP tool

---

## [0.1.6] — 2026-05-22

### Changed
- Full rebrand from `codegraph` to `mapx` across all CLI commands, MCP tools, storage paths, class names, and documentation
  - CLI binary renamed: `codegraph` → `mapx`
  - Storage directory renamed: `.codegraph/` → `.mapx/`
  - Database renamed: `codegraph.db` → `mapx.db`
  - MCP server name: `codegraph` → `mapx`
  - MCP tools: `codegraph_*` → `mapx_*`
  - TypeScript class `CodeGraph` → `MapxGraph`
  - TypeScript type `CodeGraphConfig` → `MapxConfig`
  - All build artefacts, installer scripts, and docs updated

---

## [0.1.5] — prior release

_Changelog entries not yet backfilled. See git log for history._

---

## [0.1.4] — prior release

_Changelog entries not yet backfilled. See git log for history._

---

<!-- Links (keep at the bottom) -->
[Unreleased]: https://github.com/<owner>/mapx/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/<owner>/mapx/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/<owner>/mapx/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/<owner>/mapx/releases/tag/v0.1.4
