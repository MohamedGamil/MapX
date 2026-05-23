import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../../types.js';

export class DrupalDetector implements FrameworkDetector {
  readonly name = 'drupal';
  readonly language = 'php';
  readonly filePattern = /\.(yml|module|php)$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const corePath = join(projectRoot, 'core/lib/Drupal.php');
    if (existsSync(corePath)) return true;

    // Check if any .routing.yml files exist
    const hasRoutingYml = files.some(f => f.endsWith('.routing.yml'));
    if (hasRoutingYml) return true;

    return false;
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // Only process .routing.yml files for routing
    if (!filePath.endsWith('.routing.yml')) {
      return [];
    }

    // A simple YAML indentation/block parser using regexes
    const lines = content.split('\n');
    let currentRouteId = '';
    let currentPath = '';
    let currentController = '';

    for (const line of lines) {
      const routeMatch = line.match(/^([a-z0-9_.-]+):/);
      if (routeMatch) {
        // Emit previous route if fully parsed
        if (currentPath && currentController) {
          routes.push(this.createRouteBinding(currentPath, currentController, filePath, ctx));
        }
        currentRouteId = routeMatch[1];
        currentPath = '';
        currentController = '';
        continue;
      }

      const pathMatch = line.match(/^\s+path:\s*['"]?([^'"]+)['"]?/);
      if (pathMatch) {
        currentPath = pathMatch[1];
        continue;
      }

      const controllerMatch = line.match(/^\s+_(?:controller|form):\s*['"]?([^'"]+)['"]?/);
      if (controllerMatch) {
        currentController = controllerMatch[1];
      }
    }

    // Emit final route
    if (currentPath && currentController) {
      routes.push(this.createRouteBinding(currentPath, currentController, filePath, ctx));
    }

    return routes;
  }

  private createRouteBinding(path: string, controller: string, filePath: string, ctx: ScanContext): RouteBinding {
    // Map parameter syntax /path/{param} to /path/{param} (already matches)
    // Controller format: \Drupal\mymodule\Controller\MyController::myMethod
    const parts = controller.split('::');
    const controllerClass = parts[0];
    const controllerMethod = parts[1] || 'default';
    const symbol = controllerClass.split('\\').pop() || 'Controller';

    let resolvedFile = filePath;
    const resolvedPath = ctx.resolveSymbolToFile(symbol);
    if (resolvedPath) {
      resolvedFile = resolvedPath;
    }

    return {
      framework: this.name,
      method: 'ALL',
      path: path,
      handlerFile: resolvedFile,
      handlerSymbol: `${symbol}::${controllerMethod}`,
      metadata: {
        confidence: 'inferred',
        routeType: 'server',
      },
    };
  }

  async extractHooks(filePath: string, content: string, ctx: ScanContext): Promise<HookBinding[]> {
    // Custom hooks are implemented in .module files
    if (!filePath.endsWith('.module')) {
      return [];
    }

    const hooks: HookBinding[] = [];
    const moduleName = basename(filePath, '.module');

    // Matches function mymodule_form_alter(...) or function mymodule_node_insert(...)
    const functionRegex = new RegExp(`function\\s+(${moduleName})_([a-zA-Z0-9_]+)\\s*\\(`, 'g');
    let match;
    while ((match = functionRegex.exec(content)) !== null) {
      const hookName = match[2];
      hooks.push({
        framework: this.name,
        hookName: hookName,
        handlerFile: filePath,
        handlerSymbol: `${moduleName}_${hookName}`,
        hookType: 'hook',
      });
    }

    return hooks;
  }
}
