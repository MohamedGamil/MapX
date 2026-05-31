import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../../types.js';

/**
 * Flutter framework detector.
 *
 * Detects Flutter projects by looking for `pubspec.yaml` with a flutter
 * dependency, then extracts:
 *   - Named routes from Navigator.pushNamed / Navigator.pushReplacementNamed
 *   - GoRouter route definitions (path: '...' handler: widget)
 *   - auto_route / go_router annotations (@RoutePage, @GoRoute)
 *   - Widget lifecycle hooks (build, initState, dispose, didChangeDependencies)
 *   - State management signals (Provider, Riverpod, BLoC, GetX)
 */
export class FlutterDetector implements FrameworkDetector {
  readonly name = 'flutter';
  readonly language = 'dart';
  readonly filePattern = /\.dart$/;

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    const pubspec = join(projectRoot, 'pubspec.yaml');
    if (existsSync(pubspec)) {
      try {
        const content = await readFile(pubspec, 'utf-8');
        // A Flutter project declares the flutter SDK dependency
        if (content.includes('flutter:') && content.includes('sdk: flutter')) {
          return true;
        }
      } catch {
        // fall through
      }
    }
    // Heuristic: lib/main.dart is the standard Flutter entry point
    return files.some(f => f.endsWith('lib/main.dart') || f.endsWith('/lib/main.dart'));
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!content.includes('dart')) return routes;

    // ── 1. Navigator.pushNamed / pushReplacementNamed / pushNamedAndRemoveUntil ──
    // e.g. Navigator.pushNamed(context, '/home')
    const pushNamedRe = /Navigator\.\w*pushNamed\w*\s*\(\s*\w+\s*,\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = pushNamedRe.exec(content)) !== null) {
      routes.push({
        framework: this.name,
        method: 'NAVIGATE',
        path: m[1],
        handlerFile: filePath,
        handlerSymbol: undefined,
        metadata: { confidence: 'inferred', routeType: 'navigator-named' },
      });
    }

    // ── 2. MaterialApp / CupertinoApp routes map ──────────────────────────────
    // e.g. routes: { '/home': (context) => HomeScreen() }
    const routesMapRe = /['"]([/][^'"]*)['"]\s*:\s*\([^)]*\)\s*=>\s*([A-Z][a-zA-Z0-9_]*)/g;
    while ((m = routesMapRe.exec(content)) !== null) {
      const widgetName = m[2];
      let resolvedFile = filePath;
      const resolved = ctx.resolveSymbolToFile(widgetName);
      if (resolved) resolvedFile = resolved;

      routes.push({
        framework: this.name,
        method: 'NAVIGATE',
        path: m[1],
        handlerFile: resolvedFile,
        handlerSymbol: widgetName,
        metadata: { confidence: 'inferred', routeType: 'routes-map' },
      });
    }

    // ── 3. GoRouter / go_router: GoRoute(path: '/...', builder: ...) ─────────
    const goRouteRe = /GoRoute\s*\(\s*(?:[^)]*?)path\s*:\s*['"]([^'"]+)['"]/g;
    while ((m = goRouteRe.exec(content)) !== null) {
      const path = m[1];
      // Try to find the associated builder/pageBuilder widget name
      const afterRoute = content.slice(m.index, m.index + 400);
      const builderMatch = afterRoute.match(/(?:builder|pageBuilder)\s*:\s*[^,]*?(?:=>|return)\s+([A-Z][a-zA-Z0-9_]*)/);
      const widgetName = builderMatch?.[1];

      let resolvedFile = filePath;
      if (widgetName) {
        const resolved = ctx.resolveSymbolToFile(widgetName);
        if (resolved) resolvedFile = resolved;
      }

      routes.push({
        framework: this.name,
        method: 'NAVIGATE',
        path,
        handlerFile: resolvedFile,
        handlerSymbol: widgetName,
        metadata: { confidence: 'inferred', routeType: 'go-router' },
      });
    }

    // ── 4. auto_route: @RoutePage() annotation before class declarations ─────
    const autoRouteRe = /@RoutePage\(\)\s*\n\s*(?:abstract\s+)?class\s+([A-Z][a-zA-Z0-9_]*)/g;
    while ((m = autoRouteRe.exec(content)) !== null) {
      const widgetName = m[1];
      // Convert WidgetName → /widget-name for path inference
      const inferredPath = '/' + widgetName
        .replace(/Page$|Screen$|View$/, '')
        .replace(/([A-Z])/g, (c, i) => (i > 0 ? '-' : '') + c.toLowerCase());

      routes.push({
        framework: this.name,
        method: 'NAVIGATE',
        path: inferredPath,
        handlerFile: filePath,
        handlerSymbol: widgetName,
        metadata: { confidence: 'inferred', routeType: 'auto-route' },
      });
    }

    return routes;
  }

  async extractHooks(filePath: string, content: string, ctx: ScanContext): Promise<HookBinding[]> {
    const hooks: HookBinding[] = [];

    if (!content.includes('.dart')) return hooks;

    // ── 1. StatefulWidget lifecycle methods ──────────────────────────────────
    const lifecycleMethods = [
      { name: 'initState', hookType: 'lifecycle' },
      { name: 'dispose', hookType: 'lifecycle' },
      { name: 'build', hookType: 'render' },
      { name: 'didChangeDependencies', hookType: 'lifecycle' },
      { name: 'didUpdateWidget', hookType: 'lifecycle' },
      { name: 'setState', hookType: 'state-update' },
      { name: 'deactivate', hookType: 'lifecycle' },
      { name: 'reassemble', hookType: 'lifecycle' },
    ];

    for (const { name, hookType } of lifecycleMethods) {
      // Look for overridden method declarations
      const re = new RegExp(`@override\\s*\\n\\s*(?:\\w+\\s+)?${name}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const line = content.slice(0, m.index).split('\n').length;
        // Find the enclosing class name
        const before = content.slice(0, m.index);
        const classMatch = [...before.matchAll(/\bclass\s+([A-Z][a-zA-Z0-9_]*)/g)].pop();
        const className = classMatch?.[1];

        hooks.push({
          framework: this.name,
          hookName: name,
          hookType,
          handlerFile: filePath,
          handlerSymbol: className ? `${className}@${name}` : name,
          metadata: { line },
        });
      }
    }

    // ── 2. Provider / Riverpod: Consumer / ConsumerWidget ────────────────────
    const statePatterns: Array<{ re: RegExp; hookName: string; hookType: string }> = [
      { re: /\bConsumer\s*\(/g, hookName: 'Consumer', hookType: 'state-provider' },
      { re: /\bConsumerWidget\b/g, hookName: 'ConsumerWidget', hookType: 'state-provider' },
      { re: /\bConsumerStatefulWidget\b/g, hookName: 'ConsumerStatefulWidget', hookType: 'state-provider' },
      { re: /context\.watch\s*</g, hookName: 'context.watch', hookType: 'state-provider' },
      { re: /context\.read\s*</g, hookName: 'context.read', hookType: 'state-provider' },
      { re: /ref\.watch\s*\(/g, hookName: 'ref.watch', hookType: 'riverpod' },
      { re: /ref\.read\s*\(/g, hookName: 'ref.read', hookType: 'riverpod' },
      { re: /BlocBuilder\s*</g, hookName: 'BlocBuilder', hookType: 'bloc' },
      { re: /BlocListener\s*</g, hookName: 'BlocListener', hookType: 'bloc' },
      { re: /BlocConsumer\s*</g, hookName: 'BlocConsumer', hookType: 'bloc' },
      { re: /MultiBlocProvider\s*\(/g, hookName: 'MultiBlocProvider', hookType: 'bloc' },
      { re: /GetBuilder\s*</g, hookName: 'GetBuilder', hookType: 'getx' },
      { re: /Obx\s*\(/g, hookName: 'Obx', hookType: 'getx' },
      { re: /GetX\s*</g, hookName: 'GetX', hookType: 'getx' },
    ];

    for (const { re, hookName, hookType } of statePatterns) {
      if (re.test(content)) {
        hooks.push({
          framework: this.name,
          hookName,
          hookType,
          handlerFile: filePath,
          metadata: { confidence: 'inferred' },
        });
      }
    }

    return hooks;
  }
}
