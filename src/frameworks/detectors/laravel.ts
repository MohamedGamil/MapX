import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../../types.js';
import { hasComposerDependency } from '../utils.js';
import {
  findLaravelRoots,
  normalizeMountPath,
  opensConditionalBlock,
  phpString,
  resourceParam,
  stringAssignments,
  varsAt,
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
  initialized: boolean;
}

/** Group context a route file inherits from whatever loads it (entry point, provider, require). */
interface RouteMount {
  prefixes: string[];
  middlewares: string[];
  namespaces: string[];
  controller: string | null;
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

function parseRouteServiceProvider(content: string, providerPath: string, wctx: LaravelWorkspaceContext) {
  const namespaceVarMatch = content.match(/(?:protected|public|private)\s+\$namespace\s*=\s*['"]([^'"]+)['"]/);
  const classNamespace = namespaceVarMatch ? namespaceVarMatch[1] : 'App\\Http\\Controllers';

  let index = 0;
  while (true) {
    const start = content.indexOf('Route::', index);
    if (start === -1) break;

    const parsed = parseRouteChain(content, start);
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

/** Entry points declared by bootstrap/app.php `withRouting(...)`. */
function withRoutingEntries(content: string, root: string): { file: string; frame: Omit<RouteMount, 'order' | 'via'> }[] {
  const at = content.search(/->\s*withRouting\s*\(/);
  if (at < 0) return [];
  const paren = getParenthesizedContent(content, content.indexOf('(', at));
  if (!paren) return [];
  const scope = { dir: posix.join(root, 'bootstrap'), root, vars: new Map<string, string>() };
  const named = new Map<string, string>();
  for (const arg of parseArgs(paren.content, true)) {
    const m = arg.match(/^(\w+)\s*:\s*([\s\S]+)$/);
    if (m) named.set(m[1]!, m[2]!.trim());
  }
  const files = (expr: string | undefined) => {
    if (!expr) return [];
    const items = expr.startsWith('[') ? parseArgs(expr.slice(1, expr.lastIndexOf(']')), true) : [expr];
    return items.map(e => phpString(e, scope)).filter((f): f is string => !!f).map(normalizeMountPath);
  };
  const apiPrefix = named.has('apiPrefix') ? phpString(named.get('apiPrefix')!, scope) ?? 'api' : 'api';
  return [
    ...files(named.get('web')).map(file => ({ file, frame: { ...emptyFrame(), middlewares: ['web'] } })),
    ...files(named.get('api')).map(file => ({ file, frame: { ...emptyFrame(), prefixes: apiPrefix ? [apiPrefix] : [], middlewares: ['api'] } })),
  ];
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

  // Providers boot before the application's route files are loaded, so their mounts come first.
  const rspPath = rel('app/Providers/RouteServiceProvider.php');
  const providers = await listServiceProviders(workspaceRoot, root);
  for (const [pi, provider] of providers.entries()) {
    if (provider === rspPath) continue;
    const content = await read(provider);
    if (!content) continue;
    for (const m of walkRouteFile(content, provider, emptyFrame(), ctx, { collectRoutes: false, root }).mounts)
      queue.push({ file: m.file, frame: m.frame, order: [rootIndex, 0, pi, m.offset], via: `${provider}:${m.line}`, depth: 0 });
  }

  const entries: { file: string; frame: Omit<RouteMount, 'order' | 'via'>; via: string }[] = [];
  const bootstrap = await read(rel('bootstrap/app.php'));
  if (bootstrap) entries.push(...withRoutingEntries(bootstrap, root).map(e => ({ ...e, via: rel('bootstrap/app.php') })));
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

  while (queue.length) {
    const next = queue.shift()!;
    const mounts = wctx.mounts.get(next.file) ?? [];
    // Each (file, order) pair is a distinct mount; the depth cap stops require cycles.
    if (mounts.some(m => m.order.join('.') === next.order.join('.')) || next.depth > 8) continue;
    mounts.push({ ...next.frame, order: next.order, via: next.via });
    wctx.mounts.set(next.file, mounts);
    const content = await read(next.file);
    if (!content) continue;
    for (const m of walkRouteFile(content, next.file, next.frame, ctx, { collectRoutes: false, root }).mounts)
      queue.push({
        file: m.file,
        frame: { ...m.frame, conditional: next.frame.conditional || m.frame.conditional },
        order: [...next.order, m.offset],
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
      if (r.framework !== this.name || r.metadata?.reachable === false || !Array.isArray(r.metadata?.order)) continue;
      const path = r.path.replace(/\{[^}]*\}/g, '{}');
      for (const method of r.method.split('|')) {
        const key = `${method} ${path}`;
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
      let frames: { frame: Omit<RouteMount, 'order' | 'via'>; order: number[]; reachable?: boolean; via?: string }[];
      if (mounts) {
        frames = mounts.map(m => ({ frame: m, order: m.order, reachable: true, via: m.via }));
      } else {
        // Not loaded by anything we can see: name-based defaults, and unreachable when the app's
        // mount graph is known.
        const config = getInitialGroupConfig(normalizedPath, wctx);
        frames = [{
          frame: { ...emptyFrame(), prefixes: config.prefix ? [config.prefix] : [], middlewares: config.middlewares, namespaces: config.namespace ? [config.namespace] : [] },
          order: [],
          reachable: root !== undefined ? false : undefined,
        }];
      }
      const routes: RouteBinding[] = [];
      for (const f of frames) {
        const walked = walkRouteFile(content, normalizedPath, f.frame, ctx, { collectRoutes: true, root: root ?? '' }).routes;
        for (const r of walked) {
          const meta = (r.metadata ??= {});
          meta.order = [...f.order, ...(meta.order ?? [])];
          if (f.reachable !== undefined) meta.reachable = f.reachable;
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

        routes.push({
          framework: this.name,
          method: verb,
          path: fullPath,
          handlerFile: filePath,
          handlerSymbol: `${classFqn}@${methodName}`,
          metadata: {
            confidence: 'inferred',
            middlewares: allMiddlewares,
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

function parseRouteChain(content: string, startIndex: number): { calls: ChainedCall[], endIndex: number } | null {
  let index = startIndex;
  const calls: ChainedCall[] = [];

  const initMatch = content.substring(index).match(/^Route::([a-zA-Z0-9_]+)\s*\(/);
  if (!initMatch) return null;

  const name = initMatch[1];
  index += initMatch[0].length - 1;

  if (name === 'group') {
    const paren = getParenthesizedContent(content, index);
    const args = paren ? paren.content : '';
    calls.push({ name: 'group', args });
    return { calls, endIndex: index + 1 };
  }

  const paren = getParenthesizedContent(content, index);
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
      const methodParen = getParenthesizedContent(content, index);
      const args = methodParen ? methodParen.content : '';
      calls.push({ name: 'group', args });
      return { calls, endIndex: index + 1 };
    }

    const methodParen = getParenthesizedContent(content, index);
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

function parseGroupAttributes(argsStr: string): { prefixes: string[], middlewares: string[], namespaces: string[] } {
  const prefixes: string[] = [];
  const middlewares: string[] = [];
  const namespaces: string[] = [];

  const trimmed = argsStr.trim();
  let arrayContent = '';
  if (trimmed.startsWith('[')) {
    const bracket = getBracketedContent(trimmed, 0);
    if (bracket) arrayContent = bracket.content;
  } else if (trimmed.startsWith('array(')) {
    const paren = getParenthesizedContent(trimmed, 5);
    if (paren) arrayContent = paren.content;
  } else {
    return { prefixes, middlewares, namespaces };
  }

  if (arrayContent) {
    // 1. Extract prefix
    const prefixMatch = arrayContent.match(/['"]prefix['"]\s*=>\s*['"]([^'"]+)['"]/);
    if (prefixMatch) {
      prefixes.push(prefixMatch[1]);
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

  return { prefixes, middlewares, namespaces };
}

function parseResourceDict(argsStr: string): Record<string, string> {
  const dict: Record<string, string> = {};
  const matches = argsStr.matchAll(/['"]([^'"]+)['"]\s*=>\s*([a-zA-Z0-9_\\]+)/g);
  for (const match of matches) {
    dict[match[1]] = match[2];
  }
  return dict;
}

interface ResourceOptions {
  only?: string[];
  except?: string[];
  parameters?: Record<string, string>;
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

function expandResourceRoute(
  frameworkName: string,
  resourceName: string,
  controllerName: string,
  resolvedFile: string,
  fullPrefixes: string[],
  fullMiddlewares: string[],
  isApi: boolean,
  options: ResourceOptions = {}
): RouteBinding[] {
  const lastSegment = resourceName.split(/[./]/).filter(Boolean).pop() ?? '';
  const param = options.parameters?.[lastSegment] ?? options.parameters?.[resourceName] ?? getResourceParam(resourceName);
  const cleanPrefixes = fullPrefixes.map(p => p.replace(/^\/|\/$/g, '')).filter(Boolean);
  const cleanUri = resourceName.replace(/^\/|\/$/g, '');
  const basePath = '/' + [...cleanPrefixes, cleanUri].join('/');

  const routesDefs = isApi ? [
    { method: 'GET', pathSuffix: '', action: 'index' },
    { method: 'POST', pathSuffix: '', action: 'store' },
    { method: 'GET', pathSuffix: `/{${param}}`, action: 'show' },
    { method: 'PUT', pathSuffix: `/{${param}}`, action: 'update' },
    { method: 'PATCH', pathSuffix: `/{${param}}`, action: 'update' },
    { method: 'DELETE', pathSuffix: `/{${param}}`, action: 'destroy' }
  ] : [
    { method: 'GET', pathSuffix: '', action: 'index' },
    { method: 'GET', pathSuffix: '/create', action: 'create' },
    { method: 'POST', pathSuffix: '', action: 'store' },
    { method: 'GET', pathSuffix: `/{${param}}`, action: 'show' },
    { method: 'GET', pathSuffix: `/{${param}}/edit`, action: 'edit' },
    { method: 'PUT', pathSuffix: `/{${param}}`, action: 'update' },
    { method: 'PATCH', pathSuffix: `/{${param}}`, action: 'update' },
    { method: 'DELETE', pathSuffix: `/{${param}}`, action: 'destroy' }
  ];

  return routesDefs
    .filter(def => (!options.only || options.only.includes(def.action)) && !options.except?.includes(def.action))
    .map(def => {
    const fullPath = (basePath + def.pathSuffix).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return {
      framework: frameworkName,
      method: def.method,
      path: fullPath,
      handlerFile: resolvedFile,
      handlerSymbol: `${controllerName}@${def.action}`,
      metadata: {
        confidence: 'inferred',
        resourceType: isApi ? 'apiResource' : 'resource',
        middlewares: fullMiddlewares,
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
}

/** Group attributes declared by a chain itself (prefix, middleware, namespace, controller, group array). */
function chainAttributes(calls: ChainedCall[]) {
  const prefixes: string[] = [];
  const middlewares: string[] = [];
  const namespaces: string[] = [];
  let controller: string | null = null;
  for (const call of calls) {
    if (call.name === 'prefix') {
      const a = parseArgs(call.args)[0];
      if (a) prefixes.push(a);
    } else if (call.name === 'middleware' || call.name === 'withoutMiddleware') {
      if (call.name === 'withoutMiddleware') continue;
      middlewares.push(...listArg(call.args));
    } else if (call.name === 'namespace') {
      const a = parseArgs(call.args)[0];
      if (a) namespaces.push(a);
    } else if (call.name === 'controller') {
      controller = parseArgs(call.args)[0]?.match(/([a-zA-Z0-9_\\]+)/)?.[1] ?? null;
    } else if (call.name === 'group' && /^\s*(\[|array\()/.test(call.args)) {
      const attrs = parseGroupAttributes(call.args);
      prefixes.push(...attrs.prefixes);
      middlewares.push(...attrs.middlewares);
      namespaces.push(...attrs.namespaces);
    }
  }
  return { prefixes, middlewares, namespaces, controller };
}

/** A string or array-of-strings argument, e.g. 'auth' or ['auth', 'verified']. */
function listArg(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed.startsWith('[')) return (trimmed.match(/['"]([^'"]+)['"]/g) || []).map(m => m.replace(/['"]/g, ''));
  const a = parseArgs(trimmed)[0];
  return a ? [a] : [];
}

const lineAt = (content: string, index: number) => content.slice(0, index).split('\n').length;

/**
 * Walks a PHP file that declares routes. Tracks the group stack and conditional blocks, and
 * reports routes (when collectRoutes) and mounts: require/include of a file, `->group(<path>)`
 * and `$this->loadRoutesFrom(<path>)`, each with the group context in force at that point.
 */
function walkRouteFile(
  content: string,
  filePath: string,
  frame: Omit<RouteMount, 'order' | 'via'>,
  ctx: ScanContext,
  options: WalkOptions,
): { routes: RouteBinding[]; mounts: MountRequest[] } {
  const routes: RouteBinding[] = [];
  const mounts: MountRequest[] = [];
  const dir = posix.dirname(filePath) === '.' ? '' : posix.dirname(filePath);
  const assignments = stringAssignments(content);
  const useImports = parseUseImports(content);
  let braceDepth = 0;
  const conditionalBraces: boolean[] = [];
  const groupStack: { prefixes: string[]; middlewares: string[]; namespaces: string[]; controller: string | null; startDepth: number }[] = [{
    prefixes: frame.prefixes,
    middlewares: frame.middlewares,
    namespaces: frame.namespaces,
    controller: frame.controller,
    startDepth: 0,
  }];
  const inConditional = () => conditionalBraces.some(Boolean);
  const current = () => ({
    prefixes: groupStack.flatMap(g => g.prefixes),
    middlewares: groupStack.flatMap(g => g.middlewares),
    namespaces: groupStack.flatMap(g => g.namespaces),
    controller: [...groupStack].reverse().find(g => g.controller)?.controller ?? null,
  });
  const mountAt = (expr: string, index: number, extra = { prefixes: [] as string[], middlewares: [] as string[], namespaces: [] as string[], controller: null as string | null }) => {
    const path = phpString(expr, { dir, root: options.root, vars: varsAt(assignments, index) });
    if (!path || !path.endsWith('.php')) return false;
    const base = current();
    mounts.push({
      file: normalizeMountPath(path),
      frame: {
        prefixes: [...base.prefixes, ...extra.prefixes],
        middlewares: [...base.middlewares, ...extra.middlewares],
        namespaces: [...base.namespaces, ...extra.namespaces],
        controller: extra.controller ?? base.controller,
        conditional: inConditional(),
      },
      offset: index,
      line: lineAt(content, index),
    });
    return true;
  };

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '{') {
      conditionalBraces.push(opensConditionalBlock(content.slice(Math.max(0, i - 300), i)));
      braceDepth++;
      continue;
    }
    if (char === '}') {
      conditionalBraces.pop();
      braceDepth--;
      while (groupStack.length > 1 && groupStack[groupStack.length - 1].startDepth > braceDepth) {
        groupStack.pop();
      }
      continue;
    }
    if (char === '/' && content[i + 1] === '/') {
      const eol = content.indexOf('\n', i);
      i = eol < 0 ? content.length : eol;
      continue;
    }
    if (char === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end < 0 ? content.length : end + 1;
      continue;
    }

    const include = /^(?:require|include)(?:_once)?\b\s*\(?/.exec(content.slice(i, i + 20));
    if (include && !/[\w$>]/.test(content[i - 1] ?? '')) {
      const end = content.indexOf(';', i);
      if (end > i) {
        const expr = content.slice(i + include[0].length, end).replace(/\)\s*$/, '');
        mountAt(expr, i);
        i = end;
      }
      continue;
    }
    if (content.startsWith('loadRoutesFrom', i) && /->\s*$/.test(content.slice(Math.max(0, i - 4), i))) {
      const paren = getParenthesizedContent(content, content.indexOf('(', i));
      if (paren) {
        mountAt(paren.content, i);
        i = paren.endIndex - 1;
      }
      continue;
    }

    if (content.substring(i, i + 7) === 'Route::' && !/\w/.test(content[i - 1] ?? '')) {
      const parsed = parseRouteChain(content, i);
      if (!parsed) continue;
      const group = parsed.calls.find(c => c.name === 'group');
      // `->group(<path>)` mounts a file; it does not open a group in this one.
      if (group && group.args.trim() && !/^\s*(\[|array\(|function\b|fn\b|static\b)/.test(group.args)) {
        const groupEnd = getParenthesizedContent(content, parsed.endIndex - 1);
        mountAt(group.args, i, chainAttributes(parsed.calls));
        i = (groupEnd?.endIndex ?? parsed.endIndex) - 1;
        continue;
      }
      const skippedText = content.substring(i, parsed.endIndex);
      for (const c of skippedText) {
        if (c === '{') braceDepth++;
        else if (c === '}') braceDepth--;
      }
      const before = routes.length;
      processRouteChain(parsed.calls, groupStack, braceDepth, filePath, ctx, routes, 'laravel', useImports, {
        vars: varsAt(assignments, i),
        scope: { dir, root: options.root },
      });
      const name = parsed.calls.find(c => c.name === 'name');
      const line = lineAt(content, i);
      for (const r of routes.slice(before)) {
        r.line = line;
        const meta = (r.metadata ??= {});
        meta.line = line;
        meta.order = [i];
        if (inConditional()) meta.conditional = true;
        if (name && !meta.resourceType) meta.name = parseArgs(name.args)[0];
      }
      i = parsed.endIndex - 1;
    }
  }
  return { routes: options.collectRoutes ? routes : [], mounts };
}

function processRouteChain(
  calls: ChainedCall[],
  groupStack: any[],
  currentBraceDepth: number,
  filePath: string,
  ctx: ScanContext,
  routes: RouteBinding[],
  frameworkName: string,
  useImports: Map<string, string>,
  extra: { vars: Map<string, string>; scope: { dir: string; root: string } } = { vars: new Map(), scope: { dir: '', root: '' } }
) {
  const routesBefore = routes.length;
  let verb: string | null = null;
  let uriExpr: string | null = null;
  let routeName: string | undefined;
  const resourceOptions: ResourceOptions = {};
  let uri: string | null = null;
  let handlerStr: string | null = null;
  let chainController: string | null = null;
  const chainPrefixes: string[] = [];
  const chainMiddlewares: string[] = [];
  const chainNamespaces: string[] = [];
  let isGroup = false;

  for (const call of calls) {
    if (call.name === 'group') {
      isGroup = true;
      if (call.args) {
        const groupAttrs = parseGroupAttributes(call.args);
        chainPrefixes.push(...groupAttrs.prefixes);
        chainMiddlewares.push(...groupAttrs.middlewares);
        chainNamespaces.push(...groupAttrs.namespaces);
      }
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
      uriExpr = parseArgs(call.args, true)[0] || null;
      uri = args[0] || null;
      handlerStr = args[1] || null;
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
      uri = args[0] || null;
      handlerStr = 'Redirect';
    } else if (call.name === 'view') {
      verb = 'GET';
      const args = parseArgs(call.args);
      uri = args[0] || null;
      handlerStr = `View(${args[1] || ''})`;
    } else if (call.name === 'prefix') {
      const args = parseArgs(call.args);
      if (args[0]) chainPrefixes.push(args[0]);
    } else if (call.name === 'middleware') {
      if (call.args.trim().startsWith('[')) {
        const matches = call.args.match(/['"]([^'"]+)['"]/g) || [];
        chainMiddlewares.push(...matches.map(m => m.replace(/['"]/g, '')));
      } else {
        const args = parseArgs(call.args);
        if (args[0]) chainMiddlewares.push(args[0]);
      }
    } else if (call.name === 'namespace') {
      const args = parseArgs(call.args);
      if (args[0]) chainNamespaces.push(args[0]);
    } else if (call.name === 'only' || call.name === 'except') {
      resourceOptions[call.name] = listArg(call.args);
    } else if (call.name === 'parameters') {
      resourceOptions.parameters = Object.fromEntries(
        [...call.args.matchAll(/['"]([^'"]+)['"]\s*=>\s*['"]([^'"]+)['"]/g)].map(m => [m[1]!, m[2]!]),
      );
    } else if (call.name === 'parameter') {
      const [res, param] = parseArgs(call.args);
      if (res && param) resourceOptions.parameters = { ...resourceOptions.parameters, [res]: param };
    }
  }

  // Evaluate the URI as PHP: literals, concatenation and local string variables.
  let dynamicUri = false;
  if (uriExpr && verb !== 'ANY') {
    const evaluated = phpString(uriExpr, { ...extra.scope, vars: extra.vars });
    if (evaluated !== null) uri = evaluated;
    else if (!/^(['"])[^'"]*\1$/.test(uriExpr)) {
      dynamicUri = true;
      uri = '{dynamic}';
    }
  }

  // Array handlers: ['uses' => 'C@m', 'as' => 'name', 'middleware' => ...]
  if (handlerStr && /^\s*(\[|array\()/.test(handlerStr) && /['"]uses['"]\s*=>/.test(handlerStr)) {
    const uses = handlerStr.match(/['"]uses['"]\s*=>\s*(?:(['"])([^'"]+)\1|([\w\\]+)::class\s*\.\s*['"]@(\w+)['"])/);
    if (uses) handlerStr = uses[2] ?? `${uses[3]}@${uses[4]}`;
    const as = handlerStr.length && /['"]as['"]\s*=>/.test(calls.map(c => c.args).join(',')) ? calls.map(c => c.args).join(',').match(/['"]as['"]\s*=>\s*['"]([^'"]+)['"]/) : null;
    if (as) routeName = as[1];
    const mw = calls.map(c => c.args).join(',').match(/['"]middleware['"]\s*=>\s*(\[[^\]]*\]|['"][^'"]+['"])/);
    if (mw) chainMiddlewares.push(...listArg(mw[1]!));
  }

  const groupPrefixes = groupStack.flatMap(g => g.prefixes);
  const groupMiddlewares = groupStack.flatMap(g => g.middlewares);
  const groupNamespaces = groupStack.flatMap(g => g.namespaces);

  const fullPrefixes = [...groupPrefixes, ...chainPrefixes];
  const fullMiddlewares = [...groupMiddlewares, ...chainMiddlewares];
  const fullNamespaces = [...groupNamespaces, ...chainNamespaces];

  if (isGroup) {
    const parentController = groupStack.length > 0 ? groupStack[groupStack.length - 1].controller : null;
    const activeController = chainController || parentController;

    groupStack.push({
      prefixes: chainPrefixes,
      middlewares: chainMiddlewares,
      namespaces: chainNamespaces,
      controller: activeController,
      startDepth: currentBraceDepth + 1
    });
  } else if (verb && uri) {
    const activeController = chainController || (groupStack.length > 0 ? groupStack[groupStack.length - 1].controller : null);
    let controllerClass: string | null = null;
    let controllerMethod: string | null = null;

    if (['RESOURCE', 'APIRESOURCE', 'RESOURCES', 'APIRESOURCES'].includes(verb)) {
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
      } else if (activeController && !handlerStr.startsWith('function') && !handlerStr.startsWith('fn')) {
        // Route::controller -> short method handler mapping
        controllerClass = activeController;
        controllerMethod = handlerStr.replace(/['"]/g, '').trim();
      }
    }

    if (['RESOURCE', 'APIRESOURCE', 'RESOURCES', 'APIRESOURCES'].includes(verb)) {
      if (controllerClass) {
 let resolvedFile = filePath;
        const fqn = controllerFqn(controllerClass, useImports, fullNamespaces);
        
        const resolvedPath = ctx.resolveSymbolToFile(fqn);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }

        if (verb === 'RESOURCE' || verb === 'APIRESOURCE') {
          const expanded = expandResourceRoute(
            frameworkName,
            uri,
            controllerFqn(controllerClass, useImports, fullNamespaces),
            resolvedFile,
            fullPrefixes,
            fullMiddlewares,
            verb === 'APIRESOURCE',
            resourceOptions
          );
          routes.push(...expanded);
        } else {
          // RESOURCES / APIRESOURCES array dictionary
          const resourcesCall = calls.find(c => ['resources', 'apiresources'].includes(c.name.toLowerCase()));
          const dict = resourcesCall ? parseResourceDict(resourcesCall.args) : {};
          for (const [resName, ctrlName] of Object.entries(dict)) {
            let resolvedResFile = filePath;
            const resFqn = controllerFqn(ctrlName, useImports, fullNamespaces);
            const resolvedPath = ctx.resolveSymbolToFile(resFqn);
            if (resolvedPath) {
              resolvedResFile = resolvedPath;
            }

            const expanded = expandResourceRoute(
              frameworkName,
              resName,
              controllerFqn(ctrlName, useImports, fullNamespaces),
              resolvedResFile,
              fullPrefixes,
              fullMiddlewares,
              verb === 'APIRESOURCES'
            );
            routes.push(...expanded);
          }
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
          ...(dynamicUri ? { dynamic: true } : {}),
        },
      });
    }
  }
  // Handlers given as Class::class (array form or resource controller) are declared, not inferred.
  if (handlerStr && /::class\b/.test(handlerStr))
    for (const r of routes.slice(routesBefore)) (r.metadata ??= {}).confidence = 'declared';
}
