import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class AspNetDetector implements FrameworkDetector {
  readonly name = 'aspnet';
  readonly language = 'csharp';
  readonly filePattern = /\.cs$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const hasCsproj = files.some(f => f.endsWith('.csproj') || f.endsWith('.sln'));
    if (hasCsproj) return true;
    return files.some(f => f.endsWith('.cs'));
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!content.includes('Controller') && !content.includes('Route') && !content.includes('Http')) {
      return [];
    }

    // 1. Class name extraction
    const classMatch = content.match(/\bclass\s+([a-zA-Z0-9_]+)\b/);
    if (!classMatch) return [];
    const className = classMatch[1];

    // Compute controller name from class name
    const controllerName = className.endsWith('Controller')
      ? className.substring(0, className.length - 10).toLowerCase()
      : className.toLowerCase();

    // 2. Class Route prefix extraction
    let classRoutePrefix = '';
    const classRouteMatch = content.match(/\[Route\s*\(\s*['"]([^'"]+)['"]\s*\)\]/);
    if (classRouteMatch) {
      classRoutePrefix = classRouteMatch[1];
      // Replace token [controller] with our computed controllerName
      classRoutePrefix = classRoutePrefix.replace(/\[controller\]/gi, controllerName);
    }

    // 3. Method routing extraction
    // Match HttpGet, HttpPost, HttpPut, HttpDelete, HttpPatch with optional route template parameter
    const methodRouteRegex = /\[Http(Get|Post|Put|Delete|Patch)(?:\s*\(\s*['"]([^'"]+)['"]\s*\))?\][^({]*?\b([a-zA-Z0-9_]+)\s*\(/g;
    let match;
    while ((match = methodRouteRegex.exec(content)) !== null) {
      const verb = match[1].toUpperCase();
      const methodTemplate = match[2] || '';
      const methodName = match[3];

      const cleanClassPrefix = classRoutePrefix.replace(/^\/|\/$/g, '');
      const cleanMethodTemplate = methodTemplate.replace(/^\/|\/$/g, '');
      let combinedPath = '/' + [cleanClassPrefix, cleanMethodTemplate].filter(Boolean).join('/');

      // ASP.NET route parameter format: {id} or {id:int} or {*slug} -> we match and map to {id}
      combinedPath = combinedPath.replace(/\{([a-zA-Z0-9_?*]+)(?::[a-zA-Z0-9_]+)?\}/g, '{$1}');

      routes.push({
        framework: this.name,
        method: verb,
        path: combinedPath,
        handlerFile: filePath,
        handlerSymbol: `${className}.${methodName}`,
        metadata: {
          confidence: 'inferred',
          routeType: 'server',
        },
      });
    }

    return routes;
  }
}
