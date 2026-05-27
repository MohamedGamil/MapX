import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../../types.js';

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
  packageRoutes: Record<string, {
    prefix: string;
    namespace: string;
    middlewares: string[];
    providerPath: string;
  }>;
  initialized: boolean;
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
        packageRoutes: {},
        initialized: true
      };
      
      // 1. Parse Kernel.php if it exists
      const kernelPath = join(workspaceRoot, 'app/Http/Kernel.php');
      if (existsSync(kernelPath)) {
        try {
          const content = await readFile(kernelPath, 'utf-8');
          parseKernel(content, wctx);
        } catch (e) {
          // Ignored
        }
      }

      // 2. Parse RouteServiceProvider.php if it exists
      const rspPath = 'app/Providers/RouteServiceProvider.php';
      if (existsSync(join(workspaceRoot, rspPath))) {
        try {
          const content = await readFile(join(workspaceRoot, rspPath), 'utf-8');
          parseRouteServiceProvider(content, rspPath, wctx);
        } catch (e) {
          // Ignored
        }
      }

      // 3. Scan for other service providers
      try {
        await scanPackageProviders(workspaceRoot, wctx);
      } catch (e) {
        // Ignored
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

async function scanPackageProviders(dir: string, wctx: LaravelWorkspaceContext, currentRelativeDir: string = ''): Promise<void> {
  const absoluteDir = currentRelativeDir ? join(dir, currentRelativeDir) : dir;
  if (!existsSync(absoluteDir)) return;

  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const skipDirs = new Set(['vendor', 'node_modules', '.git', '.mapx', 'storage', 'bootstrap', 'public', 'tests', 'resources', 'database', 'config']);

  for (const entry of entries) {
    const relPath = currentRelativeDir ? `${currentRelativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name.toLowerCase())) {
        continue;
      }
      await scanPackageProviders(dir, wctx, relPath);
    } else if (entry.isFile() && entry.name.endsWith('ServiceProvider.php')) {
      const filePath = relPath.replace(/\\/g, '/');
      const content = await readFile(join(dir, relPath), 'utf-8');
      
      const loadRoutesRegex = /\$this\s*->\s*loadRoutesFrom\s*\(\s*(['"]([^'"]+)['"]|[^)]+)\s*\)/g;
      let match;
      while ((match = loadRoutesRegex.exec(content)) !== null) {
        const routePathArg = match[1];
        const resolvedRoute = resolveRoutePath(routePathArg, filePath);
        if (resolvedRoute) {
          wctx.packageRoutes[resolvedRoute] = {
            prefix: '',
            namespace: '',
            middlewares: [],
            providerPath: filePath
          };
        }
      }
    }
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

  if (wctx.packageRoutes[normalizedPath]) {
    const config = wctx.packageRoutes[normalizedPath];
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

    const composerPath = join(projectRoot, 'composer.json');
    if (existsSync(composerPath)) {
      try {
        const composerContent = JSON.parse(await readFile(composerPath, 'utf-8'));
        const deps = { ...composerContent.require, ...composerContent['require-dev'] };
        if (deps && deps['laravel/framework']) {
          return true;
        }
      } catch {
        // Ignored
      }
    }
    return false;
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const wctx = await ensureWorkspaceInitialized(ctx.workspaceRoot, ctx);
    const normalizedPath = filePath.replace(/\\/g, '/');
    const lowerPath = normalizedPath.toLowerCase();
    
    // Support modular structures (e.g. Modules/Blog/Routes/web.php)
    const isPackageRoute = wctx.packageRoutes[normalizedPath] !== undefined;
    const isRouteFile = lowerPath.includes('/routes/') ||
                        lowerPath.startsWith('routes/') ||
                        lowerPath.endsWith('/routes.php') ||
                        lowerPath.includes('/routes.php') ||
                        isPackageRoute;

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
      const routes: RouteBinding[] = [];
      let braceDepth = 0;
      const initialConfig = getInitialGroupConfig(normalizedPath, wctx);
      const groupStack: { 
        prefixes: string[], 
        middlewares: string[], 
        namespaces: string[], 
        controller: string | null, 
        startDepth: number 
      }[] = [{
        prefixes: initialConfig.prefix ? [initialConfig.prefix] : [],
        middlewares: initialConfig.middlewares,
        namespaces: initialConfig.namespace ? [initialConfig.namespace] : [],
        controller: null,
        startDepth: 0
      }];
      
      const useImports = parseUseImports(content);

      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (char === '{') {
          braceDepth++;
        } else if (char === '}') {
          braceDepth--;
          while (groupStack.length > 0 && groupStack[groupStack.length - 1].startDepth > braceDepth) {
            groupStack.pop();
          }
        }

        if (content.substring(i, i + 7) === 'Route::') {
          const parsed = parseRouteChain(content, i);
          if (parsed) {
            const skippedText = content.substring(i, parsed.endIndex);
            for (const c of skippedText) {
              if (c === '{') braceDepth++;
              else if (c === '}') braceDepth--;
            }

            i = parsed.endIndex - 1;
            processRouteChain(parsed.calls, groupStack, braceDepth, filePath, ctx, routes, this.name, useImports);
          }
        }
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
        hooks.push({
          framework: this.name,
          hookName: className,
          hookType: 'service_provider',
          handlerFile: filePath,
          handlerSymbol: classFqn,
          metadata: {
            confidence: 'declared'
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

function parseArgs(argsStr: string): string[] {
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
      args.push(cleanQuotes(current.trim()));
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    args.push(cleanQuotes(current.trim()));
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

function getResourceParam(resourceName: string): string {
  const lastPart = resourceName.split('/').pop() || '';
  if (lastPart.endsWith('ies')) {
    return lastPart.substring(0, lastPart.length - 3) + 'y';
  }
  if (lastPart.endsWith('s') && !lastPart.endsWith('ss')) {
    return lastPart.substring(0, lastPart.length - 1);
  }
  return lastPart || 'id';
}

function expandResourceRoute(
  frameworkName: string,
  resourceName: string,
  controllerName: string,
  resolvedFile: string,
  fullPrefixes: string[],
  fullMiddlewares: string[],
  isApi: boolean
): RouteBinding[] {
  const param = getResourceParam(resourceName);
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

  return routesDefs.map(def => {
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

function processRouteChain(
  calls: ChainedCall[],
  groupStack: any[],
  currentBraceDepth: number,
  filePath: string,
  ctx: ScanContext,
  routes: RouteBinding[],
  frameworkName: string,
  useImports: Map<string, string>
) {
  let verb: string | null = null;
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
      uri = args[0] || null;
      handlerStr = args[1] || null;
    } else if (call.name === 'match') {
      const args = parseArgs(call.args);
      const verbsRaw = args[0] || '';
      const matchedVerbs = verbsRaw.replace(/[\[\]']/g, '').split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
      verb = matchedVerbs.join('|');
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
    }
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
        let fqn = useImports.get(controllerClass) || controllerClass;
        if (!fqn.startsWith('\\') && !useImports.has(controllerClass) && fullNamespaces.length > 0) {
          fqn = `${fullNamespaces.join('\\')}\\${fqn}`;
        }
        if (fqn.startsWith('\\')) fqn = fqn.substring(1);
        
        const resolvedPath = ctx.resolveSymbolToFile(fqn);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }

        if (verb === 'RESOURCE' || verb === 'APIRESOURCE') {
          const expanded = expandResourceRoute(
            frameworkName,
            uri,
            controllerClass,
            resolvedFile,
            fullPrefixes,
            fullMiddlewares,
            verb === 'APIRESOURCE'
          );
          routes.push(...expanded);
        } else {
          // RESOURCES / APIRESOURCES array dictionary
          const resourcesCall = calls.find(c => ['resources', 'apiresources'].includes(c.name.toLowerCase()));
          const dict = resourcesCall ? parseResourceDict(resourcesCall.args) : {};
          for (const [resName, ctrlName] of Object.entries(dict)) {
            let resolvedResFile = filePath;
            let resFqn = useImports.get(ctrlName) || ctrlName;
            if (!resFqn.startsWith('\\') && !useImports.has(ctrlName) && fullNamespaces.length > 0) {
              resFqn = `${fullNamespaces.join('\\')}\\${resFqn}`;
            }
            if (resFqn.startsWith('\\')) resFqn = resFqn.substring(1);
            const resolvedPath = ctx.resolveSymbolToFile(resFqn);
            if (resolvedPath) {
              resolvedResFile = resolvedPath;
            }

            const expanded = expandResourceRoute(
              frameworkName,
              resName,
              ctrlName,
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
      if (controllerClass) {
        let fqn = useImports.get(controllerClass) || controllerClass;
        if (!fqn.startsWith('\\') && !useImports.has(controllerClass) && fullNamespaces.length > 0) {
          fqn = `${fullNamespaces.join('\\')}\\${fqn}`;
        }
        if (fqn.startsWith('\\')) fqn = fqn.substring(1);

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
        handlerSymbol: controllerMethod ? `${controllerClass}@${controllerMethod}` : (controllerClass || undefined),
        metadata: {
          confidence: 'inferred',
          middlewares: fullMiddlewares,
        },
      });
    }
  }
}
