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
      const lookbackText = content.substring(Math.max(0, classHeaderStart - 1000), classHeaderStart);

      // Support controller decoration
      let classPrefix = '';
      const controllerMatch = lookbackText.match(/@Controller\s*\(\s*([^)]*)\)/);
      if (controllerMatch) {
        const arg = controllerMatch[1].trim();
        if (arg) {
          if (arg.startsWith('{')) {
            const pathMatch = arg.match(/path\s*:\s*['"`]([^'"`]*)['"`]/);
            if (pathMatch) {
              classPrefix = pathMatch[1];
            }
          } else {
            classPrefix = arg.replace(/^['"`]|['"`]$/g, '');
          }
        }

        // Extract routes inside this class using the new robust helper
        const methodDecoratorRegex = /@(Get|Post|Put|Delete|Patch|Options|All|Head)\s*\(\s*([^)]*)\)/g;
        let match;
        while ((match = methodDecoratorRegex.exec(classBlock)) !== null) {
          const verb = match[1].toUpperCase();
          const args = match[2].trim();
          let routePath = '';
          if (args) {
            if (args.startsWith('{')) {
              const pathMatch = args.match(/path\s*:\s*['"`]([^'"`]*)['"`]/);
              if (pathMatch) {
                routePath = pathMatch[1];
              }
            } else {
              routePath = args.replace(/^['"`]|['"`]$/g, '');
            }
          }

          const nextIndex = match.index + match[0].length;
          const methodName = this.findMethodNameAfter(classBlock, nextIndex);
          if (methodName) {
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
      const lookbackText = content.substring(Math.max(0, classHeaderStart - 1000), classHeaderStart);

      let resolvedFile = filePath;
      const resolvedPath = ctx.resolveSymbolToFile(className);
      if (resolvedPath) {
        resolvedFile = resolvedPath;
      }

      // 1. Class-level guards / interceptors / pipes / filters
      const classDecoratorRegex = /@(UseGuards|UseInterceptors|UsePipes|UseFilters)\s*\(\s*([^)]+)\)/g;
      let classDecMatch;
      while ((classDecMatch = classDecoratorRegex.exec(lookbackText)) !== null) {
        const type = classDecMatch[1]; // UseGuards, etc.
        const list = classDecMatch[2].split(',').map(s => s.trim());
        for (const item of list) {
          let itemFile = filePath;
          const resolvedItem = ctx.resolveSymbolToFile(item);
          if (resolvedItem) {
            itemFile = resolvedItem;
          }
          hooks.push({
            framework: this.name,
            hookName: `${type}:${item}`,
            hookType: 'middleware',
            handlerFile: itemFile,
            handlerSymbol: className,
          });
        }
      }

      // 2. Class interfaces implementation (Guards, Interceptors, Pipes, Lifecycle Hooks)
      const implementsMatch = classBlock.match(/^[^{]*implements\s+([^{]+)/);
      if (implementsMatch) {
        const interfaces = implementsMatch[1].split(',').map(s => s.trim().replace(/<.*>$/, '')); // remove generics
        for (const iface of interfaces) {
          if (['CanActivate', 'NestInterceptor', 'PipeTransform', 'OnModuleInit', 'OnApplicationBootstrap', 'OnModuleDestroy', 'BeforeApplicationShutdown', 'OnApplicationShutdown'].includes(iface)) {
            let hookType = 'hook';
            let targetMethod = '';
            if (iface === 'CanActivate') {
              hookType = 'guard';
              targetMethod = 'canActivate';
            } else if (iface === 'NestInterceptor') {
              hookType = 'interceptor';
              targetMethod = 'intercept';
            } else if (iface === 'PipeTransform') {
              hookType = 'pipe';
              targetMethod = 'transform';
            } else if (iface === 'OnModuleInit') {
              hookType = 'lifecycle';
              targetMethod = 'onModuleInit';
            } else if (iface === 'OnApplicationBootstrap') {
              hookType = 'lifecycle';
              targetMethod = 'onApplicationBootstrap';
            } else if (iface === 'OnModuleDestroy') {
              hookType = 'lifecycle';
              targetMethod = 'onModuleDestroy';
            } else if (iface === 'BeforeApplicationShutdown') {
              hookType = 'lifecycle';
              targetMethod = 'beforeApplicationShutdown';
            } else if (iface === 'OnApplicationShutdown') {
              hookType = 'lifecycle';
              targetMethod = 'onApplicationShutdown';
            }

            let handlerSymbol = className;
            if (targetMethod) {
              const methodRegex = new RegExp(`\\b${targetMethod}\\s*\\(`);
              if (methodRegex.test(classBlock)) {
                handlerSymbol = `${className}@${targetMethod}`;
              }
            }

            hooks.push({
              framework: this.name,
              hookName: iface,
              hookType,
              handlerFile: resolvedFile,
              handlerSymbol,
            });
          }
        }
      }

      // 3. Method-level guards / interceptors / pipes / filters
      const methodDecoratorRegex = /@(UseGuards|UseInterceptors|UsePipes|UseFilters)\s*\(\s*([^)]+)\)/g;
      let methodDecMatch;
      while ((methodDecMatch = methodDecoratorRegex.exec(classBlock)) !== null) {
        const type = methodDecMatch[1];
        const list = methodDecMatch[2].split(',').map(s => s.trim());

        const nextIndex = methodDecMatch.index + methodDecMatch[0].length;
        const methodName = this.findMethodNameAfter(classBlock, nextIndex);
        if (methodName) {
          for (const item of list) {
            let itemFile = filePath;
            const resolvedItem = ctx.resolveSymbolToFile(item);
            if (resolvedItem) {
              itemFile = resolvedItem;
            }
            hooks.push({
              framework: this.name,
              hookName: `${type}:${item}`,
              hookType: 'middleware',
              handlerFile: itemFile,
              handlerSymbol: `${className}@${methodName}`,
              metadata: {
                middlewareClass: item,
              }
            });
          }
        }
      }

      // 4. GraphQL Resolvers
      const isResolver = /@Resolver\s*\(/.test(lookbackText);
      if (isResolver) {
        const resolverRegex = /@(Query|Mutation|Subscription)\s*\(\s*([^)]*)\)/g;
        let gqlMatch;
        while ((gqlMatch = resolverRegex.exec(classBlock)) !== null) {
          const type = gqlMatch[1].toLowerCase();
          const args = gqlMatch[2].trim();
          let opName = '';
          if (args) {
            if (args.startsWith('{')) {
              const nameMatch = args.match(/name\s*:\s*['"`]([^'"`]*)['"`]/);
              if (nameMatch) {
                opName = nameMatch[1];
              }
            } else {
              opName = args.replace(/^['"`]|['"`]$/g, '');
            }
          }

          const nextIndex = gqlMatch.index + gqlMatch[0].length;
          const methodName = this.findMethodNameAfter(classBlock, nextIndex);
          if (methodName) {
            if (!opName) opName = methodName;
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
      }

      // 5. Message/Event Handlers
      const messageRegex = /@(MessagePattern|EventPattern)\s*\(\s*([^)]+)\)/g;
      let msgMatch;
      while ((msgMatch = messageRegex.exec(classBlock)) !== null) {
        const decoratorName = msgMatch[1];
        const type = decoratorName === 'MessagePattern' ? 'request-response' : 'event-driven';
        const patternRaw = msgMatch[2].trim();
        const pattern = patternRaw.replace(/['"`{} ]/g, '');

        const nextIndex = msgMatch.index + msgMatch[0].length;
        const methodName = this.findMethodNameAfter(classBlock, nextIndex);
        if (methodName) {
          hooks.push({
            framework: this.name,
            hookName: pattern || methodName,
            hookType: 'message_handler',
            handlerFile: resolvedFile,
            handlerSymbol: `${className}@${methodName}`,
            metadata: {
              patternType: type,
            },
          });
        }
      }

      // 6. WebSocket Subscriptions
      const wsRegex = /@SubscribeMessage\s*\(\s*([^)]+)\)/g;
      let wsMatch;
      while ((wsMatch = wsRegex.exec(classBlock)) !== null) {
        const eventRaw = wsMatch[1].trim();
        const event = eventRaw.replace(/^['"`]|['"`]$/g, '');

        const nextIndex = wsMatch.index + wsMatch[0].length;
        const methodName = this.findMethodNameAfter(classBlock, nextIndex);
        if (methodName) {
          hooks.push({
            framework: this.name,
            hookName: event || methodName,
            hookType: 'websocket_handler',
            handlerFile: resolvedFile,
            handlerSymbol: `${className}@${methodName}`,
          });
        }
      }
    }

    return hooks;
  }

  private findMethodNameAfter(text: string, startIndex: number): string | null {
    let i = startIndex;
    const len = text.length;

    while (i < len) {
      const char = text[i];

      // Skip whitespace
      if (/\s/.test(char)) {
        i++;
        continue;
      }

      // Skip line comments
      if (char === '/' && text[i + 1] === '/') {
        i += 2;
        while (i < len && text[i] !== '\n') {
          i++;
        }
        continue;
      }

      // Skip block comments
      if (char === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
          i++;
        }
        i += 2;
        continue;
      }

      // Skip other decorators
      if (char === '@') {
        i++; // skip '@'
        // skip decorator name identifier
        while (i < len && /[a-zA-Z0-9_$]/.test(text[i])) {
          i++;
        }
        // skip whitespace
        while (i < len && /\s/.test(text[i])) {
          i++;
        }
        // if there are parentheses, balance them
        if (text[i] === '(') {
          i++; // skip '('
          let parenCount = 1;
          let inString = false;
          let quoteChar = '';
          while (i < len && parenCount > 0) {
            const c = text[i];
            if (inString) {
              if (c === quoteChar && text[i - 1] !== '\\') {
                inString = false;
              }
            } else {
              if (c === '"' || c === "'" || c === '`') {
                inString = true;
                quoteChar = c;
              } else if (c === '(') {
                parenCount++;
              } else if (c === ')') {
                parenCount--;
              }
            }
            i++;
          }
        }
        continue;
      }

      // Read identifier/word
      if (/[a-zA-Z0-9_$]/.test(char)) {
        let word = '';
        while (i < len && /[a-zA-Z0-9_$]/.test(text[i])) {
          word += text[i];
          i++;
        }

        const modifiers = new Set(['public', 'private', 'protected', 'readonly', 'static', 'async', 'get', 'set']);
        if (modifiers.has(word)) {
          continue;
        }

        // Verify the next non-whitespace char is '(' to confirm it's a method name
        let j = i;
        while (j < len && /\s/.test(text[j])) {
          j++;
        }
        if (text[j] === '(') {
          return word;
        }
      } else {
        // Skip any unexpected chars
        i++;
      }
    }
    return null;
  }
}
