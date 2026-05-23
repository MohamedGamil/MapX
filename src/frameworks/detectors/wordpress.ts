import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../../types.js';

export class WordPressDetector implements FrameworkDetector {
  readonly name = 'wordpress';
  readonly language = 'php';
  readonly filePattern = /\.php$/;

  // Standard WP template hierarchy files
  private static readonly TEMPLATE_FILES = new Set([
    'front-page.php',
    'home.php',
    'single.php',
    'page.php',
    'archive.php',
    'category.php',
    'tag.php',
    'taxonomy.php',
    'search.php',
    '404.php',
    'index.php'
  ]);

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const wpConfig = join(projectRoot, 'wp-config.php');
    if (existsSync(wpConfig)) return true;

    // Check if there are wp-includes or wp-content files
    return files.some(f => f.includes('wp-content/') || f.includes('wp-includes/'));
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    // 1. Template hierarchy routes
    const fileName = basename(filePath);
    if (WordPressDetector.TEMPLATE_FILES.has(fileName)) {
      let pathVal = '/' + fileName.replace(/\.php$/, '');
      if (fileName === 'front-page.php') {
        pathVal = '/';
      }

      routes.push({
        framework: this.name,
        method: 'GET',
        path: pathVal,
        handlerFile: filePath,
        handlerSymbol: fileName,
        metadata: {
          confidence: 'inferred',
          routeType: 'server',
          templateFile: fileName,
        },
      });
    }

    // 2. register_rest_route REST routes
    // E.g., register_rest_route('my-ns/v1', '/users', ...)
    const restRegex = /register_rest_route\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = restRegex.exec(content)) !== null) {
      const namespace = match[1];
      const routePath = match[2];
      const fullPath = `/wp-json/${namespace.replace(/^\/|\/$/g, '')}/${routePath.replace(/^\/|\/$/g, '')}`;

      // Search forward from match index to find callback and methods
      const scanWindow = content.substring(match.index, match.index + 1000);

      // Find callback: 'callback' => 'my_fn' or ['MyClass', 'method']
      const callbackMatch = scanWindow.match(/'callback'\s*=>\s*(?:['"]([^'"]+)['"]|\[\s*(?:['"]?([a-zA-Z0-9_]+)['"]?|([$]this))\s*,\s*['"]([^'"]+)['"]\s*\])/);
      let handlerSymbol = 'rest_callback';
      if (callbackMatch) {
        if (callbackMatch[1]) {
          handlerSymbol = callbackMatch[1];
        } else {
          const className = callbackMatch[2] || 'this';
          const methodName = callbackMatch[4];
          handlerSymbol = `${className}::${methodName}`;
        }
      }

      // Find methods
      let verbs = ['GET'];
      const methodsMatch = scanWindow.match(/'methods'\s*=>\s*(?:['"]([^'"]+)['"]|WP_REST_Server::([A-Z_]+)|\[\s*([^\]]+)\s*\])/);
      if (methodsMatch) {
        if (methodsMatch[1]) {
          verbs = [methodsMatch[1].toUpperCase()];
        } else if (methodsMatch[2]) {
          const constant = methodsMatch[2];
          if (constant === 'READABLE') verbs = ['GET'];
          else if (constant === 'CREATABLE') verbs = ['POST'];
          else if (constant === 'EDITABLE') verbs = ['PUT', 'PATCH'];
          else if (constant === 'DELETABLE') verbs = ['DELETE'];
          else verbs = ['ALL'];
        } else if (methodsMatch[3]) {
          verbs = methodsMatch[3].split(',').map(v => v.trim().replace(/['"]/g, '').toUpperCase());
        }
      }

      let resolvedFile = filePath;
      const resolvedPath = ctx.resolveSymbolToFile(handlerSymbol.split('::')[0]);
      if (resolvedPath) {
        resolvedFile = resolvedPath;
      }

      for (const verb of verbs) {
        routes.push({
          framework: this.name,
          method: verb,
          path: fullPath,
          handlerFile: resolvedFile,
          handlerSymbol: handlerSymbol,
          metadata: {
            confidence: 'inferred',
            routeType: 'server',
          },
        });
      }
    }

    return routes;
  }

  async extractHooks(filePath: string, content: string, ctx: ScanContext): Promise<HookBinding[]> {
    const hooks: HookBinding[] = [];

    // 1. add_action, add_filter, add_shortcode
    // Match: add_action('hook_name', 'callback') or add_action('hook_name', [Class, 'method'])
    const hookRegex = /\badd_(action|filter|shortcode)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(?:['"]([^'"]+)['"]|\[\s*(?:['"]?([a-zA-Z0-9_]+)['"]?|([$]this))\s*,\s*['"]([^'"]+)['"]\s*\])/g;
    let match;
    while ((match = hookRegex.exec(content)) !== null) {
      const type = match[1]; // action, filter, shortcode
      const hookName = match[2];

      let handlerSymbol = 'callback';
      if (match[3]) {
        handlerSymbol = match[3];
      } else {
        const className = match[4] || 'this';
        const methodName = match[6];
        handlerSymbol = `${className}::${methodName}`;
      }

      hooks.push({
        framework: this.name,
        hookName: hookName,
        handlerFile: filePath,
        handlerSymbol: handlerSymbol,
        hookType: type === 'shortcode' ? 'shortcode' : type === 'filter' ? 'filter' : 'action',
      });
    }

    // 2. register_post_type
    // E.g., register_post_type('post_type_name', ...)
    const ptRegex = /\bregister_post_type\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = ptRegex.exec(content)) !== null) {
      const postTypeName = match[1];
      hooks.push({
        framework: this.name,
        hookName: postTypeName,
        handlerFile: filePath,
        handlerSymbol: 'register_post_type',
        hookType: 'post_type',
      });
    }

    return hooks;
  }
}
