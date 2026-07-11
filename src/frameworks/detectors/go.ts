import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class GoDetector implements FrameworkDetector {
  readonly name = 'go';
  readonly language = 'go';
  readonly filePattern = /\.go$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    if (files.some(f => f === 'go.mod' || f.endsWith('/go.mod'))) {
      return true;
    }
    const modPath = join(projectRoot, 'go.mod');
    return existsSync(modPath);
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // 1. Gin & Chi routing
    // e.g., router.GET("/users", handler) or router.Get("/users", handler)
    const verbRegex = /\b[a-zA-Z0-9_]+\.(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|Get|Post|Put|Delete|Patch|Options|Head)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([a-zA-Z0-9_.]+)/g;
    let match;
    while ((match = verbRegex.exec(content)) !== null) {
      const verb = match[1].toUpperCase();
      const pathVal = match[2];
      const handlerSymbol = match[3];

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

    // 2. Gorilla Mux routing
    // e.g., router.HandleFunc("/users", handler).Methods("GET", "POST")
    const muxRegex = /\b[a-zA-Z0-9_]+\.HandleFunc\s*\(\s*['"]([^'"]+)['"]\s*,\s*([a-zA-Z0-9_.]+)\s*\)(?:\.Methods\s*\(\s*([^)]+)\s*\))?/g;
    while ((match = muxRegex.exec(content)) !== null) {
      const pathVal = match[1];
      const handlerSymbol = match[2];
      const methodsStr = match[3];

      let resolvedFile = filePath;
      const resolvedPath = ctx.resolveSymbolToFile(handlerSymbol);
      if (resolvedPath) {
        resolvedFile = resolvedPath;
      }

      const verbs: string[] = [];
      if (methodsStr) {
        // e.g., "GET", "POST"
        const verbMatches = methodsStr.match(/['"]([A-Z]+)['"]/g);
        if (verbMatches) {
          verbs.push(...verbMatches.map(v => v.replace(/['"]/g, '')));
        }
      }

      if (verbs.length === 0) {
        verbs.push('ALL');
      }

      for (const verb of verbs) {
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
    }

    return routes;
  }
}
