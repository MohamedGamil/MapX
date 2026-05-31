import { Store } from './store.js';
import type { ArchLayer, FileRole } from '../types.js';
import { detectLeidenCommunities } from './leiden.js';

export type ClusterSource = 'namespace' | 'directory' | 'community' | 'layer';

export interface Cluster {
  name: string;
  label: string;
  source: ClusterSource;
  parentName: string | null;
  depth: number;
  fileCount: number;
  layer?: ArchLayer;
}

export interface ClusterResult {
  clustersFound: number;
  namespaceClusters: number;
  directoryClusters: number;
  communityClusters: number;
  layerClusters: number;
  filesAssigned: number;
  durationMs: number;
}

export class ClusterEngine {
  constructor(private store: Store) {}

  detect(repo: string): ClusterResult {
    const startTime = Date.now();

    // 1. Detect Namespace clusters (Source 1)
    const nsRes = this.detectNamespaceClusters(repo);

    // 2. Detect Directory clusters (Source 2)
    const dirRes = this.detectDirectoryClusters(repo, nsRes.memberships);

    // Combine primary memberships
    const allPrimaryMemberships = new Map<string, string>();
    for (const [f, c] of nsRes.memberships.entries()) {
      allPrimaryMemberships.set(f, c);
    }
    for (const [f, c] of dirRes.memberships.entries()) {
      allPrimaryMemberships.set(f, c);
    }

    // Combine primary clusters
    const primaryClustersMap = new Map<string, Cluster>();
    for (const c of nsRes.clusters) {
      primaryClustersMap.set(c.name, c);
    }
    for (const c of dirRes.clusters) {
      if (!primaryClustersMap.has(c.name)) {
        primaryClustersMap.set(c.name, c);
      }
    }

    // Compute recursive file counts for primary clusters
    const primaryFileCounts = new Map<string, number>();
    for (const clusterName of allPrimaryMemberships.values()) {
      let current: string | null = clusterName;
      while (current) {
        primaryFileCounts.set(current, (primaryFileCounts.get(current) || 0) + 1);
        const idx = current.lastIndexOf('.');
        current = idx !== -1 ? current.substring(0, idx) : null;
      }
    }

    // Apply recursive file counts to primary clusters
    const primaryClusters = Array.from(primaryClustersMap.values()).map(c => ({
      ...c,
      fileCount: primaryFileCounts.get(c.name) || 0,
    }));

    // Build map of cluster name to set of files it contains recursively (for community overlap check)
    const clusterFileSets = new Map<string, Set<string>>();
    for (const c of primaryClusters) {
      clusterFileSets.set(c.name, new Set<string>());
    }
    for (const [filePath, clusterName] of allPrimaryMemberships.entries()) {
      let current: string | null = clusterName;
      while (current) {
        if (clusterFileSets.has(current)) {
          clusterFileSets.get(current)!.add(filePath);
        }
        const idx = current.lastIndexOf('.');
        current = idx !== -1 ? current.substring(0, idx) : null;
      }
    }

    // 3. Detect Community clusters (Source 3)
    const files = this.store.getAllFiles(repo);
    const edges = this.store.getAllEdges(repo);
    const commRes = this.detectCommunityClusters(repo, files, edges, clusterFileSets);

    // 4. Detect Layer clusters (Source 4)
    const layerRes = this.detectLayerClusters(repo, files);

    // Save all to database
    this.store.inTransaction(() => {
      this.store.clearClusters(repo);

      // Persist primary clusters
      for (const c of primaryClusters) {
        this.store.insertCluster({
          repo,
          name: c.name,
          label: c.label,
          source: c.source,
          parentName: c.parentName,
          depth: c.depth,
          fileCount: c.fileCount,
        });
      }

      // Persist primary memberships
      for (const [filePath, clusterName] of allPrimaryMemberships.entries()) {
        this.store.insertClusterMembership({
          filePath,
          clusterName,
          repo,
          isPrimary: 1,
        });
      }

      // Persist community clusters
      for (const c of commRes.clusters) {
        this.store.insertCluster({
          repo,
          name: c.name,
          label: c.label,
          source: c.source,
          parentName: c.parentName,
          depth: c.depth,
          fileCount: c.fileCount,
        });
      }

      // Persist community memberships
      for (const m of commRes.memberships) {
        this.store.insertClusterMembership({
          filePath: m.filePath,
          clusterName: m.clusterName,
          repo,
          isPrimary: 0,
        });
      }

      // Persist layer clusters
      for (const c of layerRes.clusters) {
        this.store.insertCluster({
          repo,
          name: c.name,
          label: c.label,
          source: c.source,
          parentName: c.parentName,
          depth: c.depth,
          fileCount: c.fileCount,
          layer: c.layer,
        });
      }

      // Persist layer memberships (secondary — allow files to appear in both a
      // primary cluster and a layer cluster simultaneously)
      for (const m of layerRes.memberships) {
        this.store.insertClusterMembership({
          filePath: m.filePath,
          clusterName: m.clusterName,
          repo,
          isPrimary: 0,
        });
      }
    });

    const namespaceCount = primaryClusters.filter(c => c.source === 'namespace').length;
    const directoryCount = primaryClusters.filter(c => c.source === 'directory').length;

    return {
      clustersFound: primaryClusters.length + commRes.clusters.length + layerRes.clusters.length,
      namespaceClusters: namespaceCount,
      directoryClusters: directoryCount,
      communityClusters: commRes.clusters.length,
      layerClusters: layerRes.clusters.length,
      filesAssigned: allPrimaryMemberships.size,
      durationMs: Date.now() - startTime,
    };
  }

  private detectNamespaceClusters(repo: string): { clusters: Cluster[]; memberships: Map<string, string> } {
    const files = this.store.getAllFiles(repo);
    const clustersMap = new Map<string, Cluster>();
    const memberships = new Map<string, string>();

    for (const f of files) {
      let ns = (f.namespace as string) || null;
      if (!ns && f.metadata) {
        try {
          const meta = JSON.parse(f.metadata as string);
          ns = meta.namespace || null;
        } catch {}
      }

      if (ns) {
        const normalized = ns.replace(/\\/g, '.').replace(/^\.|\.$/g, '');
        if (!normalized) continue;

        memberships.set(f.path as string, normalized);

        let current = normalized;
        while (current) {
          if (!clustersMap.has(current)) {
            const parts = current.split('.');
            const parentName = parts.slice(0, -1).join('.') || null;
            const depth = parts.length - 1;
            clustersMap.set(current, {
              name: current,
              label: parts.join(' / '),
              source: 'namespace',
              parentName,
              depth,
              fileCount: 0,
            });
          }
          const idx = current.lastIndexOf('.');
          current = idx !== -1 ? current.substring(0, idx) : '';
        }
      }
    }

    return { clusters: Array.from(clustersMap.values()), memberships };
  }

  private detectDirectoryClusters(
    repo: string,
    existingPrimaryMemberships: Map<string, string>
  ): { clusters: Cluster[]; memberships: Map<string, string> } {
    const files = this.store.getAllFiles(repo);
    const dirFileCount = new Map<string, Set<string>>();

    for (const f of files) {
      const filePath = f.path as string;
      const parts = filePath.split('/');
      if (parts.length <= 1) continue;

      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join('/');
        if (!dirFileCount.has(dirPath)) {
          dirFileCount.set(dirPath, new Set());
        }
        dirFileCount.get(dirPath)!.add(filePath);
      }
    }

    const clustersMap = new Map<string, Cluster>();
    const memberships = new Map<string, string>();

    for (const [dirPath, fileSet] of dirFileCount.entries()) {
      if (fileSet.size >= 2) {
        const clusterName = dirPath.replace(/\//g, '.');
        const parts = clusterName.split('.');
        const parentName = parts.slice(0, -1).join('.') || null;
        const depth = parts.length;

        clustersMap.set(clusterName, {
          name: clusterName,
          label: parts.join(' / '),
          source: 'directory',
          parentName,
          depth,
          fileCount: 0,
        });
      }
    }

    for (const f of files) {
      const filePath = f.path as string;
      if (existingPrimaryMemberships.has(filePath)) continue;

      const parts = filePath.split('/');
      if (parts.length <= 1) continue;

      for (let i = parts.length - 1; i >= 1; i--) {
        const dirPath = parts.slice(0, i).join('/');
        const clusterName = dirPath.replace(/\//g, '.');
        if (clustersMap.has(clusterName)) {
          memberships.set(filePath, clusterName);
          break;
        }
      }
    }

    return { clusters: Array.from(clustersMap.values()), memberships };
  }

  private detectCommunityClusters(
    repo: string,
    files: any[],
    edges: any[],
    existingClusterFileSets: Map<string, Set<string>>
  ): { clusters: Cluster[]; memberships: { filePath: string; clusterName: string }[] } {
    const filesList = files.map(f => f.path as string).sort();
    const leidenEdges: { source: string; target: string; weight: number }[] = [];

    for (const e of edges) {
      const src = e.source_file as string;
      const tgt = e.target_file as string;
      if (src === tgt) continue;

      let weight = 1;
      const type = (e.edge_type || '').toLowerCase();
      if (type === 'call') weight = 3;
      else if (type === 'import' || type === 'require') weight = 2;
      else if (type === 'extends' || type === 'implements') weight = 2;
      else if (type === 'relation') weight = 2;
      else if (type === 'type_reference' || type === 'return_type' || type === 'param_type') weight = 1;

      leidenEdges.push({ source: src, target: tgt, weight });
    }

    const communities = detectLeidenCommunities(filesList, leidenEdges, {
      resolution: 1.3,
      minCommunitySize: 2,
      maxIterations: 20
    });

    const clusters: Cluster[] = [];
    const memberships: { filePath: string; clusterName: string }[] = [];
    let communityIndex = 1;

    const sortedGroupKeys = Object.keys(communities).sort();
    for (const key of sortedGroupKeys) {
      const filePaths = communities[key];
      if (filePaths.length < 2) continue;

      const commName = `community_${communityIndex++}`;
      clusters.push({
        name: commName,
        label: `Community ${commName.split('_')[1]}`,
        source: 'community',
        parentName: null,
        depth: 0,
        fileCount: filePaths.length,
      });
      for (const f of filePaths) {
        memberships.push({ filePath: f, clusterName: commName });
      }
    }

    return { clusters, memberships };
  }

  /**
   * Assign an architectural layer to a file based on its path and filename.
   *
   * The rules are applied in priority order; the first match wins.
   */
  static assignFileLayer(filePath: string): ArchLayer {
    const lower = filePath.toLowerCase();
    const basename = lower.split('/').pop() ?? lower;
    const parts = lower.split('/');

    // Tests — highest priority so spec files are never mis-classified
    if (
      parts.some(p => p === 'tests' || p === 'test' || p === '__tests__' || p === 'spec' || p === 'specs') ||
      /\.(test|spec)\.[a-z]+$/.test(lower)
    ) return 'test';

    // Agents (checked before docs so e.g. agents.stub.md is not mis-classified)
    if (
      parts.some(p => p === 'agents' || p === 'agent') ||
      basename.startsWith('agent') || basename.endsWith('.agent.ts') ||
      basename.startsWith('agents.')
    ) return 'agents';

    // Docs
    if (
      parts.some(p => p === 'docs' || p === 'documentation') ||
      basename.endsWith('.md') || basename.endsWith('.mdx')
    ) return 'docs';

    // Config files
    if (
      parts.some(p => p === 'config' || p === 'configs' || p === 'configuration') ||
      /\.(config|env|rc)\.[a-z]+$/.test(lower) ||
      basename.endsWith('.env') ||
      [
        'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vitest.config.ts',
        'webpack.config.js', 'rollup.config.js', 'jest.config.js',
        'babel.config.js', '.eslintrc', 'turbo.json', 'nx.json',
        'package.json', 'cargo.toml', 'go.mod', 'pyproject.toml',
        'composer.json', 'build.gradle', 'pom.xml', 'makefile',
      ].includes(basename)
    ) return 'config';

    // Type definitions
    if (
      parts.some(p => p === 'types' || p === 'interfaces' || p === 'typings') ||
      basename.endsWith('.d.ts') ||
      basename === 'types.ts' || basename === 'interfaces.ts' ||
      /\.types\.[a-z]+$/.test(lower) || /\.interface\.[a-z]+$/.test(lower)
    ) return 'types';

    // Scripts / build tools
    if (
      parts.some(p => p === 'scripts' || p === 'tools' || p === 'build' || p === 'tasks') ||
      parts[0] === 'scripts'
    ) return 'scripts';

    // UI / Frontend
    if (
      parts.some(p =>
        p === 'ui' || p === 'frontend' || p === 'web' || p === 'client' ||
        p === 'views' || p === 'pages' || p === 'components' || p === 'widgets' ||
        p === 'app' || p === 'public' || p === 'assets' || p === 'static'
      ) ||
      /\.(vue|svelte|jsx|tsx)$/.test(lower) ||
      basename.endsWith('.html') || basename.endsWith('.css')
    ) return 'ui';

    // Exporters
    if (
      parts.some(p => p === 'exporters' || p === 'export' || p === 'exports') ||
      basename.includes('exporter') || basename.includes('export')
    ) return 'exporters';

    // Parsers / language support
    if (
      parts.some(p => p === 'parsers' || p === 'parser' || p === 'languages' || p === 'language') ||
      basename.includes('parser') || basename.includes('-parser')
    ) return 'parsers';

    // Framework adapters
    if (
      parts.some(p => p === 'frameworks' || p === 'framework' || p === 'plugins' || p === 'adapters') ||
      basename.includes('framework') || basename.includes('detector')
    ) return 'frameworks';

    // API / Routes / Controllers
    if (
      parts.some(p =>
        p === 'api' || p === 'routes' || p === 'route' || p === 'controllers' ||
        p === 'controller' || p === 'handlers' || p === 'handler' || p === 'endpoints'
      ) ||
      basename.includes('route') || basename.includes('controller') || basename.includes('handler')
    ) return 'api';

    // Data layer
    if (
      parts.some(p =>
        p === 'stores' || p === 'store' || p === 'db' || p === 'database' ||
        p === 'models' || p === 'model' || p === 'data' || p === 'repositories' ||
        p === 'repository' || p === 'migrations' || p === 'seeds'
      ) ||
      basename.startsWith('store') || basename.includes('repository') || basename.includes('migration')
    ) return 'data';

    // Utilities / helpers
    if (
      parts.some(p =>
        p === 'utils' || p === 'util' || p === 'helpers' || p === 'helper' ||
        p === 'shared' || p === 'common' || p === 'lib' || p === 'libs'
      ) ||
      basename.startsWith('util') || basename.startsWith('helper') ||
      basename.includes('utils') || basename.includes('helpers')
    ) return 'utils';

    // Core business logic
    if (
      parts.some(p => p === 'core' || p === 'domain' || p === 'services' || p === 'service') ||
      basename.includes('service') || basename.includes('engine') || basename.includes('manager')
    ) return 'core';

    // CLI / entry points
    if (
      basename === 'cli.ts' || basename === 'cli.js' ||
      basename === 'main.ts' || basename === 'main.js' ||
      basename === 'index.ts' || basename === 'index.js' ||
      parts.some(p => p === 'cli' || p === 'bin' || p === 'commands' || p === 'cmd') ||
      basename.includes('command') || basename.startsWith('cmd')
    ) return 'entry';

    return 'other';
  }

  /**
   * Layer labels surfaced in the UI (ordered from high-level entry points down
   * to foundational infrastructure).
   */
  private static readonly LAYER_LABELS: Record<FileRole, string> = {
    // Universal
    entry:      'Entry Points',
    config:     'Configuration',
    types:      'Types / Interfaces',
    shared:     'Shared / Utilities',
    test:       'Tests',
    docs:       'Documentation',
    other:      'Other',
    // Backend
    api:        'API / Routes',
    middleware: 'Middleware',
    service:    'Services / Use Cases',
    data:       'Data / Persistence',
    integration:'Integrations / SDKs',
    auth:       'Authentication / Security',
    // Frontend
    pages:      'Pages / Views',
    components: 'Components',
    state:      'State Management',
    hooks:      'Custom Hooks',
    styles:     'Styles / Themes',
    assets:     'Static Assets',
    // Tool/Library
    cli:        'CLI / Commands',
    core:       'Core Library Logic',
    parsers:    'Parsers / Translators',
    plugins:    'Plugins / Adapters',
    // Legacy aliases
    utils:      'Utilities',
    ui:         'UI / Frontend',
    exporters:  'Exporters',
    agents:     'Agents',
    frameworks: 'Frameworks',
    scripts:    'Scripts / Build',
  };

  private detectLayerClusters(
    repo: string,
    files: any[]
  ): { clusters: Cluster[]; memberships: { filePath: string; clusterName: string }[] } {
    const layerGroups = new Map<FileRole, string[]>();

    for (const f of files) {
      const filePath = f.path as string;
      const layer = (f.role as FileRole) || ClusterEngine.assignFileLayer(filePath);
      if (!layerGroups.has(layer)) {
        layerGroups.set(layer, []);
      }
      layerGroups.get(layer)!.push(filePath);
    }

    const clusters: Cluster[] = [];
    const memberships: { filePath: string; clusterName: string }[] = [];

    for (const [layer, filePaths] of layerGroups.entries()) {
      if (filePaths.length === 0) continue;
      const clusterName = `layer:${layer}`;
      clusters.push({
        name: clusterName,
        label: ClusterEngine.LAYER_LABELS[layer] || String(layer),
        source: 'layer',
        parentName: null,
        depth: 0,
        fileCount: filePaths.length,
        layer,
      });
      for (const fp of filePaths) {
        memberships.push({ filePath: fp, clusterName });
      }
    }

    return { clusters, memberships };
  }
}
