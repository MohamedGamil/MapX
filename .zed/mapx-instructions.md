<!-- mapx v0.3.3 -->
# Zed Assistant MapxGraph Instructions

This project uses MapxGraph (22 languages, 32 MCP tools).

## Key Commands
- Run `mapx export` to retrieve a token-budgeted codebase summary.
- Run `mapx query <symbol>` to find definitions (supports glob: `*Service`, `get*`, and flexible namespace notations: `BillingService::getEffectiveLimits` or `BillingService.getEffectiveLimits`).
- Run `mapx search <term>` for advanced filtered search (auto-expand, fuzzy fallback, `--format json`).
- Run `mapx callers <symbol>` / `mapx callees <symbol>` to trace call chains.
- Run `mapx impact <symbol>` to assess change risk before refactoring.
- Run `mapx trace <symbol>` to trace data flow.
- Run `mapx sources` to find entry points.
- Run `mapx sinks` to find terminal consumers.
- Run `mapx context <task>` to generate task-specific context.
- Run `mapx sync` after file edits to update the graph.
<!-- /mapx -->