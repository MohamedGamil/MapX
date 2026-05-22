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
import { CodeGraph } from './core/graph.js';
import { Scanner } from './core/scanner.js';
import { Config } from './core/config.js';
import { LLMExporter } from './exporters/llm-exporter.js';
import { GraphExporter } from './exporters/graph-exporter.js';
import { DotExporter } from './exporters/dot-exporter.js';
import { SvgExporter } from './exporters/svg-exporter.js';

let defaultDir = process.cwd();

const DirSchema = z.object({
  dir: z.string().optional(),
});

function resolveDir(args: Record<string, unknown>): string {
  const parsed = DirSchema.parse(args);
  return parsed.dir ? resolve(parsed.dir) : defaultDir;
}

async function loadContext(dir: string) {
  const configPath = resolve(dir, '.codegraph', 'config.json');
  if (!existsSync(configPath)) {
    return { error: `CodeGraph not initialized in ${dir}. Run \`codegraph init ${dir}\` first.` };
  }

  const config = await Config.load(dir);
  const dbPath = resolve(dir, '.codegraph', 'codegraph.db');
  const store = new Store(dbPath);
  const graph = new CodeGraph(config.repo.name);

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

function buildServer(): Server {
  const server = new Server(
    { name: 'codegraph', version: '0.1.3' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'codegraph_scan',
        description: 'Scan the codebase and build/update the code graph. Run this when you need to understand project structure or after files have changed.',
        inputSchema: {
          type: 'object',
          properties: {
            ...dirProperty,
          },
        },
      },
      {
        name: 'codegraph_query',
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
        name: 'codegraph_dependencies',
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
        name: 'codegraph_export',
        description: 'Export a compact, token-efficient summary of the code graph. Use this at the start of a session to quickly understand the codebase structure.',
        inputSchema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['llm', 'json', 'dot', 'svg'], description: 'Output format', default: 'llm' },
            tokens: { type: 'number', description: 'Token budget for LLM format', default: 8192 },
            repo: { type: 'string', description: 'Filter by repo name' },
            ...dirProperty,
          },
        },
      },
      {
        name: 'codegraph_status',
        description: 'Check what files have changed since the last scan. Use this to determine if a re-scan is needed.',
        inputSchema: {
          type: 'object',
          properties: {
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
    const loadCtx = async (dir: string) => {
      const ctx = await loadContext(dir);
      if (!('error' in ctx)) activeStore = ctx.store;
      return ctx;
    };

    try {
    switch (name) {
      case 'codegraph_scan': {
        const dir = resolveDir(args || {});
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const scanner = new Scanner(ctx.store, ctx.config, ctx.graph);
        const result = await scanner.scanFull();

        return {
          content: [{
            type: 'text',
            text: `Scanned ${result.filesScanned} files in ${dir} (${Object.entries(result.languageBreakdown).map(([l, c]) => `${l}: ${c}`).join(', ')})\nFound ${result.symbolsFound} symbols, ${result.edgesFound} edges in ${result.durationMs}ms`,
          }],
        };
      }

      case 'codegraph_query': {
        const dir = resolveDir(args || {});
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

      case 'codegraph_dependencies': {
        const dir = resolveDir(args || {});
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

      case 'codegraph_export': {
        const dir = resolveDir(args || {});
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const format = (args as any)?.format || 'llm';
        const tokens = (args as any)?.tokens || 8192;
        const repo = (args as any)?.repo;

        if (format === 'json') {
          const exporter = new GraphExporter(ctx.store, ctx.graph);
          return { content: [{ type: 'text', text: exporter.exportAsJSONString(repo) }] };
        }

        if (format === 'dot') {
          const exporter = new DotExporter(ctx.store, ctx.graph);
          return { content: [{ type: 'text', text: exporter.export(repo) }] };
        }

        if (format === 'svg') {
          const exporter = new SvgExporter(ctx.store, ctx.graph);
          return { content: [{ type: 'text', text: exporter.export(repo) }] };
        }

        const exporter = new LLMExporter(ctx.store, ctx.graph);
        const output = exporter.export({ format: 'llm', tokenBudget: tokens, repo });
        return { content: [{ type: 'text', text: output }] };
      }

      case 'codegraph_status': {
        const dir = resolveDir(args || {});
        const ctx = await loadCtx(dir);
        if ('error' in ctx) return { content: [{ type: 'text', text: ctx.error }] };

        const lastScan = ctx.store.getMeta('last_scan_time');
        const lastCommit = ctx.store.getMeta('last_scan_commit');
        const fileCount = ctx.store.getFileCount();
        const symbolCount = ctx.store.getSymbolCount();
        const edgeCount = ctx.store.getEdgeCount();

        return {
          content: [{
            type: 'text',
            text: `Directory: ${dir}\nLast scan: ${lastScan || 'never'}\nLast commit: ${lastCommit || 'none'}\nFiles: ${fileCount} | Symbols: ${symbolCount} | Edges: ${edgeCount}`,
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
  const binPath = resolve(dir, 'node_modules', '.bin', 'codegraph');
  const hasBin = existsSync(binPath);
  const cmd = hasBin ? 'codegraph' : `npx tsx ${resolve(dir, 'src', 'main.ts')}`;

  const lines: string[] = [
    '',
    '  CodeGraph MCP server ready.',
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
      '      "codegraph": {',
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
      '        "codegraph": {',
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
      '      "codegraph": {',
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
      '        "codegraph": {',
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
    '  Available tools: codegraph_scan, codegraph_query, codegraph_dependencies, codegraph_export, codegraph_status',
    '',
  );

  return lines.join('\n');
}

export async function startMcpServer(dir?: string, options?: ServeOptions): Promise<void> {
  if (dir) {
    defaultDir = resolve(dir);
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

    console.error(generateConfigs(defaultDir, 'sse', port));
  } else {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(generateConfigs(defaultDir, 'stdio'));
  }
}
