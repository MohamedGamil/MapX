import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';
import { hasPackageJsonDependency } from '../utils.js';

export class NextJSDetector implements FrameworkDetector {
  readonly name = 'nextjs';
  readonly language = 'typescript';
  readonly filePattern = /\.(js|jsx|ts|tsx)$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    return hasPackageJsonDependency(projectRoot, files, ['next']);
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // Normalized file path slashes
    const pathNormalized = filePath.replace(/\\/g, '/');

    // 1. Pages Router
    // e.g. pages/about.tsx -> /about, pages/api/users.ts -> /api/users
    if (pathNormalized.includes('pages/')) {
      const pagesIndex = pathNormalized.indexOf('pages/');
      let routePart = pathNormalized.substring(pagesIndex + 6); // Strip pages/
      routePart = routePart.replace(/\.[a-zA-Z0-9]+$/, ''); // Strip extension
      let routePath = '/' + routePart;
      routePath = routePath.replace(/\/index$/, ''); // Strip index
      if (routePath === '') routePath = '/';

      // Map parameter format [param] -> {param}
      routePath = routePath.replace(/\[([a-zA-Z0-9_]+)\]/g, '{$1}');

      const isApi = routePath.startsWith('/api/');
      routes.push({
        framework: this.name,
        method: isApi ? 'ALL' : 'GET',
        path: routePath,
        handlerFile: filePath,
        handlerSymbol: 'default',
        metadata: {
          confidence: 'inferred',
          routeType: isApi ? 'server' : 'client',
        },
      });
    }

    // 2. App Router Page
    // e.g. app/(auth)/login/page.tsx -> /login
    if (pathNormalized.endsWith('/page.tsx') || pathNormalized.endsWith('/page.jsx')) {
      const appIndex = pathNormalized.indexOf('app/');
      if (appIndex !== -1) {
        let routePart = pathNormalized.substring(appIndex + 4); // Strip app/
        routePart = routePart.replace(/\/page\.[a-zA-Z0-9]+$/, ''); // Strip page.tsx

        // Split segments and filter out route groups e.g. (auth)
        const segments = routePart.split('/').filter(seg => !seg.startsWith('(') || !seg.endsWith(')'));
        let routePath = '/' + segments.join('/');
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
    }

    // 3. App Router Route Handler (API endpoint)
    // e.g. app/api/users/route.ts -> /api/users
    if (pathNormalized.endsWith('/route.ts') || pathNormalized.endsWith('/route.js')) {
      const appIndex = pathNormalized.indexOf('app/');
      if (appIndex !== -1) {
        let routePart = pathNormalized.substring(appIndex + 4);
        routePart = routePart.replace(/\/route\.[a-zA-Z0-9]+$/, '');

        const segments = routePart.split('/').filter(seg => !seg.startsWith('(') || !seg.endsWith(')'));
        let routePath = '/' + segments.join('/');
        if (routePath === '') routePath = '/';

        routePath = routePath.replace(/\[([a-zA-Z0-9_]+)\]/g, '{$1}');

        // Parse exported HTTP verb functions
        const verbRegex = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/g;
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
    }

    // 4. Server Actions
    // Files containing 'use server' either at top or inside exported functions
    if (content.includes("'use server'") || content.includes('"use server"')) {
      const actionRegex = /export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)\b/g;
      let match;
      while ((match = actionRegex.exec(content)) !== null) {
        const actionName = match[1];
        routes.push({
          framework: this.name,
          method: 'POST',
          path: `/action/${actionName}`,
          handlerFile: filePath,
          handlerSymbol: actionName,
          metadata: {
            confidence: 'inferred',
            routeType: 'server',
          },
        });
      }
    }

    return routes;
  }
}
