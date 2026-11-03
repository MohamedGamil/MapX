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

## Accuracy scoring (fixtures)

Separately from token savings, MapX measures its own extraction accuracy on three labelled synthetic fixtures:

| Scorer | Fixture | Measures |
| --- | --- | --- |
| `scripts/eval/score-routes.ts` | `tests/fixtures/laravel-routes` | Laravel route URI, handler and attribute recall, precision, false positives |
| `scripts/eval/score-http.ts` | `tests/fixtures/vue-http` | HTTP call-site and URL recall, frontend → backend pairing recall and precision |
| `scripts/eval/score-edges.ts` | `tests/fixtures/vue-sfc` | Vue SFC edge and symbol recall per pattern, precision, false positives on negatives |
| `scripts/eval/score-arch.ts` | `tests/fixtures/arch-rules` | Architecture-rule findings (violation, skipped, uncovered, warning, error) per kind: recall and precision against `expected-findings.json`. Findings on `allowed` and same-layer rows are false positives. Five apps (PHP, TypeScript, Python, Go, a PHP copy with a `+` cycle), a two-repo workspace, and four vendor apps (M5-24: npm, Composer, pypi, Go). Findings on packages outside the workspace are also scored per ecosystem (`externalFindings`: uncovered, vendor-confinement and dev-dependency rows). Not yet in `npm run eval`: there is no engine until M5-04 |

The floors each score must hold are recorded in `scripts/eval/floors.json`. The fixture tests read the same file. `npm run eval` runs all three scorers and checks every floor. CI runs it as the `Eval` job.

```bash
npm run eval                          # table per scorer; exit 1 when a floor is missed
npm run eval -- --json                # machine-readable result
npm run eval -- --floors my.json      # check another floors file
```

In `floors.json`:
- `fixture` is the fixture directory, relative to the repository root.
- `min` and `max` bound a scorer's totals.
- `patterns` bounds each labelled pattern. `"*"` applies to every pattern, and a named pattern overrides it metric by metric.

A floors file naming an unknown scorer, metric or pattern, or a recall or precision outside [0, 1], is rejected with exit 2 before anything is scanned. A scan that fails also exits 2, after the other scorers have reported. Floors only rise: when a change improves a score, raise its floor in the same change.

## Dashboard browser tests

`npm run test:ui` runs the dashboard in headless Chromium (Playwright, `playwright.config.ts`). It builds the dashboard, scans generated fixture workspaces with the source CLI, serves each with `mapx ui` on a free port, and drives it:

| Spec | Checks |
| --- | --- |
| `tests/ui/smoke.spec.ts` | Every tab renders its content: the graph's layout finishes, symbols and routes fill their tables, the architecture profile and DSM appear, a context build returns files, metrics fill, and a logged tool call shows. No tab may log a console error or page error, or get a failed `/api` request. |
| `tests/ui/perf.spec.ts` | The time from navigation to the first finished graph layout on the generated 500-file fixture. The median of three cold loads must stay within the budget in `tests/ui/budgets.json`: the M4-16 baseline (720 ms) plus 20%. |

The dashboard marks its graph state on `<body data-graph>` (`loading`, `layout`, `ready`, `empty`, `error`) and records a `mapx:graph-ready` performance mark each time a layout finishes. The tests wait on these instead of on fixed delays.

```bash
npx playwright install chromium            # once; without it the specs skip and say so
npm run test:ui                            # all specs
npm run test:ui -- smoke                   # one spec
MAPX_UI_PERF_SCALE=2 npm run test:ui       # double the render budget on slower hardware
```

CI runs them as the `UI` job, with `MAPX_UI_PERF_SCALE=2` because shared runners are slower than the machine the baseline was measured on. `npx tsx scripts/ui/audit.ts` is the fuller audit behind the baseline: screenshots at three widths, axe accessibility results and Full Codebase timings (M4-16, `docs/research/dashboard-ux-audit.md`).
