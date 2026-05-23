import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class FastAPIDetector implements FrameworkDetector {
  readonly name = 'fastapi';
  readonly language = 'python';
  readonly filePattern = /\.py$/;

  private routerPrefixes = new Map<string, string>(); // router variable -> prefix

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    let isFastAPI = false;

    // Check project dependencies
    for (const file of ['requirements.txt', 'Pipfile', 'pyproject.toml']) {
      const filePath = join(projectRoot, file);
      if (existsSync(filePath)) {
        try {
          const content = await readFile(filePath, 'utf-8');
          if (content.toLowerCase().includes('fastapi')) {
            isFastAPI = true;
          }
        } catch {
          // Ignored
        }
      }
    }

    if (!isFastAPI) {
      isFastAPI = files.some(f => f.endsWith('main.py'));
    }

    if (isFastAPI) {
      // Pre-scan all python files to map APIRouter variables and registrations to prefixes
      for (const file of files) {
        if (!file.endsWith('.py')) continue;
        try {
          const content = await readFile(join(projectRoot, file), 'utf-8');
          
          // 1. router = APIRouter(prefix="/users")
          const routerDefRegex = /(\w+)\s*=\s*APIRouter\s*\(\s*(?:prefix\s*=\s*)?['"]([^'"]+)['"]/g;
          let match;
          while ((match = routerDefRegex.exec(content)) !== null) {
            const varName = match[1];
            const prefix = match[2];
            this.routerPrefixes.set(varName, prefix);
          }

          // 2. app.include_router(router, prefix="/users")
          const routerIncRegex = /include_router\s*\(\s*([^,\s)]+)(?:,\s*prefix\s*=\s*['"]([^'"]+)['"])?/g;
          while ((match = routerIncRegex.exec(content)) !== null) {
            const routerVar = match[1].split('.').pop() || '';
            const prefix = match[2];
            if (prefix) {
              this.routerPrefixes.set(routerVar, prefix);
            }
          }
        } catch {
          // Ignored
        }
      }
    }

    return isFastAPI;
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // Skip if no FastAPI decorators are present
    if (!content.includes('@') || !content.includes('.')) {
      return [];
    }

    // Match FastAPI verb decorators: @app.get(...) or @router.post(...)
    let index = 0;
    while (true) {
      const match = content.substring(index).match(/@(\w+)\.(get|post|put|delete|patch|options|head|trace)\s*\(/);
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

      const postDecoratorText = content.substring(paren.endIndex);
      const funcMatch = postDecoratorText.match(/^\s*(?:def|async def)\s+(\w+)\s*\(/);
      if (funcMatch) {
        const funcName = funcMatch[1];

        const routerPrefix = this.routerPrefixes.get(targetVar) || '';
        const cleanPrefix = routerPrefix.replace(/^\/|\/$/g, '');
        const cleanRoute = routePath.replace(/^\/|\/$/g, '');
        const fullPath = '/' + [cleanPrefix, cleanRoute].filter(Boolean).join('/');

        let resolvedFile = filePath;
        const resolvedPath = ctx.resolveSymbolToFile(funcName);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }

        routes.push({
          framework: this.name,
          method,
          path: fullPath,
          handlerFile: resolvedFile,
          handlerSymbol: funcName,
          metadata: {
            confidence: 'inferred',
          },
        });
      }

      index = paren.endIndex;
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
