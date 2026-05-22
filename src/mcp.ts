import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './core/store.js';
import { MapxGraph } from './core/graph.js';
import { Scanner, buildMatcher } from './core/scanner.js';
import { Config } from './core/config.js';
import { LLMExporter } from './exporters/llm-exporter.js';
import { GraphExporter } from './exporters/graph-exporter.js';
import { DotExporter } from './exporters/dot-exporter.js';
import { SvgExporter } from './exporters/svg-exporter.js';
import { calculateMetrics } from './core/metrics.js';

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
}

export function buildServer(): Server {
  const server = new Server(
    { name: 'mapx', version: '0.1.3' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'mapx_scan',
        description: 'Scan the codebase and build/update the code graph. Run this when you need to understand project structure or after files have changed.',
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
        name: 'mapx_query',
        description: 'Search for symbols (classes, functions, methods) by name pattern. Returns definitions with file locations and signatures.',
        inputSchema: {
          type: 'object',
          properties: {
            term: { type: 'string', description: 'Symbol name or pattern to search for' },
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
        description: 'Export a compact, token-efficient summary of the code graph. Use this at the start of a session to quickly understand the codebase structure.',
        inputSchema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['llm', 'json', 'dot', 'svg'], description: 'Output format', default: 'llm' },
            tokens: { type: 'number', description: 'Token budget for LLM format', default: 8192 },
            repo: { type: 'string', description: 'Filter by repo name' },
            exclude: { type: 'string', description: 'Comma-separated list of exclude glob patterns to append' },
            include: { type: 'string', description: 'Comma-separated list of include glob patterns to append' },
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Each tool call opens a fresh Store; track it so we can close it when done.
    let activeStore: Store | undefined;
    const resolveOrFail = (a: Record<string, unknown>): { dir: string } | { error: string } => {
      const dir = resolveDir(a);
      if (!dir) return { error: 'No project directory set. Either pass a "dir" argument or start the server with --dir /path/to/project.' };
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
        const exclude = excludeStr ? excludeStr.split(',').map((s: string) => s.trim()) : [];
        const include = includeStr ? includeStr.split(',').map((s: string) => s.trim()) : [];

        try {
          const scanner = new Scanner(ctx.store, ctx.config, ctx.graph, undefined, { excludes: exclude, includes: include });
          const result = await scanner.scanFull();
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
          return { content: [{ type: 'text', text: `No symbols matching "${term}" in ${dir}` }] };
        }

        const lines = results.map(sym => {
          const scope = sym.scope ? `${sym.scope}::` : '';
          return `${sym.kind} ${scope}${sym.name}\n  @ ${sym.file_path}:${sym.start_line}${sym.signature && sym.signature !== sym.name ? `\n  signature: ${sym.signature}` : ''}`;
        });

        return { content: [{ type: 'text', text: lines.join('\n\n') }] };
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

        return { content: [{ type: 'text', text: parts.join('\n') }] };
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

        if (format === 'json') {
          const exporter = new GraphExporter(ctx.store, ctx.graph);
          return { content: [{ type: 'text', text: exporter.exportAsJSONString(repo, filteredFiles) }] };
        }

        if (format === 'dot') {
          const exporter = new DotExporter(ctx.store, ctx.graph);
          return { content: [{ type: 'text', text: exporter.export(repo, filteredFiles) }] };
        }

        if (format === 'svg') {
          const exporter = new SvgExporter(ctx.store, ctx.graph);
          return { content: [{ type: 'text', text: exporter.export(repo, filteredFiles) }] };
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

        const lastScan = ctx.store.getMeta('last_scan_time');
        const lastCommit = ctx.store.getMeta('last_scan_commit');
        const fileCount = ctx.store.getFileCount();
        const symbolCount = ctx.store.getSymbolCount();
        const edgeCount = ctx.store.getEdgeCount();
        const verifiedEdgeCount = (ctx.store.raw.prepare("SELECT COUNT(*) as cnt FROM edges WHERE verifiability = 'verified'").get() as any)?.cnt || 0;
        const inferredEdgeCount = (ctx.store.raw.prepare("SELECT COUNT(*) as cnt FROM edges WHERE verifiability = 'inferred'").get() as any)?.cnt || 0;

        const excludeStr = (args as any)?.exclude;
        const includeStr = (args as any)?.include;
        const exclude = excludeStr ? excludeStr.split(',').map((s: string) => s.trim()) : [];
        const include = includeStr ? includeStr.split(',').map((s: string) => s.trim()) : [];

        const activeExcludes = [...(ctx.config.settings.excludePatterns ?? []), ...exclude];
        const activeIncludes = [...(ctx.config.settings.includePatterns ?? []), ...include];

        return {
          content: [{
            type: 'text',
            text: `Directory: ${dir}\nLast scan: ${lastScan || 'never'}\nLast commit: ${lastCommit || 'none'}\nFiles: ${fileCount} | Symbols: ${symbolCount} | Edges: ${edgeCount} (verified: ${verifiedEdgeCount}, inferred: ${inferredEdgeCount})\nExcludes: [${activeExcludes.join(', ')}]\nIncludes: [${activeIncludes.join(', ')}]`,
          }],
        };
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

        return {
          content: [{
            type: 'text',
            text: lines.join('\n'),
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

        return {
          content: [{
            type: 'text',
            text: lines.join('\n'),
          }],
        };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    } finally {
      try { activeStore?.close(); } catch { /* already closed */ }
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
    '  Available tools: mapx_scan, mapx_query, mapx_dependencies, mapx_export, mapx_status, mapx_metrics, mapx_edges',
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

        const server = buildServer();
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
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(generateConfigs(defaultDir!, 'stdio'));
  }
}
