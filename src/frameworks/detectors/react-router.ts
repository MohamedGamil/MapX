import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class ReactRouterDetector implements FrameworkDetector {
  readonly name = 'react-router';
  readonly language = 'typescript';
  readonly filePattern = /\.(js|jsx|ts|tsx)$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const packageJsonPath = join(projectRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps && (deps['react-router'] || deps['react-router-dom'])) {
          return true;
        }
      } catch {
        // Ignored
      }
    }
    return false;
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!content.includes('Route') && !content.includes('createBrowserRouter')) {
      return [];
    }

    // 1. Nested JSX Route parsing
    // We walk the content and keep a stack of paths for nested <Route> elements
    const tagRegex = /<\/?Route\b|path=['"]([^'"]*)['"]|element=\{\s*<\s*([a-zA-Z0-9_]+)/g;
    let match;
    const pathStack: string[] = [];
    let currentPath: string | null = null;
    let currentElement: string | null = null;
    let inOpeningTag = false;

    // Line-by-line tag scanning for simplicity
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.includes('<Route')) {
        const pathMatch = line.match(/\bpath=['"]([^'"]*)['"]/);
        const elementMatch = line.match(/\belement=\{\s*<\s*([a-zA-Z0-9_]+)/);

        const pathSeg = pathMatch ? pathMatch[1] : '';
        const element = elementMatch ? elementMatch[1] : null;

        if (line.trim().endsWith('/>')) {
          // Self-closing Route tag: emit route but do not push to nesting stack
          const fullPath = '/' + [...pathStack, pathSeg].map(p => p.replace(/^\/|\/$/g, '')).filter(Boolean).join('/');
          if (element) {
            let resolvedFile = filePath;
            const resolvedPath = ctx.resolveSymbolToFile(element);
            if (resolvedPath) {
              resolvedFile = resolvedPath;
            }
            routes.push({
              framework: this.name,
              method: 'GET',
              path: fullPath,
              handlerFile: resolvedFile,
              handlerSymbol: element,
              metadata: {
                confidence: 'inferred',
                routeType: 'client',
              },
            });
          }
        } else {
          // Opening Route tag: push to stack
          pathStack.push(pathSeg);
          if (element) {
            const fullPath = '/' + pathStack.map(p => p.replace(/^\/|\/$/g, '')).filter(Boolean).join('/');
            let resolvedFile = filePath;
            const resolvedPath = ctx.resolveSymbolToFile(element);
            if (resolvedPath) {
              resolvedFile = resolvedPath;
            }
            routes.push({
              framework: this.name,
              method: 'GET',
              path: fullPath,
              handlerFile: resolvedFile,
              handlerSymbol: element,
              metadata: {
                confidence: 'inferred',
                routeType: 'client',
              },
            });
          }
        }
      } else if (line.includes('</Route>')) {
        pathStack.pop();
      }
    }

    // 2. createBrowserRouter array parsing
    // E.g. { path: '/admin', children: [ { path: 'users', element: <AdminUsers /> } ] }
    const createRouterRegex = /createBrowserRouter\s*\(/;
    if (createRouterRegex.test(content)) {
      const configRegex = /path\s*:\s*['"]([^'"]+)['"]\s*,\s*element\s*:\s*<\s*([a-zA-Z0-9_]+)/g;
      while ((match = configRegex.exec(content)) !== null) {
        const routePath = match[1];
        const element = match[2];

        let resolvedFile = filePath;
        const resolvedPath = ctx.resolveSymbolToFile(element);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }

        routes.push({
          framework: this.name,
          method: 'GET',
          path: routePath,
          handlerFile: resolvedFile,
          handlerSymbol: element,
          metadata: {
            confidence: 'inferred',
            routeType: 'client',
          },
        });
      }
    }

    return routes;
  }
}
