# F18 — Git Workspace & Submodule Awareness

| Field | Value |
|-------|-------|
| ID | F18 |
| Status | `planned` |
| Iteration | I10 |
| Branch | `feat/i10-git-workspace-awareness` |
| Depends on | — (independent) |
| Blocked by | — |

---

## Problem

mapx's current `git-tracker.ts` operates exclusively on a single `repoRoot`. The `Config.repos[]` array supports multiple repo entries but they are never populated automatically — the user must manually edit `.mapx/config.json`. This causes three concrete failure modes:

### 1. Submodules — incorrect incremental scans

When a parent repo contains a git submodule (e.g. `libs/ui` is a submodule), running `git ls-tree -r HEAD` in the parent lists the submodule directory as a single commit-object entry, not as individual file hashes. Consequence:

- `mapx update` sees no file-level changes inside the submodule — it either skips all submodule files (misses changes) or re-scans every file on each run (because content-hash differs from the missing blob-hash)
- The submodule's own `HEAD` is never stored — diff-based updates against `HEAD~1` produce wrong results

### 2. Peer repos — blended symbol namespaces

In a multi-repo workspace (`api/`, `frontend/`, `shared/` each as independent `.git` repos), mapx has no concept of boundaries. Symbols from all repos are mixed in the same index under the parent directory name. Cross-repo imports (e.g. `frontend/` importing from `shared/`) are invisible — they look like intra-repo imports even though they cross a version-controlled boundary.

### 3. Nested `.git` detection — silent wrong indexing

During a file walk, if mapx encounters an unregistered `.git` directory, it continues walking into it and indexes those files as part of the parent repo. The user gets no warning and the incremental scan behaviour for that sub-tree is incorrect.

---

## Goal

1. Auto-discover git submodules by parsing `.gitmodules` and register them as separate `RepoConfig` entries
2. Auto-discover sibling git repos (peer repos) and VS Code multi-root workspaces
3. Stop the file walker at unregistered nested `.git` directories and emit a warning
4. Fix incremental scan correctness for submodules (use the submodule's own git index)
5. Track cross-repo dependency edges in the graph
6. Add `mapx workspaces` CLI command group and `--all` flags

---

## New type definitions

### Extensions to existing types (`src/types.ts`)

```typescript
export interface RepoConfig {
  name: string;
  path: string;
  languages?: Record<string, UserLanguageDefinition>;
  // NEW
  submoduleOf?: string;       // parent repo name, if this is a registered submodule
  gitmoduleUrl?: string;      // remote URL from .gitmodules
  peerDiscovery?: boolean;    // true if auto-discovered as a peer repo
}
```

### New types

```typescript
// In src/types.ts
export interface SubmoduleInfo {
  name: string;             // from [submodule "name"] in .gitmodules
  path: string;             // relative path from parent repo root
  url: string;              // remote URL
  branch?: string;          // optional branch lock
  absolutePath: string;     // resolved absolute path
  isInitialised: boolean;   // does the directory exist and contain a .git entry?
}

export interface WorkspaceInfo {
  root: string;             // absolute path to workspace root
  repos: RepoSummary[];
}

export interface RepoSummary {
  name: string;
  path: string;             // absolute path
  relativePath: string;     // relative to workspace root
  type: 'primary' | 'submodule' | 'peer' | 'vscode-workspace';
  isRegistered: boolean;    // in config.repos
  isInitialised: boolean;   // .git dir / file exists
  lastScanned: string | null;
  fileCount: number;
  headSha: string | null;
}
```

---

## `WorkspaceManager` class

New file: `src/core/workspace-manager.ts`

```typescript
export interface DiscoverOptions {
  includeSubmodules?: boolean;    // default: true
  includePeers?: boolean;         // default: false (opt-in; can be noisy)
  includeVSCodeWorkspace?: boolean; // default: true (if .code-workspace found)
  recursive?: boolean;            // recurse into submodule's own .gitmodules
}

export interface DiscoverResult {
  submodules: SubmoduleInfo[];
  peers: SubmoduleInfo[];
  vsCodeRepos: SubmoduleInfo[];
  unregisteredNested: string[];   // .git paths found during walk but not in .gitmodules
}

export class WorkspaceManager {
  constructor(private workspaceRoot: string, private config: Config) {}

  // Parse .gitmodules at repoRoot, return SubmoduleInfo[]
  discoverSubmodules(repoRoot: string, recursive?: boolean): SubmoduleInfo[] { ... }

  // Find sibling directories in parent(workspaceRoot) that contain .git
  discoverPeerRepos(workspaceRoot: string): SubmoduleInfo[] { ... }

  // Read a .code-workspace file, extract folder paths that are git repos
  discoverVSCodeWorkspace(wsFilePath: string): SubmoduleInfo[] { ... }

  // Find a .code-workspace file in or near workspaceRoot
  findVSCodeWorkspaceFile(workspaceRoot: string): string | null { ... }

  // Detect unregistered nested .git dirs under rootDir
  detectNestedRepos(rootDir: string, registeredPaths: Set<string>): string[] { ... }

  // Run all discovery, return combined result
  discover(options?: DiscoverOptions): DiscoverResult { ... }

  // Convert DiscoverResult to new RepoConfig entries (dedup against existing)
  toRepoConfigs(result: DiscoverResult): RepoConfig[] { ... }

  // Apply discovered repos to config (writes config file)
  autoRegister(options?: DiscoverOptions): Promise<RepoConfig[]> { ... }

  // Build a WorkspaceInfo summary for `mapx workspaces`
  buildWorkspaceInfo(): WorkspaceInfo { ... }
}
```

---

## `.gitmodules` parsing

`discoverSubmodules(repoRoot)` reads and parses `.gitmodules` using a simple INI-style parser (no external dep):

```
[submodule "libs/ui"]
	path = libs/ui
	url = https://github.com/org/ui-library.git
	branch = main

[submodule "vendor/legacy"]
	path = vendor/legacy
	url = ../legacy-service.git
```

Parsed to:
```typescript
[
  {
    name: 'libs/ui',
    path: 'libs/ui',
    url: 'https://github.com/org/ui-library.git',
    branch: 'main',
    absolutePath: '/workspace/libs/ui',
    isInitialised: true,  // existsSync('/workspace/libs/ui/.git')
  },
  ...
]
```

Uninitialised submodules (`isInitialised: false`) are reported in the discover output but not auto-registered — they would cause scan failures. The user is warned.

---

## Peer repo discovery

`discoverPeerRepos(workspaceRoot)` walks one directory level above `workspaceRoot` looking for sibling directories that contain `.git`:

```
/home/user/projects/
├── api/            .git   ← sibling
├── frontend/       .git   ← sibling
└── shared/         .git   ← workspaceRoot
```

When called from `shared/`, returns `['api', 'frontend']` as potential peers. This is **opt-in** (`--include-peers` flag or interactive prompt during `mapx workspaces discover`) to avoid false positives in deeply nested directory trees.

---

## VS Code `.code-workspace` reading

`findVSCodeWorkspaceFile(dir)` searches for `*.code-workspace` in `dir` and one level up. If found, `discoverVSCodeWorkspace(path)` parses the JSON:

```json
{
  "folders": [
    { "path": "/home/user/projects/api" },
    { "path": "/home/user/projects/frontend" },
    { "path": "../shared" }
  ]
}
```

Each folder that is a git repo is returned as a `SubmoduleInfo` with `type = 'vscode-workspace'`.

---

## Nested `.git` detection during scan

The `Scanner.discoverFiles()` method currently ignores `.git` directories (they are in `DEFAULT_IGNORE`). This check is enhanced:

**Before F18:** Skip any directory named `.git`

**After F18:** When a directory entry is `.git`, check whether the **parent** directory is:
- The registered `repoRoot` — expected, continue scanning as normal
- A registered submodule path — expected for that submodule's scan context
- Unregistered — **stop walking into this directory**. Add the parent path to `unregisteredNested[]` and emit a warning via `onProgress`:

```
⚠  Unregistered git repository found at libs/legacy/
   Run `mapx workspaces discover` to register it, or add `libs/legacy/**` to excludePatterns to silence this warning.
```

Files inside unregistered nested repos are **excluded** from the current scan. This prevents incorrect blob-hash tracking for those files.

---

## Per-submodule incremental scan correctness

**Current behaviour:** `getGitBlobHashes(repoRoot)` is called once with the parent's root. Submodule directories produce a single commit-hash entry in `git ls-tree`, not per-file hashes.

**F18 behaviour:** For each registered `RepoConfig`, `getGitBlobHashes()` is called with that repo's `absolutePath` as the `cwd`. This is the submodule's own `.git` directory root, so `git ls-tree -r HEAD` lists actual file hashes within the submodule.

This requires that the scanner iterates repos independently:

```typescript
// Before F18: scanner processes config.repo (singular)
// After F18: scanner iterates config.repos[] and runs per-repo scan
for (const repo of this.config.repos) {
  const repoRoot = resolve(workspaceRoot, repo.path);
  const gitHashes = isGitRepo(repoRoot) ? getGitBlobHashes(repoRoot) : new Map();
  // ... scan this repo's files
}
```

The schema's `files.repo` column already stores the repo name — no schema change needed.

---

## Cross-repo edge tracking

When symbol resolution (F05 FQN or TypeScript import path resolution) determines that a reference in `repo A` targets a symbol in `repo B`, the edge is stored with both `source_repo` and `target_repo` populated:

```sql
-- existing edges table
INSERT INTO edges (..., source_repo, target_repo)
VALUES (..., 'api', 'shared')
```

The `GraphEdge` interface gains:
```typescript
export interface GraphEdge {
  // ... existing fields ...
  sourceRepo: string;
  targetRepo: string;   // may differ from sourceRepo for cross-repo edges
}
```

Cross-repo edges are rendered distinctly in DOT/SVG exports (dashed border on subgraph cluster) and listed separately in `mapx deps <file> --cross-repo`.

---

## `mapx workspaces` command group

### `mapx workspaces [dir]`

List all registered repos with their scan status:

```
$ mapx workspaces

Workspace: /home/user/projects/my-app

  Name            Path              Type        Files  Last scanned    HEAD
  ─────────────────────────────────────────────────────────────────────────────
  my-app          .                 primary     312    2 hours ago     a1b2c3d
  libs/ui         libs/ui           submodule   84     2 hours ago     f4e5d6c  
  vendor/legacy   vendor/legacy     submodule   ✗ not initialised
  
2 registered repos, 1 uninitialised submodule.
Run `git submodule update --init vendor/legacy` to initialise it.
```

### `mapx workspaces discover [dir]`

Auto-discover submodules, peers, and VS Code workspace folders:

```
$ mapx workspaces discover

Discovering git repositories for /home/user/projects/my-app...

  Found .gitmodules — 2 submodules:
    + libs/ui        (libs/ui)       ✓ initialised
    + vendor/legacy  (vendor/legacy) ✗ not initialised — skipping

  Found .code-workspace at /home/user/projects/my-app.code-workspace:
    + api   (/home/user/projects/api)  — sibling repo

  Peer repos in /home/user/projects/:
    (use --include-peers to include sibling directories)

Register libs/ui and api? [Y/n]
```

### `mapx workspaces add <path> [dir]`

Manually register a repo:

```bash
mapx workspaces add libs/ui
mapx workspaces add /absolute/path/to/other-repo --name=other
```

### `mapx workspaces remove <name> [dir]`

Unregister a repo. Does not delete indexed data immediately (data is cleaned on next full scan):

```bash
mapx workspaces remove libs/ui
```

---

## `--all` flag enhancements

### `mapx scan --all`

Runs `scanFull()` for each registered repo sequentially. Progress output is prefixed with the repo name:

```
[my-app]    Discovering files... 312 found
[my-app]    Indexing 312 files...
[my-app]    Parsing 312 files...
[libs/ui]   Discovering files... 84 found
[libs/ui]   Parsing 84 files...
...
Scanned 2 repos: 396 files, 2,140 symbols, 4,820 edges — 8.3s
```

### `mapx update --all`

Runs `scanIncremental()` for each registered repo:

```
[my-app]    Checking git changes... 3 files changed
[my-app]    Re-parsing 3 files...
[libs/ui]   No changes since last scan (HEAD: f4e5d6c)
...
Updated 1 repo: 3 files re-scanned — 0.4s
```

### `mapx status --all`

Per-repo status table:

```
$ mapx status --all

  Repo           Files  Symbols  Edges   HEAD     Last scan     Changed
  ────────────────────────────────────────────────────────────────────────
  my-app         312    1,840    4,200   a1b2c3d  2h ago        3 files
  libs/ui        84       300      620   f4e5d6c  2h ago        clean
  
Total: 396 files, 2,140 symbols, 4,820 edges
Cross-repo edges: 47 (my-app → libs/ui)
```

### `mapx export --all`

Combined multi-repo export in LLM format, with each repo as a separate section:

```markdown
# Workspace: my-app

## Repos (2)
- my-app (primary) — 312 files, 1,840 symbols
- libs/ui (submodule) — 84 files, 300 symbols

## Cross-repo dependencies (47 edges)
my-app → libs/ui: 47 imports

## my-app
...

## libs/ui
...
```

### `mapx export --repo=<name>`

Restricts export to a single repo (already partially supported via `ExportOptions.repo`; F18 makes this fully functional with the multi-repo model).

---

## `mapx_workspaces` MCP tool

```typescript
{
  name: "mapx_workspaces",
  description: "List all git repositories registered in this workspace, including submodules and peer repos. Returns scan status, file counts, and HEAD commit for each.",
  inputSchema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "Workspace root (default: configured project dir)" }
    }
  }
}
```

Response:
```json
{
  "root": "/home/user/projects/my-app",
  "repos": [
    {
      "name": "my-app",
      "path": "/home/user/projects/my-app",
      "type": "primary",
      "isRegistered": true,
      "isInitialised": true,
      "lastScanned": "2026-05-22T10:00:00Z",
      "fileCount": 312,
      "headSha": "a1b2c3d"
    },
    {
      "name": "libs/ui",
      "path": "/home/user/projects/my-app/libs/ui",
      "type": "submodule",
      "isRegistered": true,
      "isInitialised": true,
      "lastScanned": "2026-05-22T10:00:00Z",
      "fileCount": 84,
      "headSha": "f4e5d6c"
    }
  ],
  "crossRepoEdgeCount": 47
}
```

---

## Changes to `mapx init`

After the existing init steps, if `.gitmodules` is found:

```
  Detected .gitmodules with 2 submodule(s):

    libs/ui        (libs/ui)       ✓ initialised
    vendor/legacy  (vendor/legacy) ✗ not initialised

  Register initialised submodules? [Y/n]  Y

  Registered 1 submodule. Run `mapx scan --all` to index all repos.
```

If a `.code-workspace` file is found nearby:

```
  Detected VS Code workspace file: my-app.code-workspace
  Additional repos: api (/home/user/projects/api)

  Register workspace repos? [Y/n]
```

`mapx init --no-workspaces` skips both prompts.

---

## New source files

```
src/core/workspace-manager.ts    ← WorkspaceManager class
```

## Modified source files

```
src/types.ts                     ← RepoConfig.submoduleOf, RepoConfig.gitmoduleUrl,
                                   SubmoduleInfo, WorkspaceInfo, RepoSummary interfaces;
                                   GraphEdge.targetRepo field
src/core/git-tracker.ts          ← discoverSubmodules(), isSubmodule() helpers
src/core/scanner.ts              ← multi-repo iteration; nested .git detection;
                                   per-repo getGitBlobHashes() call
src/core/config.ts               ← getRepos(), getRepo(name) accessors;
                                   addRepo(), removeRepo() mutators
src/cli.ts                       ← `mapx workspaces` command group;
                                   --all flag on scan/update/status/export;
                                   submodule prompt in init flow
src/mcp.ts                       ← mapx_workspaces MCP tool
src/exporters/llm-exporter.ts    ← --all multi-repo export, cross-repo edge section
src/exporters/dot-exporter.ts    ← cross-repo edges rendered as dashed inter-cluster edges
```

---

## Schema changes

A schema migration is required to support cross-repo edges:
- `files.repo` — already stores repo name
- `symbols.repo` — already stores repo name
- `edges` — requires adding a new `target_repo` column

```sql
-- Migration: add target_repo column to edges (nullable; NULL = same repo)
ALTER TABLE edges ADD COLUMN target_repo TEXT;
```

This requires a schema version bump to **v5** (v3 = F01 verifiability, v4 = F14 clusters, v5 = F18 target_repo, v6 = F21 edge metadata).

---

## Acceptance Criteria

- [ ] `mapx workspaces discover` finds all entries in `.gitmodules`
- [ ] `mapx workspaces discover` finds VS Code `.code-workspace` folders when file is present
- [ ] Uninitialised submodules reported but not registered
- [ ] `mapx workspaces add <path>` registers a repo and persists to config
- [ ] `mapx workspaces remove <name>` removes from config
- [ ] `mapx scan --all` scans each registered repo independently
- [ ] `mapx update --all` runs incremental scan per repo using each repo's own git index
- [ ] After `mapx update --all`, incremental scan for an unchanged submodule reports 0 files changed
- [ ] After `mapx update --all`, changed files in a submodule are correctly detected
- [ ] Nested unregistered `.git` directory during scan: warning emitted, directory excluded
- [ ] `mapx status --all` prints per-repo table with file counts and HEAD SHAs
- [ ] `mapx export --all` produces multi-repo LLM summary
- [ ] `mapx export --repo=<name>` exports only that repo
- [ ] Cross-repo edges stored with correct `target_repo` value
- [ ] `mapx deps <file> --cross-repo` shows cross-repo imports separately
- [ ] `mapx_workspaces` MCP tool returns correct JSON
- [ ] `mapx init` prompts for submodule registration when `.gitmodules` present
- [ ] `mapx init --no-workspaces` skips submodule/workspace prompts
- [ ] TypeScript type-check passes with 0 errors
- [ ] All existing single-repo behaviour unchanged when only one repo is registered

---

## Out of scope for F18

- `git worktree` awareness (multiple working trees from one repo)
- Sparse checkout / partial clone awareness
- Automatic re-registration when `.gitmodules` changes (file watch mode)
- Cross-repo cluster visualisation (F15 from I08 handles cluster DOT rendering)
- Automatic submodule initialisation (`git submodule update --init`) — mapx does not execute git mutating commands
- Cross-repo taint analysis / data flow (F16 from I08)
