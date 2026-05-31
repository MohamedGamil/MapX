<!-- mapx v0.3.2 -->
# MapxGraph Aider Integration

Use MapxGraph commands in this repository to analyze code across **22 languages**.

## Key CLI Commands

- `mapx export`: Compact summary of the graph structure.
- `mapx export --format=svg -o graph.svg`: Visual graph export.
- `mapx query <symbol>`: Find locations and definitions (supports glob: `*Service`, `get*`).
- `mapx search <term> --kind class`: Advanced filtered search (auto-expand, fuzzy fallback).
- `mapx search <term> --format json`: Structured JSON output.
- `mapx deps <file>`: Show dependencies.
- `mapx callers <symbol>`: Show who calls a symbol (fuzzy fallback on typos).
- `mapx callees <symbol>`: Show what a symbol calls (fuzzy fallback on typos).
- `mapx impact <symbol>`: Change impact analysis.
- `mapx trace <symbol>`: Show data-flow traversal.
- `mapx sources`: Find entry points.
- `mapx sinks`: Find terminal consumers.
- `mapx context <task>`: Generate task-specific context.
- `mapx node <symbol> --source`: View symbol source code.
- `mapx node <symbol> --format json`: Symbol details as JSON.
- `mapx sync` (or `mapx update`): Run after edits.
<!-- /mapx -->