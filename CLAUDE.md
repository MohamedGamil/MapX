<!-- mapx v0.3.5 -->
# MapxGraph - Claude Integration Guide

This project is configured with **MapxGraph** for codebase navigation and graph query support across **22 languages**.

## Claude Desktop Configuration

Add the following to your Claude Desktop configuration file (`~/.config/Claude/claude_desktop_config.json` or `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mapx-mapx": {
      "command": "npx",
      "args": [
        "-y",
        "mapx",
        "serve",
        "--dir",
        "/Users/gamil/Projects/mapx"
      ]
    }
  }
}
```

## MCP Tools Available (32 total)

**Graph Building:** `mapx_scan`, `mapx_sync`
**Symbol Discovery:** `mapx_query`, `mapx_search`, `mapx_node`, `mapx_files`
**Dependencies & Flow:** `mapx_dependencies`, `mapx_callers`, `mapx_callees`, `mapx_trace`, `mapx_sources`, `mapx_sinks`, `mapx_routes`, `mapx_hooks`, `mapx_edges`
**Analysis:** `mapx_impact`, `mapx_clusters`, `mapx_status`, `mapx_metrics`, `mapx_profile`, `mapx_explain`, `mapx_smells`, `mapx_dsm`, `mapx_layers`
**Export:** `mapx_export` (llm/json/dot/svg/toon), `mapx_context`
**Workspaces:** `mapx_workspaces` (list/discover)
**Languages:** `mapx_lang_list`, `mapx_lang_install`, `mapx_lang_uninstall`
**Orchestration:** `mapx_batch`, `mapx_agents_generate`

## Workflows

1. Run `mapx_export` at the start of your session to gain context.
2. Use `mapx_query` or `mapx_search` to find symbols.
3. Use `mapx_callers` / `mapx_callees` to trace call chains.
4. Run `mapx_impact` before making changes to understand blast radius.
5. If files are modified, call `mapx_sync` to update the graph.
6. Call `mapx_trace` to trace data flow paths.
<!-- /mapx -->

## MapX development: BATON

Read `docs/baton/PROJECT_STATE.md` and `docs/baton/HANDOFF.md`, inspect git, and run `npm run plan:validate` before any work. `docs/baton/TASKS.json` is authoritative for status, dependencies, gates and evidence; handoffs and reports are claims to verify against files and test output. `specs/` is frozen history (D001): cite `specs/features/F*.md` from task `sources`, and never update `specs/ITERATIONS.md`.

- **Plan and continue work** with the `baton` skill (`.claude/skills/baton/`). Use `npm run plan:scan` for ready/promotable/next-wave work, and `npm run plan:transition` for every status change.
- **Review delivered work** with the `baton-review` skill (`.claude/skills/baton-review/`), which reviews since the marker in `docs/baton/reviews/state.json`.
- **Baseline check:** `npm run check` (plan validation, typecheck, vitest, skill tests). Run `npm ci --legacy-peer-deps` first on a fresh clone.
- **Ground rules:** fixtures before fixes; never use private or pilot code in fixtures; attach real evidence before DONE; one active iteration per owner. Releases are owner-initiated (D007): never bump the version, publish or request a release. Commit only when asked.
