# F29 — `mapx_workspaces` MCP Tool

> **Iteration**: [I16](../iterations/I16.md) · **Status**: `planned` · **Priority**: 🔴 HIGH
> **Origin**: Roadmap audit finding #1 — MCP tool missing despite being planned in I10

---

## Problem

The I10 spec and ROADMAP.md both list `mapx_workspaces` as an MCP tool, but it was never registered or implemented in `src/mcp.ts`. LLM agents using MCP cannot query or manage workspaces programmatically. The CLI commands (`mapx workspaces list/add/remove/sync`) work correctly — only the MCP surface is missing.

## Solution

Add `mapx_workspaces` tool registration to the `ListToolsRequestSchema` handler and a corresponding `case 'mapx_workspaces':` handler in the `executeTool` switch block.

## Interface

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "dir": { "type": "string", "description": "Target project directory" },
    "action": {
      "type": "string",
      "enum": ["list", "discover"],
      "description": "Action to perform (default: list)",
      "default": "list"
    }
  }
}
```

### Output — `list` action

Returns registered repos with stats and any discovered-but-unregistered repos:

```json
{
  "repos": [
    {
      "name": "myapp",
      "path": ".",
      "type": "primary",
      "fileCount": 120,
      "symbolCount": 450,
      "edgeCount": 890,
      "crossRepoEdgeCount": 0,
      "lastScanned": "2026-05-23T00:00:00Z"
    }
  ],
  "discovered": [
    { "name": "shared-lib", "path": "../shared-lib", "source": "peer" }
  ]
}
```

### Output — `discover` action

Returns only unregistered repos (submodules, peers, VS Code workspace folders):

```json
{
  "discovered": [
    { "name": "shared-lib", "path": "../shared-lib", "source": "peer", "isInitialized": true },
    { "name": "frontend", "path": "packages/frontend", "source": "submodule", "isInitialized": true },
    { "name": "docs", "path": "../docs", "source": "vscode-workspace", "isInitialized": true }
  ]
}
```

## Files Changed

| File | Change |
|------|--------|
| `src/mcp.ts` | Add import for `WorkspaceManager`, tool registration, handler case |

## Acceptance Criteria

- [ ] `mapx_workspaces` appears in `ListToolsRequestSchema` response
- [ ] `{ "action": "list" }` returns repos with file/symbol/edge counts
- [ ] `{ "action": "discover" }` returns unregistered submodules/peers/VS Code workspace entries
- [ ] TypeScript compiles with 0 errors
