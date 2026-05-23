import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class SvelteKitDetector implements FrameworkDetector {
  readonly name = 'sveltekit';
  readonly language = 'typescript';
  readonly filePattern = /\.(svelte|ts|js)$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const svelteConfigPath = join(projectRoot, 'svelte.config.js');
    if (existsSync(svelteConfigPath)) {
      return true;
    }
    const packageJsonPath = join(projectRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps && (deps['@sveltejs/kit'] || deps['svelte'])) {
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

    const pathNormalized = filePath.replace(/\\/g, '/');

    // SvelteKit filesystem routing resides in src/routes/
    if (pathNormalized.includes('src/routes/')) {
      const routesIndex = pathNormalized.indexOf('src/routes/');
      let routePart = pathNormalized.substring(routesIndex + 11); // Strip src/routes/

      // 1. +page.svelte (Page)
      if (routePart.endsWith('+page.svelte')) {
        routePart = routePart.replace(/\/\+page\.svelte$/, '');
        let routePath = '/' + routePart;
        if (routePath === '/+') routePath = '/';
        if (routePath === '') routePath = '/';

        // Map parameter format [param] -> {param}
        routePath = routePath.replace(/\[([a-zA-Z0-9_]+)\]/g, '{$1}');

        routes.push({
          framework: this.name,
          method: 'GET',
          path: routePath,
          handlerFile: filePath,
          handlerSymbol: 'default',
          metadata: {
            confidence: 'inferred',
            routeType: 'client',
          },
        });
      }

      // 2. +server.ts / +server.js (API Endpoints)
      if (routePart.endsWith('+server.ts') || routePart.endsWith('+server.js')) {
        routePart = routePart.replace(/\/\+server\.[a-zA-Z0-9]+$/, '');
        let routePath = '/' + routePart;
        if (routePath === '/+') routePath = '/';
        if (routePath === '') routePath = '/';

        routePath = routePath.replace(/\[([a-zA-Z0-9_]+)\]/g, '{$1}');

        // Parse exported HTTP verb functions
        const verbRegex = /export\s+(?:const|async\s+function)\s+(GET|POST|PUT|DELETE|PATCH)\b/g;
        let match;
        while ((match = verbRegex.exec(content)) !== null) {
          const verb = match[1];
          routes.push({
            framework: this.name,
            method: verb,
            path: routePath,
            handlerFile: filePath,
            handlerSymbol: verb,
            metadata: {
              confidence: 'inferred',
              routeType: 'server',
            },
          });
        }
      }

      // 3. +page.server.ts / +page.server.js (Server Actions)
      if (routePart.endsWith('+page.server.ts') || routePart.endsWith('+page.server.js')) {
        routePart = routePart.replace(/\/\+page\.server\.[a-zA-Z0-9]+$/, '');
        let routePath = '/' + routePart;
        if (routePath === '/+') routePath = '/';
        if (routePath === '') routePath = '/';

        routePath = routePath.replace(/\[([a-zA-Z0-9_]+)\]/g, '{$1}');

        // Match SvelteKit actions: export const actions = { ... }
        const actionsIndex = content.indexOf('export const actions');
        if (actionsIndex !== -1) {
          const braceStart = content.indexOf('{', actionsIndex);
          if (braceStart !== -1) {
            const bodyObj = getBracedContent(content, braceStart);
            if (bodyObj) {
              const actionKeysRegex = /\b([a-zA-Z0-9_]+)\s*:/g;
              let keyMatch;
              while ((keyMatch = actionKeysRegex.exec(bodyObj.content)) !== null) {
                const actionName = keyMatch[1];
                routes.push({
                  framework: this.name,
                  method: 'POST',
                  path: actionName === 'default' ? routePath : `${routePath}?/${actionName}`,
                  handlerFile: filePath,
                  handlerSymbol: `actions.${actionName}`,
                  metadata: {
                    confidence: 'inferred',
                    routeType: 'server',
                  },
                });
              }
            }
          }
        }
      }
    }

    return routes;
  }
}

function getBracedContent(str: string, startIndex: number): { content: string, endIndex: number } | null {
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
    if (char === '{') {
      depth++;
      if (depth === 1) {
        startIndex = i + 1;
      }
    } else if (char === '}') {
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
