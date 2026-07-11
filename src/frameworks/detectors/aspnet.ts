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

    // 1. Find all classes and their class-level Route attributes
    const classRegex = /\bclass\s+([a-zA-Z0-9_]+)/g;
    const classes: Array<{ name: string; prefix: string; index: number }> = [];
    let classMatch;
    while ((classMatch = classRegex.exec(content)) !== null) {
      const className = classMatch[1];
      const classIndex = classMatch.index;

      // Look backward from classIndex to find the nearest [Route("...")] attribute applied to the class
      const startIdx = Math.max(0, classIndex - 200);
      const preText = content.substring(startIdx, classIndex);
      const routeMatches = [...preText.matchAll(/\[Route\s*\(\s*['"]([^'"]+)['"]\s*\)\]/g)];
      const prefix = routeMatches.length > 0 ? routeMatches[routeMatches.length - 1][1] : '';

      classes.push({
        name: className,
        prefix,
        index: classIndex,
      });
    }

    if (classes.length === 0) return [];

    // 2. Find all method declarations preceded by routing attributes
    // Matches one or more attributes (HttpGet/Post/Put/Delete/Patch/Route) followed by a method signature
    const methodRouteRegex = /((?:\[(?:HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|Route)[^\]]*\]\s*)+)[^{;]*\b([a-zA-Z0-9_]+)\s*\(/g;
    let methodMatch;
    while ((methodMatch = methodRouteRegex.exec(content)) !== null) {
      const attributeBlock = methodMatch[1];
      const methodName = methodMatch[2];
      const methodIndex = methodMatch.index;

      // Find the class that immediately precedes this method
      const parentClass = classes
        .filter(c => c.index < methodIndex)
        .sort((a, b) => b.index - a.index)[0];
      if (!parentClass) continue;

      // Extract verb and template from the attribute block
      const attrRegex = /\[(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|Route)(?:\s*\(\s*['"]([^'"]+)['"]\s*\))?[^\]]*\]/g;
      let attrMatch;
      let verb = 'GET';
      let methodTemplate = '';

      while ((attrMatch = attrRegex.exec(attributeBlock)) !== null) {
        const attrName = attrMatch[1];
        const templateVal = attrMatch[2] || '';

        if (attrName.startsWith('Http')) {
          verb = attrName.substring(4).toUpperCase();
          if (templateVal) {
            methodTemplate = templateVal;
          }
        } else if (attrName === 'Route') {
          if (templateVal) {
            methodTemplate = templateVal;
          }
        }
      }

      // Compute controller name from class name
      const className = parentClass.name;
      const controllerName = className.endsWith('Controller')
        ? className.substring(0, className.length - 10).toLowerCase()
        : className.toLowerCase();

      // Resolve class prefix
      let classRoutePrefix = parentClass.prefix;
      classRoutePrefix = classRoutePrefix.replace(/\[controller\]/gi, controllerName);

      const cleanClassPrefix = classRoutePrefix.replace(/^\/|\/$/g, '');
      const cleanMethodTemplate = methodTemplate.replace(/^\/|\/$/g, '');
      let combinedPath = '/' + [cleanClassPrefix, cleanMethodTemplate].filter(Boolean).join('/');

      // Replace [action] token with the lowercase method name
      combinedPath = combinedPath.replace(/\[action\]/gi, methodName.toLowerCase());

      // ASP.NET route parameter format: {id} or {id:int} or {*slug} or {id:min(1)} -> we match and map to {id}
      combinedPath = combinedPath.replace(/\{([a-zA-Z0-9_?*]+)(?::[^}]+)?\}/g, '{$1}');

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
