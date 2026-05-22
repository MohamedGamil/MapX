import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class RailsDetector implements FrameworkDetector {
  readonly name = 'rails';
  readonly language = 'ruby';
  readonly filePattern = /(routes\.rb|Gemfile)$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const gemfilePath = join(projectRoot, 'Gemfile');
    if (existsSync(gemfilePath)) {
      const content = await readFile(gemfilePath, 'utf-8');
      if (content.includes('rails')) return true;
    }
    return files.some(f => f.endsWith('routes.rb'));
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!filePath.endsWith('routes.rb')) {
      return [];
    }

    // 1. Single Route Mapping: get '/users', to: 'users#index'
    const routeRegex = /\b(get|post|put|patch|delete)\s+['"]([^'"]+)['"]\s*,\s*to:\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const verb = match[1].toUpperCase();
      let pathVal = match[2];
      const controllerAction = match[3];

      // Convert Rails path parameter format :id to {id}
      pathVal = pathVal.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');

      routes.push(this.createRouteBinding(verb, pathVal, controllerAction, filePath, ctx));
    }

    // 2. Resource Mapping: resources :users
    const resourcesRegex = /\bresources\s+:([a-zA-Z0-9_]+)/g;
    while ((match = resourcesRegex.exec(content)) !== null) {
      const resourceName = match[1]; // e.g., users
      const controllerPrefix = resourceName.charAt(0).toUpperCase() + resourceName.slice(1);
      const controllerClass = `${controllerPrefix}Controller`;

      // 7 Standard REST CRUD endpoints
      const crudEndpoints = [
        { verb: 'GET', path: `/${resourceName}`, action: 'index' },
        { verb: 'GET', path: `/${resourceName}/new`, action: 'new' },
        { verb: 'POST', path: `/${resourceName}`, action: 'create' },
        { verb: 'GET', path: `/${resourceName}/{id}`, action: 'show' },
        { verb: 'GET', path: `/${resourceName}/{id}/edit`, action: 'edit' },
        { verb: 'PUT', path: `/${resourceName}/{id}`, action: 'update' },
        { verb: 'PATCH', path: `/${resourceName}/{id}`, action: 'update' },
        { verb: 'DELETE', path: `/${resourceName}/{id}`, action: 'destroy' },
      ];

      for (const endpoint of crudEndpoints) {
        routes.push(this.createRouteBinding(endpoint.verb, endpoint.path, `${resourceName}#${endpoint.action}`, filePath, ctx));
      }
    }

    return routes;
  }

  private createRouteBinding(verb: string, path: string, controllerAction: string, filePath: string, ctx: ScanContext): RouteBinding {
    const parts = controllerAction.split('#');
    const controller = parts[0];
    const action = parts[1] || 'index';

    // Format controller class name e.g., users -> UsersController
    const controllerClassName = controller.charAt(0).toUpperCase() + controller.slice(1) + 'Controller';

    let resolvedFile = filePath;
    const resolvedPath = ctx.resolveSymbolToFile(controllerClassName);
    if (resolvedPath) {
      resolvedFile = resolvedPath;
    }

    return {
      framework: this.name,
      method: verb,
      path: path,
      handlerFile: resolvedFile,
      handlerSymbol: `${controllerClassName}#${action}`,
      metadata: {
        confidence: 'inferred',
        routeType: 'server',
      },
    };
  }
}
