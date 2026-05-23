import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class SpringDetector implements FrameworkDetector {
  readonly name = 'spring';
  readonly language = 'java';
  readonly filePattern = /\.(java|kt)$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const hasPom = existsSync(join(projectRoot, 'pom.xml'));
    const hasGradle = existsSync(join(projectRoot, 'build.gradle'));
    if (hasPom || hasGradle) return true;

    // Check for @SpringBootApplication or class imports
    return files.some(f => f.endsWith('.java') || f.endsWith('.kt'));
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!content.includes('Controller') && !content.includes('RequestMapping')) {
      return [];
    }

    // 1. Extract class-level prefix
    let classPrefix = '';
    const classMappingMatch = content.match(/@RequestMapping\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (classMappingMatch) {
      classPrefix = classMappingMatch[1];
    } else {
      const restControllerMatch = content.match(/@RestController\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (restControllerMatch) {
        classPrefix = restControllerMatch[1];
      }
    }

    // 2. Extract class name as symbol representation
    const classDeclMatch = content.match(/\bclass\s+([a-zA-Z0-9_]+)\b/);
    const className = classDeclMatch ? classDeclMatch[1] : 'Controller';

    // 3. Match mapping methods: @GetMapping, @PostMapping, etc.
    const mappingRegex = /@(Get|Post|Put|Delete|Patch)Mapping(?:\s*\(\s*['"]([^'"]+)['"]\s*\))?[^({]*?\b([a-zA-Z0-9_]+)\s*\(/g;
    let match;
    while ((match = mappingRegex.exec(content)) !== null) {
      const mappingType = match[1].toUpperCase(); // GET, POST etc
      const mappingPath = match[2] || '';
      const methodName = match[3];

      const cleanClassPrefix = classPrefix.replace(/^\/|\/$/g, '');
      const cleanMethodPath = mappingPath.replace(/^\/|\/$/g, '');
      const combinedPath = '/' + [cleanClassPrefix, cleanMethodPath].filter(Boolean).join('/');

      routes.push({
        framework: this.name,
        method: mappingType,
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
