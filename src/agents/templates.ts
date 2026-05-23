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

MapxGraph scans source files across **22 languages**, extracts symbols (classes, functions, methods, interfaces, traits, enums, structs, modules, constants, properties, namespaces) and dependencies (imports, requires, extends, implements, calls, instantiation), builds a weighted graph with PageRank importance scoring, and persists everything to \`.mapx/\`.

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

- \`mapx init [path]\` - First-time setup (auto-adds .mapx/ to .gitignore)
- \`mapx scan [path]\` - Full scan
- \`mapx update [path]\` (alias: \`sync\`) - Incremental update (fast)
- \`mapx status [path]\` - Check what changed since last scan
- \`mapx export [--dir path]\` - Export compact graph summary
- \`mapx export --format=<fmt>\` - Export as \`llm\`, \`json\`, \`dot\`, \`svg\`, or \`toon\`
- \`mapx export --cluster <mode> --depth <n>\` - Cluster-aware DOT/SVG export
- \`mapx query <symbol> [--dir path]\` - Search for symbols
- \`mapx search <term> [--dir path] [--kind kind] [--file prefix] [--exact] [--limit limit]\` - Advanced search for symbols
- \`mapx deps <file> [--dir path]\` - Show dependencies for a file
- \`mapx summary [path]\` - Project summary
- \`mapx clusters [--dir path]\` - List detected clusters/modules
- \`mapx trace <symbol> [--dir path]\` - Trace data flow
- \`mapx callers <symbol> [--dir path] [--depth depth]\` - Trace callers of a symbol
- \`mapx callees <symbol> [--dir path] [--depth depth]\` - Trace callees of a symbol
- \`mapx impact <symbol> [--dir path] [--depth depth]\` - Perform change impact analysis
- \`mapx node <symbol> [--dir path] [--source]\` - Inspect a symbol node and optionally view its source code
- \`mapx files [--dir path] [--path prefix] [--lang language] [--sort sort] [--limit limit]\` - List and filter files
- \`mapx lang list\` - List supported languages and status
- \`mapx lang install <lang>\` - Install dynamic language support
- \`mapx lang uninstall <lang>\` - Uninstall dynamic language support
- \`mapx serve --dir /path\` - Start stdio MCP server
- \`mapx serve --sse --port <port>\` - Start SSE (HTTP) MCP server
- \`mapx ui [--port <port>]\` - Open web dashboard for interactive visualization
- \`mapx workspaces list\` - List registered repositories
- \`mapx workspaces add <path>\` - Register a new repository
- \`mapx workspaces discover\` - Discover unregistered submodules, peers, VS Code folders
- \`mapx workspaces sync\` - Auto-register discovered repositories

## MCP Tools

When running as an MCP server, MapxGraph exposes these tools:
- \`mapx_scan\` - Scan the code graph (full scan)
- \`mapx_sync\` - Sync changed files to update the graph (incremental scan)
- \`mapx_query\` - Search symbols by name pattern
- \`mapx_search\` - Filtered semantic and regex-like symbol search
- \`mapx_node\` - Deep inspection of a specific symbol and its source code
- \`mapx_files\` - List and filter files by path, language, and size or line counts
- \`mapx_dependencies\` - Get deps and reverse-deps for a file
- \`mapx_callers\` - Direct and nested callers of a symbol
- \`mapx_callees\` - Direct and nested callees of a symbol
- \`mapx_trace\` - Trace data flow paths from a starting symbol or file
- \`mapx_sources\` - Find entry points (sources) in the codebase
- \`mapx_sinks\` - Find terminal consumers (sinks) in the codebase
- \`mapx_impact\` - Multi-depth blast radius and change risk analysis for a symbol
- \`mapx_clusters\` - List code clusters/modules
- \`mapx_status\` - Check scan status, languages breakdown, top PageRank files/symbols, and index recommendations
- \`mapx_export\` - Export compact graph summary (formats: llm, json, dot, svg, toon)
- \`mapx_context\` - Intelligent, token-budgeted workspace context builder
- \`mapx_workspaces\` - Retrieve workspace configuration and repositories (list/discover)
- \`mapx_lang_list\` - List supported languages and status
- \`mapx_lang_install\` - Install dynamic language support
- \`mapx_lang_uninstall\` - Uninstall dynamic language support

## When to Use

1. **Start of session**: Run \`mapx export\` to get a compact overview.
2. **Need to find something**: Run \`mapx query <term>\` or \`mapx search\` instead of grepping.
3. **Need to understand a file**: Run \`mapx deps <file>\` to see relationships.
4. **Files changed**: Run \`mapx sync\` (or \`mapx update\`) to incrementally update the graph.
5. **Major changes**: Run \`mapx scan\` for a full re-scan.
6. **Need a visual overview**: Run \`mapx export --format=svg -o graph.svg\`.
7. **Trace data flow / call chains**: Run \`mapx trace <symbol>\`, \`mapx callers\`, or \`mapx callees\`.
8. **Planning a modification**: Run \`mapx impact\` to determine the blast radius.
9. **Building custom prompts / context**: Run \`mapx context\` to generate optimal context within a token budget.`
  },
  claude: {
    filename: 'CLAUDE.md',
    isAppend: false,
    content: `# MapxGraph - Claude Integration Guide

This project is configured with **MapxGraph** for codebase navigation and graph query support across **22 languages**.

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

## MCP Tools Available (25 total)

**Graph Building:** \`mapx_scan\`, \`mapx_sync\`
**Symbol Discovery:** \`mapx_query\`, \`mapx_search\`, \`mapx_node\`, \`mapx_files\`
**Dependencies & Flow:** \`mapx_dependencies\`, \`mapx_callers\`, \`mapx_callees\`, \`mapx_trace\`, \`mapx_sources\`, \`mapx_sinks\`
**Analysis:** \`mapx_impact\`, \`mapx_clusters\`, \`mapx_status\`
**Export:** \`mapx_export\` (llm/json/dot/svg/toon), \`mapx_context\`
**Workspaces:** \`mapx_workspaces\` (list/discover)
**Languages:** \`mapx_lang_list\`, \`mapx_lang_install\`, \`mapx_lang_uninstall\`

## Workflows

1. Run \`mapx_export\` at the start of your session to gain context.
2. Use \`mapx_query\` or \`mapx_search\` to find symbols.
3. Use \`mapx_callers\` / \`mapx_callees\` to trace call chains.
4. Run \`mapx_impact\` before making changes to understand blast radius.
5. If files are modified, call \`mapx_sync\` to update the graph.
6. Call \`mapx_trace\` to trace data flow paths.`
  },
  cursor: {
    filename: '.cursor/rules/mapx.mdc',
    isAppend: false,
    content: `---
description: Rules for using MapxGraph for codebase understanding, symbol search, and data-flow tracing across 22 languages
globs: ["**/*"]
alwaysApply: false
---
# Cursor Rules for MapxGraph

Use MapxGraph commands or MCP tools to understand code structure.

## Available MCP Tools (25 total)

**Graph:** \`mapx_scan\`, \`mapx_sync\`
**Search:** \`mapx_query\`, \`mapx_search\`, \`mapx_node\`, \`mapx_files\`
**Deps:** \`mapx_dependencies\`, \`mapx_callers\`, \`mapx_callees\`, \`mapx_trace\`, \`mapx_sources\`, \`mapx_sinks\`
**Analysis:** \`mapx_impact\`, \`mapx_clusters\`, \`mapx_status\`
**Export:** \`mapx_export\` (llm/json/dot/svg/toon), \`mapx_context\`
**Workspaces:** \`mapx_workspaces\`
**Languages:** \`mapx_lang_list\`, \`mapx_lang_install\`, \`mapx_lang_uninstall\`

## Workflow

1. Always use \`mapx_export\` on startup rather than reading directories.
2. Use \`mapx_search --kind class\` to find specific symbol types.
3. Run \`mapx_impact\` before refactoring to assess blast radius.
4. Run \`mapx_sync\` (or \`mapx_scan\`) after file changes.
5. Query via \`mapx_query\` to navigate symbols.`
  },
  copilot: {
    filename: '.github/copilot-instructions.md',
    isAppend: true,
    content: `## MapxGraph Integration

This project uses MapxGraph (22 languages, 25 MCP tools). You can run the following CLI commands to understand the codebase:
- \`mapx export\` - Graph overview (LLM summary, or --format=json/dot/svg/toon)
- \`mapx query <term>\` - Search symbols
- \`mapx search <term> --kind class\` - Advanced filtered search
- \`mapx deps <file>\` - View file dependencies
- \`mapx callers <symbol>\` - Trace callers
- \`mapx callees <symbol>\` - Trace callees
- \`mapx impact <symbol>\` - Change impact analysis
- \`mapx clusters\` - View logical modules
- \`mapx trace <symbol>\` - Trace data-flow paths
- \`mapx node <symbol> --source\` - Inspect symbol source code`
  },
  windsurf: {
    filename: '.windsurf/rules/mapx.md',
    isAppend: false,
    content: `---
trigger: model_decided
---
# MapxGraph Rules for Windsurf

This project utilizes MapxGraph to maintain local code indexes across **22 languages** with **25 MCP tools**.

Use the MapxGraph MCP tools or CLI commands to navigate:
- \`mapx_export\` / \`mapx export\` on startup.
- \`mapx_query\` / \`mapx query\` to locate definitions.
- \`mapx_search\` / \`mapx search\` for advanced filtered search.
- \`mapx_callers\` / \`mapx callers\` to trace call chains.
- \`mapx_impact\` / \`mapx impact\` before refactoring.
- \`mapx_trace\` / \`mapx trace\` to analyze data flow.
- \`mapx_sync\` / \`mapx sync\` after edits.`
  },
  cline: {
    filename: '.clinerules',
    isAppend: true,
    content: `## MapxGraph Rules for Cline

This project is indexed by MapxGraph (22 languages, 25 MCP tools).
Auto-start the MCP server with the configured directory \`{{PROJECT_DIR}}\`.
Available tools:
- \`mapx_export\` - Call this first to get the summary.
- \`mapx_query\` / \`mapx_search\` - Find files or symbols.
- \`mapx_callers\` / \`mapx_callees\` - Trace call chains.
- \`mapx_impact\` - Assess blast radius before changes.
- \`mapx_trace\` - Trace data-flow callers and callees.
- \`mapx_context\` - Generate token-budgeted context.`
  },
  aider: {
    filename: 'AIDER.md',
    isAppend: false,
    content: `# MapxGraph Aider Integration

Use MapxGraph commands in this repository to analyze code across **22 languages**.

## Key CLI Commands

- \`mapx export\`: Compact summary of the graph structure.
- \`mapx export --format=svg -o graph.svg\`: Visual graph export.
- \`mapx query <symbol>\`: Find locations and definitions.
- \`mapx search <term> --kind class\`: Advanced filtered search.
- \`mapx deps <file>\`: Show dependencies.
- \`mapx callers <symbol>\`: Show who calls a symbol.
- \`mapx callees <symbol>\`: Show what a symbol calls.
- \`mapx impact <symbol>\`: Change impact analysis.
- \`mapx trace <symbol>\`: Show data-flow traversal.
- \`mapx node <symbol> --source\`: View symbol source code.
- \`mapx sync\` (or \`mapx update\`): Run after edits.`
  },
  gemini: {
    filename: 'GEMINI.md',
    isAppend: false,
    content: `# MapxGraph Gemini Integration

Utilize MapxGraph to obtain codebase context for Gemini across **22 languages**.

## CLI Commands

- Run \`mapx export\` to summarize the project (supports --format=llm/json/dot/svg/toon).
- Run \`mapx query <symbol>\` to locate symbols.
- Run \`mapx search <term>\` for advanced filtered search.
- Run \`mapx callers <symbol>\` / \`mapx callees <symbol>\` to trace call chains.
- Run \`mapx impact <symbol>\` to assess change blast radius.
- Run \`mapx trace <symbol>\` to analyze data flow.
- Run \`mapx node <symbol> --source\` to inspect a symbol's source code.
- Run \`mapx sync\` after file edits to update the graph.`
  },
  continue: {
    filename: '.continue/mapx.yaml',
    isAppend: false,
    content: `# Continue configuration for MapxGraph (22 languages, 25 MCP tools)
contextProviders:
  - name: cmd
    args:
      name: mapx-export
      cmd: mapx export --tokens=4000
  - name: cmd
    args:
      name: mapx-status
      cmd: mapx status
`
  },
  zed: {
    filename: '.zed/mapx-instructions.md',
    isAppend: false,
    content: `# Zed Assistant MapxGraph Instructions

This project uses MapxGraph (22 languages, 25 MCP tools).

## Key Commands
- Run \`mapx export\` to retrieve a token-budgeted codebase summary.
- Run \`mapx query <symbol>\` to find definitions.
- Run \`mapx search <term>\` for advanced filtered search.
- Run \`mapx callers <symbol>\` / \`mapx callees <symbol>\` to trace call chains.
- Run \`mapx impact <symbol>\` to assess change risk before refactoring.
- Run \`mapx trace <symbol>\` to trace data flow.
- Run \`mapx sync\` after file edits to update the graph.`
  }
};
