import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class YiiDetector implements FrameworkDetector {
  readonly name = 'yii';
  readonly language = 'php';
  readonly filePattern = /\.php$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const composerPath = join(projectRoot, 'composer.json');
    if (existsSync(composerPath)) {
      try {
        const pkg = JSON.parse(await readFile(composerPath, 'utf-8'));
        const reqs = { ...pkg.require, ...pkg['require-dev'] };
        if (reqs && (reqs['yiisoft/yii2'] || reqs['yiisoft/yii3'] || reqs['yiisoft/router'])) {
          return true;
        }
      } catch {
        // Ignored
      }
    }
    return files.some(f => f.includes('config/web.php') || f.includes('config/routes.php'));
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // 1. Yii2 URL Rules
    // E.g., 'GET users' => 'user/index'
    const yii2RuleRegex = /['"](?:(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+)?([a-zA-Z0-9_.-]+)['"]\s*=>\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = yii2RuleRegex.exec(content)) !== null) {
      const verb = match[1] || 'GET';
      const pathVal = '/' + match[2].replace(/^\/|\/$/g, '');
      const target = match[3]; // e.g. user/index

      // If target contains a slash, parse controller and action
      if (target.includes('/')) {
        const parts = target.split('/');
        const controller = parts[0];
        const action = parts[1];
        const controllerClassName = controller.charAt(0).toUpperCase() + controller.slice(1) + 'Controller';
        const actionMethodName = 'action' + action.charAt(0).toUpperCase() + action.slice(1);

        let resolvedFile = filePath;
        const resolvedPath = ctx.resolveSymbolToFile(controllerClassName);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }

        routes.push({
          framework: this.name,
          method: verb,
          path: pathVal,
          handlerFile: resolvedFile,
          handlerSymbol: `${controllerClassName}::${actionMethodName}`,
          metadata: {
            confidence: 'inferred',
            routeType: 'server',
          },
        });
      }
    }

    // 2. Yii2 Rest UrlRule
    // E.g., 'class' => 'yii\rest\UrlRule', 'controller' => 'user' or 'controller' => ['user', 'post']
    if (content.includes('yii\\rest\\UrlRule')) {
      const restControllerRegex = /'controller'\s*=>\s*(?:['"]([^'"]+)['"]|\[\s*([^\]]+)\s*\])/g;
      while ((match = restControllerRegex.exec(content)) !== null) {
        const controllers: string[] = [];
        if (match[1]) {
          controllers.push(match[1]);
        } else if (match[2]) {
          controllers.push(...match[2].split(',').map(c => c.trim().replace(/['"]/g, '')));
        }

        for (const controller of controllers) {
          const controllerClassName = controller.charAt(0).toUpperCase() + controller.slice(1) + 'Controller';
          const crudEndpoints = [
            { verb: 'GET', path: `/${controller}`, action: 'actionIndex' },
            { verb: 'GET', path: `/${controller}/view`, action: 'actionView' },
            { verb: 'POST', path: `/${controller}`, action: 'actionCreate' },
            { verb: 'PUT', path: `/${controller}/update`, action: 'actionUpdate' },
            { verb: 'PATCH', path: `/${controller}/update`, action: 'actionUpdate' },
            { verb: 'DELETE', path: `/${controller}/delete`, action: 'actionDelete' },
            { verb: 'OPTIONS', path: `/${controller}`, action: 'actionOptions' },
          ];

          let resolvedFile = filePath;
          const resolvedPath = ctx.resolveSymbolToFile(controllerClassName);
          if (resolvedPath) {
            resolvedFile = resolvedPath;
          }

          for (const ep of crudEndpoints) {
            routes.push({
              framework: this.name,
              method: ep.verb,
              path: ep.path,
              handlerFile: resolvedFile,
              handlerSymbol: `${controllerClassName}::${ep.action}`,
              metadata: {
                confidence: 'inferred',
                routeType: 'server',
              },
            });
          }
        }
      }
    }

    // 3. Yii3 Route DSL
    // E.g., Route::get('/users')->action([UserController::class, 'index'])
    // E.g., Route::addGroup('/api', Route::get('/users')->action(...))
    let yii3GroupPrefix = '';
    const groupMatch = content.match(/Route::addGroup\s*\(\s*['"]([^'"]+)['"]/);
    if (groupMatch) {
      yii3GroupPrefix = groupMatch[1];
    }

    const yii3RouteRegex = /Route::(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]+)['"]\s*\)\s*(?:->[a-zA-Z0-9_]+\s*\([^)]*\)\s*)*->action\s*\(\s*(?:\[\s*([a-zA-Z0-9_]+)::class\s*,\s*['"]([^'"]+)['"]\s*\]|['"]([^'"]+)['"])/g;
    while ((match = yii3RouteRegex.exec(content)) !== null) {
      const verb = match[1].toUpperCase();
      const pathVal = match[2];
      const controllerClass = match[3] || 'Controller';
      const actionMethod = match[4] || match[5] || 'index';

      const cleanGroup = yii3GroupPrefix.replace(/^\/|\/$/g, '');
      const cleanPath = pathVal.replace(/^\/|\/$/g, '');
      const combinedPath = '/' + [cleanGroup, cleanPath].filter(Boolean).join('/');

      let resolvedFile = filePath;
      const resolvedPath = ctx.resolveSymbolToFile(controllerClass);
      if (resolvedPath) {
        resolvedFile = resolvedPath;
      }

      routes.push({
        framework: this.name,
        method: verb,
        path: combinedPath,
        handlerFile: resolvedFile,
        handlerSymbol: `${controllerClass}::${actionMethod}`,
        metadata: {
          confidence: 'inferred',
          routeType: 'server',
        },
      });
    }

    return routes;
  }
}
