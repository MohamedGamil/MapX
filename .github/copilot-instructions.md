<!-- mapx v0.3.1 -->
## MapxGraph Integration

This project uses MapxGraph (22 languages, 26 MCP tools). You can run the following CLI commands to understand the codebase:
- `mapx export` - Graph overview (LLM summary, or --format=json/dot/svg/toon)
- `mapx query <term>` - Search symbols (supports glob patterns: `*Service`, `get*`)
- `mapx search <term> --kind class` - Advanced filtered search (auto-expands if kind has 0 results)
- `mapx search <term> --format json` - Structured JSON output with PageRank scores
- `mapx deps <file>` - View file dependencies
- `mapx callers <symbol>` - Trace callers (with fuzzy "Did you mean?" on typos)
- `mapx callees <symbol>` - Trace callees (with fuzzy "Did you mean?" on typos)
- `mapx impact <symbol>` - Change impact analysis
- `mapx clusters` - View logical modules
- `mapx trace <symbol>` - Trace data-flow paths
- `mapx sources` - Find entry points
- `mapx sinks` - Find terminal consumers
- `mapx context <task>` - Generate task-specific context
- `mapx node <symbol> --source` - Inspect symbol source code
- `mapx node <symbol> --format json` - Symbol details as JSON
<!-- /mapx -->