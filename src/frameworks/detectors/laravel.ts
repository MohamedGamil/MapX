import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../../types.js';
import { hasComposerDependency } from '../utils.js';
import {
  closingBracket,
  expandGlob,
  findLaravelRoots,
  liveProviderCode,
  maskPhp,
  normalizeMountPath,
  opensConditionalBlock,
  phpString,
  resourceParam,
  stringAssignments,
  varsAt,
  type PhpScope,
} from './laravel-mounts.js';

interface ChainedCall {
  name: string;
  args: string;
}

// Controller analysis cache to prevent multiple disk reads
const controllerCache = new Map<string, {
  content: string,
  middlewares: { middleware: string, only: string[], except: string[] }[]
}>();

interface LaravelWorkspaceContext {
  kernelMiddlewares: {
    groups: Record<string, string[]>;
    aliases: Record<string, string>;
  };
  routeServiceProvider: {
    routes: Record<string, {
      prefix: string;
      namespace: string;
      middlewares: string[];
    }>;
  };
  /** Route files reachable from an entry point, each with every mount that loads it. */
  mounts: Map<string, RouteMount[]>;
  /** Laravel app roots (workspace-relative) whose mount graph is known. */
  knownRoots: string[];
  /**
   * Per app root, mounts that could not be evaluated (`file:line`). While any exist, a route file
   * nothing visibly mounts may still be loaded, so its reachability is unknown, not false.
   */
  unresolved: Map<string, string[]>;
  initialized: boolean;
}

/** Group context a route file inherits from whatever loads it (entry point, provider, require). */
interface RouteMount {
  prefixes: string[];
  middlewares: string[];
  namespaces: string[];
  controller: string | null;
  /** Route::domain() / 'domain' => of the enclosing groups, when any. */
  domain?: string | null;
  /** Route name prefixes of the enclosing groups (`->name('admin.')`, `'as' => 'admin.'`). */
  names?: string[];
  /** Registration order: compare lexicographically; later wins for duplicate method + URI. */
  order: number[];
  conditional: boolean;
  via: string;
}

/** A mount discovered while walking a file: the target file and the group context at that point. */
interface MountRequest {
  file: string;
  frame: Omit<RouteMount, 'order' | 'via'>;
  offset: number;
  /** Position among the files one statement mounts (a glob loop), in glob order. */
  sub?: number;
  line: number;
}

const workspaceInitializationPromises = new Map<string, Promise<LaravelWorkspaceContext>>();

function ensureWorkspaceInitialized(workspaceRoot: string, ctx: ScanContext): Promise<LaravelWorkspaceContext> {
  let promise = workspaceInitializationPromises.get(workspaceRoot);
  if (!promise) {
    promise = (async () => {
      const wctx: LaravelWorkspaceContext = {
        kernelMiddlewares: {
          groups: {},
          aliases: {}
        },
        routeServiceProvider: {
          routes: {}
        },
        mounts: new Map(),
        knownRoots: [],
        unresolved: new Map(),
        initialized: true
      };
      
      const roots = findLaravelRoots(workspaceRoot);
      for (const root of roots.length ? roots : ['']) {
        // 1. Parse Kernel.php if it exists
        const kernelPath = join(workspaceRoot, root, 'app/Http/Kernel.php');
        if (existsSync(kernelPath)) {
          try {
            parseKernel(await readFile(kernelPath, 'utf-8'), wctx);
          } catch (e) {
            // Ignored
          }
        }
      }

      // 2. Build the mount graph of every Laravel app root
      for (const [index, root] of roots.entries()) {
        try {
          await buildMountGraph(workspaceRoot, root, index, wctx, ctx);
        } catch (e) {
          // Ignored: files fall back to name-based defaults
        }
      }

      return wctx;
    })();
    workspaceInitializationPromises.set(workspaceRoot, promise);
  }
  return promise;
}

function parseKernel(content: string, wctx: LaravelWorkspaceContext) {
  // Extract $middlewareGroups block
  const groupsMatch = content.match(/\$middlewareGroups\s*=\s*/);
  if (groupsMatch && groupsMatch.index !== undefined) {
    const afterGroups = content.substring(groupsMatch.index + groupsMatch[0].length);
    const bracket = getArrayBlockContent(afterGroups);
    if (bracket) {
      const groupRegex = /['"]([^'"]+)['"]\s*=>\s*/g;
      let gMatch;
      while ((gMatch = groupRegex.exec(bracket.content)) !== null) {
        const groupName = gMatch[1];
        const subContent = bracket.content.substring(gMatch.index + gMatch[0].length);
        const subBracket = getArrayBlockContent(subContent);
        if (subBracket) {
          const itemRegex = /['"]([^'"]+)['"]|([a-zA-Z0-9_\\]+)::class/g;
          const items: string[] = [];
          let itemMatch;
          while ((itemMatch = itemRegex.exec(subBracket.content)) !== null) {
            let item = (itemMatch[1] || itemMatch[2] || '').trim();
            if (item && item !== 'class' && item !== 'protected' && item !== 'public') {
              if (item.startsWith('\\')) item = item.substring(1);
              items.push(item);
            }
          }
          wctx.kernelMiddlewares.groups[groupName] = items;
        }
      }
    }
  }

  // Extract $routeMiddleware or $middlewareAliases block
  const routeMwMatch = content.match(/\$(?:routeMiddleware|middlewareAliases)\s*=\s*/);
  if (routeMwMatch && routeMwMatch.index !== undefined) {
    const afterMw = content.substring(routeMwMatch.index + routeMwMatch[0].length);
    const bracket = getArrayBlockContent(afterMw);
    if (bracket) {
      const mappingRegex = /['"]([^'"]+)['"]\s*=>\s*['"]?([a-zA-Z0-9_\\]+)(?:::class)?['"]?/g;
      let mMatch;
      while ((mMatch = mappingRegex.exec(bracket.content)) !== null) {
        const alias = mMatch[1];
        let fqn = mMatch[2];
        if (fqn && fqn !== 'class') {
          if (fqn.startsWith('\\')) fqn = fqn.substring(1);
          wctx.kernelMiddlewares.aliases[alias] = fqn;
        }
      }
    }
  }
}

function getArrayBlockContent(str: string): { content: string, endIndex: number } | null {
  const trimmed = str.trimStart();
  const startOffset = str.length - trimmed.length;
  if (trimmed.startsWith('[')) {
    const res = getBracketedContent(trimmed, 0);
    if (res) {
      return { content: res.content, endIndex: res.endIndex + startOffset };
    }
  } else if (trimmed.startsWith('array(')) {
    const res = getParenthesizedContent(trimmed, 5);
    if (res) {
      return { content: res.content, endIndex: res.endIndex + startOffset };
    }
  }
  return null;
}

function resolveRoutePath(arg: string, providerPath: string): string | null {
  const clean = arg.trim();

  const basePathMatch = clean.match(/base_path\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (basePathMatch) {
    return basePathMatch[1].replace(/^\/|\/$/g, '').replace(/\\/g, '/');
  }

  if (clean.includes('__DIR__')) {
    const relativePartMatch = clean.match(/['"]([^'"]+)['"]/);
    if (relativePartMatch) {
      const relPath = relativePartMatch[1];
      const providerDir = providerPath.includes('/') ? providerPath.substring(0, providerPath.lastIndexOf('/')) : '';
      const resolved = join(providerDir, relPath).replace(/\\/g, '/');
      return resolved;
    }
  }

  const stringMatch = clean.match(/^['"]([^'"]+)['"]$/);
  if (stringMatch) {
    return stringMatch[1].replace(/^\/|\/$/g, '').replace(/\\/g, '/');
  }

  const phpMatch = clean.match(/['"]?([a-zA-Z0-9_\-/]+\.php)['"]?/);
  if (phpMatch) {
    return phpMatch[1].replace(/^\/|\/$/g, '').replace(/\\/g, '/');
  }

  return null;
}

function parseRouteServiceProvider(source: string, providerPath: string, wctx: LaravelWorkspaceContext) {
  // Comments, strings and methods Laravel never calls (e.g. a map*Routes() whose call is
  // commented out) declare no mounts.
  const { code: content, text } = liveProviderCode(source);
  const namespaceVarMatch = text.match(/(?:protected|public|private)\s+\$namespace\s*=\s*['"]([^'"]+)['"]/);
  const classNamespace = namespaceVarMatch ? namespaceVarMatch[1] : 'App\\Http\\Controllers';

  let index = 0;
  while (true) {
    const start = content.indexOf('Route::', index);
    if (start === -1) break;

    const parsed = /\w/.test(content[start - 1] ?? '') ? null : parseRouteChain(content, start, text);
    if (!parsed) {
      index = start + 7;
      continue;
    }

    index = parsed.endIndex;

    const groupCall = parsed.calls.find(c => c.name === 'group');
    if (groupCall && groupCall.args) {
      const routePathArg = groupCall.args;
      const relativeRoutePath = resolveRoutePath(routePathArg, providerPath);
      if (relativeRoutePath) {
        let prefix = '';
        let namespace = classNamespace;
        const middlewares: string[] = [];

        for (const call of parsed.calls) {
          if (call.name === 'prefix') {
            const args = parseArgs(call.args);
            if (args[0]) prefix = (prefix ? `${prefix}/` : '') + args[0];
          } else if (call.name === 'namespace') {
            const args = parseArgs(call.args);
            if (args[0]) {
              const val = args[0];
              if (val === '$this->namespace') {
                namespace = classNamespace;
              } else {
                namespace = val;
              }
            }
          } else if (call.name === 'middleware') {
            if (call.args.trim().startsWith('[')) {
              const matches = call.args.match(/['"]([^'"]+)['"]/g) || [];
              middlewares.push(...matches.map(m => m.replace(/['"]/g, '')));
            } else {
              const args = parseArgs(call.args);
              if (args[0]) middlewares.push(args[0]);
            }
          } else if (call.name === 'group' && (call.args.trim().startsWith('[') || call.args.trim().startsWith('array('))) {
            const groupAttrs = parseGroupAttributes(call.args);
            if (groupAttrs.prefixes[0]) {
              prefix = (prefix ? `${prefix}/` : '') + groupAttrs.prefixes[0];
            }
            if (groupAttrs.namespaces[0]) {
              namespace = groupAttrs.namespaces[0];
            }
            middlewares.push(...groupAttrs.middlewares);
          }
        }

        wctx.routeServiceProvider.routes[relativeRoutePath] = {
          prefix,
          namespace,
          middlewares
        };
      }
    }
  }
}

async function listServiceProviders(workspaceRoot: string, dir: string): Promise<string[]> {
  const found: string[] = [];
  const skipDirs = new Set(['vendor', 'node_modules', '.git', '.mapx', 'storage', 'bootstrap', 'public', 'tests', 'resources', 'database', 'config']);
  const walk = async (rel: string) => {
    const abs = join(workspaceRoot, rel);
    if (!existsSync(abs)) return;
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name.toLowerCase())) await walk(child);
      } else if (entry.isFile() && entry.name.endsWith('ServiceProvider.php')) {
        found.push(child);
      }
    }
  };
  await walk(dir);
  return found.sort();
}

const emptyFrame = (): Omit<RouteMount, 'order' | 'via'> => ({
  prefixes: [], middlewares: [], namespaces: [], controller: null, conditional: false,
});

/**
 * Entry points declared by bootstrap/app.php `withRouting(...)`: the `web:` and `api:` files,
 * then whatever the `then:` closure mounts (Laravel runs it after loading them). A `using:`
 * closure replaces the default files. Read through the masking lexer, so a commented-out call or
 * argument declares nothing. `unresolved` lists the lines of mounts that could not be evaluated.
 */
function withRoutingEntries(content: string, path: string, root: string, ctx: ScanContext): { entries: { file: string; frame: Omit<RouteMount, 'order' | 'via'>; via: string }[]; unresolved: number[] } {
  const { code, text } = maskPhp(content);
  const at = code.search(/->\s*withRouting\s*\(/);
  if (at < 0) return { entries: [], unresolved: [] };
  const open = code.indexOf('(', at);
  const paren = parenAt(code, text, open);
  if (!paren) return { entries: [], unresolved: [] };
  const scope = { dir: posix.join(root, 'bootstrap'), root, vars: new Map<string, string>() };
  const named = new Map<string, string>();
  for (const arg of parseArgs(paren.content, true)) {
    const m = arg.match(/^(\w+)\s*:\s*([\s\S]+)$/);
    if (m) named.set(m[1]!, m[2]!.trim());
  }
  const unresolved: number[] = [];
  const files = (expr: string | undefined) => {
    if (!expr) return [];
    const items = expr.startsWith('[') ? parseArgs(expr.slice(1, expr.lastIndexOf(']')), true) : [expr];
    const evaluated = items.map(e => phpString(e, scope));
    if (evaluated.some(f => f === null)) unresolved.push(lineAt(content, at));
    return evaluated.filter((f): f is string => !!f).map(normalizeMountPath);
  };
  const apiPrefix = named.has('apiPrefix') ? phpString(named.get('apiPrefix')!, scope) ?? 'api' : 'api';
  const entries: { file: string; frame: Omit<RouteMount, 'order' | 'via'>; via: string }[] = named.has('using') ? [] : [
    ...files(named.get('web')).map(file => ({ file, frame: { ...emptyFrame(), middlewares: ['web'] }, via: path })),
    ...files(named.get('api')).map(file => ({ file, frame: { ...emptyFrame(), prefixes: apiPrefix ? [apiPrefix] : [], middlewares: ['api'] }, via: path })),
  ];
  // The closure's mounts: walk the file with everything outside the closure blanked.
  const closure = /\b(then|using)\s*:/g;
  closure.lastIndex = open;
  for (let m: RegExpExecArray | null; (m = closure.exec(code)) && m.index < paren.endIndex;) {
    const start = m.index + m[0].length;
    const end = expressionEnd(code, start);
    const body = content.slice(0, end).replace(/[^\r\n]/g, (c, k: number) => (k >= start ? c : ' '));
    const walked = walkRouteFile(body, path, emptyFrame(), ctx, { collectRoutes: false, root });
    entries.push(...walked.mounts.map(mount => ({ file: mount.file, frame: mount.frame, via: `${path}:${mount.line}` })));
    unresolved.push(...walked.unresolved);
  }
  return { entries, unresolved };
}

/**
 * Builds the route mount graph of one Laravel app: entry points (withRouting, RouteServiceProvider
 * or the routes/web.php + routes/api.php defaults), service-provider mounts, then every file they
 * require or include, each inheriting the group context at the point it is loaded.
 */
async function buildMountGraph(workspaceRoot: string, root: string, rootIndex: number, wctx: LaravelWorkspaceContext, ctx: ScanContext): Promise<void> {
  const read = async (rel: string) => (existsSync(join(workspaceRoot, rel)) ? readFile(join(workspaceRoot, rel), 'utf-8') : null);
  const queue: { file: string; frame: Omit<RouteMount, 'order' | 'via'>; order: number[]; via: string; depth: number }[] = [];
  const rel = (p: string) => (root ? posix.join(root, p) : p);
  const unresolved: string[] = [];
  const orderOf = (m: MountRequest) => (m.sub !== undefined ? [m.offset, m.sub] : [m.offset]);

  // Providers boot before the application's route files are loaded, so their mounts come first.
  const rspPath = rel('app/Providers/RouteServiceProvider.php');
  const providers = await listServiceProviders(workspaceRoot, root);
  for (const [pi, provider] of providers.entries()) {
    if (provider === rspPath) continue;
    const content = await read(provider);
    if (!content) continue;
    const walked = walkRouteFile(content, provider, emptyFrame(), ctx, { collectRoutes: false, root, provider: true });
    unresolved.push(...walked.unresolved.map(line => `${provider}:${line}`));
    for (const m of walked.mounts)
      queue.push({ file: m.file, frame: m.frame, order: [rootIndex, 0, pi, ...orderOf(m)], via: `${provider}:${m.line}`, depth: 0 });
  }

  const entries: { file: string; frame: Omit<RouteMount, 'order' | 'via'>; via: string }[] = [];
  const bootstrap = await read(rel('bootstrap/app.php'));
  if (bootstrap) {
    const routing = withRoutingEntries(bootstrap, rel('bootstrap/app.php'), root, ctx);
    entries.push(...routing.entries);
    unresolved.push(...routing.unresolved.map(line => `${rel('bootstrap/app.php')}:${line}`));
  }
  const rsp = await read(rspPath);
  if (rsp) {
    const legacy = { routeServiceProvider: { routes: {} } } as LaravelWorkspaceContext;
    parseRouteServiceProvider(rsp, 'app/Providers/RouteServiceProvider.php', legacy);
    for (const [file, config] of Object.entries(legacy.routeServiceProvider.routes))
      entries.push({
        file: normalizeMountPath(rel(file)),
        frame: { ...emptyFrame(), prefixes: config.prefix ? [config.prefix] : [], middlewares: config.middlewares, namespaces: config.namespace ? [config.namespace] : [] },
        via: rspPath,
      });
  }
  if (!entries.length) {
    for (const name of ['web', 'api'] as const) {
      const file = rel(`routes/${name}.php`);
      if (!existsSync(join(workspaceRoot, file))) continue;
      const config = getInitialGroupConfig(file, wctx);
      entries.push({
        file,
        frame: { ...emptyFrame(), prefixes: config.prefix ? [config.prefix] : [], middlewares: config.middlewares, namespaces: config.namespace ? [config.namespace] : [] },
        via: 'default',
      });
    }
  }
  entries.forEach((e, i) => queue.push({ ...e, order: [rootIndex, 1, i], depth: 0 }));
  if (!queue.length) return;
  wctx.knownRoots.push(root);
  wctx.unresolved.set(root, unresolved);

  while (queue.length) {
    const next = queue.shift()!;
    const mounts = wctx.mounts.get(next.file) ?? [];
    // Each (file, order) pair is a distinct mount; the depth cap stops require cycles.
    if (mounts.some(m => m.order.join('.') === next.order.join('.')) || next.depth > 8) continue;
    mounts.push({ ...next.frame, order: next.order, via: next.via });
    wctx.mounts.set(next.file, mounts);
    const content = await read(next.file);
    if (!content) continue;
    const walked = walkRouteFile(content, next.file, next.frame, ctx, { collectRoutes: false, root });
    unresolved.push(...walked.unresolved.map(line => `${next.file}:${line}`));
    for (const m of walked.mounts)
      queue.push({
        file: m.file,
        frame: { ...m.frame, conditional: next.frame.conditional || m.frame.conditional },
        order: [...next.order, ...orderOf(m)],
        via: `${next.file}:${m.line}`,
        depth: next.depth + 1,
      });
  }
}

function getInitialGroupConfig(normalizedPath: string, wctx: LaravelWorkspaceContext): { prefix: string, namespace: string, middlewares: string[] } {
  if (wctx.routeServiceProvider.routes[normalizedPath]) {
    const config = wctx.routeServiceProvider.routes[normalizedPath];
    return {
      prefix: config.prefix,
      namespace: config.namespace,
      middlewares: [...config.middlewares]
    };
  }

  if (normalizedPath === 'routes/web.php' || normalizedPath.endsWith('/routes/web.php')) {
    return {
      prefix: '',
      namespace: 'App\\Http\\Controllers',
      middlewares: ['web']
    };
  }

  if (normalizedPath === 'routes/api.php' || normalizedPath.endsWith('/routes/api.php')) {
    return {
      prefix: 'api',
      namespace: 'App\\Http\\Controllers',
      middlewares: ['api']
    };
  }

  return {
    prefix: '',
    namespace: 'App\\Http\\Controllers',
    middlewares: []
  };
}

async function resolveRouteMiddlewares(routes: RouteBinding[], wctx: LaravelWorkspaceContext) {
  for (const r of routes) {
    const mws = r.middlewares || r.metadata?.middlewares;
    if (!mws) continue;

    const expanded: string[] = [];
    for (const mw of mws) {
      if (wctx.kernelMiddlewares.groups[mw]) {
        for (const subMw of wctx.kernelMiddlewares.groups[mw]) {
          const resolved = wctx.kernelMiddlewares.aliases[subMw] || subMw;
          expanded.push(resolved);
        }
      } else {
        const resolved = wctx.kernelMiddlewares.aliases[mw] || mw;
        expanded.push(resolved);
      }
    }

    const uniqueMws = Array.from(new Set(expanded));
    r.middlewares = uniqueMws;
    if (r.metadata) {
      r.metadata.middlewares = uniqueMws;
    }
  }
}

export class LaravelDetector implements FrameworkDetector {
  readonly name = 'laravel';
  readonly language = 'php';
  readonly filePattern = /\.php$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const hasArtisan = files.some(f => f.endsWith('artisan'));
    if (hasArtisan) return true;
    // artisan is extensionless and composer.json is excluded by default, so neither is in the
    // scanned file list: look on disk, including apps nested below a parent-folder workspace.
    if (findLaravelRoots(projectRoot).length > 0) return true;

    return hasComposerDependency(projectRoot, files, ['laravel/framework', 'laravel/lumen-framework']);
  }

  beginScan(workspaceRoot: string): void {
    workspaceInitializationPromises.delete(workspaceRoot);
    controllerCache.clear();
  }

  /**
   * Laravel keeps the last registration of a method + URI. Among reachable routes, mark every
   * earlier duplicate overridden and point it at the winner's declaration.
   */
  finalizeRoutes(routes: RouteBinding[]): void {
    const byKey = new Map<string, RouteBinding[]>();
    for (const r of routes) {
      if (r.framework !== this.name || r.metadata?.reachable === false || r.metadata?.reachability === 'unknown' || !Array.isArray(r.metadata?.order)) continue;
      // Laravel's route collection keys on domain + exact URI: `{id}` and `{slug}` are two routes.
      const path = r.path;
      for (const method of r.method.split('|')) {
        // order[0] is the Laravel root: separate apps never override each other.
        const key = `${r.metadata.order[0]} ${r.metadata.domain ?? ''} ${method} ${path}`;
        byKey.set(key, [...(byKey.get(key) ?? []), r]);
      }
    }
    const compare = (a: number[], b: number[]) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
      return a.length - b.length;
    };
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => compare(a.metadata!.order, b.metadata!.order));
      const winner = group[group.length - 1]!;
      for (const r of group.slice(0, -1)) {
        if (r === winner) continue;
        r.metadata!.overridden = true;
        r.metadata!.overriddenBy = `${winner.metadata?.sourceFile ?? winner.handlerFile}:${winner.line ?? '?'}`;
      }
    }
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const wctx = await ensureWorkspaceInitialized(ctx.workspaceRoot, ctx);
    const normalizedPath = filePath.replace(/\\/g, '/');
    const lowerPath = normalizedPath.toLowerCase();

    // Support modular structures (e.g. Modules/Blog/Routes/web.php) and anything a mount loads
    const mounts = wctx.mounts.get(normalizedPath);
    const isRouteFile = !!mounts ||
                        lowerPath.includes('/routes/') ||
                        lowerPath.startsWith('routes/') ||
                        lowerPath.endsWith('/routes.php') ||
                        lowerPath.includes('/routes.php');

    const hasRouteAttributes = content.includes('RouteAttributes') ||
      content.includes('#[Route') ||
      content.includes('#[Get') ||
      content.includes('#[Post') ||
      content.includes('#[Put') ||
      content.includes('#[Patch') ||
      content.includes('#[Delete') ||
      content.includes('#[Options') ||
      content.includes('#[Any') ||
      content.includes('#[Head') ||
      content.includes('#[Prefix') ||
      content.includes('#[Middleware');

    if (!isRouteFile && !hasRouteAttributes) {
      return [];
    }

    if (isRouteFile) {
      const root = wctx.knownRoots.find(r => !r || normalizedPath.startsWith(`${r}/`));
      type Reachability = 'reachable' | 'unreachable' | 'unknown';
      let frames: { frame: Omit<RouteMount, 'order' | 'via'>; order: number[]; reachability?: Reachability; via?: string }[];
      if (mounts) {
        frames = mounts.map(m => ({ frame: m, order: m.order, reachability: 'reachable', via: m.via }));
      } else {
        // Not loaded by anything we can see: name-based defaults. Unreachable when the app's mount
        // graph is known and complete; unknown while some mount of the app can't be evaluated.
        const config = getInitialGroupConfig(normalizedPath, wctx);
        const unknown = root !== undefined && (wctx.unresolved.get(root)?.length ?? 0) > 0;
        frames = [{
          frame: { ...emptyFrame(), prefixes: config.prefix ? [config.prefix] : [], middlewares: config.middlewares, namespaces: config.namespace ? [config.namespace] : [] },
          order: [],
          reachability: root === undefined ? undefined : unknown ? 'unknown' : 'unreachable',
        }];
      }
      const routes: RouteBinding[] = [];
      for (const f of frames) {
        const walked = walkRouteFile(content, normalizedPath, f.frame, ctx, { collectRoutes: true, root: root ?? '' }).routes;
        for (const r of walked) {
          const meta = (r.metadata ??= {});
          meta.order = [...f.order, ...(meta.order ?? [])];
          if (f.reachability) meta.reachability = f.reachability;
          if (f.reachability === 'unreachable') meta.reachable = false;
          if (f.reachability === 'unknown') meta.unresolvedMounts = wctx.unresolved.get(root!)!.slice(0, 5);
          if (f.via) meta.mountedBy = f.via;
          if (f.frame.conditional) meta.conditional = true;
        }
        routes.push(...walked);
      }

      // Enrich routes with parameter details and constructor-defined middlewares
      await Promise.all(routes.map(r => enrichRouteFromController(r)));
      await resolveRouteMiddlewares(routes, wctx);
      return routes;
    }

    // Attribute Routing in Controller Files
    const routes: RouteBinding[] = [];
    const namespaceMatch = content.match(/namespace\s+([^;]+);/);
    const namespace = namespaceMatch ? namespaceMatch[1].trim() : '';

    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) return [];
    const className = classMatch[1];
    const classFqn = namespace ? `${namespace}\\${className}` : className;

    const classIndex = content.indexOf(`class ${className}`);
    const beforeClass = content.substring(0, classIndex);

    let classPrefix = '';
    const classMiddlewares: string[] = [];

    const classAttrs = extractAttributes(beforeClass);
    for (const attr of classAttrs) {
      if (attr.startsWith('Prefix')) {
        const match = attr.match(/Prefix\s*\(\s*['"]([^'"]+)['"]/);
        if (match) classPrefix = match[1];
      } else if (attr.startsWith('Route')) {
        const prefixMatch = attr.match(/prefix\s*:\s*['"]([^'"]+)['"]/);
        if (prefixMatch) {
          classPrefix = prefixMatch[1];
        } else {
          const argsMatch = attr.match(/Route\s*\(\s*['"]([^'"]+)['"]/);
          if (argsMatch && !attr.includes('method')) {
            classPrefix = argsMatch[1];
          }
        }
        
        const mwMatch = attr.match(/middleware\s*:\s*['"]([^'"]+)['"]/);
        if (mwMatch) {
          classMiddlewares.push(mwMatch[1]);
        } else {
          const mwsMatch = attr.match(/middleware\s*:\s*\[([^\]]+)\]/);
          if (mwsMatch) {
            const matches = mwsMatch[1].match(/['"]([^'"]+)['"]/g) || [];
            classMiddlewares.push(...matches.map(m => m.replace(/['"]/g, '')));
          }
        }
      } else if (attr.startsWith('Middleware')) {
        if (attr.includes('[')) {
          const matches = attr.match(/['"]([^'"]+)['"]/g) || [];
          classMiddlewares.push(...matches.map(m => m.replace(/['"]/g, '')));
        } else {
          const match = attr.match(/Middleware\s*\(\s*['"]([^'"]+)['"]/);
          if (match) classMiddlewares.push(match[1]);
        }
      }
    }

    const parts = content.substring(classIndex).split(/\bfunction\s+/);
    // Offset of each `function ` the split consumed: parts[idx] follows methodOffsets[idx - 1].
    const methodOffsets = [...content.substring(classIndex).matchAll(/\bfunction\s+/g)].map(m => classIndex + m.index!);
    let previousText = parts[0];

    for (let idx = 1; idx < parts.length; idx++) {
      const part = parts[idx];
      const nameMatch = part.match(/^(\w+)\s*\(/);
      if (!nameMatch) {
        previousText += ' function ' + part;
        continue;
      }
      const methodName = nameMatch[1];
      
      // Restrict method attributes scan to text after the previous function's closing curly brace
      const lastCloseBrace = previousText.lastIndexOf('}');
      const searchSpace = lastCloseBrace !== -1 ? previousText.substring(lastCloseBrace + 1) : previousText;
      const methodAttrs = extractAttributes(searchSpace);

      for (const attr of methodAttrs) {
        const verbMatch = attr.match(/^(Get|Post|Put|Patch|Delete|Options|Any|Head|Route)\b/);
        if (!verbMatch) continue;

        const attrName = verbMatch[1];
        let verb = attrName === 'Route' ? 'GET' : attrName.toUpperCase();
        let uri = '';
        const methodMiddlewares: string[] = [];

        if (attrName === 'Route') {
          const verbParamMatch = attr.match(/Route\s*\(\s*['"]([^'"]+)['"]/);
          if (verbParamMatch) {
            verb = verbParamMatch[1].toUpperCase();
          }
          const uriParamMatch = attr.match(/Route\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/);
          if (uriParamMatch) {
            uri = uriParamMatch[1];
          } else {
            const uriNamedMatch = attr.match(/uri\s*:\s*['"]([^'"]+)['"]/);
            if (uriNamedMatch) uri = uriNamedMatch[1];
          }
        } else {
          const uriParamMatch = attr.match(/^[a-zA-Z]+\s*\(\s*['"]([^'"]+)['"]/);
          if (uriParamMatch) uri = uriParamMatch[1];
        }

        const mwAttrs = methodAttrs.filter(a => a.startsWith('Middleware'));
        for (const mwAttr of mwAttrs) {
          if (mwAttr.includes('[')) {
            const matches = mwAttr.match(/['"]([^'"]+)['"]/g) || [];
            methodMiddlewares.push(...matches.map(m => m.replace(/['"]/g, '')));
          } else {
            const match = mwAttr.match(/Middleware\s*\(\s*['"]([^'"]+)['"]/);
            if (match) methodMiddlewares.push(match[1]);
          }
        }

        const cleanClassPrefix = classPrefix.replace(/^\/|\/$/g, '').trim();
        const cleanUri = uri.replace(/^\/|\/$/g, '').trim();
        const fullPath = '/' + [cleanClassPrefix, cleanUri].filter(Boolean).join('/');
        const allMiddlewares = Array.from(new Set([...classMiddlewares, ...methodMiddlewares]));
        // The attribute's own line (M1-09): the last occurrence of its text before the method.
        const methodAt = methodOffsets[idx - 1] ?? classIndex;
        const attrAt = content.lastIndexOf(attr, methodAt);
        const line = lineAt(content, attrAt >= 0 ? attrAt : methodAt);

        routes.push({
          framework: this.name,
          method: verb,
          path: fullPath,
          handlerFile: filePath,
          handlerSymbol: `${classFqn}@${methodName}`,
          line,
          metadata: {
            confidence: 'inferred',
            middlewares: allMiddlewares,
            line,
          },
        });
      }

      previousText = part;
    }

    await Promise.all(routes.map(r => enrichRouteFromController(r)));
    await resolveRouteMiddlewares(routes, wctx);
    return routes;
  }

  async extractHooks(filePath: string, content: string, ctx: ScanContext): Promise<HookBinding[]> {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const lowerPath = normalizedPath.toLowerCase();
    const hooks: HookBinding[] = [];

    // 1. Kernel.php file (Middlewares)
    if (lowerPath.endsWith('app/http/kernel.php') || normalizedPath.endsWith('Kernel.php')) {
      const wctx = await ensureWorkspaceInitialized(ctx.workspaceRoot, ctx);
      
      // Add all aliases
      for (const [alias, fqn] of Object.entries(wctx.kernelMiddlewares.aliases)) {
        const resolvedPath = ctx.resolveSymbolToFile(fqn);
        hooks.push({
          framework: this.name,
          hookName: alias,
          hookType: 'middleware',
          handlerFile: resolvedPath || filePath,
          handlerSymbol: fqn,
          metadata: {
            confidence: 'declared',
            middlewareType: 'alias'
          }
        });
        // Register concrete FQN as a hook (qualified entry)
        hooks.push({
          framework: this.name,
          hookName: fqn,
          hookType: 'middleware',
          handlerFile: resolvedPath || filePath,
          handlerSymbol: fqn,
          metadata: {
            confidence: 'declared',
            middlewareType: 'concrete_qualified'
          }
        });
      }

      // Add all groups
      for (const [groupName, mws] of Object.entries(wctx.kernelMiddlewares.groups)) {
        for (const mw of mws) {
          const resolvedPath = ctx.resolveSymbolToFile(mw);
          hooks.push({
            framework: this.name,
            hookName: groupName,
            hookType: 'middleware',
            handlerFile: resolvedPath || filePath,
            handlerSymbol: mw,
            metadata: {
              confidence: 'declared',
              middlewareType: 'group_member'
            }
          });
          // Register concrete member FQN as a hook (qualified entry)
          hooks.push({
            framework: this.name,
            hookName: mw,
            hookType: 'middleware',
            handlerFile: resolvedPath || filePath,
            handlerSymbol: mw,
            metadata: {
              confidence: 'declared',
              middlewareType: 'group_member_qualified'
            }
          });
        }
      }
    }

    // 2. Service Provider files
    if (normalizedPath.endsWith('ServiceProvider.php')) {
      const namespaceMatch = content.match(/namespace\s+([^;]+);/);
      const namespace = namespaceMatch ? namespaceMatch[1].trim() : '';
      const classMatch = content.match(/class\s+(\w+)/);
      if (classMatch) {
        const className = classMatch[1];
        const classFqn = namespace ? `${namespace}\\${className}` : className;
        // Register fully-qualified name as a hook
        hooks.push({
          framework: this.name,
          hookName: classFqn,
          hookType: 'service_provider',
          handlerFile: filePath,
          handlerSymbol: classFqn,
          metadata: {
            confidence: 'declared'
          }
        });
        // Register simple class name as hook
        hooks.push({
          framework: this.name,
          hookName: className,
          hookType: 'service_provider',
          handlerFile: filePath,
          handlerSymbol: classFqn,
          metadata: {
            confidence: 'declared',
            aliasOf: classFqn
          }
        });
      }
    }

    return hooks;
  }
}

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------

function parseUseImports(fileContent: string): Map<string, string> {
  const imports = new Map<string, string>();
  // Match use statements: use App\Http\Controllers\UserController;
  // or alias: use App\Http\Controllers\UserController as UserCtrl;
  const singleMatches = fileContent.matchAll(/use\s+([a-zA-Z0-9_\\]+)(?:\s+as\s+([a-zA-Z0-9_]+))?\s*;/g);
  for (const match of singleMatches) {
    const fqn = match[1];
    const alias = match[2];
    const shortName = alias || fqn.split('\\').pop() || '';
    imports.set(shortName, fqn);
  }
  return imports;
}

function splitAttributes(bracketContent: string): string[] {
  const attrs: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;

  for (let i = 0; i < bracketContent.length; i++) {
    const char = bracketContent[i];
    if (escape) {
      escape = false;
      current += char;
      continue;
    }
    if (char === '\\') {
      escape = true;
      current += char;
      continue;
    }
    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      inString = true;
      stringChar = char;
      current += char;
      continue;
    }
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    }

    if (char === ',' && depth === 0) {
      attrs.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    attrs.push(current.trim());
  }
  return attrs;
}

function extractAttributes(text: string): string[] {
  const attrs: string[] = [];
  let index = 0;
  while (true) {
    const start = text.indexOf('#[', index);
    if (start === -1) break;

    const bracket = getBracketedContent(text, start + 1);
    if (!bracket) {
      index = start + 2;
      continue;
    }

    const split = splitAttributes(bracket.content);
    attrs.push(...split);
    index = bracket.endIndex;
  }
  return attrs;
}

function getParenthesizedContent(str: string, startIndex: number): { content: string, endIndex: number } | null {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;

  for (let i = startIndex; i < str.length; i++) {
    const char = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      inString = true;
      stringChar = char;
      continue;
    }
    if (char === '(') {
      depth++;
      if (depth === 1) {
        startIndex = i + 1;
      }
    } else if (char === ')') {
      depth--;
      if (depth === 0) {
        return {
          content: str.substring(startIndex, i),
          endIndex: i + 1
        };
      }
    }
  }
  return null;
}

/**
 * Parenthesised content found by scanning `code` (a masked view, see maskPhp) and sliced from
 * `text`, a same-length view that still has the string contents.
 */
function parenAt(code: string, text: string, index: number): { content: string, endIndex: number } | null {
  const paren = getParenthesizedContent(code, index);
  if (!paren || code === text) return paren;
  return { content: text.slice(paren.endIndex - 1 - paren.content.length, paren.endIndex - 1), endIndex: paren.endIndex };
}

/**
 * Parses `Route::x(...)->y(...)` at startIndex. Structure is read from `code` and arguments are
 * sliced from `text` (both same-length masked views; they default to the same string).
 */
function parseRouteChain(code: string, startIndex: number, text = code): { calls: ChainedCall[], endIndex: number } | null {
  const content = code;
  let index = startIndex;
  const calls: ChainedCall[] = [];

  const initMatch = content.substring(index).match(/^Route::([a-zA-Z0-9_]+)\s*\(/);
  if (!initMatch) return null;

  const name = initMatch[1];
  index += initMatch[0].length - 1;

  if (name === 'group') {
    const paren = parenAt(code, text, index);
    const args = paren ? paren.content : '';
    calls.push({ name: 'group', args });
    return { calls, endIndex: index + 1 };
  }

  const paren = parenAt(code, text, index);
  if (!paren) return null;

  calls.push({ name, args: paren.content });
  index = paren.endIndex;

  while (true) {
    const wsMatch = content.substring(index).match(/^\s+/);
    if (wsMatch) {
      index += wsMatch[0].length;
    }

    if (content.substring(index, index + 2) !== '->') {
      break;
    }

    const methodMatch = content.substring(index + 2).match(/^([a-zA-Z0-9_]+)\s*\(/);
    if (!methodMatch) {
      break;
    }

    const methodName = methodMatch[1];
    index += 2 + methodMatch[0].length - 1;

    if (methodName === 'group') {
      const methodParen = parenAt(code, text, index);
      const args = methodParen ? methodParen.content : '';
      calls.push({ name: 'group', args });
      return { calls, endIndex: index + 1 };
    }

    const methodParen = parenAt(code, text, index);
    if (!methodParen) {
      break;
    }

    calls.push({ name: methodName, args: methodParen.content });
    index = methodParen.endIndex;
  }

  return { calls, endIndex: index };
}

function parseArgs(argsStr: string, raw = false): string[] {
  const finish = (arg: string) => (raw ? arg : cleanQuotes(arg));
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let bracketDepth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];
    if (escape) {
      escape = false;
      current += char;
      continue;
    }
    if (char === '\\') {
      escape = true;
      current += char;
      continue;
    }
    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      inString = true;
      stringChar = char;
      current += char;
      continue;
    }
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    } else if (char === '[') {
      bracketDepth++;
    } else if (char === ']') {
      bracketDepth--;
    }

    if (char === ',' && depth === 0 && bracketDepth === 0) {
      args.push(finish(current.trim()));
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    args.push(finish(current.trim()));
  }
  return args;
}

function cleanQuotes(str: string): string {
  return str.replace(/^['"]|['"]$/g, '');
}

function getBracketedContent(str: string, startIndex: number): { content: string, endIndex: number } | null {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;

  for (let i = startIndex; i < str.length; i++) {
    const char = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      inString = true;
      stringChar = char;
      continue;
    }
    if (char === '[') {
      depth++;
      if (depth === 1) {
        startIndex = i + 1;
      }
    } else if (char === ']') {
      depth--;
      if (depth === 0) {
        return {
          content: str.substring(startIndex, i),
          endIndex: i + 1
        };
      }
    }
  }
  return null;
}

/** Path segment standing for a URI part or prefix that can't be evaluated statically (M1-06). */
const DYNAMIC = '{dynamic}';
const literalScope = (): PhpScope => ({ dir: '', root: '', vars: new Map() });

/** A URI or prefix argument evaluated as PHP; anything unresolvable becomes {dynamic}. */
function pathArg(raw: string, scope: PhpScope): string {
  return phpString(raw, scope, DYNAMIC) ?? DYNAMIC;
}

function parseGroupAttributes(argsStr: string, scope: PhpScope = literalScope()): { prefixes: string[], middlewares: string[], namespaces: string[], domain: string | null, names: string[] } {
  const prefixes: string[] = [];
  const middlewares: string[] = [];
  const namespaces: string[] = [];
  const names: string[] = [];
  let domain: string | null = null;

  const trimmed = argsStr.trim();
  let arrayContent = '';
  if (trimmed.startsWith('[')) {
    const bracket = getBracketedContent(trimmed, 0);
    if (bracket) arrayContent = bracket.content;
  } else if (trimmed.startsWith('array(')) {
    const paren = getParenthesizedContent(trimmed, 5);
    if (paren) arrayContent = paren.content;
  } else {
    return { prefixes, middlewares, namespaces, domain, names };
  }

  if (arrayContent) {
    // 1. Extract prefix and domain, evaluated like a URI (literals, concatenation, variables,
    // interpolation), and the route name prefix ('as').
    for (const entry of parseArgs(arrayContent, true)) {
      const m = entry.match(/^(['"])(prefix|domain|as)\1\s*=>\s*([\s\S]+)$/);
      if (!m) continue;
      if (m[2] === 'as') {
        const name = phpString(m[3]!.trim(), scope);
        if (name) names.push(name);
        continue;
      }
      const value = pathArg(m[3]!.trim(), scope);
      if (m[2] === 'domain') domain = value || null;
      else if (value) prefixes.push(value);
    }

    // 2. Extract namespace
    const namespaceMatch = arrayContent.match(/['"]namespace['"]\s*=>\s*['"]([^'"]+)['"]/);
    if (namespaceMatch) {
      namespaces.push(namespaceMatch[1]);
    }

    // 3. Extract middleware
    const mwIndex = arrayContent.search(/['"]middleware['"]\s*=>/);
    if (mwIndex !== -1) {
      const afterMw = arrayContent.substring(mwIndex).replace(/^['"]middleware['"]\s*=>\s*/, '').trim();
      if (afterMw.startsWith('[')) {
        const bracket = getBracketedContent(afterMw, 0);
        if (bracket) {
          const matches = bracket.content.match(/['"]([^'"]+)['"]/g) || [];
          middlewares.push(...matches.map(m => m.replace(/['"]/g, '')));
        }
      } else if (afterMw.startsWith('array(')) {
        const paren = getParenthesizedContent(afterMw, 5);
        if (paren) {
          const matches = paren.content.match(/['"]([^'"]+)['"]/g) || [];
          middlewares.push(...matches.map(m => m.replace(/['"]/g, '')));
        }
      } else {
        const match = afterMw.match(/^['"]([^'"]+)['"]/);
        if (match) {
          middlewares.push(match[1]);
        }
      }
    }
  }

  return { prefixes, middlewares, namespaces, domain, names };
}

/**
 * Entries of a PHP array literal (`[...]` or `array(...)`): `key => value` pairs with a string
 * key, and positional values with key null. Null when the argument is not an array literal.
 */
function phpArrayEntries(arg: string | undefined): { key: string | null; value: string }[] | null {
  const t = arg?.trim() ?? '';
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1)
    : /^array\s*\(/i.test(t) && t.endsWith(')') ? t.slice(t.indexOf('(') + 1, -1)
    : null;
  if (inner === null) return null;
  return parseArgs(inner, true).map(entry => {
    const m = entry.match(/^(['"])((?:\\.|(?!\1).)*)\1\s*=>\s*([\s\S]*)$/);
    return m ? { key: m[2]!, value: m[3]!.trim() } : { key: null, value: entry };
  });
}

/** A `['key' => 'value', ...]` array of strings. */
function stringMap(arg: string, scope: PhpScope): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { key, value } of phpArrayEntries(arg) ?? []) {
    const v = key === null ? null : phpString(value, scope);
    if (key !== null && v !== null) map[key] = v;
  }
  return map;
}

/** A controller argument: `Foo::class` or a string class name. */
function classArg(arg: string, scope: PhpScope): string | null {
  return arg.trim().match(/^\\?([\w\\]+)::class$/)?.[1] ?? phpString(arg, scope);
}

/** Options of a resource registration: the options array and PendingResourceRegistration calls. */
interface ResourceOptions {
  only?: string[];
  except?: string[];
  parameters?: Record<string, string>;
  /** `names` option: one base name for every action, or a name per action. */
  names?: string | Record<string, string>;
  /** `as` option: a name prefix joined with `.`. */
  as?: string;
  middleware?: string[];
  shallow?: boolean;
}

/** The options array of `Route::resource($name, $controller, $options)` and `Route::resources($map, $options)`. */
function parseResourceOptions(arg: string | undefined, scope: PhpScope): ResourceOptions {
  const options: ResourceOptions = {};
  for (const { key, value } of phpArrayEntries(arg) ?? []) {
    if (key === 'only' || key === 'except') options[key] = listArg(value);
    else if (key === 'parameters') options.parameters = stringMap(value, scope);
    else if (key === 'names') options.names = phpArrayEntries(value) ? stringMap(value, scope) : phpString(value, scope) ?? undefined;
    else if (key === 'as') options.as = phpString(value, scope) ?? undefined;
    else if (key === 'middleware') options.middleware = listArg(value);
    else if (key === 'shallow') options.shallow = /^true$/i.test(value);
  }
  return options;
}

/**
 * Laravel's group namespace merge: a nested namespace is appended to the outer one unless it is
 * absolute (leading backslash). One that already starts with the outer namespace is kept as is.
 */
function mergeNamespaces(namespaces: string[]): string {
  let merged = '';
  for (const raw of namespaces) {
    const ns = raw.replace(/\\\\/g, '\\');
    if (!ns) continue;
    const trimmed = ns.replace(/^\\+|\\+$/g, '');
    merged = ns.startsWith('\\') || !merged || trimmed === merged || trimmed.startsWith(`${merged}\\`) ? trimmed : `${merged}\\${trimmed}`;
  }
  return merged;
}

/** Fully-qualified controller class: use imports first, then the merged group namespace. */
function controllerFqn(cls: string, useImports: Map<string, string>, namespaces: string[]): string {
  if (useImports.has(cls)) return useImports.get(cls)!.replace(/^\\/, '');
  if (cls.startsWith('\\')) return cls.substring(1);
  const ns = mergeNamespaces(namespaces);
  return ns ? `${ns}\\${cls}` : cls;
}

function getResourceParam(resourceName: string): string {
  return resourceParam(resourceName);
}

const API_RESOURCE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy'];

/**
 * The routes of one resource registration, following Laravel's ResourceRegistrar: everything
 * before the last `/` is a URI prefix; `a.b` nests `b` under `a/{a}`; every segment's wildcard is
 * its `parameters` entry or its singular; `shallow` drops the parents from member routes; route
 * names are `[as.]<name>.<action>` unless `names` overrides them, behind the group name prefix.
 * MapX keeps `update` as two routes (PUT and PATCH) where Laravel registers one PUT|PATCH route.
 */
function expandResourceRoute(
  frameworkName: string,
  resourceName: string,
  controllerName: string,
  resolvedFile: string,
  fullPrefixes: string[],
  groupMiddlewares: string[],
  isApi: boolean,
  options: ResourceOptions = {},
  namePrefix = '',
): RouteBinding[] {
  const clean = resourceName.replace(/^\/+|\/+$/g, '');
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  const uriPrefix = clean.slice(0, Math.max(0, clean.lastIndexOf('/')));
  const wildcard = (segment: string) => (options.parameters?.[segment] ?? getResourceParam(segment)).replace(/-/g, '_');
  // getResourceUri: each segment followed by its wildcard, minus the last segment's wildcard.
  const resourceUri = (n: string) => {
    const segments = n.split('.');
    if (segments.length === 1) return n;
    return segments.map(s => `${s}/{${wildcard(s)}}`).join('/').split(`/{${wildcard(segments[segments.length - 1]!)}}`).join('');
  };
  const param = wildcard(name.split('.').pop()!);
  const memberName = options.shallow ? name.split('.').pop()! : name;
  const cleanPrefixes = [...fullPrefixes, uriPrefix].map(p => p.replace(/^\/|\/$/g, '')).filter(Boolean);
  const routeName = (n: string, action: string) => {
    if (typeof options.names === 'object' && options.names[action]) return namePrefix + options.names[action];
    const base = typeof options.names === 'string' ? options.names : n;
    return namePrefix + `${options.as ? `${options.as}.` : ''}${base}.${action}`.replace(/^\.+|\.+$/g, '');
  };
  // apiResource() is resource() with `only` defaulting to the API actions minus `except`.
  const only = options.only ?? (isApi ? API_RESOURCE_ACTIONS.filter(a => !options.except?.includes(a)) : undefined);
  const middlewares = [...groupMiddlewares, ...(options.middleware ?? [])];

  const routesDefs = [
    { method: 'GET', pathSuffix: '', action: 'index', member: false },
    { method: 'GET', pathSuffix: '/create', action: 'create', member: false },
    { method: 'POST', pathSuffix: '', action: 'store', member: false },
    { method: 'GET', pathSuffix: `/{${param}}`, action: 'show', member: true },
    { method: 'GET', pathSuffix: `/{${param}}/edit`, action: 'edit', member: true },
    { method: 'PUT', pathSuffix: `/{${param}}`, action: 'update', member: true },
    { method: 'PATCH', pathSuffix: `/{${param}}`, action: 'update', member: true },
    { method: 'DELETE', pathSuffix: `/{${param}}`, action: 'destroy', member: true },
  ];

  return routesDefs
    .filter(def => (!only || only.includes(def.action)) && !options.except?.includes(def.action))
    .map(def => {
    const n = def.member ? memberName : name;
    const fullPath = ('/' + [...cleanPrefixes, resourceUri(n)].join('/') + def.pathSuffix).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return {
      framework: frameworkName,
      method: def.method,
      path: fullPath,
      handlerFile: resolvedFile,
      handlerSymbol: `${controllerName}@${def.action}`,
      metadata: {
        confidence: 'inferred',
        resourceType: isApi ? 'apiResource' : 'resource',
        middlewares,
        name: routeName(n, def.action),
      }
    };
  });
}

function parseControllerMiddlewares(controllerContent: string): { middleware: string, only: string[], except: string[] }[] {
  const middlewares: { middleware: string, only: string[], except: string[] }[] = [];

  const constructIndex = controllerContent.indexOf('function __construct');
  if (constructIndex === -1) return [];

  const startIndex = controllerContent.indexOf('{', constructIndex);
  if (startIndex === -1) return [];

  let braceDepth = 0;
  let constructBody = '';
  for (let i = startIndex; i < controllerContent.length; i++) {
    const char = controllerContent[i];
    if (char === '{') {
      braceDepth++;
    } else if (char === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        constructBody = controllerContent.substring(startIndex + 1, i);
        break;
      }
    }
  }

  if (!constructBody) return [];

  let searchIndex = 0;
  while (true) {
    const mwPos = constructBody.indexOf('$this->middleware', searchIndex);
    if (mwPos === -1) break;

    const semiPos = constructBody.indexOf(';', mwPos);
    if (semiPos === -1) {
      searchIndex = mwPos + 17;
      continue;
    }

    const statement = constructBody.substring(mwPos, semiPos);
    searchIndex = semiPos + 1;

    const mwParenMatch = statement.match(/\$this->middleware\s*\(\s*(['"][^'"]+['"]|\[[^\]]+\]|[^)]+)\s*\)/);
    if (!mwParenMatch) continue;

    const rawMw = mwParenMatch[1].trim();
    const mwNames: string[] = [];
    if (rawMw.startsWith('[')) {
      const matches = rawMw.match(/['"]([^'"]+)['"]/g) || [];
      mwNames.push(...matches.map(m => m.replace(/['"]/g, '')));
    } else {
      mwNames.push(rawMw.replace(/['"]/g, ''));
    }

    let onlyMethods: string[] = [];
    let exceptMethods: string[] = [];

    const onlyMatch = statement.match(/->only\s*\(\s*(['"][^'"]+['"]|\[[^\]]+\]|[^)]+)\s*\)/);
    if (onlyMatch) {
      const rawOnly = onlyMatch[1].trim();
      if (rawOnly.startsWith('[')) {
        const matches = rawOnly.match(/['"]([^'"]+)['"]/g) || [];
        onlyMethods = matches.map(m => m.replace(/['"]/g, ''));
      } else {
        onlyMethods = rawOnly.replace(/['"]/g, '').split(',').map(m => m.trim());
      }
    }

    const exceptMatch = statement.match(/->except\s*\(\s*(['"][^'"]+['"]|\[[^\]]+\]|[^)]+)\s*\)/);
    if (exceptMatch) {
      const rawExcept = exceptMatch[1].trim();
      if (rawExcept.startsWith('[')) {
        const matches = rawExcept.match(/['"]([^'"]+)['"]/g) || [];
        exceptMethods = matches.map(m => m.replace(/['"]/g, ''));
      } else {
        exceptMethods = rawExcept.replace(/['"]/g, '').split(',').map(m => m.trim());
      }
    }

    for (const middleware of mwNames) {
      middlewares.push({ middleware, only: onlyMethods, except: exceptMethods });
    }
  }

  return middlewares;
}

function getMethodContent(controllerContent: string, methodName: string): string {
  const methodRegex = new RegExp(`public\\s+function\\s+${methodName}\\s*\\(`, 'i');
  const match = controllerContent.match(methodRegex);
  if (!match) return '';

  const startIndex = controllerContent.indexOf('{', match.index);
  if (startIndex === -1) return '';

  let braceDepth = 0;
  for (let i = startIndex; i < controllerContent.length; i++) {
    const char = controllerContent[i];
    if (char === '{') {
      braceDepth++;
    } else if (char === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        return controllerContent.substring(startIndex, i + 1);
      }
    }
  }
  return '';
}

function parseMethodParams(methodContent: string): { name: string, type: 'query' | 'body' | 'path' | 'validation' }[] {
  const params: { name: string, type: 'query' | 'body' | 'path' | 'validation' }[] = [];
  const seen = new Set<string>();

  const addParam = (name: string, type: 'query' | 'body' | 'path' | 'validation') => {
    const key = `${name}:${type}`;
    if (!seen.has(key)) {
      seen.add(key);
      params.push({ name, type });
    }
  };

  const queryMatches = methodContent.matchAll(/->query\s*\(\s*['"]([^'"]+)['"]/g);
  for (const match of queryMatches) {
    addParam(match[1], 'query');
  }

  const inputMatches = methodContent.matchAll(/->(?:input|get)\s*\(\s*['"]([^'"]+)['"]/g);
  for (const match of inputMatches) {
    addParam(match[1], 'body');
  }

  const helperMatches = methodContent.matchAll(/\brequest\s*\(\s*['"]([^'"]+)['"]/g);
  for (const match of helperMatches) {
    addParam(match[1], 'body');
  }

  const facadeMatches = methodContent.matchAll(/\bRequest::(?:get|input)\s*\(\s*['"]([^'"]+)['"]/g);
  for (const match of facadeMatches) {
    addParam(match[1], 'body');
  }

  const magicMatches = methodContent.matchAll(/\$request->([a-zA-Z0-9_]+)\b/g);
  const excludedMagic = new Set(['user', 'validate', 'session', 'file', 'cookies', 'headers', 'all', 'input', 'query', 'get', 'has', 'filled', 'anyFilled', 'missing', 'only', 'except', 'merge', 'replace']);
  for (const match of magicMatches) {
    const prop = match[1];
    if (!excludedMagic.has(prop)) {
      addParam(prop, 'body');
    }
  }

  const valIndex = methodContent.indexOf('validate');
  if (valIndex !== -1) {
    const afterVal = methodContent.substring(valIndex);
    const bracket = afterVal.match(/validate\s*\(\s*\[([\s\S]*?)\]/);
    if (bracket) {
      const keys = bracket[1].matchAll(/['"]([^'"]+)['"]\s*=>/g);
      for (const keyMatch of keys) {
        addParam(keyMatch[1], 'validation');
      }
    }
  }

  return params;
}

async function enrichRouteFromController(route: RouteBinding) {
  if (!route.handlerSymbol || !route.handlerSymbol.includes('@')) return;
  if (!route.handlerFile || !existsSync(route.handlerFile)) return;

  const [controllerClass, methodName] = route.handlerSymbol.split('@');

  let cached = controllerCache.get(route.handlerFile);
  if (!cached) {
    try {
      const content = await readFile(route.handlerFile, 'utf-8');
      const middlewares = parseControllerMiddlewares(content);
      cached = { content, middlewares };
      controllerCache.set(route.handlerFile, cached);
    } catch {
      return;
    }
  }

  // 1. Associate constructor-defined middlewares
  const matchedMws: string[] = [];
  for (const mw of cached.middlewares) {
    let applies = false;
    if (mw.only.length > 0) {
      applies = mw.only.includes(methodName);
    } else if (mw.except.length > 0) {
      applies = !mw.except.includes(methodName);
    } else {
      applies = true;
    }
    if (applies) {
      matchedMws.push(mw.middleware);
    }
  }

  if (matchedMws.length > 0) {
    if (!route.middlewares) route.middlewares = [];
    route.middlewares = Array.from(new Set([...route.middlewares, ...matchedMws]));
    if (!route.metadata) route.metadata = {};
    route.metadata.middlewares = Array.from(new Set([...(route.metadata.middlewares || []), ...matchedMws]));
  }

  // 2. Parse method query, body, and validation parameters
  const methodContent = getMethodContent(cached.content, methodName);
  if (methodContent) {
    const params = parseMethodParams(methodContent);
    const queryParams = params.filter(p => p.type === 'query').map(p => p.name);
    const bodyParams = params.filter(p => p.type === 'body' || p.type === 'validation').map(p => p.name);
    
    if (queryParams.length > 0) {
      if (!route.metadata) route.metadata = {};
      route.metadata.queryParams = Array.from(new Set([...(route.metadata.queryParams || []), ...queryParams]));
    }
    if (bodyParams.length > 0) {
      if (!route.metadata) route.metadata = {};
      route.metadata.bodyParams = Array.from(new Set([...(route.metadata.bodyParams || []), ...bodyParams]));
    }
  }

  // 3. Extract path parameters from route path
  const pathParams = (route.path.match(/\{([^}]+)\}/g) || []).map(p => p.replace(/[{}]/g, ''));
  if (pathParams.length > 0) {
    if (!route.metadata) route.metadata = {};
    route.metadata.pathParams = Array.from(new Set([...(route.metadata.pathParams || []), ...pathParams]));
  }
}

interface WalkOptions {
  collectRoutes: boolean;
  /** Laravel app root, for base_path() and friends. */
  root: string;
  /** A service provider: methods Laravel never runs are ignored (see liveProviderCode). */
  provider?: boolean;
}

/** Group attributes declared by a chain itself (prefix, middleware, namespace, controller, group array). */
function chainAttributes(calls: ChainedCall[], scope: PhpScope) {
  const prefixes: string[] = [];
  const middlewares: string[] = [];
  const namespaces: string[] = [];
  const names: string[] = [];
  let controller: string | null = null;
  let domain: string | null = null;
  for (const call of calls) {
    if (call.name === 'prefix') {
      const a = parseArgs(call.args, true)[0];
      if (a) prefixes.push(pathArg(a, scope));
    } else if (call.name === 'name' || call.name === 'as') {
      // A RouteRegistrar attribute: the last one wins.
      const a = parseArgs(call.args, true)[0];
      const name = a ? phpString(a, scope) : null;
      if (name !== null) names.splice(0, names.length, name);
    } else if (call.name === 'domain') {
      const a = parseArgs(call.args, true)[0];
      if (a) domain = pathArg(a, scope);
    } else if (call.name === 'middleware' || call.name === 'withoutMiddleware') {
      if (call.name === 'withoutMiddleware') continue;
      middlewares.push(...listArg(call.args));
    } else if (call.name === 'namespace') {
      const a = parseArgs(call.args)[0];
      if (a) namespaces.push(a);
    } else if (call.name === 'controller') {
      controller = parseArgs(call.args)[0]?.match(/([a-zA-Z0-9_\\]+)/)?.[1] ?? null;
    } else if (call.name === 'group' && /^\s*(\[|array\()/.test(call.args)) {
      const attrs = parseGroupAttributes(call.args, scope);
      prefixes.push(...attrs.prefixes);
      middlewares.push(...attrs.middlewares);
      namespaces.push(...attrs.namespaces);
      names.push(...attrs.names);
      domain = attrs.domain ?? domain;
    }
  }
  return { prefixes, middlewares, namespaces, controller, domain, names };
}

/** A string or array-of-strings argument, e.g. 'auth' or ['auth', 'verified']. */
function listArg(args: string): string[] {
  const trimmed = args.trim();
  if (/^(\[|array\s*\()/i.test(trimmed)) return (trimmed.match(/['"]([^'"]+)['"]/g) || []).map(m => m.replace(/['"]/g, ''));
  const a = parseArgs(trimmed)[0];
  return a ? [a] : [];
}

const lineAt = (content: string, index: number) => content.slice(0, index).split('\n').length;

/** End of the expression starting at `start` in masked code: `;`, `,` or an unbalanced closer. */
function expressionEnd(code: string, start: number): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if ((c === ';' || c === ',') && depth === 0) return i;
    else if (c === '?' && code[i + 1] === '>') return i;
  }
  return code.length;
}

/** Strips parentheses that wrap a whole expression: `(__DIR__.'/x.php')` → `__DIR__.'/x.php'`. */
function unwrapParens(expr: string): string {
  let e = expr.trim();
  while (e.startsWith('(')) {
    const paren = getParenthesizedContent(e, 0);
    if (!paren || paren.endIndex !== e.length) break;
    e = paren.content.trim();
  }
  return e;
}

/** One open route group while walking a file; `end` is where its group(...) call closes. */
interface GroupFrame {
  prefixes: string[];
  middlewares: string[];
  namespaces: string[];
  /** Route name prefixes, concatenated outermost first. */
  names: string[];
  controller: string | null;
  domain?: string | null;
  end: number;
}

/**
 * Walks a PHP file that declares routes. Tracks the group stack and conditional blocks, and
 * reports routes (when collectRoutes) and mounts: require/include of a file, `->group(<path>)`,
 * the legacy `Route::group($attributes, <path>)` and `$this->loadRoutesFrom(<path>)`, each with
 * the group context in force at that point.
 *
 * Structure is read from a masked copy (maskPhp), so comments, strings and heredocs never yield
 * routes, mounts, braces or statement ends; arguments are sliced from the comment-free copy.
 * A group lasts until its call's closing parenthesis, whatever its body: a closure, an arrow
 * function or nothing at all.
 */
function walkRouteFile(
  content: string,
  filePath: string,
  frame: Omit<RouteMount, 'order' | 'via'>,
  ctx: ScanContext,
  options: WalkOptions,
): { routes: RouteBinding[]; mounts: MountRequest[]; unresolved: number[] } {
  const routes: RouteBinding[] = [];
  const mounts: MountRequest[] = [];
  /** Lines of mounts whose path could not be evaluated. */
  const unresolved: number[] = [];
  const { code, text } = options.provider ? liveProviderCode(content) : maskPhp(content);
  const dir = posix.dirname(filePath) === '.' ? '' : posix.dirname(filePath);
  const assignments = stringAssignments(text, code);
  const useImports = parseUseImports(text);
  const scopeAt = (index: number): PhpScope => ({ dir, root: options.root, vars: varsAt(assignments, index) });
  const conditionalBraces: boolean[] = [];
  const groupStack: GroupFrame[] = [{
    prefixes: frame.prefixes,
    middlewares: frame.middlewares,
    namespaces: frame.namespaces,
    names: frame.names ?? [],
    controller: frame.controller,
    domain: frame.domain ?? null,
    end: Infinity,
  }];
  // A statement that is the brace-less body of an if/else (`if (x) require ...;`).
  const bracelessIf = (index: number) => opensConditionalBlock(code.slice(Math.max(0, index - 300), index));
  const inConditional = () => conditionalBraces.some(Boolean);
  const current = () => ({
    prefixes: groupStack.flatMap(g => g.prefixes),
    middlewares: groupStack.flatMap(g => g.middlewares),
    namespaces: groupStack.flatMap(g => g.namespaces),
    names: groupStack.flatMap(g => g.names),
    controller: [...groupStack].reverse().find(g => g.controller)?.controller ?? null,
    domain: [...groupStack].reverse().find(g => g.domain)?.domain ?? null,
  });
  // `foreach (glob(<pattern>) as $file) { require $file; }`, braced or not: expanded on disk.
  const globLoops: { variable: string; pattern: string; at: number; start: number; end: number }[] = [];
  for (const m of code.matchAll(/\bforeach\s*\(/g)) {
    const head = parenAt(code, text, m.index! + m[0].length - 1);
    const loop = head?.content.match(/^\s*glob\s*\(([\s\S]*)\)\s+as\s+(?:\$\w+\s*=>\s*)?\$(\w+)\s*$/);
    if (!head || !loop) continue;
    let body = head.endIndex;
    while (/\s/.test(code[body] ?? '')) body++;
    const closed = code[body] === '{' ? closingBracket(code, body) : expressionEnd(code, body) + 1;
    const end = closed > 0 ? closed : code.length;
    globLoops.push({ variable: loop[2]!, pattern: parseArgs(loop[1]!, true)[0] ?? '', at: m.index!, start: head.endIndex, end });
  }
  const mountAt = (expr: string, index: number, extra: { prefixes: string[]; middlewares: string[]; namespaces: string[]; controller: string | null; domain?: string | null; names?: string[] } = { prefixes: [], middlewares: [], namespaces: [], controller: null }) => {
    const base = current();
    const push = (file: string, sub?: number) => mounts.push({
      file: normalizeMountPath(file),
      frame: {
        prefixes: [...base.prefixes, ...extra.prefixes],
        middlewares: [...base.middlewares, ...extra.middlewares],
        namespaces: [...base.namespaces, ...extra.namespaces],
        names: [...base.names, ...(extra.names ?? [])],
        controller: extra.controller ?? base.controller,
        domain: extra.domain ?? base.domain,
        conditional: inConditional() || bracelessIf(index),
      },
      offset: index,
      ...(sub !== undefined ? { sub } : {}),
      line: lineAt(content, index),
    });
    const loopVar = expr.trim().match(/^\$(\w+)$/)?.[1];
    const loop = loopVar ? globLoops.find(l => l.variable === loopVar && l.start <= index && index < l.end) : undefined;
    if (loop) {
      const pattern = phpString(loop.pattern, scopeAt(loop.at));
      if (pattern === null) {
        unresolved.push(lineAt(content, index));
        return false;
      }
      expandGlob(ctx.workspaceRoot, pattern).filter(f => f.endsWith('.php')).forEach((f, k) => push(f, k));
      return true;
    }
    const path = phpString(expr, scopeAt(index));
    if (path === null) unresolved.push(lineAt(content, index));
    if (!path || !path.endsWith('.php')) return false;
    push(path);
    return true;
  };

  for (let i = 0; i < code.length; i++) {
    while (groupStack.length > 1 && groupStack[groupStack.length - 1].end <= i) groupStack.pop();
    const char = code[i];
    if (char === '{') {
      conditionalBraces.push(opensConditionalBlock(code.slice(Math.max(0, i - 300), i)));
      continue;
    }
    if (char === '}') {
      conditionalBraces.pop();
      continue;
    }

    const include = /^(?:require|include)(?:_once)?\b/.exec(code.slice(i, i + 20));
    if (include && !/[\w$>:\\]/.test(code[i - 1] ?? '')) {
      const start = i + include[0].length;
      const end = expressionEnd(code, start);
      mountAt(unwrapParens(text.slice(start, end)), i);
      i = end - 1;
      continue;
    }
    if (code.startsWith('loadRoutesFrom', i) && /->\s*$/.test(code.slice(Math.max(0, i - 4), i))) {
      const paren = parenAt(code, text, code.indexOf('(', i));
      if (paren) {
        mountAt(paren.content, i);
        i = paren.endIndex - 1;
      }
      continue;
    }

    if (code.startsWith('Route::', i) && !/\w/.test(code[i - 1] ?? '')) {
      const parsed = parseRouteChain(code, i, text);
      if (!parsed) continue;
      const scope = scopeAt(i);
      const group = parsed.calls.find(c => c.name === 'group');
      // A group's frame ends with its call, so brace-less bodies (`fn () => ...`) can't leak.
      const groupEnd = group ? (getParenthesizedContent(code, parsed.endIndex - 1)?.endIndex ?? code.length) : code.length;
      if (group) {
        // `->group(<path>)` and legacy `Route::group($attributes, <path>)` mount a file; they
        // don't open a group in this one.
        const args = parseArgs(group.args, true);
        const body = args.length > 1 ? args[args.length - 1] : args[0] && !/^(\[|array\s*\()/.test(args[0]) ? args[0] : undefined;
        if (body && !/^(function\b|fn\b|static\b)/.test(body)) {
          mountAt(body, i, chainAttributes(parsed.calls, scope));
          i = groupEnd - 1;
          continue;
        }
      }
      const before = routes.length;
      processRouteChain(parsed.calls, groupStack, groupEnd, filePath, ctx, routes, 'laravel', useImports, {
        vars: scope.vars,
        scope: { dir, root: options.root },
      });
      const line = lineAt(content, i);
      for (const r of routes.slice(before)) {
        r.line = line;
        const meta = (r.metadata ??= {});
        meta.line = line;
        meta.order = [i];
        if (inConditional() || bracelessIf(i)) meta.conditional = true;
      }
      i = parsed.endIndex - 1;
    }
  }
  return { routes: options.collectRoutes ? routes : [], mounts, unresolved };
}

function processRouteChain(
  calls: ChainedCall[],
  groupStack: any[],
  /** Offset where a group opened by this chain ends (its call's closing parenthesis). */
  groupEnd: number,
  filePath: string,
  ctx: ScanContext,
  routes: RouteBinding[],
  frameworkName: string,
  useImports: Map<string, string>,
  extra: { vars: Map<string, string>; scope: { dir: string; root: string } } = { vars: new Map(), scope: { dir: '', root: '' } }
) {
  const routesBefore = routes.length;
  const scope: PhpScope = { ...extra.scope, vars: extra.vars };
  let verb: string | null = null;
  let uriExpr: string | null = null;
  const resourceOptions: ResourceOptions = {};
  /** Raw arguments of the verb call (resource options and Route::resources dictionaries). */
  let verbArgs: string[] = [];
  let uri: string | null = null;
  let handlerStr: string | null = null;
  let chainController: string | null = null;
  const chainPrefixes: string[] = [];
  const chainMiddlewares: string[] = [];
  const chainNamespaces: string[] = [];
  /** Name prefixes of a group opened by this chain. */
  const chainNames: string[] = [];
  /** `->name()` / `->as()` before the verb (a RouteRegistrar attribute; the last one wins) and after it (appended). */
  let nameAttribute: string | undefined;
  const nameSuffixes: string[] = [];
  let chainDomain: string | null = null;
  let isGroup = false;
  const isResourceVerb = () => ['RESOURCE', 'APIRESOURCE', 'RESOURCES', 'APIRESOURCES'].includes(verb ?? '');

  for (const call of calls) {
    if (call.name === 'group') {
      isGroup = true;
      if (nameAttribute !== undefined) chainNames.push(nameAttribute);
      if (call.args) {
        const groupAttrs = parseGroupAttributes(call.args, scope);
        chainPrefixes.push(...groupAttrs.prefixes);
        chainMiddlewares.push(...groupAttrs.middlewares);
        chainNamespaces.push(...groupAttrs.namespaces);
        chainNames.push(...groupAttrs.names);
        chainDomain = groupAttrs.domain ?? chainDomain;
      }
    } else if (call.name === 'name' || call.name === 'as') {
      const raw = parseArgs(call.args, true);
      if (isResourceVerb() && raw.length > 1) {
        // PendingResourceRegistration::name($method, $name)
        const name = phpString(raw[1]!, scope);
        if (name !== null) resourceOptions.names = { ...(typeof resourceOptions.names === 'object' ? resourceOptions.names : {}), [cleanQuotes(raw[0]!)]: name };
      } else {
        const name = raw[0] ? phpString(raw[0], scope) : null;
        if (name !== null && verb) nameSuffixes.push(name);
        else if (name !== null) nameAttribute = name;
      }
    } else if (call.name === 'names') {
      const raw = parseArgs(call.args, true)[0] ?? '';
      resourceOptions.names = phpArrayEntries(raw) ? stringMap(raw, scope) : phpString(raw, scope) ?? undefined;
    } else if (call.name === 'shallow') {
      resourceOptions.shallow = !/^\s*false\s*$/i.test(call.args);
    } else if (call.name === 'domain') {
      const raw = parseArgs(call.args, true)[0];
      if (raw) chainDomain = pathArg(raw, scope);
    } else if (call.name === 'controller') {
      const args = parseArgs(call.args);
      if (args[0]) {
        const classMatch = args[0].match(/([a-zA-Z0-9_\\]+)/);
        if (classMatch) {
          chainController = classMatch[1];
        }
      }
    } else if (['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'resource', 'apiResource', 'resources', 'apiResources'].includes(call.name)) {
      verb = call.name.toUpperCase();
      const args = parseArgs(call.args);
      verbArgs = parseArgs(call.args, true);
      uriExpr = verbArgs[0] || null;
      uri = args[0] || null;
      handlerStr = args[1] || null;
      if (isResourceVerb()) {
        const plural = verb.endsWith('S');
        Object.assign(resourceOptions, parseResourceOptions(verbArgs[plural ? 1 : 2], scope));
        // Attributes set before the verb (`Route::name('x')->resource(...)`) win over the options
        // array: RouteRegistrar passes `$this->attributes + $options`. Prefix, namespace and
        // domain attributes are not resource options, so Laravel ignores them.
        if (nameAttribute !== undefined) resourceOptions.as = nameAttribute;
        if (chainMiddlewares.length) resourceOptions.middleware = [...chainMiddlewares];
      }
    } else if (call.name === 'match') {
      const args = parseArgs(call.args);
      const verbsRaw = args[0] || '';
      const matchedVerbs = verbsRaw.replace(/[\[\]']/g, '').split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
      verb = matchedVerbs.join('|');
      uriExpr = parseArgs(call.args, true)[1] || null;
      uri = args[1] || null;
      handlerStr = args[2] || null;
    } else if (call.name === 'fallback') {
      verb = 'ANY';
      uri = '{any}';
      const args = parseArgs(call.args);
      handlerStr = args[0] || null;
    } else if (call.name === 'redirect') {
      verb = 'GET';
      const args = parseArgs(call.args);
      uriExpr = parseArgs(call.args, true)[0] || null;
      uri = args[0] || null;
      handlerStr = 'Redirect';
    } else if (call.name === 'view') {
      verb = 'GET';
      const args = parseArgs(call.args);
      uriExpr = parseArgs(call.args, true)[0] || null;
      uri = args[0] || null;
      handlerStr = `View(${args[1] || ''})`;
    } else if (call.name === 'prefix') {
      const raw = parseArgs(call.args, true)[0];
      if (raw) chainPrefixes.push(pathArg(raw, scope));
    } else if (call.name === 'middleware') {
      const list = listArg(call.args);
      chainMiddlewares.push(...list);
      // PendingResourceRegistration::middleware() replaces the resource's middleware option.
      if (isResourceVerb()) resourceOptions.middleware = list;
    } else if (call.name === 'namespace') {
      const args = parseArgs(call.args);
      if (args[0]) chainNamespaces.push(args[0]);
    } else if (call.name === 'only' || call.name === 'except') {
      resourceOptions[call.name] = listArg(call.args);
    } else if (call.name === 'parameters') {
      resourceOptions.parameters = stringMap(parseArgs(call.args, true)[0] ?? '', scope);
    } else if (call.name === 'parameter') {
      const [res, param] = parseArgs(call.args);
      if (res && param) resourceOptions.parameters = { ...resourceOptions.parameters, [res]: param };
    }
  }

  // Evaluate the URI as PHP: literals, concatenation, interpolation and local string variables.
  // Anything else becomes {dynamic}, never raw PHP text.
  if (uriExpr && verb !== 'ANY') uri = pathArg(uriExpr, scope);

  // Action arrays: ['as' => 'name', 'middleware' => ..., 'uses' => 'C@m'], or without `uses`, the
  // first positional callable (Laravel's RouteAction::findCallable): a closure or [C::class, 'm'].
  let actionName: string | undefined;
  const actionMiddlewares: string[] = [];
  const action = verb && !isResourceVerb() ? phpArrayEntries(handlerStr ?? undefined) : null;
  if (action?.some(e => e.key !== null)) {
    let uses: string | null = null;
    let callable: string | null = null;
    for (const { key, value } of action) {
      if (key === 'uses') {
        const concat = value.match(/^\\?([\w\\]+)::class\s*\.\s*['"]@(\w+)['"]$/);
        uses = concat ? `${concat[1]}@${concat[2]}` : value.match(/^(['"])([^'"]+)\1$/)?.[2] ?? null;
      } else if (key === 'as') actionName = phpString(value, scope) ?? undefined;
      else if (key === 'middleware') actionMiddlewares.push(...listArg(value));
      else if (key === null && callable === null && /^(function\b|fn\b|static\b|\[)/.test(value)) callable = value;
    }
    handlerStr = uses ?? callable;
  }

  const groupPrefixes = groupStack.flatMap(g => g.prefixes);
  const groupMiddlewares = groupStack.flatMap(g => g.middlewares);
  const groupNamespaces = groupStack.flatMap(g => g.namespaces);
  const groupNames: string = groupStack.flatMap(g => g.names ?? []).join('');

  const fullPrefixes = [...groupPrefixes, ...chainPrefixes];
  const fullMiddlewares = [...groupMiddlewares, ...actionMiddlewares, ...chainMiddlewares];
  const fullNamespaces = [...groupNamespaces, ...chainNamespaces];
  // Laravel's route name: group prefixes, then the action's `as` (or a `->name()` attribute set
  // before the verb), then every `->name()` after it. A named group names even unnamed routes.
  const routeName = groupNames + (actionName ?? nameAttribute ?? '') + nameSuffixes.join('') || undefined;

  if (isGroup) {
    const parentController = groupStack.length > 0 ? groupStack[groupStack.length - 1].controller : null;
    const activeController = chainController || parentController;

    groupStack.push({
      prefixes: chainPrefixes,
      middlewares: chainMiddlewares,
      namespaces: chainNamespaces,
      names: chainNames,
      controller: activeController,
      domain: chainDomain,
      end: groupEnd
    });
  } else if (verb && uri) {
    const activeController = chainController || (groupStack.length > 0 ? groupStack[groupStack.length - 1].controller : null);
    let controllerClass: string | null = null;
    let controllerMethod: string | null = null;

    if (isResourceVerb()) {
      if (handlerStr) {
        const classMatch = handlerStr.match(/([a-zA-Z0-9_\\]+)(?:::class)?/);
        if (classMatch) {
          controllerClass = classMatch[1];
        }
      }
    } else if (handlerStr) {
      if (handlerStr.includes('::class')) {
        const classAndMethod = handlerStr.match(/\[\s*([a-zA-Z0-9_\\]+)::class\s*,\s*['"]([^'"]+)['"]\s*\]/);
        if (classAndMethod) {
          controllerClass = classAndMethod[1];
          controllerMethod = classAndMethod[2];
        }
      } else if (handlerStr.includes('@')) {
        const cleanHandler = handlerStr.replace(/['"]/g, '');
        const strMatch = cleanHandler.match(/^([a-zA-Z0-9_\\]+)@([a-zA-Z0-9_]+)$/);
        if (strMatch) {
          controllerClass = strMatch[1];
          controllerMethod = strMatch[2];
        }
      } else if (activeController && !/^(function|fn|static)\b/.test(handlerStr)) {
        // Route::controller -> short method handler mapping
        controllerClass = activeController;
        controllerMethod = handlerStr.replace(/['"]/g, '').trim();
      }
    }

    if (isResourceVerb()) {
      // Resources take only the enclosing groups' prefix, namespace and middleware: attributes
      // chained before the verb are passed as options, and only `as` and `middleware` count.
      const register = (resName: string, ctrl: string, declared: boolean) => {
        const fqn = controllerFqn(ctrl, useImports, groupNamespaces);
        const expanded = expandResourceRoute(frameworkName, resName, fqn, ctx.resolveSymbolToFile(fqn) ?? filePath,
          groupPrefixes, groupMiddlewares, verb!.startsWith('APIRESOURCE'), resourceOptions, groupNames);
        if (declared) for (const r of expanded) r.metadata!.confidence = 'declared';
        routes.push(...expanded);
      };
      if (verb === 'RESOURCE' || verb === 'APIRESOURCE') {
        if (controllerClass) register(uri, controllerClass, false);
      } else {
        // Route::resources([...]) / apiResources([...]): one resource per `name => controller`,
        // all sharing the options array.
        for (const { key, value } of phpArrayEntries(verbArgs[0]) ?? []) {
          const ctrl = classArg(value, scope);
          if (key !== null && ctrl) register(phpString(`'${key}'`, scope) ?? key, ctrl, /::class$/.test(value));
        }
      }
    } else {
      let resolvedFile = filePath;
      const fqn = controllerClass ? controllerFqn(controllerClass, useImports, fullNamespaces) : null;
      if (fqn) {
        const resolvedPath = ctx.resolveSymbolToFile(fqn);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }
      }

      const cleanPrefixes = fullPrefixes.map(p => p.replace(/^\/|\/$/g, '')).filter(Boolean);
      const cleanUri = uri.replace(/^\/|\/$/g, '');
      const fullPath = '/' + [...cleanPrefixes, cleanUri].join('/');

      routes.push({
        framework: frameworkName,
        method: verb,
        path: fullPath,
        handlerFile: resolvedFile,
        handlerSymbol: controllerMethod ? `${fqn}@${controllerMethod}` : (fqn || undefined),
        metadata: {
          confidence: 'inferred',
          middlewares: fullMiddlewares,
          ...(routeName ? { name: routeName } : {}),
        },
      });
    }
  }
  // Handlers given as Class::class (array form or resource controller) are declared, not inferred.
  // (Route::resources() decides per controller above.)
  if (handlerStr && /::class\b/.test(handlerStr) && verb !== 'RESOURCES' && verb !== 'APIRESOURCES')
    for (const r of routes.slice(routesBefore)) (r.metadata ??= {}).confidence = 'declared';
  // A {dynamic} URI part or prefix (from this chain, a group or the mount) flags the route.
  // A domain chained before a resource is not a resource option, so Laravel ignores it.
  const domain = (isResourceVerb() ? null : chainDomain) ?? [...groupStack].reverse().find(g => g.domain)?.domain ?? null;
  for (const r of routes.slice(routesBefore)) {
    if (r.path.split('/').includes(DYNAMIC)) (r.metadata ??= {}).dynamic = true;
    if (domain && !isGroup) (r.metadata ??= {}).domain = domain;
  }
}
