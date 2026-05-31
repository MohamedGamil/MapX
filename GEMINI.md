<!-- mapx v0.3.3 -->
# MapxGraph Gemini Integration

Utilize MapxGraph to obtain codebase context for Gemini across **22 languages** with **32 MCP tools**.

## CLI Commands

- Run `mapx export` to summarize the project (supports --format=llm/json/dot/svg/toon).
- Run `mapx query <symbol>` to locate symbols (supports glob patterns: `*Service`, `get*`, and flexible namespace notations: `BillingService::getEffectiveLimits` or `BillingService.getEffectiveLimits`).
- Run `mapx search <term>` for advanced filtered search (auto-expand, fuzzy fallback, `--format json`).
- Run `mapx callers <symbol>` / `mapx callees <symbol>` to trace call chains (fuzzy fallback on typos).
- Run `mapx impact <symbol>` to assess change blast radius.
- Run `mapx trace <symbol>` to analyze data flow.
- Run `mapx sources` to find entry points.
- Run `mapx sinks` to find terminal consumers.
- Run `mapx context <task>` to generate task-specific context.
- Run `mapx node <symbol> --source` to inspect a symbol's source code.
- Run `mapx node <symbol> --format json` for structured JSON output.
- Run `mapx profile` to show codebase profile details.
- Run `mapx arch` to audit architecture design smells and structural quality.
- Run `mapx explain <file>` to explain file layer/role classification signals.
- Run `mapx layers` to view files grouped by architectural roles.
- Run `mapx sync` after file edits to update the graph.
<!-- /mapx -->