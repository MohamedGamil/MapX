# Mapx Enhancements: Architectural & Feature Implementation Plan

This document outlines the design and implementation plan to improve **Mapx** for agentic workflows and developer usage. The proposed changes address dynamic resolution noise, provide analytical metrics directly, and enhance path querying.

---

## 🛠️ Feature 1: Dynamic Resolution & Edge Verifiability

### Goal
Differentiate between **statically verified** dependencies (e.g., imports, inheritance, instantiation) and **inferred** dependencies (dynamic method resolutions like `$x->on()`).

### Technical Design
1. **Database Schema Update:**
   Add a `verifiability` column to the `edges` table:
   ```sql
   ALTER TABLE edges ADD COLUMN verifiability TEXT DEFAULT 'verified';
   -- Possible values: 'verified' (e.g., class inheritance, type-hinted calls) or 'inferred' (dynamic calls with unresolved types)
   ```
2. **Parser Updates (PHP/JS/TS):**
   * When the parser resolves a function call where the class instance cannot be statically determined (e.g., `$this->on()`), mark the generated edge as `inferred`.
   * For explicit types (e.g., `(new ActionService())->save()`), mark the edge as `verified`.
3. **Common Method Filter List:**
   * Build a blacklist of standard framework/language methods (e.g., `toArray`, `rules`, `handle`, `get`, `save`) that are automatically treated as `inferred` unless statically typed.

---

## 📊 Feature 2: Coupling & Metrics Engine (`mapx metrics`)

### Goal
Provide native queries to identify structural bottlenecks, tightly coupled components, and "God Classes."

### CLI Command Specifications
```bash
mapx metrics [--dir <path>] [--format <llm|json>] [--exclude <patterns>]
```

### SQL Aggregator Design (Mapx Internal Engine)
Instead of returning the raw graph, Mapx will calculate in-degree and out-degree at the file level:
```sql
SELECT 
    f.path,
    f.language,
    COUNT(DISTINCT CASE WHEN e.target_file = f.path THEN e.source_file END) as in_degree,
    COUNT(DISTINCT CASE WHEN e.source_file = f.path THEN e.target_file END) as out_degree
FROM files f
LEFT JOIN edges e ON (e.source_file = f.path OR e.target_file = f.path)
WHERE e.verifiability = 'verified' -- Optional filter
GROUP BY f.path
ORDER BY (in_degree + out_degree) DESC;
```

---

## 🔍 Feature 3: Path and Directory Exclusions

### Goal
Allow scanning and exports to focus strictly on application logic (e.g., ignoring migrations, seeds, or test suites).

### CLI Command Specifications
```bash
mapx scan --exclude="**/migrations/**,**/tests/**"
mapx export --include="**/app/Services/**"
```

### Technical Design
Update the file discovery step in `mapx` (which walks directories) to match paths against glob patterns before reading files or building parser AST trees.

---

## 🕸️ Feature 4: Granular Edge Querying (`mapx edges`)

### Goal
Query the direct neighborhood of a specific file without exporting the entire graph.

### CLI Command Specifications
```bash
mapx edges <file-path> [--direction <incoming|outgoing|both>]
```

### Response Schema (JSON)
```json
{
  "file": "backend/app/Services/PDFService.php",
  "incoming": [
    {
      "source_file": "backend/app/Services/MeetingService.php",
      "edge_type": "call",
      "symbol": "getMeetingAsPdf"
    }
  ],
  "outgoing": [
    {
      "target_file": "backend/app/Models/Media.php",
      "edge_type": "use"
    }
  ]
}
```

---

## 🚀 Implementation Phases

| Phase | Tasks | Target Scope |
| :--- | :--- | :--- |
| **Phase 1: Schema & Parsing** | 1. Implement database migration for `edges.verifiability`. <br>2. Update AST parser logic to label dynamic/ambiguous calls as `'inferred'`. | Database & Parsers |
| **Phase 2: Filters & Globbing**| 1. Implement `--exclude` and `--include` glob filter matching in the file scanning runner. | Scanner Pipeline |
| **Phase 3: CLI & MCP Expose** | 1. Implement `mapx metrics` and `mapx edges` CLI subcommands.<br>2. Add corresponding tools `mapx_metrics` and `mapx_edges` to the MCP Server. | CLI / MCP Interface |
