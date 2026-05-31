import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';
import { hasPackageJsonDependency } from '../utils.js';

export class VueRouterDetector implements FrameworkDetector {
  readonly name = 'vue-router';
  readonly language = 'typescript';
  readonly filePattern = /\.(js|ts|vue)$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    return hasPackageJsonDependency(projectRoot, files, ['vue-router', 'vue']);
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!content.includes('VueRouter') && !content.includes('createRouter') && !content.includes('routes') && !content.includes('routerMap') && !content.includes('routeMap')) {
      return [];
    }

    // Locate "routes: [", "routes = [", "routerMap = [", "routeMap: [", etc.
    let index = 0;
    while (true) {
      const match = content.substring(index).match(/\b[a-zA-Z0-9_]*(?:routes|Routes|routesList|routerMap|routeMap|RouteMap)(?:\s*:[^=]+)?\s*[=:]\s*\[/);
      if (!match) break;

      const startOfArray = index + match.index! + match[0].length - 1;
      const arrayObj = getBracketedContent(content, startOfArray);
      if (!arrayObj) {
        index = startOfArray + 1;
        continue;
      }

      const parsedRoutes = this.parseRoutesArray(arrayObj.content, filePath, ctx);
      routes.push(...parsedRoutes);

      index = arrayObj.endIndex;
    }

    return routes;
  }

  private parseRoutesArray(content: string, filePath: string, ctx: ScanContext, prefixParts: string[] = []): RouteBinding[] {
    const routes: RouteBinding[] = [];
    let index = 0;

    while (index < content.length) {
      const startOfBrace = content.indexOf('{', index);
      if (startOfBrace === -1) break;

      const obj = getBracedContent(content, startOfBrace);
      if (!obj) {
        index = startOfBrace + 1;
        continue;
      }

      // Parse current route object
      const objBody = obj.content;
      const pathMatch = objBody.match(/\bpath\s*:\s*['"`]([^'"`]*)['"`]/);
      const pathVal = pathMatch ? pathMatch[1] : '';

      // Try matching component or components
      const componentsList: { symbol: string, file: string }[] = [];

      // 1. Single component matches: component: ComponentName
      const compMatch = objBody.match(/\bcomponent\s*:\s*([a-zA-Z0-9_]+)\b(?!\s*=>)/);
      if (compMatch && compMatch[1] !== 'import' && compMatch[1] !== 'require') {
        const componentSymbol = compMatch[1];
        let resolvedFile = filePath;
        const resolvedPath = ctx.resolveSymbolToFile(componentSymbol);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }
        componentsList.push({ symbol: componentSymbol, file: resolvedFile });
      }

      // 2. Dynamic import matches: component: () => import('./Home.vue')
      const importMatches = objBody.matchAll(/import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g);
      for (const impMatch of importMatches) {
        const importPath = impMatch[1];
        let resolvedFile = filePath;
        if (importPath.startsWith('.')) {
          resolvedFile = join(dirname(filePath), importPath);
        }
        const symbol = importPath.split('/').pop()?.replace(/\.[a-zA-Z0-9]+$/, '') || 'Component';
        componentsList.push({ symbol, file: resolvedFile });
      }

      // 3. Legacy require/resolve matches: component: resolve => require(['./Home.vue'], resolve)
      // or require('./Home.vue').default
      const requireMatches = objBody.matchAll(/require\s*\(\s*(?:\[\s*)?['"`]([^'"`]+)['"`]/g);
      for (const reqMatch of requireMatches) {
        const importPath = reqMatch[1];
        let resolvedFile = filePath;
        if (importPath.startsWith('.')) {
          resolvedFile = join(dirname(filePath), importPath);
        }
        const symbol = importPath.split('/').pop()?.replace(/\.[a-zA-Z0-9]+$/, '') || 'Component';
        componentsList.push({ symbol, file: resolvedFile });
      }

      // 4. Named views / components: components: { default: Home, sidebar: () => import('./Sidebar.vue') }
      const componentsMatch = objBody.match(/\bcomponents\s*:\s*\{([^}]+)\}/);
      if (componentsMatch) {
        const compsBody = componentsMatch[1];
        // Match simple symbols in components object: default: Home
        const symbolRegex = /\b[a-zA-Z0-9_]+\s*:\s*([a-zA-Z0-9_]+)\b(?!\s*=>)/g;
        let match;
        while ((match = symbolRegex.exec(compsBody)) !== null) {
          const compSym = match[1];
          if (compSym !== 'import' && compSym !== 'require') {
            let resolvedFile = filePath;
            const resolvedPath = ctx.resolveSymbolToFile(compSym);
            if (resolvedPath) {
              resolvedFile = resolvedPath;
            }
            componentsList.push({ symbol: compSym, file: resolvedFile });
          }
        }
      }

      const cleanParentPrefix = prefixParts.map(p => p.replace(/^\/|\/$/g, '')).filter(Boolean);
      const cleanPath = pathVal.replace(/^\/|\/$/g, '');
      const fullPath = '/' + [...cleanParentPrefix, cleanPath].filter(Boolean).join('/');

      if (componentsList.length > 0) {
        for (const comp of componentsList) {
          routes.push({
            framework: this.name,
            method: 'GET',
            path: fullPath,
            handlerFile: comp.file,
            handlerSymbol: comp.symbol,
            metadata: {
              confidence: 'inferred',
              routeType: 'client',
            },
          });
        }
      } else if (objBody.includes('children')) {
        // If children exist but no direct component, register placeholder component
        routes.push({
          framework: this.name,
          method: 'GET',
          path: fullPath,
          handlerFile: filePath,
          handlerSymbol: 'Component',
          metadata: {
            confidence: 'inferred',
            routeType: 'client',
          },
        });
      }

      // Recursively parse children if present
      const childrenMatch = objBody.match(/\bchildren\s*:\s*\[/);
      if (childrenMatch) {
        const childrenStart = objBody.indexOf('children') + childrenMatch[0].length - 1;
        const childrenArray = getBracketedContent(objBody, childrenStart);
        if (childrenArray) {
          const childRoutes = this.parseRoutesArray(childrenArray.content, filePath, ctx, [...prefixParts, pathVal]);
          routes.push(...childRoutes);
        }
      }

      index = obj.endIndex;
    }

    return routes;
  }
}

function getBracketedContent(str: string, startIndex: number): { content: string, endIndex: number } | null {
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
    if (char === '[') {
      depth++;
      if (depth === 1) {
        startIndex = i + 1;
      }
    } else if (char === ']') {
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
