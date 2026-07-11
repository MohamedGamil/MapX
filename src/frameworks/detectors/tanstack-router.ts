import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';
import { hasPackageJsonDependency } from '../utils.js';

export class TanstackRouterDetector implements FrameworkDetector {
  readonly name = 'tanstack-router';
  readonly language = 'typescript';
  readonly filePattern = /\.(js|jsx|ts|tsx)$/;

  private projectFiles: string[] = [];

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    this.projectFiles = files;
    return hasPackageJsonDependency(projectRoot, files, ['@tanstack/react-router']);
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // 1. File-based routing (only extract if this file is a route file)
    // Tanstack Router route files are typically located under a routes/ directory
    if (filePath.includes('routes/')) {
      // Extract route path from file path
      const routesDirIndex = filePath.indexOf('routes/');
      let routePart = filePath.substring(routesDirIndex + 7); // Strip up to routes/
      routePart = routePart.replace(/\.[a-zA-Z0-9]+$/, ''); // Strip extension

      // Convert dots to slashes (e.g., users.index -> users/index)
      let routePath = '/' + routePart.replace(/\./g, '/');
      routePath = routePath.replace(/\/index$/, ''); // Strip index suffix
      if (routePath === '') routePath = '/';

      // Map parameter format $param to {param}
      routePath = routePath.replace(/\$([a-zA-Z0-9_]+)/g, '{$1}');

      routes.push({
        framework: this.name,
        method: 'GET',
        path: routePath,
        handlerFile: filePath,
        handlerSymbol: 'Route',
        metadata: {
          confidence: 'inferred',
          routeType: 'client',
        },
      });
    }

    // 2. Code-based routes
    // new Route({ getParentRoute: ..., path: '/users', component: UserList })
    const routeRegex = /new\s+Route\s*\(\s*\{([^}]+)\}/g;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const configBody = match[1];
      const pathMatch = configBody.match(/\bpath\s*:\s*['"]([^'"]+)['"]/);
      const compMatch = configBody.match(/\bcomponent\s*:\s*([a-zA-Z0-9_]+)/);

      if (pathMatch) {
        const routePath = pathMatch[1];
        const componentSymbol = compMatch ? compMatch[1] : undefined;

        let resolvedFile = filePath;
        if (componentSymbol) {
          const resolvedPath = ctx.resolveSymbolToFile(componentSymbol);
          if (resolvedPath) {
            resolvedFile = resolvedPath;
          }
        }

        routes.push({
          framework: this.name,
          method: 'GET',
          path: routePath,
          handlerFile: resolvedFile,
          handlerSymbol: componentSymbol || 'Route',
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
