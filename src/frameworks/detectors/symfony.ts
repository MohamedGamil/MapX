import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../../types.js';
import { hasComposerDependency } from '../utils.js';

export class SymfonyDetector implements FrameworkDetector {
  readonly name = 'symfony';
  readonly language = 'php';
  readonly filePattern = /\.php$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    if (files.some(f => f === 'symfony.lock' || f.endsWith('/symfony.lock'))) {
      return true;
    }
    const lockPath = join(projectRoot, 'symfony.lock');
    if (existsSync(lockPath)) {
      return true;
    }
    return hasComposerDependency(projectRoot, files, ['symfony/framework-bundle', 'symfony/symfony']);
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // 1. YAML Routing
    if (filePath.endsWith('routes.yaml') || filePath.endsWith('routes.yml')) {
      const lines = content.split('\n');
      let currentPath = '';
      let currentController = '';
      let currentMethods: string[] = [];

      for (const line of lines) {
        // Match a new route block (starts with alphanumeric/underscore key followed by colon at indentation level 0)
        if (/^[a-zA-Z0-9_.-]+:/.test(line)) {
          if (currentPath && currentController) {
            routes.push(...this.createYamlRouteBindings(currentPath, currentController, currentMethods, filePath, ctx));
          }
          currentPath = '';
          currentController = '';
          currentMethods = [];
          continue;
        }

        const pathMatch = line.match(/^\s+path:\s*['"]?([^'"]+)['"]?/);
        if (pathMatch) {
          currentPath = pathMatch[1];
          continue;
        }

        const controllerMatch = line.match(/^\s+controller:\s*['"]?([^'"]+)['"]?/);
        if (controllerMatch) {
          currentController = controllerMatch[1];
          continue;
        }

        const methodsMatch = line.match(/^\s+methods:\s*\[?([^\]]+)\]?/);
        if (methodsMatch) {
          currentMethods = methodsMatch[1]
            .split(',')
            .map(m => m.trim().replace(/['"]/g, '').toUpperCase());
        }
      }

      if (currentPath && currentController) {
        routes.push(...this.createYamlRouteBindings(currentPath, currentController, currentMethods, filePath, ctx));
      }

      return routes;
    }

    // Only process PHP files for Route annotations/attributes
    if (!filePath.endsWith('.php')) {
      return [];
    }

    // 2. Attribute / Annotation Routing
    // Find class-level Route prefix
    let classPrefix = '';
    const classRouteMatch = content.match(/(?:#\[Route|@Route)\s*\(\s*['"]([^'"]+)['"]/);
    const classDeclMatch = content.match(/\bclass\s+([a-zA-Z0-9_]+)\b/);
    if (!classDeclMatch) return [];
    const className = classDeclMatch[1];

    // If Route attribute appears BEFORE the class declaration, it's a class prefix
    if (classRouteMatch) {
      const routeIndex = content.indexOf(classRouteMatch[0]);
      const classIndex = content.indexOf(classDeclMatch[0]);
      if (routeIndex !== -1 && routeIndex < classIndex) {
        classPrefix = classRouteMatch[1];
      }
    }

    // Find all route attributes/annotations on methods
    // We scan lines to find method-level routes
    const lines = content.split('\n');
    let pendingRoute: { path: string; methods: string[]; name?: string } | null = null;

    for (const line of lines) {
      // Look for #[Route('/path', methods: [...], name: '...')] or docblock @Route(...)
      // Supporting both PHP 8 attributes and legacy docblock annotations
      const routeAttrMatch = line.match(/(?:#\[Route|@Route)\s*\(\s*['"]([^'"]+)['"]/);
      if (routeAttrMatch) {
        const pathVal = routeAttrMatch[1];
        const methods: string[] = [];

        // Parse methods: methods: ['GET', 'POST'] or methods={"GET"}
        const methodsMatch = line.match(/methods\s*[=:]\s*\[?([^\]}]+)\]?/);
        if (methodsMatch) {
          methods.push(...methodsMatch[1].split(',').map(m => m.trim().replace(/['"{}]+/g, '').toUpperCase()));
        }

        // Parse name: name: 'app_home' or name="app_home"
        const nameMatch = line.match(/name\s*[=:]\s*['"]([^'"]+)['"]/);
        const routeName = nameMatch ? nameMatch[1] : undefined;

        pendingRoute = { path: pathVal, methods, name: routeName };
        continue;
      }

      // If we have a pending route, check if this line is a function/method declaration
      if (pendingRoute) {
        const methodDeclMatch = line.match(/\bfunction\s+([a-zA-Z0-9_]+)\s*\(/);
        if (methodDeclMatch) {
          const methodName = methodDeclMatch[1];
          const cleanClassPrefix = classPrefix.replace(/^\/|\/$/g, '');
          const cleanMethodPath = pendingRoute.path.replace(/^\/|\/$/g, '');
          const combinedPath = '/' + [cleanClassPrefix, cleanMethodPath].filter(Boolean).join('/');

          const verbs = pendingRoute.methods.length > 0 ? pendingRoute.methods : ['GET'];
          for (const verb of verbs) {
            routes.push({
              framework: this.name,
              method: verb,
              path: combinedPath,
              handlerFile: filePath,
              handlerSymbol: `${className}::${methodName}`,
              metadata: {
                confidence: 'inferred',
                routeType: 'server',
                routeName: pendingRoute.name,
              },
            });
          }
          pendingRoute = null;
        }
      }
    }

    return routes;
  }

  private createYamlRouteBindings(path: string, controller: string, methods: string[], filePath: string, ctx: ScanContext): RouteBinding[] {
    const bindings: RouteBinding[] = [];
    const parts = controller.split('::');
    const controllerClass = parts[0];
    const controllerMethod = parts[1] || 'default';
    const symbol = controllerClass.split('\\').pop() || 'Controller';

    let resolvedFile = filePath;
    const resolvedPath = ctx.resolveSymbolToFile(symbol);
    if (resolvedPath) {
      resolvedFile = resolvedPath;
    }

    const verbs = methods.length > 0 ? methods : ['ALL'];
    for (const verb of verbs) {
      bindings.push({
        framework: this.name,
        method: verb,
        path: path,
        handlerFile: resolvedFile,
        handlerSymbol: `${symbol}::${controllerMethod}`,
        metadata: {
          confidence: 'inferred',
          routeType: 'server',
        },
      });
    }

    return bindings;
  }

  async extractHooks(filePath: string, content: string, ctx: ScanContext): Promise<HookBinding[]> {
    if (!filePath.endsWith('.php')) {
      return [];
    }

    // Symfony Event subscribers implement getSubscribedEvents()
    if (!content.includes('getSubscribedEvents')) {
      return [];
    }

    const hooks: HookBinding[] = [];

    // Parse array maps inside getSubscribedEvents body
    // E.g., 'kernel.exception' => 'onKernelException'
    const eventRegex = /['"]([^'"]+)['"]\s*=>\s*(?:['"]([^'"]+)['"]|\[\s*['"]([^'"]+)['"])/g;
    let match;
    while ((match = eventRegex.exec(content)) !== null) {
      const eventName = match[1];
      const handlerSymbol = match[2] || match[3];
      if (handlerSymbol) {
        hooks.push({
          framework: this.name,
          hookName: eventName,
          handlerFile: filePath,
          handlerSymbol: handlerSymbol,
          hookType: 'event_subscriber',
        });
      }
    }

    return hooks;
  }
}
