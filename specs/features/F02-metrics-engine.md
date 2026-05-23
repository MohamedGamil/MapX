# F02 — Metrics Engine (`mapx metrics`)

| Field | Value |
|-------|-------|
| ID | F02 |
| Status | `planned` |
| Iteration | I03 |
| Branch | `feat/i03-metrics-edges` |
| Depends on | F01 (for `--verified-only` flag) |
| Blocked by | I01 must be merged first for full functionality |

---

## Problem

There is no built-in way to identify structurally problematic files — God Classes, tightly coupled modules, highly depended-on bottlenecks — without exporting the full graph and post-processing it externally. LLM consumers and developers need this surface as a first-class command.

---

## Goal

Implement a `mapx metrics` CLI subcommand and `mapx_metrics` MCP tool that compute and return structural coupling metrics per file, ranked by coupling severity.

---

## CLI Specification

```bash
mapx metrics [path]
             [--dir <path>]
             [--format <llm|json>]        # default: llm
             [--top <n>]                  # default: 20 — limit output rows
             [--verified-only]            # exclude inferred edges (requires F01)
             [--exclude <glob,...>]        # override file exclusions for this query
```

### Example output (LLM format)

```
Metrics for: /path/to/project   (last scan: 2026-05-22 11:30)
Files: 142 | Edges: 891 | Graph density: 0.044

Top coupled files (by total degree):

  RANK  FILE                                       IN   OUT  TOTAL  INSTABILITY
  ─────────────────────────────────────────────────────────────────────────────
     1  app/Services/OrderService.php              14     8     22     0.36
     2  app/Models/User.php                        12     3     15     0.20
     3  app/Http/Controllers/ApiController.php      2    11     13     0.85
     4  src/core/store.ts                           9     4     13     0.31
     5  app/Services/PaymentService.php             6     6     12     0.50
  ...

Instability = out / (in + out).  Range: 0 (stable) → 1 (unstable).
High in-degree  → depended-on bottleneck.
High out-degree → many outgoing deps (potential God Class / low cohesion).
```

### Example output (JSON format)

```json
{
  "dir": "/path/to/project",
  "generated_at": "2026-05-22T11:30:00Z",
  "summary": {
    "files": 142,
    "edges": 891,
    "density": 0.044
  },
  "files": [
    {
      "path": "app/Services/OrderService.php",
      "language": "php",
      "in_degree": 14,
      "out_degree": 8,
      "total_degree": 22,
      "instability": 0.36,
      "pagerank": 0.0142
    }
  ]
}
```

---

## Internal Implementation

### SQL query (executed by the Store)

```sql
SELECT
    f.path,
    f.language,
    COUNT(DISTINCT CASE WHEN e.target_file = f.path THEN e.source_file END) AS in_degree,
    COUNT(DISTINCT CASE WHEN e.source_file = f.path THEN e.target_file END) AS out_degree
FROM files f
LEFT JOIN edges e ON (e.source_file = f.path OR e.target_file = f.path)
-- When --verified-only is set:
-- AND e.verifiability = 'verified'
GROUP BY f.path, f.language
ORDER BY (in_degree + out_degree) DESC;
```

Instability is computed in application code (not SQL) as `out / (in + out)`, defaulting to `0` when both are zero.

### New Store method

```typescript
// src/core/store-interface.ts
getMetrics(options?: { verifiedOnly?: boolean }): FileMetricsRow[];

interface FileMetricsRow {
  path: string;
  language: string;
  in_degree: number;
  out_degree: number;
}
```

### New exporter

Create `src/exporters/metrics-exporter.ts` following the same pattern as `LLMExporter`:

```typescript
export class MetricsExporter {
  constructor(private store: Store, private graph: MapxGraph) {}
  export(options: MetricsOptions): string { /* LLM table */ }
  exportAsJSON(options: MetricsOptions): string { /* JSON */ }
}
```

### CLI wiring (`src/cli.ts`)

Add a `metrics` subcommand alongside `scan`, `export`, etc.

### MCP tool (`src/mcp.ts`)

```typescript
{
  name: 'mapx_metrics',
  description: 'Compute structural coupling metrics per file. Returns in-degree, out-degree, and instability scores ranked by total coupling.',
  inputSchema: {
    type: 'object',
    properties: {
      top:           { type: 'number', description: 'Number of files to return (default 20)' },
      format:        { type: 'string', enum: ['llm', 'json'], default: 'llm' },
      verifiedOnly:  { type: 'boolean', description: 'Exclude inferred edges from counts' },
      ...dirProperty,
    },
  },
}
```

---

## Acceptance Criteria

- [ ] `mapx metrics` prints a ranked coupling table in LLM format
- [ ] `mapx metrics --format=json` outputs valid JSON matching the schema above
- [ ] `mapx metrics --top N` limits output to N rows
- [ ] `mapx metrics --verified-only` filters to verified edges only (requires F01)
- [ ] `mapx_metrics` MCP tool registered and functional
- [ ] `mapx status` help text mentions `mapx metrics` as a related command
- [ ] Instability score is correct: `out / (in + out)`, `0` when both zero
- [ ] TypeScript type-check passes
- [ ] Tested against a project with known high-coupling files

---

## Out of Scope for F02

- Per-symbol metrics (method-level coupling) — deferred
- Trend/delta metrics across scans — deferred
- Threshold-based warnings or CI integration — deferred
