import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

interface ChainedCall {
  name: string;
  args: string;
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
    const normalizedPath = filePath.replace(/\\/g, '/');
    const isRouteFile = normalizedPath.includes('routes/');
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
      const groupStack: { prefixes: string[], middlewares: string[], startDepth: number }[] = [];

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
            processRouteChain(parsed.calls, groupStack, braceDepth, filePath, ctx, routes, this.name);
          }
        }
      }
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
      const methodAttrs = extractAttributes(previousText);

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

    return routes;
  }
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
    calls.push({ name: 'group', args: '' });
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
      calls.push({ name: 'group', args: '' });
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

    attrs.push(bracket.content);
    index = bracket.endIndex;
  }
  return attrs;
}

function processRouteChain(
  calls: ChainedCall[],
  groupStack: any[],
  currentBraceDepth: number,
  filePath: string,
  ctx: ScanContext,
  routes: RouteBinding[],
  frameworkName: string
) {
  let verb: string | null = null;
  let uri: string | null = null;
  let handlerStr: string | null = null;
  const chainPrefixes: string[] = [];
  const chainMiddlewares: string[] = [];
  let isGroup = false;

  for (const call of calls) {
    if (call.name === 'group') {
      isGroup = true;
    } else if (['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match', 'resource', 'apiResource'].includes(call.name)) {
      verb = call.name.toUpperCase();
      const args = parseArgs(call.args);
      uri = args[0] || null;
      handlerStr = args[1] || null;
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
    }
  }

  const groupPrefixes = groupStack.flatMap(g => g.prefixes);
  const groupMiddlewares = groupStack.flatMap(g => g.middlewares);

  const fullPrefixes = [...groupPrefixes, ...chainPrefixes];
  const fullMiddlewares = [...groupMiddlewares, ...chainMiddlewares];

  if (isGroup) {
    groupStack.push({
      prefixes: chainPrefixes,
      middlewares: chainMiddlewares,
      startDepth: currentBraceDepth + 1
    });
  } else if (verb && uri && handlerStr) {
    let controllerClass: string | null = null;
    let controllerMethod: string | null = null;
    let resourceType: string | null = null;

    if (verb === 'RESOURCE' || verb === 'APIRESOURCE') {
      resourceType = verb.toLowerCase();
      const classMatch = handlerStr.match(/([a-zA-Z0-9_\\]+)(?:::class)?/);
      if (classMatch) {
        controllerClass = classMatch[1];
      }
    } else {
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
      }
    }

    if (controllerClass) {
      let resolvedFile = filePath;
      const resolvedPath = ctx.resolveSymbolToFile(controllerClass);
      if (resolvedPath) {
        resolvedFile = resolvedPath;
      }

      const cleanPrefixes = fullPrefixes.map(p => p.replace(/^\/|\/$/g, '')).filter(Boolean);
      const cleanUri = uri.replace(/^\/|\/$/g, '');
      const fullPath = '/' + [...cleanPrefixes, cleanUri].join('/');

      routes.push({
        framework: frameworkName,
        method: verb,
        path: fullPath,
        handlerFile: resolvedFile,
        handlerSymbol: controllerMethod ? `${controllerClass}@${controllerMethod}` : controllerClass,
        metadata: {
          confidence: 'inferred',
          resourceType,
          middlewares: fullMiddlewares,
        },
      });
    }
  }
}
