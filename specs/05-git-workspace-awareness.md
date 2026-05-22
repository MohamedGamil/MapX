# Git Workspace Awareness — Overview

This document describes mapx's strategy for expanding from single-repository awareness to **workspace-level and multi-repository understanding**, including automatic detection of git submodules, sibling repositories, and VS Code multi-root workspaces.

---

## Problem

mapx currently assumes one git repository per `.mapx/` index. This breaks down in real-world project structures:

### Scenario 1 — Git submodules

A project has `frontend/` as a git submodule (separate repo, separate history). When mapx scans the parent, it:
- Walks into `frontend/` and indexes its files as if they belong to the parent repo
- Uses the parent's `git ls-tree HEAD` for blob hashes — but submodule directories appear as a single commit object, not as individual file hashes
- Consequently, `mapx update` cannot correctly detect changed files inside submodules (either misses changes or re-scans everything)
- The submodule's own commit history is invisible

### Scenario 2 — Monorepo-style workspace

A developer's workspace has three sibling directories, each its own git repo:
```
~/projects/
├── api/        (.git)
├── frontend/   (.git)
└── shared/     (.git)
```
Running `mapx init` in `~/projects/` initialises a single flat index that ignores the boundary between repos — symbols from `api/` and `frontend/` are mixed, cross-repo imports have no distinct identity, and `mapx update` uses a single blob-hash table that doesn't account for the separate git histories.

### Scenario 3 — VS Code multi-root workspace

A `.code-workspace` file defines multiple root folders. mapx has no mechanism to read this file or respect its folder boundaries.

### Scenario 4 — Nested repo detection during scan

During a file walk, mapx encounters a nested `.git` directory it was never told about. It silently indexes that directory's files as if they were part of the parent — missing the opportunity to track incremental changes correctly for that sub-tree.

---

## Solution: `WorkspaceManager`

A new `src/core/workspace-manager.ts` module that handles:

1. **Submodule discovery** — parse `.gitmodules` files in the current repo root and any registered repos, registering each submodule as a distinct `RepoConfig` entry
2. **Peer repo detection** — discover sibling git repositories in the same parent directory, or read a VS Code `.code-workspace` file for folder declarations
3. **Nested repo detection** — during file walk, stop at directories that contain a `.git` entry (file or directory) that hasn't been registered as a repo, and warn the user
4. **Per-repo scan isolation** — each discovered repo gets its own scan context: its own `git ls-tree` blob hash map, its own `HEAD` tracking, its own resume state

---

## Architecture

```
WorkspaceManager
├── discoverSubmodules(repoRoot)        → RepoConfig[] from .gitmodules
├── discoverPeerRepos(workspaceRoot)    → RepoConfig[] from sibling .git dirs
├── discoverVSCodeWorkspace(wsFile)     → RepoConfig[] from .code-workspace
├── detectNestedRepos(rootDir)          → string[] (unregistered nested .git paths)
└── autoRegister(options)              → updated MapxConfig
```

`Config.repos[]` is already an array — `WorkspaceManager` populates it automatically during `mapx init` or on demand via `mapx workspaces discover`.

---

## Multi-repo scanning model

Each repo in `Config.repos[]` is scanned independently:
- Its own `git ls-tree HEAD` → blob hash map (using the submodule's own `.git` index)
- Its own `HEAD` SHA stored in the database for incremental comparison
- Its files stored in the `files` table under `repo = repoName`
- Its symbols stored in `symbols` under `repo = repoName`

Cross-repo edges (imports from repo A to repo B) are stored in the `edges` table with `source_repo` and `target_repo` fields, enabling cross-repo graph queries.

---

## New CLI surface

```bash
mapx workspaces list          # list all registered repos (active) and discovered submodules, peers, and VS Code folders
mapx workspaces show          # alias for list
mapx workspaces add <path>    # manually register a repo and run initial full scan (optional --name <name>)
mapx workspaces remove <name> # unregister a repo and delete its data from SQLite immediately
mapx workspaces sync          # automatically discover and register submodules, peers, and VS Code workspaces, scanning them

mapx scan --repo <name>       # scan a specific registered repo
mapx scan --all               # scan all registered repos
mapx update --repo <name>     # incremental update for a specific repo
mapx update --all             # incremental update across all repos
```

---

## Scope

### Covered in F18 (Implemented & Verified):
- **Submodule discovery and registration**: Parses `.gitmodules` files to discover submodule names and paths.
- **Peer repo discovery**: Scans parent directory for sibling `.git` repositories.
- **VS Code workspace support**: Scans `.code-workspace` files to discover folder definitions.
- **Nested repo detection during scan**: Warns and stops walking inside unregistered nested `.git` directories.
- **Per-repo scan isolation**: Uses separate git trackers and commits.
- **`mapx workspaces` command group**: Completed with list, add, remove, and sync subcommands.
- **`--repo` and `--all` options**: Fully integrated into both `scan` and `update` commands.
- **Cross-repo edge tracking**: Graph dependency edges store `targetRepo` when targeting external workspace repositories.
- **`mapx_scan` MCP tool**: Updated to support optional `repo` and `all` parameters.

Not covered (deferred):
- Sparse-checkout / partial submodule awareness
- `git worktree` multi-worktree support
- Automatic re-registration when `.gitmodules` changes (watch mode)
- Cross-repo dependency graph visualisation (requires F15 cluster work from I08)
