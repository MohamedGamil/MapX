# Benchmarking

MapX includes a built-in benchmarking suite that measures token consumption savings when using MapX MCP tools versus traditional file-reading approaches with agentic coding tools like Claude, Codex, and GPT-4.

## Quick Start

```bash
# Benchmark the current project
make bench

# Benchmark a specific directory
make bench DIR=/path/to/project

# JSON output for CI/automation
make bench-json DIR=/path/to/project

# Or via npm
npm run bench -- /path/to/project
npm run bench:json -- /path/to/project

# Specify a pricing model
npx tsx benchmarks/run.ts /path/to/project --model gpt-4.1
```

## What It Measures

The benchmark simulates 6 common agentic coding tasks and compares token usage between two approaches:

| Scenario | Baseline (No MapX) | With MapX |
|----------|-------------------|-----------|
| **Understand project structure** | Read directory listing + open 15% of files | Single `mapx_export` call |
| **Find a symbol definition** | Grep + read 3 matching files | `mapx_query` + targeted read |
| **Trace dependencies** | Read file + read 6 imports + grep reverse refs | Single `mapx_dependencies` call |
| **Impact analysis** | Read file + 8 direct refs + grep transitives | `mapx_impact` + `mapx_callers` |
| **Multi-file edit** | Read 10 context files + grep + edit 6 + verify | `mapx_export` + `mapx_search` + targeted reads |
| **Full session (15 tasks)** | 40% of codebase read, 2.5x re-read rate | Export once + targeted queries |

## Output Format

### Human-readable (default)

```
📋 understand-structure
   Get an overview of the project

   Without MapX:     28.4K tokens  (15 tool calls)
   With MapX:          3.2K tokens  (1 tool calls)
   Savings:          25.2K tokens  (89%)  █████████████████████████████

   Cost (claude-sonnet-4):  $0.0852 → $0.0096
```

### JSON (for CI/automation)

```bash
npx tsx benchmarks/run.ts /path --json | jq '.summary'
```

Returns structured data with per-scenario breakdowns and summary statistics.

## Supported Models

Pricing is included for the following models:

| Model | Input ($/1M) | Output ($/1M) |
|-------|-------------|---------------|
| `claude-sonnet-4` | $3.00 | $15.00 |
| `claude-opus-4` | $15.00 | $75.00 |
| `gpt-4.1` | $2.00 | $8.00 |
| `gpt-4.1-mini` | $0.40 | $1.60 |
| `o3` | $2.00 | $8.00 |
| `codex-mini` | $1.50 | $6.00 |

## Accuracy

The benchmark uses a character-ratio token estimator (±5% accuracy vs tiktoken cl100k_base):
- **Code**: ~3.5 characters per token
- **Prose**: ~4.0 characters per token

For best accuracy, run `mapx init && mapx scan` on the target project first — the benchmark will use real MapX export data instead of estimates.

## Files

| File | Description |
|------|-------------|
| `benchmarks/run.ts` | CLI runner — collects data, runs scenarios, generates report |
| `benchmarks/scenarios.ts` | 6 scenario definitions with baseline vs MapX token models |
| `benchmarks/token-counter.ts` | Token estimation + pricing utilities |
