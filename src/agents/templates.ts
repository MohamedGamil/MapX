export interface ProviderTemplate {
  filename: string;
  isAppend: boolean;
  content: string;
  /** True if this template is an MCP server config (JSON) rather than an instruction doc */
  isMcpConfig?: boolean;
}

/**
 * MCP config definitions for agent tools.
 * Each entry generates a project-local JSON config file that auto-registers
 * mapx as an MCP server so the agent can discover all 32 tools on startup.
 *
 * Config files use the sentinel-block pattern (<!-- mapx --> markers are not
 * used — the entire file is owned by mapx and can safely be overwritten).
 */
export interface McpConfigEntry {
  /** Agent tool name (e.g. 'opencode', 'gemini-cli') */
  name: string;
  /** Relative path from project root to the config file */
  filename: string;
  /** Function to generate the JSON config content */
  generate: (projectDir: string) => string;
  /** How to detect if this agent tool is active / desired */
  detect: (projectDir: string) => boolean;
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Build the mapx MCP server command. Prefers global `mapx` binary; falls back
 * to `npx -y mapx` for npm-installed projects.
 */
function mcpCommand(): { command: string; args: string[] } {
  return { command: 'mapx', args: [] };
}

function mcpArgs(projectDir: string): string[] {
  return ['serve', '--dir', projectDir];
}

export const MCP_CONFIGS: McpConfigEntry[] = [
  {
    name: 'opencode',
    filename: 'opencode.json',
    detect: (dir: string) => {
      return existsSync(join(dir, 'opencode.json')) ||
             existsSync(join(dir, 'opencode.jsonc'));
    },
    generate: (projectDir: string) => {
      const cmd = mcpCommand();
      return JSON.stringify({
        "$schema": "https://opencode.ai/config.json",
        mcp: {
          mapx: {
            type: 'local',
            command: [cmd.command, ...mcpArgs(projectDir)],
            enabled: true,
          }
        }
      }, null, 2);
    },
  },
  {
    name: 'gemini-cli',
    filename: '.gemini/settings.json',
    detect: (dir: string) => {
      return existsSync(join(dir, '.gemini'));
    },
    generate: (projectDir: string) => {
      const cmd = mcpCommand();
      return JSON.stringify({
        mcpServers: {
          mapx: {
            command: cmd.command,
            args: mcpArgs(projectDir),
          }
        }
      }, null, 2);
    },
  },
  {
    name: 'cursor-mcp',
    filename: '.cursor/mcp.json',
    detect: (dir: string) => {
      return existsSync(join(dir, '.cursor'));
    },
    generate: (projectDir: string) => {
      const cmd = mcpCommand();
      return JSON.stringify({
        mcpServers: {
          mapx: {
            command: cmd.command,
            args: mcpArgs(projectDir),
          }
        }
      }, null, 2);
    },
  },
  {
    name: 'vscode-mcp',
    filename: '.vscode/mcp.json',
    detect: (dir: string) => {
      return existsSync(join(dir, '.vscode'));
    },
    generate: (projectDir: string) => {
      const cmd = mcpCommand();
      return JSON.stringify({
        servers: {
          mapx: {
            command: cmd.command,
            args: mcpArgs(projectDir),
          }
        }
      }, null, 2);
    },
  },
  {
    name: 'antigravity',
    filename: '.agents/mcp.json',
    detect: (dir: string) => {
      return existsSync(join(dir, '.agents'));
    },
    generate: (projectDir: string) => {
      const cmd = mcpCommand();
      return JSON.stringify({
        servers: {
          mapx: {
            command: cmd.command,
            args: mcpArgs(projectDir),
          }
        }
      }, null, 2);
    },
  },
];

export const TEMPLATES: Record<string, ProviderTemplate> = {
  generic: {
    filename: 'AGENTS.md',
    isAppend: false,
    content: `# MapxGraph - LLM Integration Guide

This project uses **MapxGraph** — a local code graph memory system that provides persistent, structured understanding of the codebase across LLM sessions.

## What MapxGraph Does

MapxGraph scans source files across **22 languages**, extracts symbols (classes, functions, methods, interfaces, traits, enums, structs, modules, constants, properties, namespaces) and dependencies (imports, requires, extends, implements, calls, instantiation), builds a weighted graph with PageRank importance scoring, and persists everything to \`.mapx/\`. It also indexes static files (Markdown, HTML, CSS/SCSS, JSON/JSONC/JSON5) for dependency tracking without symbol extraction.

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

- \`mapx init [path]\` - First-time setup (auto-adds .mapx/ to .gitignore, discovers monorepo packages & nested repos)
- \`mapx uninit [path]\` - Remove .mapx/ and reverse integration changes
- \`mapx scan [path]\` - Full scan (use \`--force\` to bypass cache)
- \`mapx update [path]\` (alias: \`sync\`) - Incremental update (fast)
- \`mapx status [path]\` - Check what changed since last scan
- \`mapx export [--dir path]\` - Export compact graph summary
- \`mapx export --format=<fmt>\` - Export as \`llm\`, \`json\`, \`dot\`, \`svg\`, or \`toon\`
- \`mapx export --cluster <mode> --depth <n>\` - Cluster-aware DOT/SVG export
- \`mapx query <symbol> [--dir path]\` - Search for symbols (supports glob patterns: \`*Service\`, \`get*\`)
- \`mapx search <term> [--dir path] [--kind kind] [--file prefix] [--exact] [--limit limit] [--format text|json]\` - Advanced filtered search with auto-expand and fuzzy fallback
- \`mapx deps <file> [--dir path]\` - Show dependencies for a file (supports glob/wildcard/substring matching)
- \`mapx summary [path]\` - Project summary
- \`mapx clusters [--dir path] [--source source] [--json]\` - List detected clusters/modules (filter by source: namespace, directory, community, layer)
- \`mapx trace <symbol> [--dir path]\` - Trace data flow
- \`mapx sources [--dir path]\` - Find entry points (data sources) in the codebase
- \`mapx sinks [--dir path]\` - Find terminal consumers (data sinks) in the codebase
- \`mapx context <task> [--dir path] [--seeds seeds] [--tokens budget] [--depth n] [--format fmt]\` - Generate task-specific workspace context
- \`mapx callers <symbol> [--dir path] [--depth depth]\` - Trace callers of a symbol (fuzzy fallback on typos)
- \`mapx callees <symbol> [--dir path] [--depth depth]\` - Trace callees of a symbol (fuzzy fallback on typos)
- \`mapx metrics [path]\` - Show coupling and instability metrics for files
- \`mapx edges [path] [--type type] [--from file] [--to file]\` - Query dependency edges
- \`mapx routes [path] [--framework name] [--method verb] [--json]\` - Show framework routes
- \`mapx hooks [path] [--framework name] [--type type] [--json]\` - Show framework hooks
- \`mapx profile [path]\` - Show codebase profile (archetype, frameworks, active taxonomy)
- \`mapx arch [path] [--smells] [--dsm] [--violations] [--json]\` - Full architecture and health report
- \`mapx explain <file> [--reclassify]\` - Explain file role classification signals and weights
- \`mapx layers [path] [--json]\` - List files grouped by architectural roles/layers
- \`mapx impact <symbol> [--dir path] [--depth depth]\` - Change impact analysis with fuzzy pre-check
- \`mapx node <symbol> [--dir path] [--source] [--format text|json]\` - Inspect a symbol node with optional source code
- \`mapx files [--dir path] [--path prefix_or_glob] [--lang language] [--sort sort] [--limit limit]\` - List and filter files (--path accepts globs: src/core/*.ts, **/*.json)
- \`mapx lang list\` - List supported languages and status
- \`mapx lang install <lang>\` - Install dynamic language support
- \`mapx lang uninstall <lang>\` - Uninstall dynamic language support
- \`mapx serve --dir /path\` - Start stdio MCP server
- \`mapx serve --sse --port <port>\` - Start SSE (HTTP) MCP server
- \`mapx ui [--port <port>]\` - Open web dashboard for interactive visualization
- \`mapx workspaces list\` - List registered repositories
- \`mapx workspaces add <path>\` - Register a new repository
- \`mapx workspaces discover\` - Discover unregistered submodules, peers, VS Code folders, nested git repos (up to 3 levels deep), and monorepo packages
- \`mapx workspaces sync\` - Auto-register discovered repositories (prompts for nested git repos and monorepo packages)

## MCP Tools

When running as an MCP server, MapxGraph exposes these tools:
- \`mapx_scan\` - Scan the code graph (full scan)
- \`mapx_sync\` - Sync changed files to update the graph (incremental scan)
- \`mapx_query\` - Search symbols by name pattern
- \`mapx_search\` - Filtered semantic and regex-like symbol search
- \`mapx_node\` - Deep inspection of a specific symbol and its source code
- \`mapx_files\` - List and filter files by path prefix or glob pattern, language, and size or line counts
- \`mapx_dependencies\` - Get deps and reverse-deps for a file
- \`mapx_callers\` - Direct and nested callers of a symbol
- \`mapx_callees\` - Direct and nested callees of a symbol
- \`mapx_trace\` - Trace data flow paths from a starting symbol or file
- \`mapx_sources\` - Find entry points (sources) in the codebase
- \`mapx_sinks\` - Find terminal consumers (sinks) in the codebase
- \`mapx_routes\` - Show framework routes
- \`mapx_hooks\` - Show framework hooks
- \`mapx_edges\` - Granular query of graph dependency edges
- \`mapx_impact\` - Multi-depth blast radius and change risk analysis for a symbol
- \`mapx_clusters\` - List code clusters/modules
- \`mapx_status\` - Check scan status, languages breakdown, top PageRank files/symbols, and index recommendations
- \`mapx_metrics\` - Compute file coupling and instability metrics
- \`mapx_profile\` - Retrieve codebase profile (archetype, frameworks, active taxonomy)
- \`mapx_explain\` - Explain file dynamic role classification and weights
- \`mapx_smells\` - Detect design smells and architectural violations
- \`mapx_dsm\` - Generate cluster Dependency Structure Matrix (DSM)
- \`mapx_layers\` - List files grouped by architectural roles/layers
- \`mapx_export\` - Export compact graph summary (formats: llm, json, dot, svg, toon)
- \`mapx_context\` - Intelligent, token-budgeted workspace context builder
- \`mapx_workspaces\` - Retrieve workspace configuration and repositories (list/discover)
- \`mapx_lang_list\` - List supported languages and status
- \`mapx_lang_install\` - Install dynamic language support
- \`mapx_lang_uninstall\` - Uninstall dynamic language support
- \`mapx_batch\` - Execute multiple operations in a single call (search, node, callers, callees, deps)
- \`mapx_agents_generate\` - Generate/update agent integration instructions and rules

## When to Use

1. **Start of session**: Run \`mapx export\` to get a compact overview.
2. **Need to find something**: Run \`mapx query <term>\` or \`mapx search\` instead of grepping. Supports glob patterns like \`*Service\`, \`get*\`.
3. **Need to understand a file**: Run \`mapx deps <file>\` to see relationships.
4. **Files changed**: Run \`mapx sync\` (or \`mapx update\`) to incrementally update the graph.
5. **Major changes**: Run \`mapx scan\` for a full re-scan.
6. **Need a visual overview**: Run \`mapx export --format=svg -o graph.svg\`.
7. **Trace data flow / call chains**: Run \`mapx trace <symbol>\`, \`mapx callers\`, or \`mapx callees\`.
8. **Planning a modification**: Run \`mapx impact\` to determine the blast radius.
9. **Building custom prompts / context**: Run \`mapx context\` to generate optimal context within a token budget.
10. **Batch operations**: Use \`mapx_batch\` (MCP) to execute multiple operations in a single round-trip.`
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

## MCP Tools Available (32 total)

**Graph Building:** \`mapx_scan\`, \`mapx_sync\`
**Symbol Discovery:** \`mapx_query\`, \`mapx_search\`, \`mapx_node\`, \`mapx_files\`
**Dependencies & Flow:** \`mapx_dependencies\`, \`mapx_callers\`, \`mapx_callees\`, \`mapx_trace\`, \`mapx_sources\`, \`mapx_sinks\`, \`mapx_routes\`, \`mapx_hooks\`, \`mapx_edges\`
**Analysis:** \`mapx_impact\`, \`mapx_clusters\`, \`mapx_status\`, \`mapx_metrics\`, \`mapx_profile\`, \`mapx_explain\`, \`mapx_smells\`, \`mapx_dsm\`, \`mapx_layers\`
**Export:** \`mapx_export\` (llm/json/dot/svg/toon), \`mapx_context\`
**Workspaces:** \`mapx_workspaces\` (list/discover)
**Languages:** \`mapx_lang_list\`, \`mapx_lang_install\`, \`mapx_lang_uninstall\`
**Orchestration:** \`mapx_batch\`, \`mapx_agents_generate\`

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

## Available MCP Tools (32 total)

**Graph:** \`mapx_scan\`, \`mapx_sync\`
**Search:** \`mapx_query\`, \`mapx_search\`, \`mapx_node\`, \`mapx_files\`
**Deps:** \`mapx_dependencies\`, \`mapx_callers\`, \`mapx_callees\`, \`mapx_trace\`, \`mapx_sources\`, \`mapx_sinks\`, \`mapx_routes\`, \`mapx_hooks\`, \`mapx_edges\`
**Analysis:** \`mapx_impact\`, \`mapx_clusters\`, \`mapx_status\`, \`mapx_metrics\`, \`mapx_profile\`, \`mapx_explain\`, \`mapx_smells\`, \`mapx_dsm\`, \`mapx_layers\`
**Export:** \`mapx_export\` (llm/json/dot/svg/toon), \`mapx_context\`
**Workspaces:** \`mapx_workspaces\`
**Languages:** \`mapx_lang_list\`, \`mapx_lang_install\`, \`mapx_lang_uninstall\`
**Orchestration:** \`mapx_batch\`, \`mapx_agents_generate\`

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

This project uses MapxGraph (22 languages, 32 MCP tools). You can run the following CLI commands to understand the codebase:
- \`mapx export\` - Graph overview (LLM summary, or --format=json/dot/svg/toon)
- \`mapx query <term>\` - Search symbols (supports glob patterns: \`*Service\`, \`get*\`)
- \`mapx search <term> --kind class\` - Advanced filtered search (auto-expands if kind has 0 results)
- \`mapx search <term> --format json\` - Structured JSON output with PageRank scores
- \`mapx deps <file>\` - View file dependencies
- \`mapx callers <symbol>\` - Trace callers (with fuzzy "Did you mean?" on typos)
- \`mapx callees <symbol>\` - Trace callees (with fuzzy "Did you mean?" on typos)
- \`mapx impact <symbol>\` - Change impact analysis
- \`mapx clusters\` - View logical modules
- \`mapx trace <symbol>\` - Trace data-flow paths
- \`mapx sources\` - Find entry points
- \`mapx sinks\` - Find terminal consumers
- \`mapx context <task>\` - Generate task-specific context
- \`mapx node <symbol> --source\` - Inspect symbol source code
- \`mapx node <symbol> --format json\` - Symbol details as JSON
- \`mapx profile\` - Show codebase profile
- \`mapx arch\` - Show comprehensive architecture and design smells report
- \`mapx explain <file>\` - Explain file role classification signals
- \`mapx layers\` - List files grouped by architectural roles`
  },
  windsurf: {
    filename: '.windsurf/rules/mapx.md',
    isAppend: false,
    content: `---
trigger: model_decided
---
# MapxGraph Rules for Windsurf

This project utilizes MapxGraph to maintain local code indexes across **22 languages** with **32 MCP tools**.

Use the MapxGraph MCP tools or CLI commands to navigate:
- \`mapx_export\` / \`mapx export\` on startup.
- \`mapx_query\` / \`mapx query\` to locate definitions (supports glob: \`*Service\`, \`get*\`).
- \`mapx_search\` / \`mapx search\` for advanced filtered search (auto-expand, fuzzy fallback, \`--format json\`).
- \`mapx_callers\` / \`mapx callers\` to trace call chains (fuzzy "Did you mean?" on typos).
- \`mapx_impact\` / \`mapx impact\` before refactoring.
- \`mapx_trace\` / \`mapx trace\` to analyze data flow.
- \`mapx_sources\` / \`mapx sources\` to find entry points.
- \`mapx_sinks\` / \`mapx sinks\` to find terminal consumers.
- \`mapx_context\` / \`mapx context\` to generate task-specific context.
- \`mapx_batch\` to execute multiple operations in one call.
- \`mapx_profile\` / \`mapx profile\` to inspect codebase profile.
- \`mapx_smells\` / \`mapx arch\` to analyze smells and design health.
- \`mapx_sync\` / \`mapx sync\` after edits.`
  },
  cline: {
    filename: '.clinerules',
    isAppend: true,
    content: `## MapxGraph Rules for Cline

This project is indexed by MapxGraph (22 languages, 32 MCP tools).
Auto-start the MCP server with the configured directory \`{{PROJECT_DIR}}\`.
Available tools:
- \`mapx_export\` - Call this first to get the summary.
- \`mapx_query\` / \`mapx_search\` - Find files or symbols (supports glob: \`*Service\`, \`get*\`, fuzzy fallback).
- \`mapx_callers\` / \`mapx_callees\` - Trace call chains.
- \`mapx_impact\` - Assess blast radius before changes.
- \`mapx_trace\` - Trace data-flow paths.
- \`mapx_sources\` / \`mapx_sinks\` - Find entry points / terminal consumers.
- \`mapx_context\` - Generate token-budgeted context.
- \`mapx_profile\` / \`mapx_smells\` - Profile codebase and audit design quality / code smells.
- \`mapx_batch\` - Batch multiple operations in a single call.`
  },
  aider: {
    filename: 'AIDER.md',
    isAppend: false,
    content: `# MapxGraph Aider Integration

Use MapxGraph commands in this repository to analyze code across **22 languages**.

## Key CLI Commands

- \`mapx export\`: Compact summary of the graph structure.
- \`mapx export --format=svg -o graph.svg\`: Visual graph export.
- \`mapx query <symbol>\`: Find locations and definitions (supports glob: \`*Service\`, \`get*\`).
- \`mapx search <term> --kind class\`: Advanced filtered search (auto-expand, fuzzy fallback).
- \`mapx search <term> --format json\`: Structured JSON output.
- \`mapx deps <file>\`: Show dependencies.
- \`mapx callers <symbol>\`: Show who calls a symbol (fuzzy fallback on typos).
- \`mapx callees <symbol>\`: Show what a symbol calls (fuzzy fallback on typos).
- \`mapx impact <symbol>\`: Change impact analysis.
- \`mapx trace <symbol>\`: Show data-flow traversal.
- \`mapx sources\`: Find entry points.
- \`mapx sinks\`: Find terminal consumers.
- \`mapx context <task>\`: Generate task-specific context.
- \`mapx node <symbol> --source\`: View symbol source code.
- \`mapx node <symbol> --format json\`: Symbol details as JSON.
- \`mapx sync\` (or \`mapx update\`): Run after edits.`
  },
  gemini: {
    filename: 'GEMINI.md',
    isAppend: false,
    content: `# MapxGraph Gemini Integration

Utilize MapxGraph to obtain codebase context for Gemini across **22 languages** with **32 MCP tools**.

## CLI Commands

- Run \`mapx export\` to summarize the project (supports --format=llm/json/dot/svg/toon).
- Run \`mapx query <symbol>\` to locate symbols (supports glob patterns: \`*Service\`, \`get*\`).
- Run \`mapx search <term>\` for advanced filtered search (auto-expand, fuzzy fallback, \`--format json\`).
- Run \`mapx callers <symbol>\` / \`mapx callees <symbol>\` to trace call chains (fuzzy fallback on typos).
- Run \`mapx impact <symbol>\` to assess change blast radius.
- Run \`mapx trace <symbol>\` to analyze data flow.
- Run \`mapx sources\` to find entry points.
- Run \`mapx sinks\` to find terminal consumers.
- Run \`mapx context <task>\` to generate task-specific context.
- Run \`mapx node <symbol> --source\` to inspect a symbol's source code.
- Run \`mapx node <symbol> --format json\` for structured JSON output.
- Run \`mapx profile\` to show codebase profile details.
- Run \`mapx arch\` to audit architecture design smells and structural quality.
- Run \`mapx explain <file>\` to explain file layer/role classification signals.
- Run \`mapx layers\` to view files grouped by architectural roles.
- Run \`mapx sync\` after file edits to update the graph.`
  },
  continue: {
    filename: '.continue/mapx.yaml',
    isAppend: false,
    content: `# Continue configuration for MapxGraph (22 languages, 32 MCP tools)
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

This project uses MapxGraph (22 languages, 32 MCP tools).

## Key Commands
- Run \`mapx export\` to retrieve a token-budgeted codebase summary.
- Run \`mapx query <symbol>\` to find definitions (supports glob: \`*Service\`, \`get*\`).
- Run \`mapx search <term>\` for advanced filtered search (auto-expand, fuzzy fallback, \`--format json\`).
- Run \`mapx callers <symbol>\` / \`mapx callees <symbol>\` to trace call chains.
- Run \`mapx impact <symbol>\` to assess change risk before refactoring.
- Run \`mapx trace <symbol>\` to trace data flow.
- Run \`mapx sources\` to find entry points.
- Run \`mapx sinks\` to find terminal consumers.
- Run \`mapx context <task>\` to generate task-specific context.
- Run \`mapx sync\` after file edits to update the graph.`
  },
  antigravity: {
    filename: '.agents/rules/mapx.md',
    isAppend: false,
    content: `# MapxGraph Initialization Rule

## Context

Triggered when a new task is received, before any planning, reasoning, or execution steps begin.
This project is indexed by **MapxGraph** — a local code graph memory system (22 languages, 32 MCP tools) that provides persistent, structured understanding of the codebase.

## Requirements

You must execute the following MCP tools immediately upon receiving a user prompt:

1. Call \`mapx_sync\` to incrementally re-index any files changed since the last scan.
2. Call \`mapx_export\` (with \`tokens: 8192\`) to retrieve a compact, PageRank-ranked codebase skeleton.

## Constraints

* **Do not** generate a task plan or response text until both MCP tool responses are received.
* If either MCP call fails, report the initialization error to the user before proceeding.
* After receiving the export, use it as your primary codebase context — avoid reading entire files unless specifically needed.

## Pre-Modification Workflow

Before editing any symbol (class, function, method, interface):

1. Call \`mapx_impact\` on the target symbol to assess blast radius and risk score.
2. Call \`mapx_callers\` to identify all upstream dependents.
3. If impacted files > 3, call \`mapx_context\` with the affected symbols as seeds to build a token-budgeted context window.

## Post-Modification Workflow

After completing file writes:

1. Call \`mapx_sync\` to re-index modified files.
2. Verify the updated graph reflects your changes before reporting completion.

## Available MCP Tools

**Graph Building:** \`mapx_scan\`, \`mapx_sync\`
**Symbol Discovery:** \`mapx_query\`, \`mapx_search\`, \`mapx_node\`, \`mapx_files\`
**Dependencies & Flow:** \`mapx_dependencies\`, \`mapx_callers\`, \`mapx_callees\`, \`mapx_trace\`, \`mapx_sources\`, \`mapx_sinks\`, \`mapx_routes\`, \`mapx_hooks\`, \`mapx_edges\`
**Analysis:** \`mapx_impact\`, \`mapx_clusters\`, \`mapx_status\`, \`mapx_metrics\`, \`mapx_profile\`, \`mapx_explain\`, \`mapx_smells\`, \`mapx_dsm\`, \`mapx_layers\`
**Export:** \`mapx_export\` (llm/json/dot/svg/toon), \`mapx_context\`
**Workspaces:** \`mapx_workspaces\` (list/discover)
**Languages:** \`mapx_lang_list\`, \`mapx_lang_install\`, \`mapx_lang_uninstall\`
**Orchestration:** \`mapx_batch\`, \`mapx_agents_generate\`

## Key Principles

* **Pre-Planning Trigger**: Always sync and export before planning. Never act on stale graph data.
* **Strict Ordering**: Initialization → Impact Analysis → Planning → Execution → Re-sync.
* **Fail-Safe**: Prevent the agent from acting on unverified workspace data.
* **Token Efficiency**: Use \`mapx_export\` and \`mapx_context\` instead of reading raw source files — reduces token usage by up to 87%.`
  },
  instructions: {
    filename: '.agents/rules/instructions.md',
    isAppend: false,
    content: `# MapX MCP Server - Agent Instructions Guide

MapX exposes **32** Model Context Protocol (MCP) tools that allow AI agents to navigate, analyze, and build context from a multi-language codebase.

---

## 💡 Quick Rules of Thumb

1. **Start of Session**: Call \`mapx_status\` to see if the index is up to date, followed by \`mapx_export\` (format: \`llm\` or \`toon\`) to quickly understand the overall workspace layout.
2. **Before Searching or Querying**: If you or the user made any code changes, run \`mapx_sync\` first to incrementally update the graph index.
3. **Smart Context Building**: Call \`mapx_context\` to automatically build a token-efficient context of relevant files and dependencies for a specific task.
4. **Batch Operations**: Use \`mapx_batch\` to execute multiple operations (search, node, callers, callees, deps) in a single round-trip call.

---

## 🛠️ MCP Tool Reference

### 1. \`mapx_context\` (Smart Context Builder)
Generates task-specific workspace context by running graph-expansion and keyword matching weighted by PageRank.
- **Required parameters**:
  - \`task\` (string): Natural language description of what you are trying to implement or fix. Be descriptive (e.g. "Add validation to the user sign-up controller").
- **Optional parameters**:
  - \`seeds\` (array of strings): Specific symbols or file paths to anchor the expansion around (e.g., \`["UserController", "src/auth/validator.ts"]\`).
  - \`tokens\` (number): The maximum estimated token budget (default: \`8192\`).
  - \`depth\` (number): Graph traversal depth (default: \`2\`).

### 2. \`mapx_search\` (Advanced Symbol Search)
Searches for code symbols with glob pattern support and fuzzy error recovery.
- **Parameters**:
  - \`term\` (string): The query string. Supports wildcards (\`*\`), glob patterns (\`*Service\`, \`get?\`), and empty string to list all.
  - \`kind\` (string): Filter by symbol kind (case-insensitive). Valid kinds: \`class\`, \`method\`, \`function\`, \`interface\`, \`trait\`, \`constant\`, \`enum\`, \`property\`, \`namespace\`, \`struct\`, \`module\`.
  - \`file\` (string): Path prefix to restrict the search to a directory or specific file.
  - \`exact\` (boolean): Whether to match the name exactly (default: \`false\`).
  - \`limit\` (number): Maximum number of results to return (default: \`20\`).
  - \`format\` (string): Output format: \`text\` (default) or \`json\`.
- **Auto-expand**: When a \`kind\` filter yields 0 results, search automatically retries without the filter and notifies you.
- **Fuzzy fallback**: When no results are found, suggests similar symbol names using Fuse.js.
- **Examples**:
  - \`{ "term": "*", "kind": "class" }\` → all classes
  - \`{ "term": "*Service", "kind": "class" }\` → classes ending with "Service"
  - \`{ "term": "get*", "file": "src/core/" }\` → symbols starting with "get" in src/core/

### 3. \`mapx_query\` (Quick Symbol Search)
Simpler search by name pattern. Supports the same glob patterns as \`mapx_search\` but without filters.
- **Parameters**:
  - \`term\` (string): Search query with optional glob patterns.

### 4. \`mapx_node\` (Symbol Details & Source Extraction)
Fetches metadata for a single symbol (file path, line range, signature) and can optionally extract the exact source code.
- Set \`source: true\` to view the symbol's implementation.
- Set \`format: "json"\` for structured JSON output.
- Shows related symbols: callers, callees, and sibling symbols in the same file.
- **Fuzzy fallback**: Suggests similar names if symbol not found.

### 5. \`mapx_batch\` (Batch Operations)
Execute multiple operations in a single round-trip call to reduce latency.
- **Parameters**:
  - \`operations\` (array): Each operation has \`tool\` (search, node, callers, callees, deps) and \`args\`.
  - \`maxItems\` (number): Maximum operations per batch (default: 10).
- **Example**:
  \`\`\`json
  { "operations": [
    { "tool": "search", "args": { "term": "*Controller", "kind": "class" } },
    { "tool": "node", "args": { "symbol": "UserController", "source": true } }
  ] }
  \`\`\`

### 6. \`mapx_status\` (Index Status & Breakdown)
Checks indexing state, language counts, top files/symbols, and Git status.
- Use this to check if index is stale and see PageRank rankings.

### 7. \`mapx_sync\` (Incremental Indexing)
Scans only modified/new files since the last scan and updates the graph index. Fast and efficient.
- Call this immediately after modifying files.

### 8. \`mapx_scan\` (Full Indexing)
Performs a full clean re-scan of the codebase. Use only for major structural updates.

### 9. \`mapx_impact\` (Change Impact Analysis)
Traces transitive callers of a symbol up to a certain depth and grades the change risk (\`HIGH\`, \`MEDIUM\`, or \`LOW\`).
- Depth 1 is graded \`HIGH\`/\`MEDIUM\` risk, depth 2+ is \`MEDIUM\`/\`LOW\` risk.
- Calling sites inside test files or wrapped in try/catch blocks are automatically labeled as \`LOW\` risk.
- **Fuzzy pre-check**: Validates symbol existence before running analysis; suggests alternatives if not found.

### 10. \`mapx_callers\` / \`mapx_callees\` (Call Graph)
Direct and nested callers/callees of a symbol.
- \`depth\` (number): Max traversal depth (default: 1).
- **Fuzzy fallback**: Suggests similar names if symbol not found.

### 11. \`mapx_trace\` (Data-Flow Tracing)
Follows data-bearing edges forward/backward through the graph to trace data propagation.
- Use \`direction: "up"\` or \`direction: "down"\` to trace dependencies.

### 12. \`mapx_dependencies\` / \`mapx_sources\` / \`mapx_sinks\`
- \`mapx_dependencies\`: Get deps and reverse-deps for a file.
- \`mapx_sources\`: Find entry points (data sources) in the codebase.
- \`mapx_sinks\`: Find terminal consumers (sinks) in the codebase.

### 13. \`mapx_files\` / \`mapx_clusters\` / \`mapx_export\` / \`mapx_workspaces\`
- \`mapx_files\`: List and filter files by path prefix or glob pattern, language, and size or line counts.
- \`mapx_clusters\`: List code clusters/modules (supports \`source\` filter).
- \`mapx_export\`: Export compact graph summary (formats: llm, json, dot, svg, toon).
- \`mapx_workspaces\`: Retrieve workspace configuration and repositories (list/discover).

### 14. \`mapx_lang_list\` / \`mapx_lang_install\` / \`mapx_lang_uninstall\`
Manage supported languages and dynamic grammar installation.

### 15. \`mapx_routes\` / \`mapx_hooks\` / \`mapx_edges\` / \`mapx_metrics\`
- \`mapx_routes\`: List HTTP routes parsed from controllers.
- \`mapx_hooks\`: List framework hooks and lifecycle bindings.
- \`mapx_edges\`: Granular graph dependency edges query.
- \`mapx_metrics\`: Get coupling and instability metrics for codebase files.

### 16. \`mapx_profile\` / \`mapx_explain\` / \`mapx_smells\` / \`mapx_dsm\` / \`mapx_layers\`
- \`mapx_profile\`: Retrieve high-level codebase profile (archetype, patterns, active taxonomy).
- \`mapx_explain\`: View detailed signal weights for a file's architectural role classification.
- \`mapx_smells\`: Run architectural and design smell detection audit.
- \`mapx_dsm\`: Generate the cluster Dependency Structure Matrix (DSM) matrix.
- \`mapx_layers\`: List project files grouped by their dynamically classified architectural roles.

---

## 📈 Suggested Workflows

### Scenario: Implementing a new feature
1. Call \`mapx_context\` with your feature description in the \`task\` parameter.
2. Review the resulting context and list of files.
3. Open and modify the required files.
4. Call \`mapx_sync\` to update the index.
5. Use \`mapx_impact\` on the modified symbols to make sure you didn't break callers elsewhere.

### Scenario: Batch investigation
1. Use \`mapx_batch\` to search for multiple symbol patterns and fetch their details in one call.
2. Review results, then use \`mapx_callers\` to trace upstream dependents.`
  }
};
