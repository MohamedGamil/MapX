# F14 — Module / Domain Cluster Detection

| Field | Value |
|-------|-------|
| ID | F14 |
| Status | `planned` |
| Iteration | I08 |
| Branch | `feat/i08-clusters-and-flow` |
| Depends on | — (independent; benefits from F05 for PHP namespace accuracy) |
| Blocked by | — |

---

## Problem

mapx builds a graph of files and edges. The graph is flat: every file is an equal peer node. Real codebases are organised into **logical modules** — HTTP layer, data layer, service layer, domain models, utilities — but this structure is invisible in the current graph.

Without cluster information:
- Large graphs (>50 files) are unreadable in DOT/SVG export
- The LLM exporter can't summarise at the module level ("the auth module depends on the user module")
- `mapx query` finds individual symbols but can't answer "show me everything in the billing domain"
- Metrics (F02) apply to individual files — cluster-level coupling is unmeasurable

Cluster detection is the **foundational layer** that F15 (visualization) and future analysis features build on.

---

## Goal

1. Detect logical clusters from three sources: explicit namespace/module declarations, directory structure, and import density (community detection)
2. Persist clusters and membership in the database
3. Expose clusters in `MapxGraph` as first-class queryable data
4. Add `mapx clusters` CLI command to list and inspect clusters
5. Add `mapx_clusters` MCP tool

---

## Cluster sources (priority order)

Clusters from source 1 take priority over source 2 which takes priority over source 3. A file may belong to exactly one **primary cluster** (highest-priority source match) and any number of **secondary clusters** (computed communities that span primary clusters).

### Source 1 — Namespace / module declarations (`verified`)

Extract the namespace declaration from each parsed file. This is already partially present in the parser outputs — for PHP the `namespace` statement is captured; for TypeScript, `namespace`/`module` declarations are symbols.

| Language | Syntax | Cluster ID derivation |
|----------|--------|-----------------------|
| PHP | `namespace App\Http\Controllers;` | `App.Http.Controllers` |
| TypeScript | `namespace Auth.Providers { ... }` | `Auth.Providers` |
| TypeScript (ES module path) | `import ... from '@auth/providers'` path alias | `@auth/providers` |
| JavaScript | `// @module billing` JSDoc tag | `billing` |
| Go | `package controllers` in `app/http/controllers/` | `app.http.controllers` |
| Python | directory containing `__init__.py` | directory path as package |

For PHP (the primary target) the namespace is already declared in source. The PHP parser in `php.ts` must capture it as a file-level metadata field.

### Source 2 — Directory structure (`inferred`)

Every directory containing ≥ 2 files generates a cluster named after the relative directory path, with `.` as separator:

```
app/Http/Controllers/  →  app.Http.Controllers
app/Models/            →  app.Models
src/core/              →  src.core
src/exporters/         →  src.exporters
```

This is the universal fallback — it works for every language.

**Cluster hierarchy**: directory clusters nest. `app.Http.Controllers` is a child of `app.Http` which is a child of `app`.

**Minimum depth**: The project root is never a cluster (it would contain everything). Minimum meaningful cluster depth = 1 directory level below root.

### Source 3 — Import density / community detection (`computed`)

Files that heavily import each other, even across directories, may form a logical module. Example: a `payments/` directory imports heavily from `billing/` and `invoices/` — these three directories form a higher-order community cluster.

**Algorithm**: Label Propagation (fast, O(E), good enough for < 10,000 node graphs). Each file starts as its own community. Labels propagate through edges with weight proportional to edge count. After convergence, files sharing a label form a community.

**Parameters** (configurable in `.mapx/config.json`):
```json
{
  "clustering": {
    "communityDetection": true,
    "communityMinSize": 3,
    "communityIterations": 10
  }
}
```

Community clusters are labelled `community_N` (auto-assigned) unless they exactly overlap a directory cluster, in which case they inherit the directory cluster name.

---

## Data model

### New `clusters` table

```sql
CREATE TABLE IF NOT EXISTS clusters (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  name TEXT NOT NULL,           -- e.g. "App.Http.Controllers"
  label TEXT NOT NULL,          -- human-readable: "Http / Controllers"
  source TEXT NOT NULL,         -- 'namespace' | 'directory' | 'community'
  parent_name TEXT,             -- null for root clusters
  depth INTEGER DEFAULT 0,      -- 0 = root cluster
  file_count INTEGER DEFAULT 0, -- denormalised for fast summary
  UNIQUE(repo, name)
);

CREATE INDEX IF NOT EXISTS idx_clusters_repo ON clusters(repo);
CREATE INDEX IF NOT EXISTS idx_clusters_parent ON clusters(parent_name);
```

### New `cluster_membership` table

```sql
CREATE TABLE IF NOT EXISTS cluster_membership (
  file_path    TEXT NOT NULL,
  cluster_name TEXT NOT NULL,
  repo         TEXT NOT NULL,
  is_primary   INTEGER DEFAULT 1,  -- 1 = primary, 0 = secondary (community overlap)
  PRIMARY KEY (file_path, cluster_name, repo)
);

CREATE INDEX IF NOT EXISTS idx_membership_file    ON cluster_membership(file_path);
CREATE INDEX IF NOT EXISTS idx_membership_cluster ON cluster_membership(cluster_name);
```

### Schema migration

This is schema version **4** (v3 is taken by F01/I01 which adds `verifiability` to `edges`). The upgrade migration:

```sql
-- Migration v4
CREATE TABLE IF NOT EXISTS clusters ( ... );
CREATE TABLE IF NOT EXISTS cluster_membership ( ... );
```

Added to `MIGRATIONS` array in `src/core/store.ts`.

---

## `ClusterEngine` class

New file: `src/core/cluster-engine.ts`

```typescript
export interface Cluster {
  name: string;        // dot-separated unique ID: "App.Http.Controllers"
  label: string;       // display label: "Http / Controllers"
  source: ClusterSource;
  parentName: string | null;
  depth: number;
  fileCount: number;
  children?: Cluster[];
}

export type ClusterSource = 'namespace' | 'directory' | 'community';

export class ClusterEngine {
  constructor(private store: Store) {}

  /**
   * Run all three cluster detection strategies and persist results.
   * Called at the end of `mapx scan` and `mapx update`.
   */
  detect(repo: string): ClusterResult { ... }

  /**
   * Build cluster tree from namespace declarations already stored as
   * file-level metadata (php: namespace field, ts: namespace symbol).
   */
  private detectNamespaceClusters(repo: string): Cluster[] { ... }

  /**
   * Build cluster tree from directory paths of all files in repo.
   */
  private detectDirectoryClusters(repo: string): Cluster[] { ... }

  /**
   * Run label propagation on the edge graph to find community clusters.
   */
  private detectCommunityClusters(repo: string, edges: GraphEdge[]): Cluster[] { ... }

  /**
   * Persist detected clusters and their memberships to the database.
   */
  private persist(repo: string, clusters: Cluster[], memberships: MembershipEntry[]): void { ... }

  getClusters(repo: string): Cluster[] { ... }
  getClusterTree(repo: string): Cluster[] { ... }  // returns root clusters with nested children
  getClusterFiles(clusterName: string, repo: string): string[] { ... }
  getClusterEdges(clusterName: string, repo: string): ClusterEdge[] { ... }  // inter-cluster edges
}

export interface ClusterResult {
  clustersFound: number;
  namespaceClusters: number;
  directoryClusters: number;
  communityClusters: number;
  filesAssigned: number;
  durationMs: number;
}

export interface ClusterEdge {
  sourceCluster: string;
  targetCluster: string;
  edgeCount: number;    // number of file-level edges between clusters
  dominantType: string; // most common edge_type between the clusters
}
```

---

## PHP namespace capture

The PHP parser currently does not capture the `namespace` declaration as file metadata. Add this:

```scheme
; queries/php/symbols.scm — add namespace capture
(namespace_definition
  name: (namespace_name) @symbol.namespace)
```

And in `php.ts`, store the namespace as a file-level metadata field passed back in `ParseResult.fileMetadata`.

New field in `ParseResult`:
```typescript
export interface ParseResult {
  symbols: ExtractedSymbol[];
  references: ExtractedReference[];
  errors: ParseError[];
  fileMetadata?: {
    namespace?: string;   // PHP: "App\Http\Controllers"
    module?: string;      // TS: namespace name
    package?: string;     // Go/Python: package name
  };
}
```

The scanner writes `fileMetadata.namespace` to the `files` table as a new `namespace` column (schema migration v4).

---

## `mapx clusters` CLI command

```
mapx clusters [--dir /path] [--source namespace|directory|community|all] [--json]
```

Default output (tree format):

```
app                               (directory)  [42 files]
  app.Http                        (directory)  [18 files]
    app.Http.Controllers          (namespace)  [8 files]
    app.Http.Middleware           (namespace)  [4 files]
    app.Http.Requests             (namespace)  [6 files]
  app.Models                      (namespace)  [12 files]
  app.Services                    (namespace)  [7 files]
  app.Providers                   (namespace)  [5 files]
src                               (directory)  [24 files]
  src.core                        (directory)  [8 files]
  src.exporters                   (directory)  [5 files]
  src.parsers                     (directory)  [11 files]

12 clusters detected (6 namespace, 4 directory, 2 community)
```

With `--json`:
```json
{
  "clusters": [
    {
      "name": "app.Http.Controllers",
      "label": "Http / Controllers",
      "source": "namespace",
      "depth": 2,
      "fileCount": 8,
      "parentName": "app.Http"
    }
  ]
}
```

`mapx clusters <name>` shows files in a specific cluster:
```
mapx clusters app.Http.Controllers

app.Http.Controllers  [namespace]  8 files
  app/Http/Controllers/UserController.php
  app/Http/Controllers/OrderController.php
  app/Http/Controllers/AuthController.php
  ...

Depends on:
  app.Models        [14 edges — import, param_type, call]
  app.Services      [8 edges  — call, instantiation]

Depended on by:
  (none — leaf cluster)
```

---

## `mapx_clusters` MCP tool

```typescript
{
  name: "mapx_clusters",
  description: "List detected code clusters/modules. Returns cluster hierarchy with file counts and inter-cluster dependencies.",
  inputSchema: {
    type: "object",
    properties: {
      source:  { type: "string", enum: ["all", "namespace", "directory", "community"] },
      cluster: { type: "string", description: "Show files for a specific cluster name" },
    }
  }
}
```

---

## Scan integration

`ClusterEngine.detect()` is called at the end of `Scanner.scan()` and `Scanner.update()`, after all files are parsed and edges are resolved. It adds minimal overhead (directory clustering is O(N files), namespace clustering is O(N files), community detection is O(E edges)).

Progress is reported via the existing `ProgressCallback` as a new `cluster` phase:

```typescript
export type ScanPhase = 'discover' | 'index' | 'parse' | 'resolve' | 'detect' | 'cluster';
```

---

## Acceptance Criteria

- [ ] Schema v4 migration creates `clusters` and `cluster_membership` tables without errors
- [ ] `mapx scan` on the mapx project itself detects `src.core`, `src.exporters`, `src.parsers` as directory clusters
- [ ] PHP project: `namespace App\Http\Controllers` → cluster `App.Http.Controllers`
- [ ] PHP project: namespace clusters have `source = 'namespace'`; directory clusters have `source = 'directory'`
- [ ] `mapx clusters` prints tree output
- [ ] `mapx clusters app.Http.Controllers` prints files + inter-cluster edges
- [ ] `mapx clusters --json` produces valid JSON
- [ ] `mapx_clusters` MCP tool responds correctly
- [ ] `ClusterEngine.getClusterEdges()` returns correct inter-cluster edge counts
- [ ] Community detection: files with mutual imports grouped together
- [ ] `ScanPhase` union updated; scan progress shows cluster phase
- [ ] TypeScript type-check passes
- [ ] Scan duration increase < 10% on a 200-file project

---

## Out of Scope for F14

- Manual cluster name overrides in config (deferred)
- Cross-language cluster merging (e.g. PHP controller cluster + TypeScript frontend cluster in same project)
- Cluster diff across git commits (would build on F14 + git-tracker)
- Cluster-level metrics (coupling, instability) — that is F02 enhancement territory
