<!-- mapx v0.3.9 #95e4591ebb1c -->
# MapxGraph - Claude Integration Guide

This project is configured with **MapxGraph** for codebase navigation and graph query support across **23 languages**.

## Claude Desktop Configuration

Add the following to your Claude Desktop configuration file (`~/.config/Claude/claude_desktop_config.json` or `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mapx-mapx": {
      "command": "npx",
      "args": [
        "-y",
        "@mgamil/mapx",
        "serve",
        "--dir",
        "/home/mgamil/mapx"
      ]
    }
  }
}
```

### SSE (HTTP) transport

To share one long-running server between clients, start it with `mapx serve --sse --port 3456 --dir /home/mgamil/mapx` and register its URL instead:

```json
{
  "mcpServers": {
    "mapx-mapx": {
      "type": "sse",
      "url": "http://localhost:3456/sse"
    }
  }
}
```

## MCP Tools Available (39 total)

**Graph Building:** `mapx_scan`, `mapx_sync`
**Symbol Discovery:** `mapx_query`, `mapx_search`, `mapx_node`, `mapx_files`
**Dependencies & Flow:** `mapx_dependencies`, `mapx_callers`, `mapx_callees`, `mapx_trace`, `mapx_sources`, `mapx_sinks`, `mapx_routes`, `mapx_hooks`, `mapx_edges`
**Analysis:** `mapx_impact`, `mapx_clusters`, `mapx_status`, `mapx_metrics`, `mapx_profile`, `mapx_explain`, `mapx_smells`, `mapx_dsm`, `mapx_layers`
**Architecture rules:** `mapx_arch_allowed`, `mapx_arch_check`, `mapx_arch_explain`, `mapx_arch_layers`, `mapx_arch_init`, `mapx_arch_validate_config`
**Export:** `mapx_export` (llm/json/dot/svg/toon), `mapx_context`
**Workspaces:** `mapx_workspaces` (list/discover)
**Languages:** `mapx_lang_list`, `mapx_lang_info` (all grammars bundled; `mapx_lang_install`/`mapx_lang_uninstall` are no-ops)
**Orchestration:** `mapx_batch`, `mapx_agents_generate`

## Workflows

1. Run `mapx_export` at the start of your session to gain context.
2. Use `mapx_query` or `mapx_search` to find symbols.
3. Use `mapx_callers` / `mapx_callees` to trace call chains.
4. Run `mapx_impact` before making changes to understand blast radius.
5. If files are modified, call `mapx_sync` to update the graph.
6. Call `mapx_trace` to trace data flow paths.
7. Before adding an import across modules, call `mapx_arch_allowed`.

## Architecture Rules

When the project has `.mapx/architecture.jsonc` (`mapx_arch_init` proposes one, and writes it only with `write: true`):

1. **Before adding an import across modules, call `mapx_arch_allowed`** with `from` (the file or symbol you are editing) and `to` (what you want to use). If `allowed` is false, read `reason`. `alternatives` lists matching symbols (a supertype, or a similar name) that the rules let `from` use; check that one fits before switching to it.
2. Call `mapx_arch_explain` to see why an element is in a layer, or why a dependency is refused.
3. After editing, call `mapx_arch_check` with `sync: true` (narrow it with `file` or `since`): `exitCode` 1 means a violation to fix. Without `sync: true`, every architecture tool refuses an index older than your edits (`exitCode` 4); pass it to `mapx_arch_allowed` too once you have edited files.
<!-- /mapx -->

## MapX development: BATON

Read `docs/baton/PROJECT_STATE.md` and `docs/baton/HANDOFF.md`, inspect git, and run `npm run plan:validate` before any work. `docs/baton/TASKS.json` is authoritative for status, dependencies, gates and evidence; handoffs and reports are claims to verify against files and test output. `specs/` is frozen history (D001): cite `specs/features/F*.md` from task `sources`, and never update `specs/ITERATIONS.md`.

- **Plan and continue work** with the `baton` skill (`.claude/skills/baton/`). Use `npm run plan:scan` for ready/promotable/next-wave work, and `npm run plan:transition` for every status change.
- **Review delivered work** with the `baton-review` skill (`.claude/skills/baton-review/`), which reviews since the marker in `docs/baton/reviews/state.json`.
- **Baseline check:** `npm run check` (plan validation, typecheck, vitest, skill tests). Run `npm ci --legacy-peer-deps` first on a fresh clone.
- **Ground rules:** fixtures before fixes; never use private or pilot code in fixtures; attach real evidence before DONE; one active iteration per owner. Releases are owner-initiated (D007): never bump the version, publish or request a release. Commit only when asked.
