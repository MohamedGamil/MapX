<!-- mapx v0.4.0 #964787871522 -->
# Zed Assistant MapxGraph Instructions

This project uses MapxGraph (23 languages, 39 MCP tools).
`mapx agents generate --providers zed` also registers the mapx MCP server under `context_servers` in `.zed/settings.json`, keeping your other settings.

## Key Commands
- Run `mapx export` to retrieve a token-budgeted codebase summary.
- Run `mapx query <symbol>` to find definitions (supports glob: `*Service`, `get*`, and flexible namespace notations: `BillingService::getEffectiveLimits` or `BillingService.getEffectiveLimits`).
- Run `mapx search <term>` for advanced filtered search (auto-expand, fuzzy fallback, `--format json`).
- Run `mapx callers <symbol>` / `mapx callees <symbol>` to trace call chains.
- Run `mapx impact <symbol>` to assess change risk before refactoring.
- Run `mapx trace <symbol> [--sinks] [--include-leaf-libraries]` to trace data flow.
- Run `mapx sources` to find entry points.
- Run `mapx sinks [--include-leaf-libraries]` to find terminal consumers.
- Run `mapx context <task>` to generate task-specific context.
- Run `mapx sync` after file edits to update the graph.
<!-- /mapx -->