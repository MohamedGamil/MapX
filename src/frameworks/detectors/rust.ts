import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class RustDetector implements FrameworkDetector {
  readonly name = 'rust-web';
  readonly language = 'rust';
  readonly filePattern = /\.rs$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const cargoPath = join(projectRoot, 'Cargo.toml');
    return existsSync(cargoPath) || files.some(f => f.endsWith('.rs'));
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // 1. Axum routing
    // e.g. .route("/users", get(get_users).post(create_user))
    const axumRegex = /\.route\s*\(\s*['"]([^'"]+)['"]\s*,\s*([a-z0-9_]+)\s*\(\s*([a-zA-Z0-9_:]+)\s*\)\s*\)/g;
    let match;
    while ((match = axumRegex.exec(content)) !== null) {
      const pathVal = match[1];
      const verb = match[2].toUpperCase(); // e.g. get -> GET
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

    // 2. Actix-web & Rocket attribute routing
    // e.g. #[get("/users")]
    const attrRegex = /#\[(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]\s*\)\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\b/g;
    while ((match = attrRegex.exec(content)) !== null) {
      const verb = match[1].toUpperCase();
      let pathVal = match[2];
      const handlerSymbol = match[3];

      // Convert Rocket format <param> to {param}
      pathVal = pathVal.replace(/<([a-zA-Z0-9_]+)>/g, '{$1}');

      routes.push({
        framework: this.name,
        method: verb,
        path: pathVal,
        handlerFile: filePath,
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
