import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class DjangoDetector implements FrameworkDetector {
  readonly name = 'django';
  readonly language = 'python';
  readonly filePattern = /urls\.py$/;

  private projectFiles: string[] = [];

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    this.projectFiles = files; // Store files list for include resolution
    const hasManagePy = files.some(f => f.endsWith('manage.py'));
    if (hasManagePy) return true;

    for (const file of ['requirements.txt', 'Pipfile', 'pyproject.toml']) {
      const filePath = join(projectRoot, file);
      if (existsSync(filePath)) {
        try {
          const content = await readFile(filePath, 'utf-8');
          if (content.toLowerCase().includes('django')) {
            return true;
          }
        } catch {
          // Ignored
        }
      }
    }
    return false;
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];
    const visitedFiles = new Set<string>();
    await this.parseUrlsFile(filePath, content, '', ctx, routes, visitedFiles);
    return routes;
  }

  private async parseUrlsFile(
    filePath: string,
    content: string,
    prefix: string,
    ctx: ScanContext,
    routes: RouteBinding[],
    visitedFiles: Set<string>
  ) {
    if (visitedFiles.has(filePath)) return;
    visitedFiles.add(filePath);

    // 1. Match paths/urls: path('route', handler) or re_path(r'^route$', handler)
    // Matches path('route', view, name='...') or path('route', include('...'))
    const pathRegex = /\b(path|re_path|url)\s*\(\s*['"]([^'"]*)['"]\s*,\s*([^)]+)\)/g;
    let match;

    while ((match = pathRegex.exec(content)) !== null) {
      const routePath = match[2];
      const handlerStr = match[3].trim();

      const cleanPrefix = prefix.replace(/^\/|\/$/g, '');
      const cleanRoute = routePath.replace(/^\/|\/$/g, '');
      const fullPath = '/' + [cleanPrefix, cleanRoute].filter(Boolean).join('/');

      // Check if it is an include
      const includeMatch = handlerStr.match(/include\s*\(\s*['"]([^'"]+)['"]/);
      if (includeMatch) {
        const includedModule = includeMatch[1];
        const resolvedPath = this.resolveModulePath(includedModule);
        if (resolvedPath) {
          const absResolvedPath = join(ctx.workspaceRoot, resolvedPath);
          if (existsSync(absResolvedPath)) {
            try {
              const subContent = await readFile(absResolvedPath, 'utf-8');
              await this.parseUrlsFile(resolvedPath, subContent, fullPath, ctx, routes, visitedFiles);
            } catch {
              // Ignored
            }
          }
        }
      } else {
        // E.g. views.index or MyView.as_view()
        let handlerSymbol = handlerStr.split(',')[0].trim();
        // Clean as_view()
        handlerSymbol = handlerSymbol.replace(/\.as_view\s*\([^)]*\)/, '');

        let resolvedFile = filePath;
        const resolvedPath = ctx.resolveSymbolToFile(handlerSymbol);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }

        routes.push({
          framework: this.name,
          method: 'GET', // Django defaults to GET/any unless method-check decorators are used
          path: fullPath,
          handlerFile: resolvedFile,
          handlerSymbol,
          metadata: {
            confidence: 'inferred',
          },
        });
      }
    }

    // 2. Match Django REST Framework router registrations
    // e.g. router.register(r'users', UserViewSet, basename='user')
    const routerRegex = /router\.register\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([a-zA-Z0-9_]+)/g;
    while ((match = routerRegex.exec(content)) !== null) {
      const routerPath = match[1];
      const viewSetSymbol = match[2];

      const cleanPrefix = prefix.replace(/^\/|\/$/g, '');
      const cleanRoute = routerPath.replace(/^\/|\/$/g, '');
      const fullPath = '/' + [cleanPrefix, cleanRoute].filter(Boolean).join('/');

      let resolvedFile = filePath;
      const resolvedPath = ctx.resolveSymbolToFile(viewSetSymbol);
      if (resolvedPath) {
        resolvedFile = resolvedPath;
      }

      // Expand to DRF CRUD endpoints
      const verbs = [
        { method: 'GET', suffix: '/', symbolSuffix: '.list' },
        { method: 'POST', suffix: '/', symbolSuffix: '.create' },
        { method: 'GET', suffix: '/{id}/', symbolSuffix: '.retrieve' },
        { method: 'PUT', suffix: '/{id}/', symbolSuffix: '.update' },
        { method: 'PATCH', suffix: '/{id}/', symbolSuffix: '.partial_update' },
        { method: 'DELETE', suffix: '/{id}/', symbolSuffix: '.destroy' },
      ];

      for (const v of verbs) {
        const cleanSuffix = v.suffix.replace(/^\/|\/$/g, '');
        const finalPath = '/' + [fullPath.replace(/^\/|\/$/g, ''), cleanSuffix].filter(Boolean).join('/');

        routes.push({
          framework: this.name,
          method: v.method,
          path: finalPath,
          handlerFile: resolvedFile,
          handlerSymbol: `${viewSetSymbol}${v.symbolSuffix}`,
          metadata: {
            confidence: 'inferred',
            resourceType: 'drf_viewset',
          },
        });
      }
    }
  }

  private resolveModulePath(moduleStr: string): string | null {
    const targetRelPath = moduleStr.replace(/\./g, '/') + '.py';
    for (const f of this.projectFiles) {
      if (f.endsWith(targetRelPath)) {
        return f;
      }
    }
    const parts = moduleStr.split('.');
    const lastPart = parts[parts.length - 1] + '.py';
    for (const f of this.projectFiles) {
      if (f.endsWith(lastPart)) {
        return f;
      }
    }
    return null;
  }
}
