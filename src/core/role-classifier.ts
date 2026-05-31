import type { Store } from './store.js';
import type { FileRole, CodebaseProfile, ClassificationResult, ClassificationSignal, SignalSource } from '../types.js';
import picomatch from 'picomatch';
import * as path from 'node:path';

export class RoleClassifier {
  private configSettings: any;

  constructor(private store: Store, private config?: any) {
    this.configSettings = config?.settings?.architecture || {};
  }

  /**
   * Classifies a file and stores its signals, alternate roles, and confidence scores.
   */
  classify(
    filePath: string,
    repoName: string,
    profile: CodebaseProfile,
    routes: any[] = [],
    hooks: any[] = []
  ): ClassificationResult {
    // 0. Check User Config Overrides (Highest priority)
    const overrideRole = this.getOverrideRole(filePath);
    if (overrideRole) {
      return {
        filePath,
        role: overrideRole,
        confidence: 1.0,
        signals: [
          {
            source: 'path',
            role: overrideRole,
            confidence: 1.0,
            reason: `Explicitly overridden in config.json settings`,
          },
        ],
        alternateRoles: [],
      };
    }

    // Markdown files are always classified as docs
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
      return {
        filePath,
        role: 'docs',
        confidence: 1.0,
        signals: [
          {
            source: 'path',
            role: 'docs',
            confidence: 1.0,
            reason: 'Markdown files are always classified as documentation (docs)',
          },
        ],
        alternateRoles: [],
      };
    }

    const signals: ClassificationSignal[] = [];

    // Signal 1: Path Analysis (weight: 0.30)
    const pathSignal = this.getPathSignal(filePath, profile);
    if (pathSignal) {
      signals.push(pathSignal);
    }

    // Signal 2: Symbol Naming (weight: 0.25)
    const namingSignal = this.getNamingSignal(filePath);
    if (namingSignal) {
      signals.push(namingSignal);
    }

    // Signal 3: Dependency Topology (weight: 0.20)
    const topologySignal = this.getTopologySignal(filePath, profile);
    if (topologySignal) {
      signals.push(topologySignal);
    }

    // Signal 4: Framework Bindings (weight: 0.15)
    const frameworkSignal = this.getFrameworkSignal(filePath, routes, hooks);
    if (frameworkSignal) {
      signals.push(frameworkSignal);
    }

    // Signal 5: Import Direction (weight: 0.10)
    const importsSignal = this.getImportsSignal(filePath);
    if (importsSignal) {
      signals.push(importsSignal);
    }

    // Compute combined scores
    const weights: Record<SignalSource, number> = {
      path: 0.30,
      naming: 0.25,
      topology: 0.20,
      framework: 0.15,
      imports: 0.10,
    };

    const roleScores: Record<string, number> = {};
    const roleReasons: Record<string, string[]> = {};

    for (const sig of signals) {
      const w = weights[sig.source];
      roleScores[sig.role] = (roleScores[sig.role] || 0) + sig.confidence * w;
      if (!roleReasons[sig.role]) {
        roleReasons[sig.role] = [];
      }
      roleReasons[sig.role].push(`[${sig.source}] ${sig.reason}`);
    }

    const sortedRoles = Object.entries(roleScores)
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0] as FileRole);

    const finalRole: FileRole = sortedRoles[0] || 'other';
    const totalPossibleWeight = Object.keys(weights).reduce((sum, key) => sum + weights[key as SignalSource], 0);
    const confidence = sortedRoles.length > 0 ? Math.min(1.0, roleScores[finalRole] / totalPossibleWeight) : 0.5;

    return {
      filePath,
      role: finalRole,
      confidence,
      signals,
      alternateRoles: sortedRoles.slice(1),
    };
  }

  private getOverrideRole(filePath: string): FileRole | null {
    // 1. Check custom overrides mapping
    const overrides = this.configSettings.overrides || {};
    for (const [pattern, role] of Object.entries(overrides)) {
      if (picomatch.isMatch(filePath, pattern, { dot: true })) {
        return role as FileRole;
      }
    }

    // 2. Check customRoles list
    const customRoles = this.configSettings.customRoles || [];
    for (const custom of customRoles) {
      const patterns = Array.isArray(custom.paths) ? custom.paths : [custom.paths];
      for (const p of patterns) {
        if (picomatch.isMatch(filePath, p, { dot: true })) {
          return custom.name as FileRole;
        }
      }
    }

    return null;
  }

  private getPathSignal(filePath: string, profile: CodebaseProfile): ClassificationSignal | null {
    const lower = filePath.toLowerCase();
    const basename = path.basename(lower);
    const parts = lower.split('/');

    // Universal high priority
    if (parts.some(p => p === 'tests' || p === 'test' || p === '__tests__' || p === 'spec' || p === 'specs') || /\.(test|spec)\.[a-z0-9]+$/.test(lower)) {
      return { source: 'path', role: 'test', confidence: 0.95, reason: 'Matched test path pattern' };
    }
    if (parts.some(p => p === 'docs' || p === 'documentation') || basename.endsWith('.md') || basename.endsWith('.mdx')) {
      return { source: 'path', role: 'docs', confidence: 0.95, reason: 'Matched documentation file pattern' };
    }
    if (parts.some(p => p === 'config' || p === 'configs' || p === 'configuration') || /\.(config|env|rc)\.[a-z0-9]+$/.test(lower) || basename.endsWith('.env')) {
      return { source: 'path', role: 'config', confidence: 0.95, reason: 'Matched configuration file pattern' };
    }
    if (parts.some(p => p === 'types' || p === 'interfaces' || p === 'typings') || basename.endsWith('.d.ts') || basename === 'types.ts' || basename === 'interfaces.ts' || /\.types\.[a-z0-9]+$/.test(lower) || /\.interface\.[a-z0-9]+$/.test(lower)) {
      return { source: 'path', role: 'types', confidence: 0.95, reason: 'Matched types/interfaces file pattern' };
    }

    // Universal generic
    // For Flutter/mobile apps, `lib/` is the main source root (equivalent to `src/`), not a shared folder.
    const isFlutterSourceRoot = profile.archetype === 'mobile-app' && parts[0] === 'lib' && lower.endsWith('.dart');
    if (!isFlutterSourceRoot && parts.some(p => p === 'utils' || p === 'util' || p === 'helpers' || p === 'helper' || p === 'shared' || p === 'common' || p === 'lib' || p === 'libs')) {
      return { source: 'path', role: 'shared', confidence: 0.8, reason: 'Matched shared/utilities folder' };
    }

    // Tooling/Library
    if (profile.archetype === 'cli-tool' || profile.archetype === 'library') {
      if (parts.some(p => p === 'cli' || p === 'bin' || p === 'commands' || p === 'cmd') || basename === 'cli.ts' || basename === 'cli.js' || basename === 'main.ts' || basename === 'main.js') {
        return { source: 'path', role: 'cli', confidence: 0.9, reason: 'CLI/Entry point folder or file' };
      }
      if (parts.some(p => p === 'parsers' || p === 'parser' || p === 'languages' || p === 'language') || basename.includes('parser')) {
        return { source: 'path', role: 'parsers', confidence: 0.9, reason: 'Parser or language folder' };
      }
      if (parts.some(p => p === 'plugins' || p === 'plugin' || p === 'adapters' || p === 'adapter')) {
        return { source: 'path', role: 'plugins', confidence: 0.9, reason: 'Plugins/adapters folder' };
      }
      if (parts.some(p => p === 'core' || p === 'domain' || p === 'engine')) {
        return { source: 'path', role: 'core', confidence: 0.85, reason: 'Core core engine folder' };
      }
    }

    // Backend
    if (profile.hasBackend) {
      if (parts.some(p => p === 'api' || p === 'routes' || p === 'controllers' || p === 'controller' || p === 'endpoints' || p === 'handlers')) {
        return { source: 'path', role: 'api', confidence: 0.9, reason: 'Backend route/controller API directory' };
      }
      if (parts.some(p => p === 'middleware' || p === 'middlewares' || p === 'guards' || p === 'interceptors')) {
        return { source: 'path', role: 'middleware', confidence: 0.9, reason: 'Request middleware/guards directory' };
      }
      if (parts.some(p => p === 'services' || p === 'service' || p === 'usecases' || p === 'usecase' || p === 'domain' || p === 'logic')) {
        return { source: 'path', role: 'service', confidence: 0.85, reason: 'Business logic/service directory' };
      }
      if (parts.some(p => p === 'stores' || p === 'db' || p === 'database' || p === 'models' || p === 'model' || p === 'repositories' || p === 'repository' || p === 'migrations' || p === 'seeds' || p === 'data')) {
        return { source: 'path', role: 'data', confidence: 0.9, reason: 'Persistence/database data directory' };
      }
      if (parts.some(p => p === 'auth' || p === 'identity' || p === 'login')) {
        return { source: 'path', role: 'auth', confidence: 0.9, reason: 'Auth/identity directory' };
      }
      if (parts.some(p => p === 'integration' || p === 'clients' || p === 'external' || p === 'sdk')) {
        return { source: 'path', role: 'integration', confidence: 0.85, reason: 'Integration/external SDK client directory' };
      }
    }

    // Frontend
    if (profile.hasFrontend) {
      if (parts.some(p => p === 'pages' || p === 'screens' || p === 'views')) {
        return { source: 'path', role: 'pages', confidence: 0.9, reason: 'Frontend pages view directory' };
      }
      if (parts.some(p => p === 'components' || p === 'widgets' || p === 'ui' || p === 'layout')) {
        return { source: 'path', role: 'components', confidence: 0.9, reason: 'Frontend component UI directory' };
      }
      if (parts.some(p => p === 'store' || p === 'stores' || p === 'state' || p === 'reducers' || p === 'actions')) {
        return { source: 'path', role: 'state', confidence: 0.9, reason: 'State management store directory' };
      }
      if (parts.some(p => p === 'hooks' || p === 'composables')) {
        return { source: 'path', role: 'hooks', confidence: 0.9, reason: 'React custom hooks/Vue composables directory' };
      }
      if (parts.some(p => p === 'styles' || p === 'theme' || p === 'css' || p === 'sass' || p === 'scss') || lower.endsWith('.css') || lower.endsWith('.scss')) {
        return { source: 'path', role: 'styles', confidence: 0.9, reason: 'Styling stylesheet directory or file' };
      }
      if (parts.some(p => p === 'assets' || p === 'images' || p === 'fonts' || p === 'icons' || p === 'public')) {
        return { source: 'path', role: 'assets', confidence: 0.85, reason: 'Frontend static assets directory' };
      }

      // Flutter-specific directories
      if (parts.some(p => p === 'blocs' || p === 'bloc' || p === 'cubits' || p === 'cubit')) {
        return { source: 'path', role: 'state', confidence: 0.92, reason: 'Flutter BLoC/Cubit state management directory' };
      }
      if (parts.some(p => p === 'providers' || p === 'provider' || p === 'notifiers' || p === 'notifier')) {
        return { source: 'path', role: 'state', confidence: 0.9, reason: 'Flutter Provider/Riverpod state directory' };
      }
      if (parts.some(p => p === 'controllers' || p === 'controller') && lower.endsWith('.dart')) {
        return { source: 'path', role: 'state', confidence: 0.85, reason: 'Flutter GetX controller directory' };
      }
      if (parts.some(p => p === 'repositories' || p === 'repository' || p === 'datasources' || p === 'datasource')) {
        return { source: 'path', role: 'data', confidence: 0.9, reason: 'Flutter data/repository layer directory' };
      }
      if (parts.some(p => p === 'models' || p === 'model' || p === 'entities' || p === 'entity') && lower.endsWith('.dart')) {
        return { source: 'path', role: 'data', confidence: 0.85, reason: 'Flutter data model/entity directory' };
      }
      if (parts.some(p => p === 'routes' || p === 'router' || p === 'navigation') && lower.endsWith('.dart')) {
        return { source: 'path', role: 'api', confidence: 0.88, reason: 'Flutter routing/navigation directory' };
      }
    }

    // Default main/index
    if (basename === 'main.ts' || basename === 'main.js' || basename === 'main.dart' || basename === 'index.ts' || basename === 'index.js' || basename === 'app.ts' || basename === 'app.js') {
      return { source: 'path', role: 'entry', confidence: 0.8, reason: 'Entry point filename' };
    }

    return null;
  }

  private getNamingSignal(filePath: string): ClassificationSignal | null {
    const symbols = this.store.getSymbolsForFile(filePath);
    if (symbols.length === 0) return null;

    const roleScores: Record<string, number> = {};
    const matches: string[] = [];

    for (const sym of symbols) {
      const name = sym.name as string;
      if (name.endsWith('Controller') || name.endsWith('Handler') || name.endsWith('Resolver')) {
        roleScores['api'] = (roleScores['api'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Service') || name.endsWith('UseCase') || name.endsWith('Interactor')) {
        roleScores['service'] = (roleScores['service'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Repository') || name.endsWith('DAO') || name.endsWith('Store') || name.endsWith('Model') || name.endsWith('Entity') || name.endsWith('Schema')) {
        // Store could be state or data, let's default to data for backend naming, but state is also possible
        roleScores['data'] = (roleScores['data'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Middleware') || name.endsWith('Guard') || name.endsWith('Interceptor')) {
        roleScores['middleware'] = (roleScores['middleware'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Component') || name.endsWith('Widget') || name.endsWith('View') || name.endsWith('Screen') || name.endsWith('Page')) {
        roleScores['components'] = (roleScores['components'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Bloc') || name.endsWith('Cubit') || name.endsWith('Notifier') || name.endsWith('ChangeNotifier') || name.endsWith('Provider') || name.endsWith('Controller') && /^[A-Z]/.test(name)) {
        roleScores['state'] = (roleScores['state'] || 0) + 1;
        matches.push(name);
      } else if (name.startsWith('use') && sym.kind === 'function') {
        roleScores['hooks'] = (roleScores['hooks'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Dto') || name.endsWith('Type') || name.endsWith('Interface') || name.endsWith('Props')) {
        roleScores['types'] = (roleScores['types'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Test') || name.endsWith('Spec')) {
        roleScores['test'] = (roleScores['test'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Config') || name.endsWith('Options')) {
        roleScores['config'] = (roleScores['config'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Util') || name.endsWith('Helper')) {
        roleScores['shared'] = (roleScores['shared'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Parser')) {
        roleScores['parsers'] = (roleScores['parsers'] || 0) + 1;
        matches.push(name);
      } else if (name.endsWith('Plugin') || name.endsWith('Adapter')) {
        roleScores['plugins'] = (roleScores['plugins'] || 0) + 1;
        matches.push(name);
      }
    }

    const bestRoleEntry = Object.entries(roleScores).sort((a, b) => b[1] - a[1])[0];
    if (!bestRoleEntry) return null;

    const matchedRole = bestRoleEntry[0] as FileRole;
    return {
      source: 'naming',
      role: matchedRole,
      confidence: 0.8,
      reason: `Exports symbols with standard role suffixes: ${matches.slice(0, 3).join(', ')}`,
    };
  }

  private getTopologySignal(filePath: string, profile: CodebaseProfile): ClassificationSignal | null {
    const inEdges = this.store.raw.prepare('SELECT COUNT(*) as count FROM edges WHERE target_file = ?').get(filePath) as any;
    const outEdges = this.store.raw.prepare('SELECT COUNT(*) as count FROM edges WHERE source_file = ?').get(filePath) as any;
    const fanIn = inEdges?.count || 0;
    const fanOut = outEdges?.count || 0;

    if (fanIn === 0 && fanOut > 0) {
      const suggestedRole = profile.hasBackend ? 'api' : 'entry';
      return {
        source: 'topology',
        role: suggestedRole,
        confidence: 0.7,
        reason: `Zero fan-in and non-zero fan-out (${fanOut}) suggests routing or CLI entry point`,
      };
    }

    if (fanIn > 10 && fanOut === 0) {
      const ext = path.extname(filePath).toLowerCase();
      const suggestedRole = ext === '.d.ts' || ext === '.types' ? 'types' : 'shared';
      return {
        source: 'topology',
        role: suggestedRole,
        confidence: 0.7,
        reason: `High fan-in (${fanIn}) and zero fan-out suggests shared utility or types leaf`,
      };
    }

    return null;
  }

  private getFrameworkSignal(filePath: string, routes: any[], hooks: any[]): ClassificationSignal | null {
    const lower = filePath.toLowerCase();

    // Check if this file contains route handlers
    const isRouter = routes.some(r => r.handlerFile === filePath || (r.metadata && r.metadata.sourceFile === filePath));
    if (isRouter) {
      return {
        source: 'framework',
        role: 'api',
        confidence: 0.9,
        reason: 'Registered as a controller or handler in framework route bindings',
      };
    }

    // Check if hook handler
    const isHook = hooks.some(h => h.handlerFile === filePath);
    if (isHook) {
      return {
        source: 'framework',
        role: 'middleware',
        confidence: 0.85,
        reason: 'Registered in framework hook bindings',
      };
    }

    return null;
  }

  private getImportsSignal(filePath: string): ClassificationSignal | null {
    // Check outgoing edges with type import / require
    const rows = this.backendQueryImports(filePath);
    if (rows.length === 0) return null;

    const roleScores: Record<string, number> = {};
    for (const r of rows) {
      const target = r.target_file.toLowerCase();
      if (target.includes('express') || target.includes('koa') || target.includes('fastify') || target.includes('@nestjs/common')) {
        roleScores['api'] = (roleScores['api'] || 0) + 1;
      } else if (target.includes('sequelize') || target.includes('typeorm') || target.includes('prisma') || target.includes('mongoose')) {
        roleScores['data'] = (roleScores['data'] || 0) + 1;
      } else if (target.includes('react') || target.includes('vue') || target.includes('svelte') || target.includes('@angular')) {
        roleScores['components'] = (roleScores['components'] || 0) + 1;
      } else if (target.includes('redux') || target.includes('vuex') || target.includes('pinia') || target.includes('zustand')) {
        roleScores['state'] = (roleScores['state'] || 0) + 1;
      } else if (target.includes('vitest') || target.includes('jest') || target.includes('mocha') || target.includes('chai')) {
        roleScores['test'] = (roleScores['test'] || 0) + 1;
      }
    }

    const bestRoleEntry = Object.entries(roleScores).sort((a, b) => b[1] - a[1])[0];
    if (!bestRoleEntry) return null;

    const matchedRole = bestRoleEntry[0] as FileRole;
    return {
      source: 'imports',
      role: matchedRole,
      confidence: 0.75,
      reason: `Imports library associated with ${matchedRole} role`,
    };
  }

  private backendQueryImports(filePath: string): any[] {
    try {
      return this.store.raw.prepare(`
        SELECT target_file FROM edges
        WHERE source_file = ? AND (edge_type = 'import' OR edge_type = 'require')
      `).all(filePath) as any[];
    } catch {
      return [];
    }
  }
}
