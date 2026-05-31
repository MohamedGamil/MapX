<!-- mapx v0.3.2 -->
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