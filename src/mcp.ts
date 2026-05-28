import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './core/store.js';
import { MapxGraph } from './core/graph.js';
import { Scanner, buildMatcher } from './core/scanner.js';
import { Config } from './core/config.js';
import { FlowTracer, TraceNode } from './core/flow-tracer.js';
import { AgentGenerator } from './agents/generator.js';
import { LLMExporter } from './exporters/llm-exporter.js';
import { GraphExporter } from './exporters/graph-exporter.js';
import { DotExporter } from './exporters/dot-exporter.js';
import { SvgExporter } from './exporters/svg-exporter.js';
import { calculateMetrics } from './core/metrics.js';
import { ContextBuilder } from './core/context-builder.js';
import { getChangedFiles, isGitRepo } from './core/git-tracker.js';
import { ImpactAnalyzer, checkTryCatch as coreCheckTryCatch } from './core/impact-analyzer.js';
import { getBuiltinLanguages } from './languages/registry.js';
import { isLanguageInstalled, installLanguage, uninstallLanguage } from './languages/installer.js';
import { RouteRegistry } from './frameworks/route-registry.js';
import { UiEventBus } from './ui-events.js';
import { WorkspaceManager } from './core/workspace-manager.js';
import { findSimilarSymbols } from './core/fuzzy-matcher.js';

// defaultDir is set by startMcpServer(); null means not yet configured.
let defaultDir: string | null = null;

const DirSchema = z.object({
  dir: z.string().optional(),
});

function resolveDir(args: Record<string, unknown>): string | null {
  const parsed = DirSchema.parse(args);
  if (parsed.dir) return resolve(parsed.dir);
  if (defaultDir) return defaultDir;
  return null;
}

async function loadContext(dir: string) {
  const configPath = resolve(dir, '.mapx', 'config.json');
  if (!existsSync(configPath)) {
    return { error: `Mapx not initialized in ${dir}. Run \`mapx init ${dir}\` first.` };
  }

  const config = await Config.load(dir);
  const dbPath = resolve(dir, '.mapx', 'mapx.db');
  const store = new Store(dbPath);
  const graph = new MapxGraph(config.repo.name);

  const files = store.getAllFiles();
  for (const file of files) {
    graph.addFileNode(file.path as string, file.language as string, file.size_bytes as number, file.lines as number);
  }

  const symbols = store.getAllSymbols();
  for (const sym of symbols) {
    graph.addSymbolNode(sym.name as string, sym.file_path as string, sym.name as string, sym.kind as any, sym.start_line as number, sym.end_line as number, sym.scope as string | null);
  }

  const edges = store.getAllEdges();
  for (const edge of edges) {
    graph.addDependencyEdge({
      sourceFile: edge.source_file as string,
      targetFile: edge.target_file as string,
      sourceSymbol: edge.source_symbol as string | null,
      targetSymbol: edge.target_symbol as string | null,
      edgeType: edge.edge_type as any,
      repo: edge.repo as string,
      weight: edge.weight as number,
      verifiability: edge.verifiability as any,
      targetRepo: edge.target_repo as string | null,
    });
  }

  return { config, store, graph };
}

const dirProperty = {
  dir: {
    type: 'string',
    description: 'Target project directory (absolute or relative path). Defaults to the directory set when starting the MCP server.',
  },
};

interface ServeOptions {
  sse?: boolean;
  port?: number;
  debug?: boolean;
}

export function buildServer(options?: ServeOptions): Server {
  const server = new Server(
    { name: 'mapx', version: '0.1.3' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (options?.debug) {
      process.stderr.write(`[mapx debug] Received list_tools request\n`);
    }
    return {
    tools: [
      {
        name: 'mapx_scan',
        description: 'Scan the codebase and build/update the code graph. Run this when you need to understand project structure or after files have changed.',
        inputSchema: {
          type: 'object',
          properties: {
            exclude: { type: 'string', description: 'Comma-separated list of exclude glob patterns to append' },
            include: { type: 'string', description: 'Comma-separated list of include glob patterns to append' },
            repo: { type: 'string', description: 'Scan only a specific registered repository' },
            all: { type: 'boolean', description: 'Scan all registered repositories' },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_sync',
        description: 'Incremental scan: re-scan only changed files in the codebase.',
        inputSchema: {
          type: 'object',
          properties: {
            exclude: { type: 'string', description: 'Comma-separated list of exclude glob patterns to append' },
            include: { type: 'string', description: 'Comma-separated list of include glob patterns to append' },
            repo: { type: 'string', description: 'Update/sync only a specific registered repository' },
            all: { type: 'boolean', description: 'Update/sync all registered repositories' },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_query',
        description: `Search symbols by name pattern. Returns definitions with file locations and signatures.

SEARCH MODES:
  • Substring (default): term="User" matches UserService, UserController, getUser
  • Glob pattern: term="*Service" or term="get*" (uses * and ? wildcards)
  • List all: term="*" returns all indexed symbols

Prefer mapx_search for filtered queries (by kind, file path, exact match). Use mapx_query for quick lookups.`,
        inputSchema: {
          type: 'object',
          properties: {
            term: { type: 'string', description: 'Symbol name, substring, or glob pattern (* and ? supported). Use "*" to list all.' },
            ...dirProperty,
          },
          required: ['term'],
        },
      },
      {
        name: 'mapx_dependencies',
        description: 'Get dependencies and reverse dependencies for a file. Shows what a file depends on and what depends on it.',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'File path to analyze (relative to project root)' },
            ...dirProperty,
          },
          required: ['file'],
        },
      },
      {
        name: 'mapx_export',
        description: `Export a compact, token-efficient summary of the code graph. Use at the start of a session to understand codebase structure without reading files.

FORMATS:
  • llm (default): PageRank-ranked files with signatures, optimized for LLM context. Use "tokens" to control size.
  • json: Full graph as JSON (files, symbols, edges)
  • dot: GraphViz DOT format (use with --cluster auto for grouped rendering)
  • svg: SVG visualization
  • toon: TOON compact token-efficient format

EXAMPLES:
  • Quick overview: { }
  • Larger context: { "tokens": 16384 }
  • Full JSON graph: { "format": "json" }
  • Clustered SVG: { "format": "svg", "cluster": "auto" }`,
        inputSchema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['llm', 'json', 'dot', 'svg', 'toon'], description: 'Output format', default: 'llm' },
            tokens: { type: 'number', description: 'Token budget for LLM/TOON format', default: 8192 },
            repo: { type: 'string', description: 'Filter by repo name (for multi-repo workspaces)' },
            exclude: { type: 'string', description: 'Comma-separated exclude glob patterns' },
            include: { type: 'string', description: 'Comma-separated include glob patterns' },
            cluster: { type: 'string', enum: ['none', 'auto'], description: 'Cluster rendering mode for DOT/SVG', default: 'none' },
            depth: { type: 'number', description: 'Maximum cluster nesting depth for DOT/SVG export', default: 3 },
            fallback_grid: { type: 'boolean', description: 'Force using fallback grid SVG export', default: false },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_status',
        description: 'Check what files have changed since the last scan. Use this to determine if a re-scan is needed.',
        inputSchema: {
          type: 'object',
          properties: {
            exclude: { type: 'string', description: 'Comma-separated list of exclude glob patterns to append' },
            include: { type: 'string', description: 'Comma-separated list of include glob patterns to append' },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_metrics',
        description: 'Get coupling (afferent/efferent) and instability metrics for all files, optionally filtered by language and verified-only.',
        inputSchema: {
          type: 'object',
          properties: {
            lang: { type: 'string', description: 'Filter metrics by language' },
            verifiedOnly: { type: 'boolean', description: 'Only compute metrics using verified edges', default: false },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_edges',
        description: 'Granular query of dependency edges in the code graph.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Filter edges by type' },
            from: { type: 'string', description: 'Filter edges originating from a file pattern (substring match)' },
            to: { type: 'string', description: 'Filter edges targeting a file pattern (substring match)' },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_clusters',
        description: 'List detected code clusters/modules. Returns cluster hierarchy with file counts and inter-cluster dependencies.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['all', 'namespace', 'directory', 'community'], description: 'Filter clusters by source type' },
            cluster: { type: 'string', description: 'Specific cluster name to inspect' },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_trace',
        description: 'Trace data flow paths from a starting symbol or file. Returns upstream callers (up), downstream callees (down), or both. Use this to understand how data moves through the codebase.',
        inputSchema: {
          type: 'object',
          required: ['start'],
          properties: {
            start: { type: 'string', description: 'Symbol (e.g. \'UserController::store\') or file path' },
            direction: { type: 'string', enum: ['up', 'down', 'both'], default: 'both', description: 'Direction of traversal' },
            depth: { type: 'number', default: 3, description: 'Max traversal depth' },
            format: { type: 'string', enum: ['text', 'dot', 'json'], default: 'text', description: 'Output format' },
            include_structural: { type: 'boolean', default: false, description: 'Include structural edges (e.g., import/extends)' },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_routes',
        description: 'Show routes from all detected frameworks',
        inputSchema: {
          type: 'object',
          properties: {
            framework: { type: 'string', description: 'Filter by framework name' },
            method: { type: 'string', description: 'Filter by HTTP method (GET, POST, etc.)' },
            pathPattern: { type: 'string', description: 'Filter by route path pattern' },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_hooks',
        description: 'Show hooks/events from all detected frameworks',
        inputSchema: {
          type: 'object',
          properties: {
            framework: { type: 'string', description: 'Filter by framework name' },
            type: { type: 'string', description: 'Filter by hook type' },
            namePattern: { type: 'string', description: 'Filter by hook name pattern' },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_sources',
        description: 'Find all entry points in the codebase — files/symbols with no incoming data-flow edges. Useful for understanding where data enters the system.',
        inputSchema: {
          type: 'object',
          properties: {
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_agents_generate',
        description: 'Generate provider-specific LLM integration files (AGENTS.md, CLAUDE.md, etc.) for the project.',
        inputSchema: {
          type: 'object',
          properties: {
            ...dirProperty,
            providers: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of providers to generate files for (e.g. generic, claude, cursor, copilot, windsurf, cline, aider, gemini, continue, zed).'
            },
            all: {
              type: 'boolean',
              description: 'Generate files for all available providers.'
            }
          }
        }
      },
      {
        name: 'mapx_sinks',
        description: 'Find all terminal consumers — files/symbols with no outgoing data-flow edges. Useful for identifying where data is persisted, queued, or sent externally.',
        inputSchema: {
          type: 'object',
          properties: {
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_search',
        description: `Search for symbols with filters, glob patterns, and PageRank importance scores.

SEARCH PATTERNS:
  • Substring (default): term="User" matches UserService, UserController, getUser
  • Glob pattern: term="*Service" matches UserService, AuthService; term="get*" matches getUser, getData
  • List all: term="*" lists all symbols (combine with kind/file filters to narrow)
  • Exact match: exact=true with term="UserService" matches only UserService

All matching is case-insensitive. If no results are found, similar symbol names are suggested.

EXAMPLES:
  • Find all enums: { "term": "*", "kind": "enum" }
  • Find services: { "term": "*Service" }
  • Find all symbols in a directory: { "term": "*", "file": "src/core/" }
  • Find a specific class: { "term": "UserService", "kind": "class", "exact": true }
  • Browse all classes: { "term": "*", "kind": "class", "limit": 50 }`,
        inputSchema: {
          type: 'object',
          properties: {
            term: { type: 'string', description: 'Symbol name, glob pattern (* and ? wildcards), or "*" to list all. Case-insensitive.' },
            kind: {
              type: 'string',
              enum: ['class', 'method', 'function', 'interface', 'trait', 'constant', 'enum', 'property', 'namespace', 'struct', 'module', 'field'],
              description: 'Filter by symbol kind (case-insensitive)',
            },
            file: { type: 'string', description: 'Filter by file path prefix (e.g. "src/core/" or "apps/dashboard/")' },
            exact: { type: 'boolean', description: 'Only match exact name (case-insensitive)', default: false },
            limit: { type: 'number', description: 'Max results to return', default: 20 },
            format: { type: 'string', enum: ['text', 'json'], description: 'Output format. "json" returns structured data.', default: 'text' },
            ...dirProperty,
          },
          required: ['term'],
        },
      },
      {
        name: 'mapx_context',
        description: `Generate focused, token-budgeted context for a coding task. Expands from seed symbols/files through the dependency graph, ranks by PageRank relevance, and trims to fit token budget.

USE WHEN: Starting a task and you need to understand the relevant code without reading every file.
ALTERNATIVE: Use mapx_export for a full project overview instead of a task-specific one.

EXAMPLES:
  • { "task": "refactor the authentication flow" }
  • { "task": "add rate limiting to API endpoints", "seeds": ["AuthService", "src/middleware/"] }
  • { "task": "fix payment checkout bug", "tokens": 4096 }`,
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Natural language description of the coding task' },
            seeds: { type: 'array', items: { type: 'string' }, description: 'Specific symbols or file paths to anchor the context expansion' },
            tokens: { type: 'number', description: 'Token budget for output', default: 8192 },
            depth: { type: 'number', description: 'Graph traversal depth from seeds', default: 2 },
            ...dirProperty,
          },
          required: ['task'],
        },
      },
      {
        name: 'mapx_callers',
        description: `Find all callers of a symbol — who calls this function/method/class? Traverses the call graph upstream.

SYMBOL FORMAT: "SymbolName" or "ClassName::methodName" for scoped symbols.
DEPTH: depth=1 (default) shows direct callers only. depth=2+ shows transitive callers.

If the symbol is not found, similar names are suggested.

EXAMPLES:
  • { "symbol": "handleRequest" }
  • { "symbol": "UserService::findAll", "depth": 2 }
  • { "symbol": "apiFetch", "depth": 3 }`,
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Symbol name (e.g. "handleRequest") or scoped name (e.g. "UserService::findAll")' },
            depth: { type: 'number', description: 'Max traversal depth. 1=direct callers, 2+=transitive.', default: 1 },
            ...dirProperty,
          },
          required: ['symbol'],
        },
      },
      {
        name: 'mapx_callees',
        description: `Find all callees of a symbol — what does this function/method call? Traverses the call graph downstream.

SYMBOL FORMAT: "SymbolName" or "ClassName::methodName" for scoped symbols.
DEPTH: depth=1 (default) shows direct callees only. depth=2+ shows transitive callees.

If the symbol is not found, similar names are suggested.

EXAMPLES:
  • { "symbol": "handleRequest" }
  • { "symbol": "UserService::create", "depth": 2 }`,
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Symbol name (e.g. "handleRequest") or scoped name (e.g. "UserService::create")' },
            depth: { type: 'number', description: 'Max traversal depth. 1=direct callees, 2+=transitive.', default: 1 },
            ...dirProperty,
          },
          required: ['symbol'],
        },
      },
      {
        name: 'mapx_impact',
        description: `Analyze the blast radius of changing a symbol. Returns risk-scored list of affected callers at each depth level (HIGH/MEDIUM/LOW).

USE BEFORE: Modifying any function, class, or method to understand what might break.
If the symbol is not found, similar names are suggested.

EXAMPLES:
  • { "symbol": "UserService" }
  • { "symbol": "apiFetch", "depth": 4 }
  • { "symbol": "DatabasePool::getConnection" }`,
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Symbol name or scoped name (e.g. "ClassName::method")' },
            depth: { type: 'number', description: 'Max traversal depth for impact analysis', default: 3 },
            ...dirProperty,
          },
          required: ['symbol'],
        },
      },
      {
        name: 'mapx_node',
        description: `Inspect a specific symbol: kind, file location, signature, caller/callee counts, and optionally its source code.

USE WHEN: You know the exact symbol name and want details or source code.
USE mapx_search INSTEAD WHEN: You only have a partial name or want to browse symbols.

SYMBOL FORMAT: "SymbolName" or "ClassName::methodName" (scope::name)
If the symbol is not found, similar names are suggested.

EXAMPLES:
  • { "symbol": "UserService" }
  • { "symbol": "UserService::findAll", "source": true }
  • { "symbol": "handleRequest", "source": true }`,
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Symbol name (e.g. "UserService") or scoped name (e.g. "UserService::findAll")' },
            source: { type: 'boolean', description: 'Include the symbol\'s source code in the response', default: false },
            format: { type: 'string', enum: ['text', 'json'], description: 'Output format', default: 'text' },
            ...dirProperty,
          },
          required: ['symbol'],
        },
      },
      {
        name: 'mapx_files',
        description: `List indexed project files with optional filters. Faster than filesystem listing since it uses the pre-built index.

EXAMPLES:
  • List all files: { }
  • Files in a directory: { "path": "src/core/" }
  • Only TypeScript files: { "lang": "typescript" }
  • Largest files first: { "sort": "lines", "limit": 20 }`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Filter by path prefix (e.g. "src/core/" or "apps/dashboard/")' },
            lang: { type: 'string', description: 'Filter by language (e.g. "typescript", "python", "go")' },
            sort: { type: 'string', enum: ['lines', 'path'], description: 'Sort by line count (desc) or path (asc)', default: 'path' },
            limit: { type: 'number', description: 'Max files to return', default: 50 },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_lang_list',
        description: 'List all supported languages, their extensions, tier, and installation status.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'mapx_lang_install',
        description: 'Install grammar and query files for a dynamically installable language.',
        inputSchema: {
          type: 'object',
          properties: {
            lang: { type: 'string', description: 'Name of the language (e.g. ruby, c, cpp, swift, kotlin, svelte, vue, lua, elixir, zig, bash, pascal, dart, scala)' }
          },
          required: ['lang'],
        },
      },
      {
        name: 'mapx_lang_uninstall',
        description: 'Uninstall grammar and query files for a dynamically installable language.',
        inputSchema: {
          type: 'object',
          properties: {
            lang: { type: 'string', description: 'Name of the language to uninstall' }
          },
          required: ['lang'],
        },
      },
      {
        name: 'mapx_workspaces',
        description: 'List registered repositories and discover unregistered submodules, peer repos, and VS Code workspace folders.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'discover'],
              description: 'Action to perform. "list" returns registered repos with stats + discovered repos. "discover" returns only unregistered discoveries.',
              default: 'list',
            },
            ...dirProperty,
          },
        },
      },
      {
        name: 'mapx_batch',
        description: `Execute multiple mapx queries in a single call. Reduces round-trips when you need to look up several symbols, check multiple files, or combine search + node inspection.

SUPPORTED OPERATIONS:
  • search: { "op": "search", "term": "...", "kind": "..." }
  • node: { "op": "node", "symbol": "...", "source": true }
  • callers: { "op": "callers", "symbol": "...", "depth": 2 }
  • callees: { "op": "callees", "symbol": "...", "depth": 2 }
  • deps: { "op": "deps", "file": "..." }

EXAMPLE:
  { "operations": [
    { "op": "search", "term": "UserService", "kind": "class" },
    { "op": "node", "symbol": "UserService", "source": true },
    { "op": "callers", "symbol": "UserService::findAll" }
  ]}`,
        inputSchema: {
          type: 'object',
          properties: {
            operations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['search', 'node', 'callers', 'callees', 'deps'], description: 'Operation type' },
                  term: { type: 'string', description: 'Search term (for search op)' },
                  symbol: { type: 'string', description: 'Symbol name (for node/callers/callees ops)' },
                  file: { type: 'string', description: 'File path (for deps op)' },
                  kind: { type: 'string', description: 'Symbol kind filter (for search op)' },
                  source: { type: 'boolean', description: 'Include source code (for node op)' },
                  depth: { type: 'number', description: 'Traversal depth (for callers/callees ops)' },
                  limit: { type: 'number', description: 'Max results (for search op)' },
                  exact: { type: 'boolean', description: 'Exact match (for search op)' },
                },
                required: ['op'],
              },
              description: 'Array of operations to execute',
            },
            maxItems: { type: 'number', description: 'Override default batch size limit (default: 10)', default: 10 },
            ...dirProperty,
          },
          required: ['operations'],
        },
      },
    ],
  };
  });

  const executeTool = async (request: any) => {
    const { name, arguments: args } = request.params;
    // Each tool call opens a fresh Store; track it so we can close it when done.
    let activeStore: Store | undefined;
    const resolveOrFail = (a: Record<string, unknown>): { dir: string } | { error: string } => {
      const dir = resolveDir(a);
      if (!dir) return { error: 'No project directory set. Either pass a "dir" argument or start the server with --dir /path/to/project.' };
      // Lazily enable cross-process tool call logging if not already set
      const eventBus = UiEventBus.getInstance();
      if (!(eventBus as any).mapxDir) eventBus.setMapxDir(dir);
      return { dir };
    };
    const loadCtx = async (dir: string) => {
      const ctx = await loadContext(dir);
      if (!('error' in ctx)) activeStore = ctx.store;
      return ctx;
    };

    try {
    switch (name) {
      case 'mapx_scan': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const excludeStr = (args as any)?.exclude;
        const includeStr = (args as any)?.include;
        const repo = (args as any)?.repo;
        const all = !!(args as any)?.all;
        const exclude = excludeStr ? excludeStr.split(',').map((s: string) => s.trim()) : [];
        const include = includeStr ? includeStr.split(',').map((s: string) => s.trim()) : [];

        let repoNames: string[] | undefined = undefined;
        if (repo) {
          repoNames = [repo];
        } else if (all) {
          repoNames = ['all'];
        }

        try {
          const scanner = new Scanner(ctx.store, ctx.config, ctx.graph, undefined, { excludes: exclude, includes: include });
          const result = await scanner.scanFull(repoNames);
          return {
            content: [{
              type: 'text',
              text: `Scanned ${result.filesScanned} files in ${dir} (${Object.entries(result.languageBreakdown).map(([l, c]) => `${l}: ${c}`).join(', ')})\nFound ${result.symbolsFound} symbols, ${result.edgesFound} edges in ${result.durationMs}ms`,
            }],
          };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Scan failed: ${err.message}` }] };
        }
      }
      case 'mapx_sync': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const excludeStr = (args as any)?.exclude;
        const includeStr = (args as any)?.include;
        const repo = (args as any)?.repo;
        const all = !!(args as any)?.all;
        const exclude = excludeStr ? excludeStr.split(',').map((s: string) => s.trim()) : [];
        const include = includeStr ? includeStr.split(',').map((s: string) => s.trim()) : [];

        let repoNames: string[] | undefined = undefined;
        if (repo) {
          repoNames = [repo];
        } else if (all) {
          repoNames = ['all'];
        }

        try {
          const scanner = new Scanner(ctx.store, ctx.config, ctx.graph, undefined, { excludes: exclude, includes: include });
          const result = await scanner.scanIncremental(repoNames);
          return {
            content: [{
              type: 'text',
              text: `Updated ${result.filesScanned} files in ${dir} (${Object.entries(result.languageBreakdown).map(([l, c]) => `${l}: ${c}`).join(', ')})\n${result.symbolsFound} symbols updated, ${result.edgesFound} edges updated in ${result.durationMs}ms`,
            }],
          };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Sync failed: ${err.message}` }] };
        }
      }

      case 'mapx_query': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const term = (args as any)?.term;
        if (!term) return { content: [{ type: 'text', text: 'Missing required parameter: term' }] };

        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const results = ctx.store.searchSymbols(term);
        if (results.length === 0) {
          // Fuzzy fallback: suggest similar symbol names
          const candidates = ctx.store.getSymbolCandidatesForFuzzy();
          const suggestions = findSimilarSymbols(term, candidates);
          let msg = `No symbols matching "${term}" in ${dir}`;
          if (suggestions.length > 0) {
            msg += `\n\nDid you mean:\n${suggestions.map(s => `  • ${s.name} (${s.kind} @ ${s.filePath})`).join('\n')}`;
          }
          msg += `\n\nTip: Use mapx_search for filtered queries. Example: { "term": "${term.length > 3 ? term.slice(0, 4) : term}*", "kind": "class" }`;
          return { content: [{ type: 'text', text: msg }] };
        }

        const header = `Found ${results.length} symbol${results.length !== 1 ? 's' : ''} matching "${term}":\n\n`;
        const lines = results.map(sym => {
          const scope = sym.scope ? `${sym.scope}::` : '';
          return `${sym.kind} ${scope}${sym.name}\n  @ ${sym.file_path}:${sym.start_line}${sym.signature && sym.signature !== sym.name ? `\n  signature: ${sym.signature}` : ''}`;
        });

        const warning = getMcpStalenessWarning(ctx.store, dir);
        return { content: [{ type: 'text', text: warning + header + lines.join('\n\n') }] };
      }

      case 'mapx_dependencies': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const file = (args as any)?.file;
        if (!file) return { content: [{ type: 'text', text: 'Missing required parameter: file' }] };

        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const deps = ctx.graph.getDependencies(file);
        const rdeps = ctx.graph.getReverseDependencies(file);

        const parts: string[] = [];
        if (deps.length > 0) {
          parts.push('Dependencies:');
          for (const d of deps) parts.push(`  → ${d.target} (${d.type})`);
        }
        if (rdeps.length > 0) {
          parts.push('Depended on by:');
          for (const r of rdeps) parts.push(`  ← ${r.source} (${r.type})`);
        }
        if (parts.length === 0) parts.push('No dependencies found');

        const warning = getMcpStalenessWarning(ctx.store, dir);
        return { content: [{ type: 'text', text: warning + parts.join('\n') }] };
      }

      case 'mapx_export': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const format = (args as any)?.format || 'llm';
        const tokens = (args as any)?.tokens || 8192;
        const repo = (args as any)?.repo;

        const excludeStr = (args as any)?.exclude;
        const includeStr = (args as any)?.include;
        const exclude = excludeStr ? excludeStr.split(',').map((s: string) => s.trim()) : [];
        const include = includeStr ? includeStr.split(',').map((s: string) => s.trim()) : [];

        const excludes = [
          ...(ctx.config.settings.excludePatterns ?? []),
          ...exclude,
        ];
        const includes = [
          ...(ctx.config.settings.includePatterns ?? []),
          ...include,
        ];
        const matcher = buildMatcher(excludes, includes);
        const allFiles = ctx.store.getAllFiles(repo).map(f => f.path as string);
        const filteredFiles = allFiles.filter(f => matcher(f));

        const clusterMode = (args as any)?.cluster === 'none' ? 'none' as const : 'auto' as const;
        const clusterDepth = (args as any)?.depth !== undefined ? parseInt((args as any).depth, 10) : 3;
        const fallbackGrid = !!(args as any)?.fallback_grid;
        const clusterOpts = { cluster: clusterMode, depth: clusterDepth, forceFallback: fallbackGrid };

        if (format === 'json') {
          const exporter = new GraphExporter(ctx.store, ctx.graph);
          return { content: [{ type: 'text', text: exporter.exportAsJSONString(repo, filteredFiles) }] };
        }

        if (format === 'dot') {
          const exporter = new DotExporter(ctx.store, ctx.graph);
          return { content: [{ type: 'text', text: exporter.export(repo, filteredFiles, clusterOpts) }] };
        }

        if (format === 'svg') {
          const exporter = new SvgExporter(ctx.store, ctx.graph);
          return { content: [{ type: 'text', text: exporter.export(repo, filteredFiles, clusterOpts) }] };
        }

        const exporter = new LLMExporter(ctx.store, ctx.graph);
        const output = exporter.export({ format: 'llm', tokenBudget: tokens, repo, files: filteredFiles });
        return { content: [{ type: 'text', text: output }] };
      }

      case 'mapx_status': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const lastScan = ctx.store.getMeta('last_scan_time:' + ctx.config.repo.name) || ctx.store.getMeta('last_scan_time');
        const lastCommit = ctx.store.getMeta('last_scan_commit:' + ctx.config.repo.name) || ctx.store.getMeta('last_scan_commit');
        const fileCount = ctx.store.getFileCount();
        const symbolCount = ctx.store.getSymbolCount();
        const edgeCount = ctx.store.getEdgeCount();
        const verifiedEdgeCount = (ctx.store.raw.prepare("SELECT COUNT(*) as cnt FROM edges WHERE verifiability = 'verified'").get() as any)?.cnt || 0;
        const inferredEdgeCount = (ctx.store.raw.prepare("SELECT COUNT(*) as cnt FROM edges WHERE verifiability = 'inferred'").get() as any)?.cnt || 0;

        const breakdown = ctx.store.getLanguageBreakdown();
        const topFiles = ctx.store.getTopFilesByPageRank(ctx.graph, 5);
        const topSymbols = ctx.store.getTopSymbolsByPageRank(ctx.graph, 5);

        const repoRoot = resolve(dir, ctx.config.repo.path);
        let isStale = false;
        let gitInfo = '';
        if (isGitRepo(repoRoot)) {
          const changes = getChangedFiles(repoRoot, lastCommit || undefined);
          if (changes.length === 0) {
            gitInfo = 'No changes since last scan  (✓ index is current)';
          } else {
            isStale = true;
            gitInfo = `${changes.length} changed files  (⚠ stale)`;
          }
        } else {
          gitInfo = 'Not a git repository  (✓ index is current)';
        }

        const recommendations = isStale
          ? '⚠ Index is stale. Run `mapx sync` or `mapx update` to bring it up to date.'
          : '✓ Index is up to date.';

        const textOutput = `Directory: ${dir}
Last scan: ${lastScan || 'never'}
Last commit: ${lastCommit || 'none'}
Files: ${fileCount} | Symbols: ${symbolCount} | Edges: ${edgeCount} (verified: ${verifiedEdgeCount}, inferred: ${inferredEdgeCount})

Language Breakdown:
${Object.entries(breakdown).map(([l, c]) => `  ${l}: ${c} files`).join('\n')}

Top Files by PageRank:
${topFiles.map(tf => `  ${tf.pagerank.toFixed(6)}  ${tf.path}`).join('\n')}

Top Symbols by PageRank:
${topSymbols.map(ts => `  ${ts.pagerank.toFixed(6)}  ${ts.scope ? `${ts.scope}::` : ''}${ts.name} (${ts.filePath})`).join('\n')}

Git Status:
  ${gitInfo}

Recommendation:
  ${recommendations}`;

        return {
          content: [{
            type: 'text',
            text: textOutput,
          }],
        };
      }

      case 'mapx_search': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const term = (args as any)?.term;
        if (term === undefined || term === null) return { content: [{ type: 'text', text: 'Missing required parameter: term' }] };

        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const kind = (args as any)?.kind as string | undefined;
        const filePrefix = (args as any)?.file as string | undefined;
        const exact = !!(args as any)?.exact;
        const limit = (args as any)?.limit as number | undefined;
        const format = ((args as any)?.format || 'text') as string;

        let results = ctx.store.searchSymbolsFiltered({ term, kind, filePrefix, exact, limit });
        let broadened = false;

        // F44: Auto-expand — if kind filter yields 0 results, retry without kind
        if (results.length === 0 && kind && term !== '*' && term !== '') {
          const withoutKind = ctx.store.searchSymbolsFiltered({ term, filePrefix, exact, limit });
          if (withoutKind.length > 0) {
            results = withoutKind;
            broadened = true;
          }
        }

        // F41: Fuzzy fallback — suggest similar names when nothing matches
        if (results.length === 0 && term !== '*' && term !== '') {
          const candidates = ctx.store.getSymbolCandidatesForFuzzy();
          const suggestions = findSimilarSymbols(term, candidates);
          let msg = `No symbols matching "${term}"`;
          if (kind) {
            const kinds = ctx.store.listSymbolKinds();
            msg += ` with kind="${kind}".\n\nAvailable kinds:\n${kinds.map(k => `  ${k.kind}: ${k.count} symbols`).join('\n')}`;
          }
          if (suggestions.length > 0) {
            msg += `\n\nDid you mean:\n${suggestions.map(s => `  • ${s.name} (${s.kind} @ ${s.filePath})`).join('\n')}`;
          }
          msg += `\n\nTip: Use term="*" to list all symbols, or glob patterns like "${term.length > 3 ? term.slice(0, 4) : term}*"`;
          return { content: [{ type: 'text', text: msg }] };
        }

        // PageRank enrichment
        const rankedAll = ctx.graph.getRankedSymbols();
        const rankMap = new Map<string, number>();
        for (const item of rankedAll) {
          rankMap.set(`${item.filePath}::${item.name}`, item.pagerank);
        }

        // F43: JSON format support
        if (format === 'json') {
          const jsonResults = results.map(sym => ({
            name: sym.name,
            kind: sym.kind,
            scope: sym.scope || null,
            file: sym.file_path,
            line: sym.start_line,
            endLine: sym.end_line,
            signature: sym.signature || '',
            pagerank: rankMap.get(`${sym.file_path}::${sym.name}`) || 0,
          }));
          const warning = getMcpStalenessWarning(ctx.store, dir);
          return { content: [{ type: 'text', text: warning + JSON.stringify({ total: results.length, broadened, term, kind: kind || null, results: jsonResults }, null, 2) }] };
        }

        // F43: Summary header
        let header = `Found ${results.length} symbol${results.length !== 1 ? 's' : ''}`;
        if (kind && !broadened) header += ` of kind "${kind}"`;
        if (filePrefix) header += ` in ${filePrefix}`;
        if (broadened) header += ` (broadened from kind="${kind}" which had 0 results)`;
        header += `:\n\n`;

        const lines = results.map(sym => {
          const scope = sym.scope ? `${sym.scope}::` : '';
          const key = `${sym.file_path}::${sym.name}`;
          const pagerankVal = rankMap.get(key) || 0;
          return `${sym.kind} ${scope}${sym.name} [pagerank: ${pagerankVal.toFixed(6)}]\n  @ ${sym.file_path}:${sym.start_line}${sym.signature && sym.signature !== sym.name ? `\n  signature: ${sym.signature}` : ''}`;
        });

        const warning = getMcpStalenessWarning(ctx.store, dir);
        return { content: [{ type: 'text', text: warning + header + lines.join('\n\n') }] };
      }

      case 'mapx_context': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const task = (args as any)?.task;
        if (!task) return { content: [{ type: 'text', text: 'Missing required parameter: task' }] };

        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const builder = new ContextBuilder(ctx.store, ctx.graph);
        const format = (args as any)?.format || 'text';

        const result = await builder.buildContext({
          task,
          seeds: (args as any)?.seeds,
          tokens: (args as any)?.tokens,
          depth: (args as any)?.depth,
        });

        if (format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        const mdLines: string[] = [];
        mdLines.push('# Mapx smart Context');
        mdLines.push(`*Estimated tokens:* ${result.estimatedTokens}\n`);
        
        mdLines.push('## Included Files');
        if (result.includedFiles.length === 0) {
          mdLines.push('None');
        } else {
          for (const f of result.includedFiles) {
            mdLines.push(`### [${f.path}](file://${resolve(dir, f.path)})`);
            mdLines.push(`- Language: ${f.language}`);
            mdLines.push(`- Lines: ${f.lineCount} | Size: ${f.sizeBytes} bytes`);
            if (f.symbols.length > 0) {
              mdLines.push('- Symbols:');
              for (const sym of f.symbols) {
                const scopeStr = sym.scope ? `${sym.scope}::` : '';
                mdLines.push(`  - \`${sym.kind}\` \`${scopeStr}${sym.name}\` (lines ${sym.startLine}-${sym.endLine})`);
              }
            }
          }
        }

        if (result.edges.length > 0) {
          mdLines.push('\n## Cross-File Dependencies');
          for (const edge of result.edges) {
            const srcSym = edge.sourceSymbol ? `#${edge.sourceSymbol}` : '';
            const tgtSym = edge.targetSymbol ? `#${edge.targetSymbol}` : '';
            mdLines.push(`- \`${edge.sourceFile}${srcSym}\` → \`${edge.targetFile}${tgtSym}\` (${edge.edgeType})`);
          }
        }

        if (result.excludedFiles.length > 0) {
          mdLines.push('\n## Excluded Files (Token budget exhausted)');
          for (const f of result.excludedFiles) {
            mdLines.push(`- ${f}`);
          }
        }

        return { content: [{ type: 'text', text: mdLines.join('\n') }] };
      }

      case 'mapx_callers': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const symbolName = (args as any)?.symbol;
        if (!symbolName) return { content: [{ type: 'text', text: 'Missing required parameter: symbol' }] };

        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const maxDepth = (args as any)?.depth ?? 1;
        const queue: Array<{ symName: string; depth: number }> = [{ symName: symbolName, depth: 0 }];
        const visited = new Set<string>([symbolName]);
        const results: Array<{ caller: string; callee: string; file: string; line: number; depth: number }> = [];

        while (queue.length > 0) {
          const { symName, depth } = queue.shift()!;
          if (depth >= maxDepth) continue;

          const callers = ctx.store.getCallersOfSymbol(symName);
          for (const edge of callers) {
            const callerName = edge.source_symbol ? `${edge.source_symbol}` : '<top-level>';
            const calleeName = edge.target_symbol || symName;
            const meta = edge.metadata ? JSON.parse(edge.metadata) : {};

            results.push({
              caller: callerName,
              callee: calleeName,
              file: edge.source_file,
              line: meta.startLine || 1,
              depth: depth + 1
            });

            const nextSym = edge.source_symbol;
            if (nextSym && !visited.has(nextSym)) {
              visited.add(nextSym);
              queue.push({ symName: nextSym, depth: depth + 1 });
            }
          }
        }

        if (results.length === 0) {
          // F41: Check if symbol exists at all, provide fuzzy suggestions if not
          const sym = ctx.store.getSymbolByName(symbolName);
          if (!sym) {
            const candidates = ctx.store.getSymbolCandidatesForFuzzy();
            const suggestions = findSimilarSymbols(symbolName, candidates);
            let msg = `Symbol "${symbolName}" not found.`;
            if (suggestions.length > 0) {
              msg += `\n\nDid you mean:\n${suggestions.map(s => `  • ${s.name} (${s.kind} @ ${s.filePath})`).join('\n')}`;
            }
            return { content: [{ type: 'text', text: msg }] };
          }
          return { content: [{ type: 'text', text: `No callers found for "${symbolName}"` }] };
        }

        const lines = results.map(res => {
          const indent = '  '.repeat(res.depth);
          return `${indent}← ${res.caller} (calls ${res.callee})\n${indent}  @ ${res.file}:${res.line}`;
        });

        const header = `${results.length} caller${results.length !== 1 ? 's' : ''} of "${symbolName}"${maxDepth > 1 ? ` (depth ${maxDepth})` : ''}:\n`;
        const warning = getMcpStalenessWarning(ctx.store, dir);
        return { content: [{ type: 'text', text: warning + header + lines.join('\n') }] };
      }

      case 'mapx_callees': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const symbolName = (args as any)?.symbol;
        if (!symbolName) return { content: [{ type: 'text', text: 'Missing required parameter: symbol' }] };

        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const maxDepth = (args as any)?.depth ?? 1;
        const queue: Array<{ symName: string; depth: number }> = [{ symName: symbolName, depth: 0 }];
        const visited = new Set<string>([symbolName]);
        const results: Array<{ caller: string; callee: string; file: string; line: number; depth: number }> = [];

        while (queue.length > 0) {
          const { symName, depth } = queue.shift()!;
          if (depth >= maxDepth) continue;

          const callees = ctx.store.getCalleesOfSymbol(symName);
          for (const edge of callees) {
            const calleeName = edge.target_symbol || '<unknown>';
            const callerName = edge.source_symbol || symName;
            const meta = edge.metadata ? JSON.parse(edge.metadata) : {};

            results.push({
              caller: callerName,
              callee: calleeName,
              file: edge.target_file,
              line: meta.startLine || 1,
              depth: depth + 1
            });

            if (edge.target_symbol && !visited.has(edge.target_symbol)) {
              visited.add(edge.target_symbol);
              queue.push({ symName: edge.target_symbol, depth: depth + 1 });
            }
          }
        }

        if (results.length === 0) {
          // F41: Check if symbol exists, provide fuzzy suggestions if not
          const sym = ctx.store.getSymbolByName(symbolName);
          if (!sym) {
            const candidates = ctx.store.getSymbolCandidatesForFuzzy();
            const suggestions = findSimilarSymbols(symbolName, candidates);
            let msg = `Symbol "${symbolName}" not found.`;
            if (suggestions.length > 0) {
              msg += `\n\nDid you mean:\n${suggestions.map(s => `  • ${s.name} (${s.kind} @ ${s.filePath})`).join('\n')}`;
            }
            return { content: [{ type: 'text', text: msg }] };
          }
          return { content: [{ type: 'text', text: `No callees found for "${symbolName}"` }] };
        }

        const lines = results.map(res => {
          const indent = '  '.repeat(res.depth);
          return `${indent}→ ${res.callee} (called by ${res.caller})\n${indent}  @ ${res.file}:${res.line}`;
        });

        const header = `${results.length} callee${results.length !== 1 ? 's' : ''} of "${symbolName}"${maxDepth > 1 ? ` (depth ${maxDepth})` : ''}:\n`;
        const warning = getMcpStalenessWarning(ctx.store, dir);
        return { content: [{ type: 'text', text: warning + header + lines.join('\n') }] };
      }

      case 'mapx_impact': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const symbolName = (args as any)?.symbol;
        if (!symbolName) return { content: [{ type: 'text', text: 'Missing required parameter: symbol' }] };

        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const maxDepth = (args as any)?.depth ?? 3;
        const analyzer = new ImpactAnalyzer(ctx.store);

        // F41: Check symbol exists first
        const sym = ctx.store.getSymbolByName(symbolName);
        if (!sym) {
          const candidates = ctx.store.getSymbolCandidatesForFuzzy();
          const suggestions = findSimilarSymbols(symbolName, candidates);
          let msg = `Symbol "${symbolName}" not found.`;
          if (suggestions.length > 0) {
            msg += `\n\nDid you mean:\n${suggestions.map(s => `  • ${s.name} (${s.kind} @ ${s.filePath})`).join('\n')}`;
          }
          return { content: [{ type: 'text', text: msg }] };
        }

        const result = analyzer.analyze(symbolName, maxDepth, dir);

        const warning = getMcpStalenessWarning(ctx.store, dir);
        return { content: [{ type: 'text', text: warning + JSON.stringify(result, null, 2) }] };
      }

      case 'mapx_node': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const symbolName = (args as any)?.symbol;
        if (!symbolName) return { content: [{ type: 'text', text: 'Missing required parameter: symbol' }] };

        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const sym = ctx.store.getSymbolByName(symbolName);
        if (!sym) {
          // F41: Fuzzy suggestions when symbol not found
          const candidates = ctx.store.getSymbolCandidatesForFuzzy();
          const suggestions = findSimilarSymbols(symbolName, candidates);
          let msg = `Symbol "${symbolName}" not found.`;
          if (suggestions.length > 0) {
            msg += `\n\nDid you mean:\n${suggestions.map(s => `  • ${s.name} (${s.kind} @ ${s.filePath})`).join('\n')}`;
          }
          msg += `\n\nTip: Use mapx_search to find symbols by pattern. Example: { "term": "${symbolName.length > 3 ? symbolName.slice(0, 4) : symbolName}*" }`;
          return { content: [{ type: 'text', text: msg }] };
        }

        const callers = ctx.store.getCallersOfSymbol(symbolName);
        const callees = ctx.store.getCalleesOfSymbol(symbolName);
        const format = ((args as any)?.format || 'text') as string;

        // F43: JSON format
        if (format === 'json') {
          const result: Record<string, any> = {
            name: sym.name,
            kind: sym.kind,
            scope: sym.scope || null,
            file: sym.file_path,
            startLine: sym.start_line,
            endLine: sym.end_line,
            signature: sym.signature || '',
            callerCount: callers.length,
            calleeCount: callees.length,
          };
          if ((args as any)?.source) {
            try {
              const absolutePath = resolve(dir, sym.file_path as string);
              const content = readFileSync(absolutePath, 'utf8');
              const lines = content.split('\n');
              const start = (sym.start_line as number) - 1;
              const end = (sym.end_line as number);
              result.source = lines.slice(start, end).join('\n');
            } catch (err: any) {
              result.sourceError = err.message;
            }
          }
          const warning = getMcpStalenessWarning(ctx.store, dir);
          return { content: [{ type: 'text', text: warning + JSON.stringify(result, null, 2) }] };
        }

        let outputText = `Symbol: ${sym.scope ? `${sym.scope}::` : ''}${sym.name}
Kind:   ${sym.kind}
File:   ${sym.file_path}
Lines:  ${sym.start_line}-${sym.end_line}
Signature: ${sym.signature}
Callers: ${callers.length}
Callees: ${callees.length}`;

        if ((args as any)?.source) {
          try {
            const absolutePath = resolve(dir, sym.file_path as string);
            const content = readFileSync(absolutePath, 'utf8');
            const lines = content.split('\n');
            const start = (sym.start_line as number) - 1;
            const end = (sym.end_line as number);
            const sliced = lines.slice(start, end).join('\n');
            outputText += `\n\nSource Code:\n----------------------------------------\n${sliced}\n----------------------------------------`;
          } catch (err: any) {
            outputText += `\n\nFailed to read source code: ${err.message}`;
          }
        }

        // F44: Related symbols sidebar — saves follow-up calls
        const relatedParts: string[] = [];

        // Top callers (up to 3)
        if (callers.length > 0) {
          const topCallers = callers.slice(0, 3).map((e: any) => {
            const name = e.source_symbol || '<top-level>';
            return `  ← ${name} @ ${e.source_file}`;
          });
          relatedParts.push(`Top callers:\n${topCallers.join('\n')}`);
        }

        // Top callees (up to 3)
        if (callees.length > 0) {
          const topCallees = callees.slice(0, 3).map((e: any) => {
            const name = e.target_symbol || '<unknown>';
            return `  → ${name} @ ${e.target_file}`;
          });
          relatedParts.push(`Top callees:\n${topCallees.join('\n')}`);
        }

        // Siblings in same file (other symbols, up to 5)
        const siblings = ctx.store.getSymbolsForFile(sym.file_path as string)
          .filter((s: any) => s.name !== sym.name)
          .slice(0, 5);
        if (siblings.length > 0) {
          relatedParts.push(`Other symbols in same file:\n${siblings.map((s: any) => `  ${s.kind} ${s.name} (L${s.start_line})`).join('\n')}`);
        }

        if (relatedParts.length > 0) {
          outputText += `\n\n── Related ──\n${relatedParts.join('\n\n')}`;
        }

        const warning = getMcpStalenessWarning(ctx.store, dir);
        return { content: [{ type: 'text', text: warning + outputText }] };
      }

      case 'mapx_files': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const pathPrefix = (args as any)?.path;
        const lang = (args as any)?.lang;
        const results = ctx.store.getFilesFiltered({
          pathPrefix,
          lang,
          sort: (args as any)?.sort,
          limit: (args as any)?.limit,
        });

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No files found matching filters.' }] };
        }

        // F43: Summary header
        let header = `${results.length} file${results.length !== 1 ? 's' : ''}`;
        if (pathPrefix) header += ` under ${pathPrefix}`;
        if (lang) header += ` (${lang})`;
        header += `:\n\n`;

        const outText = results.map(f => `  ${f.path} (${f.language}, ${f.lines} lines, ${f.size_bytes} bytes)`).join('\n');
        const warning = getMcpStalenessWarning(ctx.store, dir);
        return { content: [{ type: 'text', text: warning + header + outText }] };
      }

      case 'mapx_metrics': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const lang = (args as any)?.lang;
        const verifiedOnly = !!(args as any)?.verifiedOnly;

        const metrics = calculateMetrics(ctx.store, {
          repo: ctx.config.repo.name,
          language: lang,
          verifiedOnly,
        });

        if (metrics.length === 0) {
          return { content: [{ type: 'text', text: 'No metrics found.' }] };
        }

        const lines = [
          '── Coupling & Instability Metrics ─────────────────────',
          `${'File Path'.padEnd(45)} | ${'Lang'.padEnd(10)} | ${'Ca'.padStart(4)} | ${'Ce'.padStart(4)} | ${'Instability'.padStart(11)}`,
          '-'.repeat(85),
        ];

        for (const m of metrics) {
          const pathTrunc = m.path.length > 45 ? '...' + m.path.substring(m.path.length - 42) : m.path;
          lines.push(`${pathTrunc.padEnd(45)} | ${m.language.padEnd(10)} | ${String(m.afferent).padStart(4)} | ${String(m.efferent).padStart(4)} | ${m.instability.toFixed(4).padStart(11)}`);
        }

        const warning = getMcpStalenessWarning(ctx.store, dir);
        return {
          content: [{
            type: 'text',
            text: warning + lines.join('\n'),
          }],
        };
      }

      case 'mapx_edges': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const type = (args as any)?.type;
        const from = (args as any)?.from;
        const to = (args as any)?.to;

        const edges = ctx.store.queryEdges({
          repo: ctx.config.repo.name,
          type,
          from,
          to,
        });

        if (edges.length === 0) {
          return { content: [{ type: 'text', text: 'No matching edges found.' }] };
        }

        const lines = [`Found ${edges.length} matching edges:`];
        for (const e of edges) {
          const srcSym = e.source_symbol ? `#${e.source_symbol}` : '';
          const tgtSym = e.target_symbol ? `#${e.target_symbol}` : '';
          const infSuffix = e.verifiability === 'inferred' ? ' [inferred]' : '';
          lines.push(`- ${e.source_file}${srcSym} → ${e.target_file}${tgtSym} (${e.edge_type})${infSuffix}`);
        }

        const warning = getMcpStalenessWarning(ctx.store, dir);
        return {
          content: [{
            type: 'text',
            text: warning + lines.join('\n'),
          }],
        };
      }

      case 'mapx_clusters': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const source = (args as any)?.source || 'all';
        const clusterQuery = (args as any)?.cluster;

        const clusters = ctx.store.getClusters(ctx.config.repo.name);

        let filtered = clusters;
        if (source && source !== 'all') {
          filtered = clusters.filter((c: any) => c.source === source);
        }

        if (clusterQuery) {
          const targetCluster = clusters.find((c: any) => c.name === clusterQuery);
          if (!targetCluster) {
            return { content: [{ type: 'text', text: `Cluster "${clusterQuery}" not found.` }] };
          }

          const files = ctx.store.getClusterFiles(targetCluster.name as string, ctx.config.repo.name);
          const clusterEdges = ctx.store.getClusterEdges(targetCluster.name as string, ctx.config.repo.name);

          const lines = [];
          lines.push(`${targetCluster.name}  [${targetCluster.source}]  ${targetCluster.file_count} files`);
          for (const f of files) {
            lines.push(`  ${f}`);
          }

          const dependsOn = clusterEdges.filter(e => e.sourceCluster === targetCluster.name);
          lines.push('\nDepends on:');
          if (dependsOn.length === 0) {
            lines.push('  (none)');
          } else {
            for (const dep of dependsOn) {
              lines.push(`  ${dep.targetCluster.padEnd(25)} [${dep.edgeCount} edges — dominant: ${dep.dominantType}]`);
            }
          }

          const dependedOnBy = clusterEdges.filter(e => e.targetCluster === targetCluster.name);
          lines.push('\nDepended on by:');
          if (dependedOnBy.length === 0) {
            lines.push('  (none)');
          } else {
            for (const dep of dependedOnBy) {
              lines.push(`  ${dep.sourceCluster.padEnd(25)} [${dep.edgeCount} edges — dominant: ${dep.dominantType}]`);
            }
          }

          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const roots: any[] = [];
        const childrenMap = new Map<string, any[]>();
        
        for (const c of filtered) {
          if (!c.parent_name) {
            roots.push(c);
          } else {
            const parentName = c.parent_name as string;
            if (!childrenMap.has(parentName)) {
              childrenMap.set(parentName, []);
            }
            childrenMap.get(parentName)!.push(c);
          }
        }

        for (const list of childrenMap.values()) {
          list.sort((a, b) => a.name.localeCompare(b.name));
        }
        roots.sort((a, b) => a.name.localeCompare(b.name));

        const lines: string[] = [];
        const printTree = (node: any, indent: number) => {
          const padding = '  '.repeat(indent);
          const namePart = node.name;
          const sourcePart = `(${node.source})`;
          const filesPart = `[${node.file_count} files]`;
          
          const formatted = `${padding}${namePart.padEnd(35 - indent * 2)}${sourcePart.padEnd(15)} ${filesPart}`;
          lines.push(formatted);

          const children = childrenMap.get(node.name) || [];
          for (const child of children) {
            printTree(child, indent + 1);
          }
        };

        for (const root of roots) {
          printTree(root, 0);
        }

        const nsCount = filtered.filter((c: any) => c.source === 'namespace').length;
        const dirCount = filtered.filter((c: any) => c.source === 'directory').length;
        const commCount = filtered.filter((c: any) => c.source === 'community').length;
        lines.push(`\n${filtered.length} clusters detected (${nsCount} namespace, ${dirCount} directory, ${commCount} community)`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'mapx_trace': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const start = (args as any)?.start;
        const direction = (args as any)?.direction || 'both';
        const depth = (args as any)?.depth || 3;
        const format = (args as any)?.format || 'text';
        const includeStructural = (args as any)?.include_structural || false;

        if (!start) {
          return { content: [{ type: 'text', text: 'Error: "start" argument is required.' }] };
        }

        const tracer = new FlowTracer(ctx.store);
        const result = tracer.trace({
          startSymbol: start,
          direction: direction as any,
          maxDepth: depth,
          includeStructural,
          repo: ctx.config.repo.name,
        });

        if (format === 'json') {
          const jsonOutput = {
            start: result.start,
            direction: result.direction,
            maxDepth: depth,
            nodeCount: result.nodeCount,
            edgeCount: result.edgeCount,
            maxDepthReached: result.maxDepthReached,
            sources: result.sources.map(s => ({ file: s.file, symbol: s.symbol })),
            sinks: result.sinks.map(s => ({ file: s.file, symbol: s.symbol })),
            cycles: result.cycles,
            nodes: Array.from(new Map(result.paths.flatMap(p => p.nodes).map(n => [`${n.file}::${n.symbol || ''}`, n])).values()).map(n => ({
              file: n.file,
              symbol: n.symbol,
              depth: n.depth,
              incomingEdgeType: n.incomingEdgeType,
            })),
            edges: Array.from(new Set(result.paths.flatMap(p => {
              const arr = [];
              for (let i = 1; i < p.nodes.length; i++) {
                arr.push(JSON.stringify({
                  from: p.nodes[i - 1].file,
                  to: p.nodes[i].file,
                  edgeType: p.nodes[i].incomingEdgeType,
                  fromSymbol: p.nodes[i - 1].symbol,
                  toSymbol: p.nodes[i].symbol,
                }));
              }
              return arr;
            }))).map(s => JSON.parse(s)),
          };
          return { content: [{ type: 'text', text: JSON.stringify(jsonOutput, null, 2) }] };
        }

        if (format === 'dot') {
          const lines: string[] = [];
          const safeStartName = (result.start.symbol || result.start.file).replace(/[^a-zA-Z0-9]/g, '_');
          lines.push(`digraph Trace_${safeStartName} {`);
          lines.push('  rankdir=TB;');
          lines.push(`  label="Trace: ${result.start.symbol || result.start.file} (${result.direction}stream, depth≤${depth})";`);
          lines.push('  fontsize=12;');
          lines.push('  node [shape=box, style=filled, fontsize=10];');
          lines.push('');

          const uniqueNodes = new Map<string, { file: string; symbol: string | null; shape: string; color: string }>();
          const edgesSet = new Set<string>();

          for (const p of result.paths) {
            for (let i = 0; i < p.nodes.length; i++) {
              const n = p.nodes[i];
              const key = `${n.file}::${n.symbol || ''}`;
              if (!uniqueNodes.has(key)) {
                let shape = 'box';
                let color = '#E8F4FD';

                const isStart = n.file === result.start.file && n.symbol === result.start.symbol;
                const isSink = result.sinks.some(s => s.file === n.file && s.symbol === n.symbol);
                const isSource = result.sources.some(s => s.file === n.file && s.symbol === n.symbol);

                if (isStart) {
                  shape = 'diamond';
                  color = '#FFE0B2';
                } else if (isSink) {
                  shape = 'octagon';
                  color = '#FFEBEE';
                } else if (isSource) {
                  shape = 'ellipse';
                  color = '#E8F5E9';
                }

                uniqueNodes.set(key, { file: n.file, symbol: n.symbol, shape, color });
              }

              if (i > 0) {
                const fromNode = p.nodes[i - 1];
                const toNode = p.nodes[i];
                edgesSet.add(JSON.stringify({
                  from: `${fromNode.file}::${fromNode.symbol || ''}`,
                  to: `${toNode.file}::${toNode.symbol || ''}`,
                  type: toNode.incomingEdgeType,
                }));
              }
            }
          }

          for (const [key, n] of uniqueNodes.entries()) {
            const label = n.symbol || n.file.split('/').pop() || n.file;
            lines.push(`  "${key}" [label="${label}", fillcolor="${n.color}", shape=${n.shape}];`);
          }

          lines.push('');

          for (const edgeStr of edgesSet) {
            const e = JSON.parse(edgeStr);
            lines.push(`  "${e.from}" -> "${e.to}" [label="${e.type}"];`);
          }

          lines.push('}');
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const dirSymbol = result.direction === 'down' ? '↓ downstream' : result.direction === 'up' ? '↑ upstream' : '↕ bidirectional';
        const lines = [`Trace: ${start}  ${dirSymbol}  depth≤${depth}`];
        lines.push('─'.repeat(53));
        lines.push('');

        const printNode = (node: TraceNode, indentLevel: number) => {
          const indent = '  '.repeat(indentLevel);
          const prefix = indentLevel === 0 ? '' : `└─[${node.incomingEdgeType}]─→  `;
          const displayName = node.symbol || node.file;
          const filePart = node.symbol ? `  (${node.file})` : '';

          const isSink = result.sinks.some(s => s.file === node.file && s.symbol === node.symbol);
          const sinkStr = isSink ? '  ⊗ sink' : '';

          const cycle = result.cycles.find(c => c.fromFile === node.file && c.fromSymbol === node.symbol);
          const cycleStr = cycle ? '  ↻ cycle' : '';

          lines.push(`${indent}${prefix}${displayName}${filePart}${sinkStr}${cycleStr}`);

          if (!cycle) {
            const children: TraceNode[] = [];
            const seenChildKeys = new Set<string>();
            for (const path of result.paths) {
              const idx = path.nodes.findIndex(n => n.file === node.file && n.symbol === node.symbol && n.depth === node.depth);
              if (idx !== -1 && idx + 1 < path.nodes.length) {
                const nextNode = path.nodes[idx + 1];
                const key = `${nextNode.file}::${nextNode.symbol || ''}::${nextNode.depth}`;
                if (!seenChildKeys.has(key)) {
                  seenChildKeys.add(key);
                  children.push(nextNode);
                }
              }
            }

            for (const child of children) {
              printNode(child, indentLevel + 1);
            }
          }
        };

        const startNode: TraceNode = {
          file: result.start.file,
          symbol: result.start.symbol,
          depth: 0,
          incomingEdgeType: 'start',
        };
        printNode(startNode, 0);

        lines.push('');
        const cyclesStr = result.cycles.length > 0 ? `   Cycles: ${result.cycles.length}` : '';
        lines.push(`Nodes: ${result.nodeCount}   Edges: ${result.edgeCount}   Max depth: ${depth}${cyclesStr}`);
        if (result.sinks.length > 0) {
          const sinkNames = result.sinks.map(s => s.symbol || s.file.split('/').pop() || s.file);
          lines.push(`Sinks: ${sinkNames.join(', ')}`);
        }

        if (format === 'text') {
          const warning = getMcpStalenessWarning(ctx.store, dir);
          return { content: [{ type: 'text', text: warning + lines.join('\n') }] };
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'mapx_sources': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const tracer = new FlowTracer(ctx.store);
        const sources = tracer.findSources(ctx.config.repo.name);
        const lines = [`Entry points (data sources) — ${sources.length} found:`];
        for (const s of sources) {
          let extra = '[no incoming data edges]';
          if (s.file.includes('routes/')) {
            const routes = ctx.store.getEdgesForFile(s.file).filter(e => e.edge_type === 'route');
            extra = `[route file — ${routes.length} controller endpoints]`;
          } else if (s.file.includes('app/Jobs/')) {
            extra = '[dispatched externally — queue worker]';
          } else if (s.file.includes('app/Listeners/')) {
            extra = '[event listener — external trigger]';
          } else if (s.file.includes('app/Http/Middleware/')) {
            extra = '[middleware — filter chain entry]';
          }
          lines.push(`  ${s.file.padEnd(40)} ${extra}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'mapx_sinks': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const tracer = new FlowTracer(ctx.store);
        const sinks = tracer.findSinks(ctx.config.repo.name);
        const lines = [`Terminal consumers (data sinks) — ${sinks.length} found:`];
        for (const s of sinks) {
          const inEdges = ctx.store.getReverseEdges(s.file).filter(e => [
            'call', 'instantiation', 'param_type', 'return_type', 'relation', 'dispatch', 'notify', 'route', 'render'
          ].includes(e.edge_type as string));
          let extra = `[terminal — no outgoing data edges]`;
          if (s.file.includes('DatabaseManager') || s.file.includes('database')) {
            extra = `[DB facade → raw SQL — ${inEdges.length} in-edges]`;
          } else if (s.file.includes('CacheManager') || s.file.includes('cache')) {
            extra = `[Cache facade → Redis/Memcache — ${inEdges.length} in-edges]`;
          } else if (s.file.includes('Mailer') || s.file.includes('mail')) {
            extra = `[Mail facade → SMTP — ${inEdges.length} in-edges]`;
          } else if (s.file.includes('QueueManager') || s.file.includes('queue')) {
            extra = `[Queue::push — ${inEdges.length} in-edges]`;
          }
          lines.push(`  ${s.file.padEnd(40)} ${extra}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'mapx_agents_generate': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;

        const generator = new AgentGenerator();
        const available = generator.listProviders();
        let targetProviders: string[] = [];

        const requestArgs = args as any || {};
        if (requestArgs.all) {
          targetProviders = available;
        } else if (requestArgs.providers && Array.isArray(requestArgs.providers)) {
          targetProviders = requestArgs.providers.filter((p: string) => available.includes(p));
        } else {
          // Default to generic
          targetProviders = ['generic'];
        }

        if (targetProviders.length === 0) {
          return { content: [{ type: 'text', text: 'No valid providers specified.' }] };
        }

        const actions = generator.plan(targetProviders, { dir });
        const results: string[] = [];

        for (const action of actions) {
          if (action.status === 'up_to_date') {
            results.push(`${action.filename}: Up to date.`);
          } else {
            generator.execute(action);
            results.push(`${action.filename}: Successfully generated/updated (${action.status}).`);
          }
        }

        return { content: [{ type: 'text', text: results.join('\n') }] };
      }

      case 'mapx_routes': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;

        const routeRegistry = new RouteRegistry();
        await routeRegistry.load(dir);

        const routes = routeRegistry.queryRoutes({
          framework: (args as any)?.framework,
          method: (args as any)?.method,
          path: (args as any)?.pathPattern,
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(routes, null, 2),
          }],
        };
      }

      case 'mapx_hooks': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;

        const routeRegistry = new RouteRegistry();
        await routeRegistry.load(dir);

        const hooks = routeRegistry.queryHooks({
          framework: (args as any)?.framework,
          hookType: (args as any)?.type,
          hookName: (args as any)?.namePattern,
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(hooks, null, 2),
          }],
        };
      }

      case 'mapx_lang_list': {
        const langs = getBuiltinLanguages();
        const listStr = Object.entries(langs)
          .map(([name, def]) => {
            const installed = isLanguageInstalled(name) ? 'Installed' : 'Not Installed';
            return `- ${name} (${def.extensions.join(', ')} | tier: ${def.tier} | status: ${installed})`;
          })
          .join('\n');
        return { content: [{ type: 'text', text: `Supported languages:\n${listStr}` }] };
      }

      case 'mapx_lang_install': {
        const { lang } = args as { lang: string };
        if (!lang) {
          return { content: [{ type: 'text', text: 'Error: Missing "lang" parameter.' }] };
        }
        try {
          await installLanguage(lang);
          return { content: [{ type: 'text', text: `Successfully installed language '${lang}'.` }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error installing language '${lang}': ${err.message}` }] };
        }
      }

      case 'mapx_lang_uninstall': {
        const { lang } = args as { lang: string };
        if (!lang) {
          return { content: [{ type: 'text', text: 'Error: Missing "lang" parameter.' }] };
        }
        try {
          await uninstallLanguage(lang);
          return { content: [{ type: 'text', text: `Successfully uninstalled language '${lang}'.` }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Error uninstalling language '${lang}': ${err.message}` }] };
        }
      }

      case 'mapx_workspaces': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const action = (args as any)?.action || 'list';
        const registeredPaths = new Set<string>();
        for (const r of ctx.config.repos) {
          registeredPaths.add(resolve(dir, r.path));
        }

        // Discover unregistered repos
        const submodules = WorkspaceManager.discoverSubmodules(dir);
        const peers = WorkspaceManager.discoverPeerRepos(dir);
        const { readdirSync } = await import('node:fs');
        const wsFiles = readdirSync(dir).filter((f: string) => f.endsWith('.code-workspace'));
        const { join: pathJoin } = await import('node:path');
        const vscodeFolders: Array<{ name: string; path: string; source: string; isInitialized: boolean }> = [];
        for (const f of wsFiles) {
          const wsFolderRepos = WorkspaceManager.discoverVSCodeWorkspace(pathJoin(dir, f), dir);
          for (const p of wsFolderRepos) {
            if (!registeredPaths.has(resolve(dir, p.path))) {
              vscodeFolders.push({ name: p.name, path: p.path, source: 'vscode-workspace', isInitialized: p.isInitialized });
            }
          }
        }

        const discovered: Array<{ name: string; path: string; source: string; isInitialized: boolean }> = [];
        for (const s of submodules) {
          if (!registeredPaths.has(resolve(dir, s.path))) {
            discovered.push({ name: s.name, path: s.path, source: 'submodule', isInitialized: s.isInitialized });
          }
        }
        for (const p of peers) {
          if (!registeredPaths.has(resolve(dir, p.path))) {
            discovered.push({ name: p.name, path: p.path, source: 'peer', isInitialized: p.isInitialized });
          }
        }
        discovered.push(...vscodeFolders);

        if (action === 'discover') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ discovered }, null, 2),
            }],
          };
        }

        // "list" action — registered repos with stats
        const repos: Array<Record<string, unknown>> = [];
        for (const r of ctx.config.repos) {
          const fileCount = ctx.store.getFileCount(r.name);
          const symbolCount = ctx.store.getSymbolCount(r.name);
          const edgeCount = ctx.store.getEdgeCount(r.name);
          const crossRepoEdges = ctx.store.raw.prepare(
            `SELECT COUNT(*) as cnt FROM edges WHERE repo = ? AND target_repo IS NOT NULL AND target_repo != ?`
          ).get(r.name, r.name) as any;
          const lastScanned = ctx.store.getMeta('last_scan_time:' + r.name) || ctx.store.getMeta('last_scan_time') || null;
          repos.push({
            name: r.name,
            path: r.path,
            type: ctx.config.repo.name === r.name ? 'primary' : 'peer',
            fileCount,
            symbolCount,
            edgeCount,
            crossRepoEdgeCount: crossRepoEdges?.cnt || 0,
            lastScanned,
          });
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ repos, discovered }, null, 2),
          }],
        };
      }

      case 'mapx_batch': {
        const resolved = resolveOrFail(args || {});
        if ('error' in resolved) return { content: [{ type: 'text', text: resolved.error }] };
        const dir = resolved.dir;
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const operations = (args as any)?.operations;
        if (!operations || !Array.isArray(operations) || operations.length === 0) {
          return { content: [{ type: 'text', text: 'Missing or empty "operations" array.' }] };
        }

        const maxItems = (args as any)?.maxItems ?? 10;
        if (operations.length > maxItems) {
          return { content: [{ type: 'text', text: `Too many operations: ${operations.length}. Maximum is ${maxItems}. Set maxItems to increase.` }] };
        }

        const sections: string[] = [];
        const warning = getMcpStalenessWarning(ctx.store, dir);

        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          const opLabel = `── Operation ${i + 1}: ${op.op} ──`;

          try {
            switch (op.op) {
              case 'search': {
                const results = ctx.store.searchSymbolsFiltered({
                  term: op.term || '*',
                  kind: op.kind,
                  filePrefix: op.file,
                  exact: !!op.exact,
                  limit: op.limit,
                });
                if (results.length === 0) {
                  sections.push(`${opLabel}\nNo symbols matching "${op.term || '*'}"`);
                } else {
                  const lines = results.map((sym: any) =>
                    `  ${sym.kind} ${sym.scope ? `${sym.scope}::` : ''}${sym.name} @ ${sym.file_path}:${sym.start_line}`
                  );
                  sections.push(`${opLabel}\nFound ${results.length} symbol${results.length !== 1 ? 's' : ''}:\n${lines.join('\n')}`);
                }
                break;
              }
              case 'node': {
                const sym = ctx.store.getSymbolByName(op.symbol);
                if (!sym) {
                  sections.push(`${opLabel}\nSymbol "${op.symbol}" not found.`);
                } else {
                  let text = `${opLabel}\n${sym.kind} ${sym.scope ? `${sym.scope}::` : ''}${sym.name}\n  @ ${sym.file_path}:${sym.start_line}-${sym.end_line}\n  signature: ${sym.signature}`;
                  if (op.source) {
                    try {
                      const absolutePath = resolve(dir, sym.file_path as string);
                      const content = readFileSync(absolutePath, 'utf8');
                      const srcLines = content.split('\n');
                      const start = (sym.start_line as number) - 1;
                      const end = (sym.end_line as number);
                      text += `\n\n${srcLines.slice(start, end).join('\n')}`;
                    } catch { /* skip source on error */ }
                  }
                  sections.push(text);
                }
                break;
              }
              case 'callers': {
                const callerEdges = ctx.store.getCallersOfSymbol(op.symbol);
                if (callerEdges.length === 0) {
                  sections.push(`${opLabel}\nNo callers found for "${op.symbol}"`);
                } else {
                  const lines = callerEdges.map((e: any) =>
                    `  ← ${e.source_symbol || '<top-level>'} @ ${e.source_file}`
                  );
                  sections.push(`${opLabel}\n${callerEdges.length} caller(s) of "${op.symbol}":\n${lines.join('\n')}`);
                }
                break;
              }
              case 'callees': {
                const calleeEdges = ctx.store.getCalleesOfSymbol(op.symbol);
                if (calleeEdges.length === 0) {
                  sections.push(`${opLabel}\nNo callees found for "${op.symbol}"`);
                } else {
                  const lines = calleeEdges.map((e: any) =>
                    `  → ${e.target_symbol || '<unknown>'} @ ${e.target_file}`
                  );
                  sections.push(`${opLabel}\n${calleeEdges.length} callee(s) of "${op.symbol}":\n${lines.join('\n')}`);
                }
                break;
              }
              case 'deps': {
                const deps = ctx.graph.getDependencies(op.file);
                const rdeps = ctx.graph.getReverseDependencies(op.file);
                const parts: string[] = [`${opLabel}`];
                if (deps.length > 0) {
                  parts.push(`Dependencies (${deps.length}):`);
                  for (const d of deps) parts.push(`  → ${d.target} (${d.type})`);
                }
                if (rdeps.length > 0) {
                  parts.push(`Depended on by (${rdeps.length}):`);
                  for (const r of rdeps) parts.push(`  ← ${r.source} (${r.type})`);
                }
                if (deps.length === 0 && rdeps.length === 0) {
                  parts.push(`No dependencies found for "${op.file}"`);
                }
                sections.push(parts.join('\n'));
                break;
              }
              default:
                sections.push(`${opLabel}\nUnknown operation: "${op.op}". Supported: search, node, callers, callees, deps`);
            }
          } catch (err: any) {
            sections.push(`${opLabel}\nError: ${err.message}`);
          }
        }

        return { content: [{ type: 'text', text: warning + sections.join('\n\n') }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    } finally {
      try { activeStore?.close(); } catch { /* already closed */ }
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startTime = Date.now();
    if (options?.debug) {
      process.stderr.write(`[mapx debug] Received tool call: ${request.params.name} with arguments: ${JSON.stringify(request.params.arguments || {})}\n`);
    }
    let result: any;
    let error: any;
    try {
      result = await executeTool(request);
      return result;
    } catch (e: any) {
      error = e;
      throw e;
    } finally {
      let isSuccess = !error;
      let errorMsg = error?.message;
      if (result && Array.isArray(result.content)) {
        const textContent = result.content.find((c: any) => c.type === 'text')?.text;
        if (textContent && (textContent.startsWith('Error') || textContent.includes('failed'))) {
          isSuccess = false;
          errorMsg = textContent;
        }
      }
      const durationMs = Date.now() - startTime;
      if (options?.debug) {
        process.stderr.write(`[mapx debug] Completed tool call: ${request.params.name} in ${durationMs}ms (success: ${isSuccess})${errorMsg ? `, error: ${errorMsg}` : ''}\n`);
      }
      const eventBus = UiEventBus.getInstance();
      eventBus.emitToolCall({
        tool: request.params.name,
        input: request.params.arguments || {},
        timestamp: new Date().toISOString(),
        durationMs,
        success: isSuccess,
        error: errorMsg
      });
    }
  });

  return server;
}

function generateConfigs(dir: string, transport: 'stdio' | 'sse', port?: number): string {
  const binPath = resolve(dir, 'node_modules', '.bin', 'mapx');
  const hasBin = existsSync(binPath);
  const cmd = hasBin ? 'mapx' : `npx tsx ${resolve(dir, 'src', 'main.ts')}`;

  const lines: string[] = [
    '',
    '  Mapx MCP server ready.',
    '',
  ];

  if (transport === 'sse' && port) {
    lines.push(
      `  Transport:    SSE (HTTP)`,
      `  URL:          http://localhost:${port}/sse`,
      `  Messages:     POST http://localhost:${port}/messages?sessionId=<id>`,
      `  Project dir:  ${dir}`,
      '',
      '  Claude Desktop (claude_desktop_config.json):',
      '  ```json',
      '  {',
      '    "mcpServers": {',
      '      "mapx": {',
      `        "url": "http://localhost:${port}/sse"`,
      '      }',
      '    }',
      '  }',
      '  ```',
      '',
      '  Cursor / VS Code (.cursor/mcp.json or settings.json):',
      '  ```json',
      '  {',
      '    "mcp": {',
      '      "servers": {',
      '        "mapx": {',
      `          "url": "http://localhost:${port}/sse"`,
      '        }',
      '      }',
      '    }',
      '  }',
      '  ```',
    );
  } else {
    lines.push(
      `  Transport:    stdio`,
      `  Project dir:  ${dir}`,
      '',
      '  Claude Desktop (claude_desktop_config.json):',
      '  ```json',
      '  {',
      '    "mcpServers": {',
      '      "mapx": {',
      `        "command": "${cmd}",`,
      `        "args": ["serve", "--dir", "${dir}"]`,
      '      }',
      '    }',
      '  }',
      '  ```',
      '',
      '  Cursor / VS Code (.cursor/mcp.json or settings.json):',
      '  ```json',
      '  {',
      '    "mcp": {',
      '      "servers": {',
      '        "mapx": {',
      `          "command": "${cmd}",`,
      `          "args": ["serve", "--dir", "${dir}"]`,
      '        }',
      '      }',
      '    }',
      '  }',
      '  ```',
    );
  }

  lines.push(
    '',
    '  Available tools: mapx_scan, mapx_sync, mapx_query, mapx_dependencies, mapx_export, mapx_status, mapx_metrics, mapx_edges,',
    '                    mapx_clusters, mapx_trace, mapx_sources, mapx_sinks, mapx_search, mapx_context, mapx_callers, mapx_callees,',
    '                    mapx_impact, mapx_node, mapx_files, mapx_routes, mapx_hooks, mapx_workspaces, mapx_agents_generate,',
    '                    mapx_lang_list, mapx_lang_install, mapx_lang_uninstall',
    '',
  );

  return lines.join('\n');
}

export async function startMcpServer(dir?: string, options?: ServeOptions): Promise<void> {
  if (dir) {
    defaultDir = resolve(dir);
  } else {
    // Fall back to cwd only if it is an initialized mapx project; otherwise
    // leave defaultDir as null so tool calls without an explicit "dir" fail clearly
    // instead of silently operating on the wrong database.
    const cwd = process.cwd();
    if (existsSync(resolve(cwd, '.mapx', 'config.json'))) {
      defaultDir = cwd;
    }
    // defaultDir stays null when cwd is not an initialized project
  }

  if (defaultDir) {
    process.stderr.write(`[mapx] Default project directory: ${defaultDir}\n`);
    // Enable cross-process tool call logging for the UI dashboard
    UiEventBus.getInstance().setMapxDir(defaultDir);
  } else {
    process.stderr.write(`[mapx] No default project directory set. Pass --dir /path/to/project or include "dir" in each tool call.\n`);
  }
  if (options?.sse) {
    const port = options.port || 3000;
    const transports: Map<string, SSEServerTransport> = new Map();

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);

      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        transports.set(transport.sessionId, transport);

        const server = buildServer(options);
        await server.connect(transport);

        res.on('close', () => {
          transports.delete(transport.sessionId);
        });

        return;
      }

      if (req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing sessionId parameter' }));
          return;
        }

        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found. Connect via GET /sse first.' }));
          return;
        }

        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(port, () => resolve());
    });

    console.error(generateConfigs(defaultDir!, 'sse', port));
  } else {
    const server = buildServer(options);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(generateConfigs(defaultDir!, 'stdio'));
  }
}

export function getStaleFilesCount(store: Store, dir: string): number {
  try {
    const files = store.getAllFiles();
    let changedCount = 0;
    for (const file of files) {
      const absPath = resolve(dir, file.path as string);
      if (existsSync(absPath)) {
        const stats = statSync(absPath);
        const dbTime = new Date(file.last_scanned as string).getTime();
        if (stats.mtimeMs > dbTime) {
          changedCount++;
        }
      } else {
        changedCount++;
      }
    }
    return changedCount;
  } catch {
    return 0;
  }
}

/**
 * Get names of stale files (up to a limit).
 * Used for F44 enhanced staleness warnings.
 */
export function getStaleFileNames(store: Store, dir: string, maxFiles: number = 5): string[] {
  try {
    const files = store.getAllFiles();
    const changed: string[] = [];
    for (const file of files) {
      if (changed.length >= maxFiles) break;
      const absPath = resolve(dir, file.path as string);
      if (existsSync(absPath)) {
        const stats = statSync(absPath);
        const dbTime = new Date(file.last_scanned as string).getTime();
        if (stats.mtimeMs > dbTime) {
          changed.push(file.path as string);
        }
      } else {
        changed.push(`${file.path} (deleted)`);
      }
    }
    return changed;
  } catch {
    return [];
  }
}

export function getMcpStalenessWarning(store: Store, dir: string): string {
  const staleCount = getStaleFilesCount(store, dir);
  if (staleCount > 0) {
    const staleFiles = getStaleFileNames(store, dir);
    const fileList = staleFiles.length > 0
      ? `\nChanged: ${staleFiles.join(', ')}${staleCount > staleFiles.length ? ` (and ${staleCount - staleFiles.length} more)` : ''}`
      : '';
    return `⚠️  Index is stale (${staleCount} file${staleCount !== 1 ? 's' : ''} changed since last scan). Run mapx_sync to update.${fileList}\n\n`;
  }
  return '';
}

export function checkTryCatch(content: string, lineNum: number, startLine: number, isPython: boolean): boolean {
  return coreCheckTryCatch(content, lineNum, startLine, isPython);
}

