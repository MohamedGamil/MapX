import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, ScanContext } from '../../types.js';

export class FlaskDetector implements FrameworkDetector {
  readonly name = 'flask';
  readonly language = 'python';
  readonly filePattern = /\.py$/;

  private bpPrefixes = new Map<string, string>(); // blueprint variable/name -> prefix

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    let isFlask = false;

    // Check project dependencies
    for (const file of ['requirements.txt', 'Pipfile', 'pyproject.toml']) {
      const filePath = join(projectRoot, file);
      if (existsSync(filePath)) {
        try {
          const content = await readFile(filePath, 'utf-8');
          if (content.toLowerCase().includes('flask')) {
            isFlask = true;
          }
        } catch {
          // Ignored
        }
      }
    }

    if (!isFlask) {
      isFlask = files.some(f => f.endsWith('wsgi.py') || f.endsWith('app.py'));
    }

    if (isFlask) {
      // Pre-scan all python files to map Blueprint definitions and registrations to their prefixes
      for (const file of files) {
        if (!file.endsWith('.py')) continue;
        try {
          const content = await readFile(join(projectRoot, file), 'utf-8');
          
          // 1. bp = Blueprint('admin', __name__, url_prefix='/admin')
          const bpDefRegex = /(\w+)\s*=\s*Blueprint\s*\(\s*['"]([^'"]+)['"]\s*,\s*__name__(?:,\s*url_prefix\s*=\s*['"]([^'"]+)['"])?/g;
          let match;
          while ((match = bpDefRegex.exec(content)) !== null) {
            const varName = match[1];
            const prefix = match[3] || '';
            this.bpPrefixes.set(varName, prefix);
          }

          // 2. app.register_blueprint(bp, url_prefix='/admin')
          const bpRegRegex = /register_blueprint\s*\(\s*([^,\s)]+)(?:,\s*url_prefix\s*=\s*['"]([^'"]+)['"])?/g;
          while ((match = bpRegRegex.exec(content)) !== null) {
            const bpVar = match[1].split('.').pop() || '';
            const prefix = match[2];
            if (prefix) {
              this.bpPrefixes.set(bpVar, prefix);
            }
          }
        } catch {
          // Ignored
        }
      }
    }

    return isFlask;
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // Skip if no flask routing keywords present
    if (!content.includes('.route') && !content.includes('add_resource') && !content.includes('Route')) {
      return [];
    }

    // 1. Match Flask decorators: @app.route(...) or @bp.route(...)
    let index = 0;
    while (true) {
      const match = content.substring(index).match(/@(\w+)\.route\s*\(/);
      if (!match) break;

      const targetVar = match[1];
      const startOfParen = index + match.index! + match[0].length - 1;

      const paren = getParenthesizedContent(content, startOfParen);
      if (!paren) {
        index = startOfParen + 1;
        continue;
      }

      const args = parseArgs(paren.content);
      const routePath = args[0] || '';

      let methods = ['GET'];
      const methodsMatch = paren.content.match(/methods\s*=\s*\[([^\]]+)\]/);
      if (methodsMatch) {
        methods = (methodsMatch[1].match(/['"]([^'"]+)['"]/g) || []).map(m => m.replace(/['"]/g, '').toUpperCase());
      }

      const postDecoratorText = content.substring(paren.endIndex);
      const funcMatch = postDecoratorText.match(/^\s*(?:def|async def)\s+(\w+)\s*\(/);
      if (funcMatch) {
        const funcName = funcMatch[1];
        
        const bpPrefix = this.bpPrefixes.get(targetVar) || '';
        const cleanPrefix = bpPrefix.replace(/^\/|\/$/g, '');
        const cleanRoute = routePath.replace(/^\/|\/$/g, '');
        const fullPath = '/' + [cleanPrefix, cleanRoute].filter(Boolean).join('/');

        let resolvedFile = filePath;
        const resolvedPath = ctx.resolveSymbolToFile(funcName);
        if (resolvedPath) {
          resolvedFile = resolvedPath;
        }

        for (const method of methods) {
          routes.push({
            framework: this.name,
            method,
            path: fullPath,
            handlerFile: resolvedFile,
            handlerSymbol: funcName,
            metadata: {
              confidence: 'inferred',
            },
          });
        }
      }

      index = paren.endIndex;
    }

    // 2. Match Flask-RESTX resource class routing:
    // @api.route('/users')
    // class UserResource(Resource):
    //     def get(self): ...
    const restxRegex = /@(\w+)\.route\s*\(\s*['"]([^'"]+)['"]\s*\)\s*class\s+(\w+)/g;
    let restxMatch;
    while ((restxMatch = restxRegex.exec(content)) !== null) {
      const routePath = restxMatch[2];
      const className = restxMatch[3];

      const classStart = content.indexOf(`class ${className}`);
      let classEnd = content.length;
      
      const classSlice = content.substring(classStart);
      const nextClassMatch = classSlice.substring(className.length).match(/\bclass\s+\w+/);
      if (nextClassMatch && nextClassMatch.index) {
        classEnd = classStart + className.length + nextClassMatch.index;
      }
      
      const classBlock = content.substring(classStart, classEnd);
      const methodRegex = /\bdef\s+(get|post|put|delete|patch|options|head)\s*\(\s*self\b/g;
      let methodMatch;

      let resolvedFile = filePath;
      const resolvedPath = ctx.resolveSymbolToFile(className);
      if (resolvedPath) {
        resolvedFile = resolvedPath;
      }

      while ((methodMatch = methodRegex.exec(classBlock)) !== null) {
        const httpMethod = methodMatch[1].toUpperCase();
        routes.push({
          framework: this.name,
          method: httpMethod,
          path: routePath,
          handlerFile: resolvedFile,
          handlerSymbol: `${className}.${methodMatch[1]}`,
          metadata: {
            confidence: 'inferred',
            resourceType: 'flask_restx_resource',
          },
        });
      }
    }

    return routes;
  }
}

function getParenthesizedContent(str: string, startIndex: number): { content: string, endIndex: number } | null {
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
    if (char === "'" || char === '"') {
      inString = true;
      stringChar = char;
      continue;
    }
    if (char === '(') {
      depth++;
      if (depth === 1) {
        startIndex = i + 1;
      }
    } else if (char === ')') {
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

function parseArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let bracketDepth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];
    if (escape) {
      escape = false;
      current += char;
      continue;
    }
    if (char === '\\') {
      escape = true;
      current += char;
      continue;
    }
    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      inString = true;
      stringChar = char;
      current += char;
      continue;
    }
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    } else if (char === '[') {
      bracketDepth++;
    } else if (char === ']') {
      bracketDepth--;
    }

    if (char === ',' && depth === 0 && bracketDepth === 0) {
      args.push(cleanQuotes(current.trim()));
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    args.push(cleanQuotes(current.trim()));
  }
  return args;
}

function cleanQuotes(str: string): string {
  return str.replace(/^['"]|['"]$/g, '');
}
