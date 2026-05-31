<!-- mapx v0.3.3 -->
---
trigger: model_decided
---
# MapxGraph Rules for Windsurf

This project utilizes MapxGraph to maintain local code indexes across **22 languages** with **32 MCP tools**.

Use the MapxGraph MCP tools or CLI commands to navigate:
- `mapx_export` / `mapx export` on startup.
- `mapx_query` / `mapx query` to locate definitions (supports glob: `*Service`, `get*`).
- `mapx_search` / `mapx search` for advanced filtered search (auto-expand, fuzzy fallback, `--format json`).
- `mapx_callers` / `mapx callers` to trace call chains (fuzzy "Did you mean?" on typos).
- `mapx_impact` / `mapx impact` before refactoring.
- `mapx_trace` / `mapx trace` to analyze data flow.
- `mapx_sources` / `mapx sources` to find entry points.
- `mapx_sinks` / `mapx sinks` to find terminal consumers.
- `mapx_context` / `mapx context` to generate task-specific context.
- `mapx_batch` to execute multiple operations in one call.
- `mapx_profile` / `mapx profile` to inspect codebase profile.
- `mapx_smells` / `mapx arch` to analyze smells and design health.
- `mapx_sync` / `mapx sync` after edits.
<!-- /mapx -->