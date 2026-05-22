export interface ProviderTemplate {
  filename: string;
  isAppend: boolean;
  content: string;
}

export const TEMPLATES: Record<string, ProviderTemplate> = {
  generic: {
    filename: 'AGENTS.md',
    isAppend: false,
    content: `# MapxGraph - LLM Integration Guide

This project uses **MapxGraph** — a local code graph memory system that provides persistent, structured understanding of the codebase across LLM sessions.

## What MapxGraph Does

MapxGraph scans source files, extracts symbols (classes, functions, methods, interfaces) and dependencies (imports, requires, extends, implements, calls), builds a weighted graph with PageRank importance scoring, and persists everything to \`.mapx/\`.

This means you (the LLM) can quickly understand the codebase structure without reading every file.

## Commands

All commands accept a target directory. Three ways to specify:

\`\`\`bash
# 1. Positional path argument
mapx scan /path/to/project

# 2. --dir / -d flag
mapx scan --dir /path/to/project
mapx query "MyClass" -d /path/to/project

# 3. Global flag (works with any subcommand)
mapx -d /path/to/project scan
\`\`\`

### Available Commands

- \`mapx init [path]\` - First-time setup
- \`mapx scan [path]\` - Full scan
- \`mapx update [path]\` - Incremental update (fast)
- \`mapx status [path]\` - Check what changed since last scan
- \`mapx export [--dir path]\` - Export compact graph summary
- \`mapx query <symbol> [--dir path]\` - Search for symbols
- \`mapx deps <file> [--dir path]\` - Show dependencies for a file
- \`mapx summary [path]\` - Project summary
- \`mapx clusters [--dir path]\` - List detected clusters/modules
- \`mapx trace <symbol> [--dir path]\` - Trace data flow
- \`mapx serve --dir /path\` - Start stdio MCP server

## MCP Tools

When running as an MCP server, MapxGraph exposes these tools:
- \`mapx_scan\` - Scan/update the code graph
- \`mapx_query\` - Search symbols by name pattern
- \`mapx_dependencies\` - Get deps and reverse-deps for a file
- \`mapx_export\` - Export compact graph summary
- \`mapx_status\` - Check scan status and file counts
- \`mapx_clusters\` - List code clusters/modules
- \`mapx_trace\` - Trace data flow paths from a starting symbol or file
- \`mapx_sources\` - Find entry points (sources) in the codebase
- \`mapx_sinks\` - Find terminal consumers (sinks) in the codebase

## When to Use

1. **Start of session**: Run \`mapx export\` to get a compact overview.
2. **Need to find something**: Run \`mapx query <term>\` instead of grepping.
3. **Need to understand a file**: Run \`mapx deps <file>\` to see relationships.
4. **Files changed**: Run \`mapx update\` to incrementally update the graph.
5. **Major changes**: Run \`mapx scan\` for a full re-scan.
6. **Need a visual overview**: Run \`mapx export --format=svg -o graph.svg\`.
7. **Trace data flow**: Run \`mapx trace <symbol>\` to see where data comes from/goes.`
  },
  claude: {
    filename: 'CLAUDE.md',
    isAppend: false,
    content: `# MapxGraph - Claude Integration Guide

This project is configured with **MapxGraph** for codebase navigation and graph query support.

## Claude Desktop Configuration

Add the following to your Claude Desktop configuration file (\`~/.config/Claude/claude_desktop_config.json\` or \`~/Library/Application Support/Claude/claude_desktop_config.json\`):

\`\`\`json
{
  "mcpServers": {
    "mapx-{{PROJECT_NAME}}": {
      "command": "npx",
      "args": [
        "-y",
        "mapx",
        "serve",
        "--dir",
        "{{PROJECT_DIR}}"
      ]
    }
  }
}
\`\`\`

## MCP Tools Available

- \`mapx_scan\`: Refresh/update the index.
- \`mapx_query\`: Find classes, methods, or functions.
- \`mapx_dependencies\`: Get imports and references of a file.
- \`mapx_export\`: Export a compact text representation of the graph.
- \`mapx_clusters\`: Inspect logical boundaries.
- \`mapx_trace\`: Trace data-flow relationships.

## Workflows

1. Run \`mapx_export\` at the start of your session to gain context.
2. Use \`mapx_query\` to search for symbols.
3. If files are modified, call \`mapx_scan\` to update the graph.
4. Call \`mapx_trace\` to trace data flow.`
  },
  cursor: {
    filename: '.cursor/rules/mapx.mdc',
    isAppend: false,
    content: `---
description: Rules for using MapxGraph for codebase understanding and data-flow tracing
globs: ["**/*"]
alwaysApply: false
---
# Cursor Rules for MapxGraph

Use MapxGraph commands or MCP tools to understand code structure.

## Available MCP Tools

- \`mapx_scan\` - Re-scan files to update the graph
- \`mapx_query\` - Search for classes/functions
- \`mapx_dependencies\` - Map file imports/references
- \`mapx_export\` - Get a token-efficient graph summary
- \`mapx_clusters\` - Get module groupings
- \`mapx_trace\` - Trace data flow

## Workflow

1. Always use \`mapx_export\` on startup rather than reading directories.
2. Run \`mapx_scan\` after major file changes.
3. Query via \`mapx_query\` to navigate symbols.`
  },
  copilot: {
    filename: '.github/copilot-instructions.md',
    isAppend: true,
    content: `## MapxGraph Integration

This project uses MapxGraph. You can run the following CLI commands to understand the codebase:
- \`mapx export\` - Graph overview
- \`mapx query <term>\` - Search symbols
- \`mapx deps <file>\` - View file dependencies
- \`mapx clusters\` - View logical modules
- \`mapx trace <symbol>\` - Trace data-flow paths`
  },
  windsurf: {
    filename: '.windsurf/rules/mapx.md',
    isAppend: false,
    content: `---
trigger: model_decided
---
# MapxGraph Rules for Windsurf

This project utilizes MapxGraph to maintain local code indexes.

Use the MapxGraph MCP tools or CLI commands to navigate:
- \`mapx_export\` / \`mapx export\` on startup.
- \`mapx_query\` / \`mapx query\` to locate definitions.
- \`mapx_trace\` / \`mapx trace\` to analyze data flow.
- \`mapx_scan\` after edits.`
  },
  cline: {
    filename: '.clinerules',
    isAppend: true,
    content: `## MapxGraph Rules for Cline

This project is indexed by MapxGraph.
Auto-start the MCP server with the configured directory \`{{PROJECT_DIR}}\`.
Available tools:
- \`mapx_export\` - Call this first to get the summary.
- \`mapx_query\` - Find files or symbols.
- \`mapx_trace\` - Trace data-flow callers and callees.`
  },
  aider: {
    filename: 'AIDER.md',
    isAppend: false,
    content: `# MapxGraph Aider Integration

Use MapxGraph commands in this repository to analyze code.

## Key CLI Commands

- \`mapx export\`: Compact summary of the graph structure.
- \`mapx query <symbol>\`: Find locations and definitions.
- \`mapx deps <file>\`: Show dependencies.
- \`mapx trace <symbol>\`: Show data-flow traversal.
- \`mapx update\`: Run after edits.`
  },
  gemini: {
    filename: 'GEMINI.md',
    isAppend: false,
    content: `# MapxGraph Gemini Integration

Utilize MapxGraph to obtain codebase context for Gemini.

- Run \`mapx export\` to summarize the project.
- Run \`mapx query <symbol>\` to locate symbols.
- Run \`mapx trace <symbol>\` to analyze data flow.`
  },
  continue: {
    filename: '.continue/mapx.yaml',
    isAppend: false,
    content: `# Continue configuration for MapxGraph
contextProviders:
  - name: cmd
    args:
      name: mapx
      cmd: mapx export --tokens=4000
`
  },
  zed: {
    filename: '.zed/mapx-instructions.md',
    isAppend: false,
    content: `# Zed Assistant MapxGraph Instructions

This project uses MapxGraph.
Run \`mapx export\` or \`mapx query\` in the terminal to retrieve codebase context for the Zed Assistant.`
  }
};
