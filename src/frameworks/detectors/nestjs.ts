import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../../types.js';

export class NestJSDetector implements FrameworkDetector {
  readonly name = 'nestjs';
  readonly language = 'typescript';
  readonly filePattern = /\.(ts|js)$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const packageJsonPath = join(projectRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps && (deps['@nestjs/core'] || deps['@nestjs/common'])) {
          return true;
        }
      } catch {
        // Ignored
      }
    }
    return false;
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!content.includes('@Controller') && !content.includes('@Get') && !content.includes('@Post')) {
      return [];
    }

    // Split content into classes to isolate controller scopes
    const classes = content.split(/\bclass\s+/);
    // The first part is imports/file header, skip
    for (let i = 1; i < classes.length; i++) {
      const classBlock = classes[i];
      const classNameMatch = classBlock.match(/^([a-zA-Z0-9_]+)/);
      if (!classNameMatch) continue;
      const className = classNameMatch[1];

      // Look back in the content for class decorators
      const classHeaderStart = content.indexOf(`class ${className}`);
      const lookbackText = content.substring(Math.max(0, classHeaderStart - 300), classHeaderStart);

      const controllerMatch = lookbackText.match(/@Controller\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/);
      if (controllerMatch) {
        const classPrefix = controllerMatch[1] || '';

        // Extract routes inside this class
        const methodRegex = /@(Get|Post|Put|Delete|Patch|Options|All|Head)\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)\s*(?:async\s+)?(\w+)\s*\(/g;
        let match;
        while ((match = methodRegex.exec(classBlock)) !== null) {
          const verb = match[1].toUpperCase();
          const routePath = match[2] || '';
          const methodName = match[3];

          const cleanPrefix = classPrefix.replace(/^\/|\/$/g, '');
          const cleanRoute = routePath.replace(/^\/|\/$/g, '');
          const fullPath = '/' + [cleanPrefix, cleanRoute].filter(Boolean).join('/');

          let resolvedFile = filePath;
          const resolvedPath = ctx.resolveSymbolToFile(className);
          if (resolvedPath) {
            resolvedFile = resolvedPath;
          }

          routes.push({
            framework: this.name,
            method: verb,
            path: fullPath,
            handlerFile: resolvedFile,
            handlerSymbol: `${className}@${methodName}`,
            metadata: {
              confidence: 'inferred',
            },
          });
        }
      }
    }

    return routes;
  }

  async extractHooks(filePath: string, content: string, ctx: ScanContext): Promise<HookBinding[]> {
    const hooks: HookBinding[] = [];

    // Split content into classes to isolate scopes
    const classes = content.split(/\bclass\s+/);
    for (let i = 1; i < classes.length; i++) {
      const classBlock = classes[i];
      const classNameMatch = classBlock.match(/^([a-zA-Z0-9_]+)/);
      if (!classNameMatch) continue;
      const className = classNameMatch[1];

      const classHeaderStart = content.indexOf(`class ${className}`);
      const lookbackText = content.substring(Math.max(0, classHeaderStart - 300), classHeaderStart);

      let resolvedFile = filePath;
      const resolvedPath = ctx.resolveSymbolToFile(className);
      if (resolvedPath) {
        resolvedFile = resolvedPath;
      }

      // 1. Class-level guards / middleware
      const classGuardMatch = lookbackText.match(/@UseGuards\s*\(\s*([^)]+)\)/);
      if (classGuardMatch) {
        const guardSymbols = classGuardMatch[1].split(',').map(s => s.trim());
        for (const guardSymbol of guardSymbols) {
          let guardFile = filePath;
          const resolvedGuard = ctx.resolveSymbolToFile(guardSymbol);
          if (resolvedGuard) {
            guardFile = resolvedGuard;
          }
          hooks.push({
            framework: this.name,
            hookName: `guard:${guardSymbol}`,
            hookType: 'middleware',
            handlerFile: guardFile,
            handlerSymbol: guardSymbol,
          });
        }
      }

      // 2. GraphQL Resolvers
      const isResolver = /@Resolver\s*\(/.test(lookbackText);
      if (isResolver) {
        const resolverRegex = /@(Query|Mutation|Subscription)\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)\s*(?:async\s+)?(\w+)\s*\(/g;
        let match;
        while ((match = resolverRegex.exec(classBlock)) !== null) {
          const type = match[1].toLowerCase();
          const opName = match[2] || match[3];
          const methodName = match[3];

          hooks.push({
            framework: this.name,
            hookName: opName,
            hookType: 'graphql_resolver',
            handlerFile: resolvedFile,
            handlerSymbol: `${className}@${methodName}`,
            metadata: {
              operationType: type,
            },
          });
        }
      }

      // 3. Message/Event Handlers
      const messageRegex = /@(MessagePattern|EventPattern)\s*\(\s*([^)]+)\)\s*(?:async\s+)?(\w+)\s*\(/g;
      let match;
      while ((match = messageRegex.exec(classBlock)) !== null) {
        const type = match[1] === 'MessagePattern' ? 'request-response' : 'event-driven';
        const pattern = match[2].replace(/['"{}]/g, '').trim();
        const methodName = match[3];

        hooks.push({
          framework: this.name,
          hookName: pattern,
          hookType: 'message_handler',
          handlerFile: resolvedFile,
          handlerSymbol: `${className}@${methodName}`,
          metadata: {
            patternType: type,
          },
        });
      }

      // 4. WebSocket Subscriptions
      const wsRegex = /@SubscribeMessage\s*\(\s*['"]([^'"]+)['"]\s*\)\s*(?:async\s+)?(\w+)\s*\(/g;
      while ((match = wsRegex.exec(classBlock)) !== null) {
        const event = match[1];
        const methodName = match[2];

        hooks.push({
          framework: this.name,
          hookName: event,
          hookType: 'websocket_handler',
          handlerFile: resolvedFile,
          handlerSymbol: `${className}@${methodName}`,
        });
      }
    }

    return hooks;
  }
}
