import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from './core/config.js';
import { Store } from './core/store.js';
import { MapxGraph } from './core/graph.js';
import { calculateMetrics, calculateGraphMetrics } from './core/metrics.js';
import { ContextBuilder } from './core/context-builder.js';
import { RouteRegistry } from './frameworks/route-registry.js';
import { UiEventBus, getToolCallsLogPath } from './ui-events.js';
import { getChangedFiles, isGitRepo } from './core/git-tracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

interface ServerOpts {
  port: number;
  host: string;
  token?: string;
  dir: string;
}

function findUiDir(): string {
  // 1. Check if running from source/dev/npm-installed:
  if (existsSync(__filename)) {
    const root = resolve(__dirname, '..');
    // If in src/ development mode:
    if (existsSync(join(root, 'dist/ui/main.js'))) {
      return join(root, 'dist/ui');
    }
    // If in dist/ mode:
    if (existsSync(join(root, 'ui/main.js'))) {
      return join(root, 'ui');
    }
  }

  // 2. Running as compiled binary: check XDG directories and next to binary
  const binDir = resolve(process.execPath, '..');
  const candidates = [
    join(binDir, 'ui'),                                          // next to binary
    resolve(binDir, '..', 'share', 'mapx', 'ui'),               // XDG system
    join(process.env['HOME'] ?? '', '.local', 'share', 'mapx', 'ui'), // XDG user
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'main.js'))) {
      return dir;
    }
  }

  // Fallback to the default relative lookup
  return join(__dirname, 'ui');
}

export function startUiServer(opts: ServerOpts) {
  const { port, host, token, dir } = opts;
  const uiDir = findUiDir();

  // Simple in-memory rate-limiter: IP -> timestamp[]
  const rateLimitMap = new Map<string, number[]>();

  const isRateLimited = (ip: string): boolean => {
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute
    let timestamps = rateLimitMap.get(ip) || [];
    timestamps = timestamps.filter(t => t > windowStart);
    if (timestamps.length >= 10) {
      return true;
    }
    timestamps.push(now);
    rateLimitMap.set(ip, timestamps);
    return false;
  };

  const getClientIp = (req: IncomingMessage): string => {
    return (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
  };

  const checkAuth = (req: IncomingMessage): boolean => {
    if (!token) return true;
    const auth = req.headers['authorization'] || req.headers['Authorization'];
    if (typeof auth !== 'string') return false;
    return auth.trim() === `Bearer ${token}`;
  };

  const setCorsHeaders = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  };

  const server = createServer(async (req, res) => {
    setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const ip = getClientIp(req);
    const parsedUrl = new URL(req.url || '/', `http://${host}:${port}`);
    const pathname = parsedUrl.pathname;

    // Handle authentication for APIs
    if (pathname.startsWith('/api') || pathname === '/events') {
      if (!checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing Bearer token' }));
        return;
      }
    }

    // Handle Rate Limiting for specific endpoints
    if (pathname === '/api/context' || pathname === '/api/graph') {
      if (isRateLimited(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded: max 10 requests per minute' }));
        return;
      }
    }

    try {
      // API endpoints
      if (pathname === '/api/status') {
        const configPath = resolve(dir, '.mapx', 'config.json');
        if (!existsSync(configPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Mapx not initialized' }));
          return;
        }
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const fileCount = store.getFileCount();
          const symbolCount = store.getSymbolCount();
          const edgeCount = store.getEdgeCount();
          const lastScan = store.getMeta('last_scan_time') || 'never';
          const config = await Config.load(dir);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            repoName: config.repo.name,
            lastScan,
            fileCount,
            symbolCount,
            edgeCount,
            languages: store.getLanguageBreakdown()
          }));
        } finally {
          store.close();
        }
        return;
      }

      if (pathname === '/api/graph') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const files = store.getAllFiles();
          const edges = store.getAllEdges();

          const elements: any[] = [];
          for (const f of files) {
            const fPath = f.path as string;
            elements.push({
              data: {
                id: fPath,
                label: fPath.split('/').pop() || fPath,
                type: 'file',
                language: f.language,
                size: f.size_bytes,
                lines: f.lines
              }
            });
          }
          for (const e of edges) {
            elements.push({
              data: {
                id: `edge-${e.source_file}-${e.target_file}`,
                source: e.source_file,
                target: e.target_file,
                type: e.edge_type,
                verifiability: e.verifiability
              }
            });
          }

          const payload = JSON.stringify(elements);
          if (payload.length > 10 * 1024 * 1024) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Graph too large (exceeded 10MB limit)' }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(payload);
        } finally {
          store.close();
        }
        return;
      }

      if (pathname === '/api/symbols') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const term = parsedUrl.searchParams.get('q') || '';
          const limit = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
          const results = store.searchSymbolsFiltered({ term, limit });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(results));
        } finally {
          store.close();
        }
        return;
      }

      if (pathname.startsWith('/api/symbol/')) {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const symName = decodeURIComponent(pathname.substring('/api/symbol/'.length));
          const sym = store.getSymbolByName(symName);
          if (!sym) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Symbol not found' }));
            return;
          }

          const callers = store.getCallersOfSymbol(symName);
          const callees = store.getCalleesOfSymbol(symName);

          // Try reading source file segment if lines are specified
          let sourceCode = '';
          if (sym.file_path) {
            try {
              const fullFilePath = resolve(dir, sym.file_path);
              if (existsSync(fullFilePath)) {
                const fileContent = readFileSync(fullFilePath, 'utf-8');
                const lines = fileContent.split('\n');
                const start = Math.max(0, (sym.start_line || 1) - 1);
                const end = Math.min(lines.length, (sym.end_line || lines.length));
                sourceCode = lines.slice(start, end).join('\n');
              }
            } catch {
              // Ignored
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            symbol: sym,
            callers,
            callees,
            sourceCode
          }));
        } finally {
          store.close();
        }
        return;
      }

      if (pathname === '/api/metrics') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const config = await Config.load(dir);
          const graph = new MapxGraph(config.repo.name);

          for (const file of store.getAllFiles()) {
            graph.addFileNode(file.path as string, file.language as string, file.size_bytes as number, file.lines as number);
          }
          for (const sym of store.getAllSymbols()) {
            graph.addSymbolNode(sym.name as string, sym.file_path as string, sym.name as string, sym.kind as any, sym.start_line as number, sym.end_line as number, sym.scope as string | null);
          }
          for (const edge of store.getAllEdges()) {
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

          const fileCount = store.getFileCount();
          const symbolCount = store.getSymbolCount();
          const edgeCount = store.getEdgeCount();

          const fileMetrics = calculateMetrics(store, { repo: config.repo.name });
          const graphMetrics = calculateGraphMetrics(store, config.repo.name);
          const topFiles = store.getTopFilesByPageRank(graph, 10);
          const topSymbols = store.getTopSymbolsByPageRank(graph, 10);

          // Get extra metrics matching CLI status
          const verifiedEdges = (store.raw.prepare("SELECT COUNT(*) as cnt FROM edges WHERE verifiability = 'verified'").get() as any)?.cnt || 0;
          const inferredEdges = (store.raw.prepare("SELECT COUNT(*) as cnt FROM edges WHERE verifiability = 'inferred'").get() as any)?.cnt || 0;
          const languages = store.getLanguageBreakdown();

          const symbolKinds = store.raw.prepare(
            'SELECT kind, COUNT(*) as cnt FROM symbols GROUP BY kind ORDER BY cnt DESC'
          ).all() as Array<{ kind: string; cnt: number }>;

          const edgeTypes = store.raw.prepare(
            'SELECT edge_type, COUNT(*) as cnt FROM edges GROUP BY edge_type ORDER BY cnt DESC'
          ).all() as Array<{ edge_type: string; cnt: number }>;

          let dbSize = 0;
          try {
            dbSize = statSync(dbPath).size;
          } catch {}

          const repoRoot = resolve(dir, config.repo.path);
          const isGit = isGitRepo(repoRoot);
          const lastCommit = store.getMeta('last_scan_commit:' + config.repo.name) || store.getMeta('last_scan_commit');
          const gitChanges = isGit ? getChangedFiles(repoRoot, lastCommit || undefined) : [];

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            totalFiles: fileCount,
            totalSymbols: symbolCount,
            totalEdges: edgeCount,
            verifiedEdges,
            inferredEdges,
            languages,
            symbolKinds,
            edgeTypes,
            avgEdgesPerFile: fileCount > 0 ? (edgeCount / fileCount).toFixed(2) : '0',
            dbSize,
            density: `${(graphMetrics.density * 100).toFixed(4)}%`,
            transitivity: graphMetrics.transitivity.toFixed(4),
            git: {
              isGit,
              changesCount: gitChanges.length,
              changes: gitChanges
            },
            fileMetrics,
            topFiles,
            topSymbols
          }));
        } finally {
          store.close();
        }
        return;
      }

      if (pathname === '/api/context') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', chunk => {
          body += chunk;
        });

        req.on('end', async () => {
          let store: Store | null = null;
          try {
            const data = JSON.parse(body);
            const task = data.task || '';

            const dbPath = resolve(dir, '.mapx', 'mapx.db');
            store = new Store(dbPath);
            const config = await Config.load(dir);
            const graph = new MapxGraph(config.repo.name);

            for (const file of store.getAllFiles()) {
              graph.addFileNode(file.path as string, file.language as string, file.size_bytes as number, file.lines as number);
            }
            for (const sym of store.getAllSymbols()) {
              graph.addSymbolNode(sym.name as string, sym.file_path as string, sym.name as string, sym.kind as any, sym.start_line as number, sym.end_line as number, sym.scope as string | null);
            }
            for (const edge of store.getAllEdges()) {
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

            const builder = new ContextBuilder(store, graph);
            const context = await builder.buildContext({ task, tokens: 15000 }); // 15k token budget
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(context));
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          } finally {
            if (store) {
              store.close();
            }
          }
        });
        return;
      }

      if (pathname === '/api/routes') {
        const routeRegistry = new RouteRegistry();
        await routeRegistry.load(dir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          routes: routeRegistry.getRoutes(),
          hooks: routeRegistry.getHooks()
        }));
        return;
      }

      if (pathname === '/api/tool-calls') {
        const mapxDir = resolve(dir, '.mapx');
        const logPath = getToolCallsLogPath(mapxDir);
        const events: any[] = [];
        if (existsSync(logPath)) {
          try {
            const content = readFileSync(logPath, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            // Return most recent 100 entries, newest first
            const recent = lines.slice(-100).reverse();
            for (const line of recent) {
              try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
            }
          } catch { /* ignore read errors */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
        return;
      }

      if (pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const eventBus = UiEventBus.getInstance();
        const sendEvent = (name: string, data: any) => {
          res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        // In-process event listeners (for when MCP server runs in same process)
        const onToolCall = (event: any) => sendEvent('tool-call', event);
        const onScanProgress = (event: any) => sendEvent('scan-progress', event);
        const onScanComplete = (event: any) => sendEvent('scan-complete', event);

        eventBus.on('tool-call', onToolCall);
        eventBus.on('scan-progress', onScanProgress);
        eventBus.on('scan-complete', onScanComplete);

        // Cross-process: tail the shared tool-calls.jsonl log file
        const mapxDir = resolve(dir, '.mapx');
        const logPath = getToolCallsLogPath(mapxDir);
        let lastSize = 0;
        try { lastSize = existsSync(logPath) ? statSync(logPath).size : 0; } catch { /* ignore */ }

        const pollLogFile = () => {
          try {
            if (!existsSync(logPath)) return;
            const currentSize = statSync(logPath).size;
            if (currentSize <= lastSize) {
              if (currentSize < lastSize) lastSize = currentSize; // file was truncated
              return;
            }
            // Read only the new bytes
            const { openSync, readSync, closeSync } = require('node:fs');
            const fd = openSync(logPath, 'r');
            const buf = Buffer.alloc(currentSize - lastSize);
            readSync(fd, buf, 0, buf.length, lastSize);
            closeSync(fd);
            lastSize = currentSize;

            const newLines = buf.toString('utf-8').split('\n').filter(Boolean);
            for (const line of newLines) {
              try {
                const event = JSON.parse(line);
                sendEvent('tool-call', event);
              } catch { /* skip malformed */ }
            }
          } catch { /* ignore */ }
        };

        // Watch log file for immediate near-real-time updates
        let logWatcher: any = null;
        try {
          if (existsSync(logPath)) {
            const { watch } = require('node:fs');
            logWatcher = watch(logPath, (eventType: string) => {
              if (eventType === 'change') {
                pollLogFile();
              }
            });
          }
        } catch { /* ignore watch issues */ }

        // Poll every 500ms for backup/creation checks
        const pollInterval = setInterval(pollLogFile, 500);

        req.on('close', () => {
          eventBus.off('tool-call', onToolCall);
          eventBus.off('scan-progress', onScanProgress);
          eventBus.off('scan-complete', onScanComplete);
          if (logWatcher) {
            try { logWatcher.close(); } catch { /* ignore */ }
          }
          clearInterval(pollInterval);
        });
        return;
      }

      // Serve static assets from uiDir
      const rawAssetPath = pathname === '/' ? '/index.html' : pathname;
      const safeAssetPath = join(uiDir, rawAssetPath);

      // Path traversal security check
      if (!safeAssetPath.startsWith(uiDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: Path traversal rejected');
        return;
      }

      if (existsSync(safeAssetPath)) {
        const ext = extname(safeAssetPath);
        const contentTypes: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.json': 'application/json',
          '.png': 'image/png'
        };
        const contentType = contentTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(readFileSync(safeAssetPath));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, host, () => {
    console.log(`Mapx UI Server running at http://${host}:${port}`);
  });

  return server;
}
