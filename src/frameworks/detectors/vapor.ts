import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class VaporDetector implements FrameworkDetector {
  readonly name = 'vapor';
  readonly language = 'swift';
  readonly filePattern = /\.swift$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const pkgSwift = join(projectRoot, 'Package.swift');
    return existsSync(pkgSwift) || files.some(f => f.endsWith('.swift'));
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!content.includes('import Vapor') && !content.includes('routes(')) {
      return [];
    }

    // Match routing declarations: e.g. app.get("users", ":id", use: handler)
    // Wait, the routes could also be declared on group router: e.g., group.post("login", use: loginHandler)
    const routeRegex = /\b[a-zA-Z0-9_]+\.(get|post|put|delete|patch)\s*\(\s*([^)]+)\s*,\s*use\s*:\s*([a-zA-Z0-9_.]+)\s*\)/g;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const verb = match[1].toUpperCase();
      const rawSegments = match[2];
      const handlerSymbol = match[3];

      // Parse comma-separated route segments
      const segments = rawSegments
        .split(',')
        .map(s => s.trim())
        .map(s => s.replace(/['"]/g, ''))
        .filter(s => s !== '');

      // Replace path parameters starting with : e.g., :id to {id}
      const mappedSegments = segments.map(seg => {
        if (seg.startsWith(':')) {
          return `{${seg.substring(1)}}`;
        }
        return seg;
      });

      const pathVal = '/' + mappedSegments.join('/');

      let resolvedFile = filePath;
      const resolvedPath = ctx.resolveSymbolToFile(handlerSymbol);
      if (resolvedPath) {
        resolvedFile = resolvedPath;
      }

      routes.push({
        framework: this.name,
        method: verb,
        path: pathVal,
        handlerFile: resolvedFile,
        handlerSymbol: handlerSymbol,
        metadata: {
          confidence: 'inferred',
          routeType: 'server',
        },
      });
    }

    return routes;
  }
}
