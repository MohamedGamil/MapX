# F32 — `mapx workspaces discover` CLI Subcommand

> **Iteration**: [I16](../iterations/I16.md) · **Status**: `planned` · **Priority**: 🟡 MEDIUM
> **Origin**: Roadmap audit finding #6 — standalone discover command missing per I10 spec

---

## Problem

The I10 spec lists `mapx workspaces discover` as a standalone subcommand. Currently, discovery is split between `list` (shows discovered repos inline with registered repos) and `sync` (auto-discovers and registers). There is no read-only command that **only** shows unregistered discoveries without mixing them with registered repos or auto-registering anything.

## Solution

Add a `mapx workspaces discover` subcommand that:
1. Scans for submodules (`.gitmodules`), peer repos (sibling directories), and VS Code workspace folders
2. Filters out already-registered repos
3. Displays results grouped by source type (submodule / peer / vscode-workspace)
4. Does NOT register or modify anything (pure read-only operation)

## Files Changed

| File | Change |
|------|--------|
| `src/cli.ts` | Add `workspacesCmd.command('discover')` handler |

## Acceptance Criteria

- [ ] `mapx workspaces discover` lists unregistered submodules, peers, and VS Code workspace folders
- [ ] Output groups results by discovery source type
- [ ] Does NOT auto-register anything (read-only)
- [ ] Exits cleanly when no discoveries are found
- [ ] TypeScript compiles with 0 errors
