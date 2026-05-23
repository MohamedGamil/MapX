# F04 — Granular Edge Querying (`mapx edges`)

| Field | Value |
|-------|-------|
| ID | F04 |
| Status | `planned` |
| Iteration | I03 |
| Branch | `feat/i03-metrics-edges` |
| Depends on | — |
| Blocked by | — |

---

## Problem

`mapx deps <file>` returns a human-readable summary of a file's dependencies and reverse-dependencies. There is no machine-readable, structured way to query the edge neighbourhood of a single file — for example, to get only outgoing edges, or to filter by edge type, or to obtain the symbol-level detail of each edge. This limits programmatic use and makes the MCP tool harder for agents to consume precisely.

---

## Goal

Implement a `mapx edges` CLI subcommand and `mapx_edges` MCP tool that return the structured edge neighbourhood of a given file, with filtering by direction, edge type, and verifiability.

---

## CLI Specification

```bash
mapx edges <file-path>
           [--dir <path>]
           [--direction <incoming|outgoing|both>]   # default: both
           [--type <edge-type,...>]                  # filter by edge type(s)
           [--verified-only]                         # exclude inferred edges
           [--format <llm|json>]                     # default: llm
```

### Edge types (existing `ReferenceType` values)

`import` · `require` · `extends` · `implements` · `instantiation` · `call` · `use`

### Example — LLM format

```
Edges for: app/Services/PDFService.php

  Incoming (2):
    ← app/Services/MeetingService.php  [call]  getMeetingAsPdf
    ← app/Http/Controllers/ReportController.php  [call]  generateReport

  Outgoing (3):
    → app/Models/Media.php  [use]
    → app/Services/StorageService.php  [call]  store
    → vendor/barryvdh/laravel-dompdf/src/Facade.php  [instantiation]  Pdf
```

### Example — JSON format

```json
{
  "file": "app/Services/PDFService.php",
  "direction": "both",
  "incoming": [
    {
      "source_file": "app/Services/MeetingService.php",
      "edge_type": "call",
      "source_symbol": null,
      "target_symbol": "getMeetingAsPdf",
      "verifiability": "verified",
      "weight": 1
    },
    {
      "source_file": "app/Http/Controllers/ReportController.php",
      "edge_type": "call",
      "source_symbol": null,
      "target_symbol": "generateReport",
      "verifiability": "inferred",
      "weight": 1
    }
  ],
  "outgoing": [
    {
      "target_file": "app/Models/Media.php",
      "edge_type": "use",
      "source_symbol": null,
      "target_symbol": null,
      "verifiability": "verified",
      "weight": 1
    }
  ]
}
```

---

## Technical Implementation

### New Store method

```typescript
// src/core/store-interface.ts
getEdgesForFile(
  filePath: string,
  options?: {
    direction?: 'incoming' | 'outgoing' | 'both';
    types?: ReferenceType[];
    verifiedOnly?: boolean;
  }
): { incoming: EdgeRow[]; outgoing: EdgeRow[] };

interface EdgeRow {
  source_file: string;
  target_file: string;
  edge_type: string;
  source_symbol: string | null;
  target_symbol: string | null;
  verifiability: string;
  weight: number;
}
```

### SQL

```sql
-- Incoming edges
SELECT source_file, target_file, edge_type, source_symbol, target_symbol, verifiability, weight
FROM edges
WHERE target_file = ?
  -- AND edge_type IN (?, ?, ...)     -- applied when --type is set
  -- AND verifiability = 'verified'   -- applied when --verified-only is set
ORDER BY source_file;

-- Outgoing edges
SELECT source_file, target_file, edge_type, source_symbol, target_symbol, verifiability, weight
FROM edges
WHERE source_file = ?
ORDER BY target_file;
```

### Relationship to `mapx deps`

`mapx deps` remains unchanged — it is the quick human-readable summary. `mapx edges` is the structured, filterable, machine-readable alternative. They both query the same data.

### CLI wiring (`src/cli.ts`)

Add an `edges` subcommand. The `<file-path>` argument is resolved relative to the project root (same normalisation logic used by `deps`).

### MCP tool (`src/mcp.ts`)

```typescript
{
  name: 'mapx_edges',
  description: 'Get the structured edge neighbourhood of a file — all files it depends on and all files that depend on it. Supports filtering by direction, edge type, and verifiability.',
  inputSchema: {
    type: 'object',
    properties: {
      file:         { type: 'string', description: 'File path relative to project root' },
      direction:    { type: 'string', enum: ['incoming', 'outgoing', 'both'], default: 'both' },
      type:         { type: 'array', items: { type: 'string' }, description: 'Edge types to include' },
      verifiedOnly: { type: 'boolean', description: 'Exclude inferred edges' },
      format:       { type: 'string', enum: ['llm', 'json'], default: 'json' },
      ...dirProperty,
    },
    required: ['file'],
  },
}
```

Note: the MCP default for `format` is `json` (not `llm`) because agents consuming this tool typically need structured data.

---

## Acceptance Criteria

- [ ] `mapx edges <file>` prints a structured edge list in LLM format
- [ ] `mapx edges <file> --format=json` outputs valid JSON matching the schema above
- [ ] `--direction incoming` returns only incoming edges
- [ ] `--direction outgoing` returns only outgoing edges
- [ ] `--type call,import` filters to the specified edge types
- [ ] `--verified-only` excludes inferred edges (gracefully no-ops if F01 not present)
- [ ] `mapx_edges` MCP tool registered and functional, defaults to JSON format
- [ ] File path accepts both relative (from project root) and absolute forms
- [ ] Returns a clear message when the file has no edges (not an error)
- [ ] TypeScript type-check passes
- [ ] Tested against a file with both incoming and outgoing edges

---

## Out of Scope for F04

- Multi-hop / transitive dependency queries (N-depth reachability) — deferred
- Symbol-level edge querying (edges involving a specific function/class) — deferred
- Diff between two scans showing added/removed edges — deferred
