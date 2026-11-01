import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, watchFile, unwatchFile, openSync, readSync, closeSync, watch, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { Config } from './core/config.js';
import { Store } from './core/store.js';
import { applyCollapsedRepos } from './core/workspace-summary.js';
import { indexableChanges } from './core/staleness.js';
import { MapxGraph } from './core/graph.js';
import { buildMetricsReport, calculateGraphMetrics, calculateDSM } from './core/metrics.js';
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
  /** Build a stale dashboard bundle first when running from source (the CLI sets it; M4-05). */
  devBuild?: boolean;
}

/**
 * The dashboard bundle of a source checkout needs building: a file it is made of is missing, or a
 * file under `src/ui/`, the build script or the lockfile (its dependencies) is newer (M4-05:
 * installs no longer build it).
 */
export function uiBundleStale(root: string): boolean {
  const outputs = ['main.js', 'index.html', 'layout-worker.js'].map((f) => join(root, 'dist/ui', f));
  if (!outputs.every((f) => existsSync(f))) return true;
  const built = Math.min(...outputs.map((f) => statSync(f).mtimeMs));
  const newer = (path: string): boolean => {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    if (!stat.isDirectory()) return stat.mtimeMs > built;
    return readdirSync(path).some((name) => newer(join(path, name)));
  };
  return ['src/ui', 'scripts/build-ui.ts', 'package-lock.json'].some((p) => newer(join(root, p)));
}

/**
 * Running from source (`tsx src/main.ts ui`): build the dashboard first when it is stale. A failed
 * build is reported and the server starts anyway, so `serve --ui` keeps its MCP server.
 */
function ensureDevBundle(): void {
  if (!__filename.endsWith('.ts')) return; // an installed package or a binary ships its bundle
  if (process.env.MAPX_NO_UI === '1') return;
  const root = resolve(__dirname, '..');
  if (!uiBundleStale(root)) return;
  console.error('Building the dashboard…');
  try {
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    execFileSync(process.execPath, [tsxCli, join(root, 'scripts/build-ui.ts')], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (err) {
    console.error(`Dashboard build failed (${err instanceof Error ? err.message.split('\n')[0] : err}); run npm run build:ui.`);
  }
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

/**
 * A client on this machine, judged by the socket's address (never by a forwarded header, which the
 * client writes). The dashboard's own user is not rate-limited: reloading the page, or the browser
 * tests, must not get 429s from /api/graph (M4-17).
 */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/**
 * The dashboard's own user: a loopback client whose request is not cross-site, i.e. it sends no
 * Origin (curl, the CLI) or the dashboard's own origin. A web page in another tab also connects
 * from loopback, but sends its own Origin, and stays rate-limited.
 */
export function isOwnLocalClient(req: IncomingMessage): boolean {
  if (!isLoopback(req.socket.remoteAddress)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

/** Bodies smaller than this go out as they are: compressing them saves little. */
const COMPRESS_MIN_BYTES = 1024;

/**
 * The encoding to send a body in: brotli when the client accepts it, else gzip, else none (M4-20).
 * Only `br` and `gzip` tokens without `q=0` count.
 */
export function pickEncoding(acceptEncoding: string | string[] | undefined): 'br' | 'gzip' | null {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding ?? '';
  const parts = header.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  const name = (part: string) => part.split(';')[0]!.trim();
  const refused = new Set(parts.filter((part) => /;\s*q=0(\.0+)?\s*$/.test(part)).map(name));
  const accepted = new Set(parts.map(name).filter((n) => !refused.has(n)));
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip') || (accepted.has('*') && !refused.has('gzip'))) return 'gzip';
  return null;
}

/** Compresses `body` for `encoding`; brotli at a fast level, since the dashboard compresses per request. */
function encode(body: Buffer, encoding: 'br' | 'gzip'): Buffer {
  return encoding === 'br'
    ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : gzipSync(body, { level: 6 });
}

/** Sends a body, compressed when the client accepts it and it is large enough. */
function sendBody(req: IncomingMessage, res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}) {
  const encoding = body.length >= COMPRESS_MIN_BYTES ? pickEncoding(req.headers['accept-encoding']) : null;
  const headers: Record<string, string | number> = { 'Content-Type': contentType, Vary: 'Accept-Encoding', ...extraHeaders };
  const payload = encoding ? encode(body, encoding) : body;
  if (encoding) headers['Content-Encoding'] = encoding;
  headers['Content-Length'] = payload.length;
  res.writeHead(status, headers);
  res.end(payload);
}

/** Static files compressed once per file version (path, size and mtime) and encoding. */
const staticCache = new Map<string, Buffer>();

/** `Config.load` plus the duplicate-entry collapse the CLI and MCP loaders apply (M0-10-R4). */
async function loadConfig(dir: string, store: Store): Promise<Config> {
  const config = await Config.load(dir);
  for (const message of applyCollapsedRepos(config, store)) console.error(message);
  return config;
}

export function startUiServer(opts: ServerOpts) {
  const { port, host, token, dir } = opts;
  if (opts.devBuild) ensureDevBundle();
  const uiDir = findUiDir();
  // Git, `npm link` and `file:` installs run only `prepare`, which no longer builds the dashboard (D020).
  if (!existsSync(join(uiDir, 'main.js'))) console.error(`Dashboard bundle not found in ${uiDir}; run npm run build:ui in the MapX folder.`);

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
    if (pathname === '/api/context' || pathname === '/api/graph' || pathname === '/api/graph/meta') {
      if (!isOwnLocalClient(req) && isRateLimited(ip)) {
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
          const config = await loadConfig(dir, store);
          const fileCount = store.getFileCount();
          const symbolCount = store.getSymbolCount();
          const edgeCount = store.getEdgeCount();
          const lastScan = store.getMeta('last_scan_time') || 'never';

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
          try { store.close(); } catch { /* ignore close errors */ }
        }
        return;
      }

      if (pathname === '/api/graph/meta') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const totalFiles = store.getFileCount();
          const totalEdges = store.getEdgeCount();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ totalFiles, totalEdges, totalElements: totalFiles + totalEdges }));
        } finally {
          try { store.close(); } catch { /* ignore close errors */ }
        }
        return;
      }

      if (pathname === '/api/graph') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          // --- Retrieve pre-computed PageRank scores directly from SQLite ---
          const files = store.getAllFiles();

          // --- Symbol counts per file via SQL aggregate ---
          const symbolCountRows = store.raw.prepare(
            'SELECT file_path, COUNT(*) as cnt FROM symbols GROUP BY file_path'
          ).all() as Array<{ file_path: string; cnt: number }>;
          const symbolCountMap = new Map<string, number>();
          for (const row of symbolCountRows) {
            symbolCountMap.set(row.file_path, row.cnt);
          }

          // --- Build elements array ---
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
                lines: f.lines,
                symbolCount: symbolCountMap.get(fPath) || 0,
                pagerank: (f.pagerank as number) || 0,
                role: f.role,
                roleConfidence: f.role_confidence
              }
            });
          }

          // --- Retrieve and format grouped file-to-file edges directly from SQLite ---
          // Aggregating directly in SQLite avoids loading and looping over thousands of symbol-level edges in JS.
          const groupedEdges = store.raw.prepare(`
            SELECT source_file, target_file, MAX(weight) as weight, COUNT(*) as count, edge_type, verifiability
            FROM edges
            GROUP BY source_file, target_file
          `).all() as Array<{ source_file: string; target_file: string; weight: number; count: number; edge_type: string; verifiability: string }>;

          for (const e of groupedEdges) {
            elements.push({
              data: {
                id: `edge-${e.source_file}-${e.target_file}`,
                source: e.source_file,
                target: e.target_file,
                type: e.edge_type,
                verifiability: e.verifiability,
                weight: e.weight,
                count: e.count,
              }
            });
          }

          // --- Pagination support ---
          const limitParam = parsedUrl.searchParams.get('limit');
          const offsetParam = parsedUrl.searchParams.get('offset');
          const usePagination = limitParam !== null || offsetParam !== null;

          let responseBody: any;
          if (usePagination) {
            const total = elements.length;
            const limit = Math.max(1, parseInt(limitParam || String(total), 10));
            const offset = Math.max(0, parseInt(offsetParam || '0', 10));
            const paginatedElements = elements.slice(offset, offset + limit);
            responseBody = { elements: paginatedElements, meta: { total, limit, offset } };
          } else {
            responseBody = elements;
          }

          // Compressed when the client accepts it (M4-20): the 2,000-file graph is about 1 MB of JSON.
          sendBody(req, res, 200, 'application/json', Buffer.from(JSON.stringify(responseBody)));
        } finally {
          try { store.close(); } catch { /* ignore close errors */ }
        }
        return;
      }

      if (pathname === '/api/clusters') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const config = await loadConfig(dir, store);
          const repo = config.repo.name;
          const clusters = store.getClusters(repo);
          const memberships = store.getClusterMemberships(repo);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ clusters, memberships }));
        } finally {
          try { store.close(); } catch { /* ignore close errors */ }
        }
        return;
      }

      if (pathname === '/api/profile') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const config = await loadConfig(dir, store);
          const repo = config.repo.name;
          const profileStr = store.getMeta('codebase_profile:' + repo);
          const profile = profileStr ? JSON.parse(profileStr) : null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ profile }));
        } finally {
          try { store.close(); } catch { /* ignore close errors */ }
        }
        return;
      }

      if (pathname === '/api/smells') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const config = await loadConfig(dir, store);
          const repo = config.repo.name;
          const smells = store.getArchSmells(repo);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ smells }));
        } finally {
          try { store.close(); } catch { /* ignore close errors */ }
        }
        return;
      }

      if (pathname === '/api/dsm') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const config = await loadConfig(dir, store);
          const repo = config.repo.name;
          const dsm = calculateDSM(store, repo);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(dsm));
        } finally {
          try { store.close(); } catch { /* ignore close errors */ }
        }
        return;
      }

      if (pathname === '/api/explain') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const file = parsedUrl.searchParams.get('file') || '';
          const signals = store.getClassificationSignals(file);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ signals }));
        } finally {
          try { store.close(); } catch { /* ignore close errors */ }
        }
        return;
      }

      if (pathname === '/api/symbols') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const term = parsedUrl.searchParams.get('q') || '';
          const limit = Math.min(Math.max(1, parseInt(parsedUrl.searchParams.get('limit') || '50', 10)), 200);
          const offset = Math.max(0, parseInt(parsedUrl.searchParams.get('offset') || '0', 10));
          const results = store.searchSymbolsFiltered({ term, limit, offset });
          const total = store.countSymbolsFiltered({ term });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results, total, limit, offset }));
        } finally {
          try { store.close(); } catch { /* ignore close errors */ }
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
          try { store.close(); } catch { /* ignore close errors */ }
        }
        return;
      }

      if (pathname === '/api/metrics') {
        const dbPath = resolve(dir, '.mapx', 'mapx.db');
        const store = new Store(dbPath);
        try {
          const config = await loadConfig(dir, store);

          const fileCount = store.getFileCount();
          const symbolCount = store.getSymbolCount();
          const edgeCount = store.getEdgeCount();

          // D012 file rows, every file, with the PageRank the scan stored.
          const storedRank = new Map(store.getAllFiles(config.repo.name).map(f => [f.path as string, Number(f.pagerank ?? 0)]));
          const fileMetrics = buildMetricsReport(store, storedRank, { dir, repo: config.repo.name, top: 0 }).report.files;
          const graphMetrics = calculateGraphMetrics(store, config.repo.name);
          const topFiles = store.getTopFilesByPageRank(null, 10);
          const topSymbols = store.getTopSymbolsByPageRank(null, 10);

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
          // As `mapx status` (M0-11-R3).
          const gitChanges = isGit ? indexableChanges(store, dir, repoRoot, getChangedFiles(repoRoot, lastCommit || undefined), config.repo.name) : [];

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
          try { store.close(); } catch { /* ignore close errors */ }
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
            const config = await loadConfig(dir, store);
            const graph = new MapxGraph(config.repo.name);

            for (const file of store.getAllFiles()) {
              graph.addFileNode(file.path as string, file.language as string, file.size_bytes as number, file.lines as number);
            }
            // Symbols loading is skipped to optimize context build memory and time.
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
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          } finally {
            if (store) {
              try { store.close(); } catch { /* ignore close errors */ }
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
        const qp = new URL(req.url!, 'http://localhost').searchParams;
        const limit = Math.min(Math.max(1, parseInt(qp.get('limit') ?? '50', 10)), 200);
        const offset = Math.max(0, parseInt(qp.get('offset') ?? '0', 10));
        const events: any[] = [];
        let total = 0;
        if (existsSync(logPath)) {
          try {
            const content = readFileSync(logPath, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            total = lines.length;
            // newest-first pagination: offset 0 = most recent entries
            const end = Math.max(0, total - offset);
            const start = Math.max(0, end - limit);
            for (const line of lines.slice(start, end).reverse()) {
              try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
            }
          } catch { /* ignore read errors */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events, total }));
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
        // Scripts, styles and markup go out compressed, cached per file version (M4-20).
        const encoding = ['.js', '.css', '.html', '.svg', '.json'].includes(ext) ? pickEncoding(req.headers['accept-encoding']) : null;
        if (!encoding) {
          res.writeHead(200, { 'Content-Type': contentType, Vary: 'Accept-Encoding' });
          res.end(readFileSync(safeAssetPath));
        } else {
          const stat = statSync(safeAssetPath);
          const key = `${safeAssetPath}:${stat.size}:${stat.mtimeMs}:${encoding}`;
          let body = staticCache.get(key);
          if (!body) {
            body = encode(readFileSync(safeAssetPath), encoding);
            if (staticCache.size >= 64) staticCache.clear(); // rebuilt bundles leave old versions behind
            staticCache.set(key, body);
          }
          res.writeHead(200, { 'Content-Type': contentType, 'Content-Encoding': encoding, 'Content-Length': body.length, Vary: 'Accept-Encoding' });
          res.end(body);
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  server.listen(port, host, () => {
    console.log(`Mapx UI Server running at http://${host}:${port}`);
  });

  return server;
}
