import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';
import { hasPackageJsonDependency } from '../utils.js';

export class ExpressDetector implements FrameworkDetector {
  readonly name = 'express';
  readonly language = 'typescript';
  readonly filePattern = /\.(js|ts)$/;

  private routerPrefixes = new Map<string, string>(); // router variable -> prefix

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const isExpress = await hasPackageJsonDependency(projectRoot, files, ['express']);

    if (isExpress) {
      // Pre-scan all JS/TS files to map router variable use to prefixes
      for (const file of files) {
        if (!file.match(this.filePattern) || file.includes('node_modules')) continue;
        try {
          const content = await readFile(join(projectRoot, file), 'utf-8');
          // Match: app.use('/api', apiRouter)
          const useRegex = /([a-zA-Z0-9_]+)\.use\s*\(\s*['"]([^'"]+)['"]\s*,\s*([a-zA-Z0-9_]+)\)/g;
          let match;
          while ((match = useRegex.exec(content)) !== null) {
            const prefix = match[2];
            const routerVar = match[3];
            this.routerPrefixes.set(routerVar, prefix);
          }
        } catch {
          // Ignored
        }
      }
    }

    return isExpress;
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!content.includes('express') && !content.includes('Router') && !content.includes('.get') && !content.includes('.post')) {
      return [];
    }

    // 1. Parse app.METHOD('path', ...middlewares, handler)
    let index = 0;
    while (true) {
      const match = content.substring(index).match(/([a-zA-Z0-9_]+)\.(get|post|put|delete|patch|options|use)\s*\(/);
      if (!match) break;

      const targetVar = match[1];
      const method = match[2].toUpperCase();
      const startOfParen = index + match.index! + match[0].length - 1;

      const paren = getParenthesizedContent(content, startOfParen);
      if (!paren) {
        index = startOfParen + 1;
        continue;
      }

      const args = parseArgs(paren.content);
      const routePath = args[0] || '';

      // Handler is typically the last argument
      if (args.length >= 2 && method !== 'USE') {
        const handlerSymbol = args[args.length - 1];
        const middlewares = args.slice(1, args.length - 1);

        const routerPrefix = this.routerPrefixes.get(targetVar) || '';
        const cleanPrefix = routerPrefix.replace(/^\/|\/$/g, '');
        const cleanRoute = routePath.replace(/^\/|\/$/g, '');
        const fullPath = '/' + [cleanPrefix, cleanRoute].filter(Boolean).join('/');

        let resolvedFile = filePath;
        const resolvedPath = ctx.resolveSymbolToFile(handlerSymbol);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }

        routes.push({
          framework: this.name,
          method,
          path: fullPath,
          handlerFile: resolvedFile,
          handlerSymbol,
          metadata: {
            confidence: 'inferred',
            middlewares: middlewares.filter(m => !m.includes('function') && !m.includes('=>')), // filter inline callbacks
          },
        });
      }

      index = paren.endIndex;
    }

    // 2. Parse router.route('/users').get(h).post(h)
    let routeIndex = 0;
    while (true) {
      const routeMatch = content.substring(routeIndex).match(/([a-zA-Z0-9_]+)\.route\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (!routeMatch) break;

      const routePath = routeMatch[2];
      const startOfChain = routeIndex + routeMatch.index! + routeMatch[0].length;

      // Extract trailing method calls like .get(handler) or .post(handler)
      const trailingSlice = content.substring(startOfChain);
      const chainRegex = /\s*\.(get|post|put|delete|patch|options)\s*\(\s*([^)]+)\)/g;
      let chainMatch;
      let lastMatchEnd = 0;

      while ((chainMatch = chainRegex.exec(trailingSlice)) !== null) {
        const matchIndex = chainMatch.index;
        const skipped = trailingSlice.substring(lastMatchEnd, matchIndex);
        if (skipped.trim() !== '') {
          break; // Not consecutive
        }

        const method = chainMatch[1].toUpperCase();
        const handlerSymbol = chainMatch[2].trim();

        let resolvedFile = filePath;
        const resolvedPath = ctx.resolveSymbolToFile(handlerSymbol);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }

        routes.push({
          framework: this.name,
          method,
          path: routePath,
          handlerFile: resolvedFile,
          handlerSymbol,
          metadata: {
            confidence: 'inferred',
          },
        });

        lastMatchEnd = chainRegex.lastIndex;
      }

      routeIndex = startOfChain;
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
    if (char === "'" || char === '"' || char === '`') {
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

function parseArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
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
    if (char === "'" || char === '"' || char === '`') {
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
    } else if (char === '{') {
      braceDepth++;
    } else if (char === '}') {
      braceDepth--;
    }

    if (char === ',' && depth === 0 && bracketDepth === 0 && braceDepth === 0) {
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
  return str.replace(/^['"`]|['"`]$/g, '');
}
