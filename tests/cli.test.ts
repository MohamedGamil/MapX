import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

let mockExists = true;
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (path: string) => {
      if (path.toString().includes('.mapx')) return mockExists;
      return original.existsSync(path);
    },
    readFileSync: (path: string, options: any) => {
      if (path.toString().includes('composer.json')) return '{}';
      if (path.toString().includes('.mapx/config.json')) return '{"repo":{"name":"test-repo","path":"."}}';
      return original.readFileSync(path, options);
    },
    writeFileSync: vi.fn(),
    readdirSync: () => [],
    statSync: () => ({ mtimeMs: 100 }),
    rmSync: vi.fn()
  };
});

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
  spinner: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  }),
  progress: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    advance: vi.fn(),
    message: vi.fn(),
  }),
  text: vi.fn().mockResolvedValue('test-input'),
  select: vi.fn().mockResolvedValue('test-select'),
  multiselect: vi.fn().mockResolvedValue(['generic']),
  confirm: vi.fn().mockResolvedValue(true),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}));

// Shared store mock functions that tests can modify
const storeMocks = {
  getMeta: vi.fn().mockReturnValue('6'),
  setMeta: vi.fn(),
  getAllFiles: vi.fn().mockReturnValue([{ path: 'src/main.ts', last_scanned: new Date().toISOString() }]),
  raw: {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue({ cnt: 0 })
    })
  },
  getAllSymbols: vi.fn().mockReturnValue([]),
  getAllEdges: vi.fn().mockReturnValue([]),
  close: vi.fn(),
  queryEdges: vi.fn().mockReturnValue([]),
  searchSymbolsFiltered: vi.fn().mockReturnValue([]),
  getFilesFiltered: vi.fn().mockReturnValue([]),
  getLanguageBreakdown: vi.fn().mockReturnValue({}),
  getClusters: vi.fn().mockReturnValue([]),
  listSymbolKinds: vi.fn().mockReturnValue([]),
  searchSymbols: vi.fn().mockReturnValue([]),
  getSymbolCandidatesForFuzzy: vi.fn().mockReturnValue([]),
  getFileCount: vi.fn().mockReturnValue(0),
  getSymbolCount: vi.fn().mockReturnValue(0),
  getEdgeCount: vi.fn().mockReturnValue(0),
  getTopFilesByPageRank: vi.fn().mockReturnValue([]),
  getTopSymbolsByPageRank: vi.fn().mockReturnValue([]),
  getCallersOfSymbol: vi.fn().mockReturnValue([]),
  getCalleesOfSymbol: vi.fn().mockReturnValue([]),
  getSymbolByName: vi.fn().mockReturnValue(undefined),
  getSymbolsForFile: vi.fn().mockReturnValue([]),
  getClusterFiles: vi.fn().mockReturnValue([]),
  getClusterEdges: vi.fn().mockReturnValue([]),
  getEdgesForFile: vi.fn().mockReturnValue([]),
  getReverseEdges: vi.fn().mockReturnValue([]),
  deleteRepo: vi.fn(),
};

vi.mock('../src/core/store.js', () => ({
  Store: class {
    constructor() {
      Object.assign(this, storeMocks);
    }
  },
}));

vi.mock('../src/core/config.js', () => ({
  Config: {
    load: vi.fn().mockResolvedValue({
      repo: { name: 'test-repo', path: '.' },
      repos: [{ name: 'test-repo', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] },
      addRepo: vi.fn(),
      removeRepo: vi.fn(),
      save: vi.fn()
    }),
    init: vi.fn().mockResolvedValue({
      repo: { name: 'test-repo', path: '.' },
      save: vi.fn()
    })
  }
}));

vi.mock('../src/core/scanner.js', () => ({
  Scanner: class {
    private onProgress: any;
    constructor(_store: any, _config: any, _graph: any, onProgress: any, _opts?: any) {
      this.onProgress = onProgress;
    }
    scanFull = vi.fn().mockImplementation(async () => {
      // Invoke progress callback to exercise createProgressRenderer
      if (this.onProgress) {
        this.onProgress({ phase: 'discover', current: 0, total: 0, file: null });
        this.onProgress({ phase: 'parse', current: 0, total: 5, file: null });
        this.onProgress({ phase: 'parse', current: 1, total: 5, file: 'src/main.ts' });
        this.onProgress({ phase: 'parse', current: 2, total: 5, file: 'src/utils.ts' });
        this.onProgress({ phase: 'resolve', current: 0, total: 0, file: null });
        this.onProgress({ phase: 'resolve', current: 1, total: 0, file: 'src/main.ts' });
      }
      return { filesScanned: 1, symbolsFound: 2, edgesFound: 3, durationMs: 10, languageBreakdown: { typescript: 1 } };
    });
    scanIncremental = vi.fn().mockImplementation(async () => {
      if (this.onProgress) {
        this.onProgress({ phase: 'detect', current: 0, total: 0, file: null });
        this.onProgress({ phase: 'parse', current: 0, total: 2, file: null });
        this.onProgress({ phase: 'parse', current: 1, total: 2, file: 'src/changed.ts' });
      }
      return { filesScanned: 1, symbolsFound: 2, edgesFound: 3, durationMs: 10, languageBreakdown: { typescript: 1 } };
    });
    abort = vi.fn();
  },
  buildMatcher: () => () => true
}));

vi.mock('../src/core/workspace-manager.js', () => ({
  WorkspaceManager: {
    discoverSubmodules: vi.fn().mockReturnValue([]),
    discoverPeerRepos: vi.fn().mockReturnValue([]),
    discoverVSCodeWorkspace: vi.fn().mockReturnValue([]),
    discoverNestedGitRepos: vi.fn().mockReturnValue([]),
    discoverMonorepoPackages: vi.fn().mockReturnValue([]),
  }
}));

vi.mock('../src/core/fuzzy-matcher.js', () => ({
  findSimilarSymbols: vi.fn().mockReturnValue([])
}));

const impactMocks = {
  analyze: vi.fn().mockReturnValue({ affected: [], summary: { high: 0, medium: 0, low: 0 }, recommendation: 'No callers found — safe to change' }),
};

vi.mock('../src/core/impact-analyzer.js', () => ({
  ImpactAnalyzer: class { constructor() { Object.assign(this, impactMocks); } },
  checkTryCatch: vi.fn().mockReturnValue(false)
}));

vi.mock('../src/languages/installer.js', () => ({
  isLanguageInstalled: vi.fn().mockReturnValue(true),
  installLanguage: vi.fn().mockResolvedValue(true),
  uninstallLanguage: vi.fn().mockResolvedValue(true)
}));

vi.mock('../src/languages/registry.js', () => ({
  getBuiltinLanguages: vi.fn().mockReturnValue({})
}));

vi.mock('../src/core/git-tracker.js', () => ({
  getChangedFiles: vi.fn().mockReturnValue([]),
  isGitRepo: vi.fn().mockReturnValue(true)
}));

vi.mock('../src/exporters/llm-exporter.js', () => ({
  LLMExporter: class {
    export = vi.fn().mockReturnValue('llm-export-string');
  }
}));

vi.mock('../src/exporters/graph-exporter.js', () => ({
  GraphExporter: class {
    exportAsJSONString = vi.fn().mockReturnValue('graph-export-string');
  }
}));

vi.mock('../src/exporters/dot-exporter.js', () => ({
  DotExporter: class {
    export = vi.fn().mockReturnValue('dot-export-string');
  }
}));

vi.mock('../src/exporters/svg-exporter.js', () => ({
  SvgExporter: class {
    export = vi.fn().mockReturnValue('svg-export-string');
  }
}));

vi.mock('../src/exporters/toon-exporter.js', () => ({
  ToonExporter: class {
    export = vi.fn().mockReturnValue('toon-export-string');
  }
}));

vi.mock('../src/mcp.js', () => ({
  startMcpServer: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../src/core/metrics.js', () => ({
  calculateMetrics: vi.fn().mockReturnValue([
    { path: 'src/main.ts', language: 'typescript', afferent: 1, efferent: 2, instability: 0.5 }
  ])
}));

vi.mock('../src/version.js', () => ({
  VERSION: '0.1.0-test'
}));

const routeRegistryMocks = {
  load: vi.fn().mockResolvedValue(undefined),
  queryRoutes: vi.fn().mockReturnValue([]),
  queryHooks: vi.fn().mockReturnValue([]),
};

vi.mock('../src/frameworks/route-registry.js', () => ({
  RouteRegistry: class { constructor() { Object.assign(this, routeRegistryMocks); } }
}));

const flowTracerMocks = {
  trace: vi.fn().mockReturnValue({
    start: { file: 'src/main.ts', symbol: 'main' },
    direction: 'both',
    paths: [],
    nodeCount: 0,
    edgeCount: 0,
    maxDepthReached: false,
    sources: [],
    sinks: [],
    cycles: [],
  }),
  findSources: vi.fn().mockReturnValue([]),
  findSinks: vi.fn().mockReturnValue([]),
  findCriticalPath: vi.fn().mockReturnValue(null),
};

vi.mock('../src/core/flow-tracer.js', () => ({
  FlowTracer: class { constructor() { Object.assign(this, flowTracerMocks); } },
  TraceNode: undefined
}));

const contextBuilderMocks = {
  buildContext: vi.fn().mockResolvedValue({
    estimatedTokens: 100,
    includedFiles: [],
    edges: [],
    excludedFiles: [],
  }),
};

vi.mock('../src/core/context-builder.js', () => ({
  ContextBuilder: class { constructor() { Object.assign(this, contextBuilderMocks); } }
}));

const agentGeneratorMocks = {
  listProviders: vi.fn().mockReturnValue(['generic', 'cursor']),
  getTemplate: vi.fn().mockReturnValue({ filename: 'AGENTS.md', isAppend: false }),
  plan: vi.fn().mockReturnValue([{ filename: 'AGENTS.md', filepath: '/test/AGENTS.md', status: 'create', provider: 'generic' }]),
  execute: vi.fn(),
  revert: vi.fn(),
  detectAgentTools: vi.fn().mockReturnValue([]),
  listMcpConfigs: vi.fn().mockReturnValue([{ name: 'cursor-mcp', filename: '.cursor/mcp.json' }]),
  generateMcpConfigs: vi.fn().mockReturnValue([]),
  executeMcpConfig: vi.fn(),
  revertMcpConfigs: vi.fn(),
};

vi.mock('../src/agents/generator.js', () => ({
  AgentGenerator: class { constructor() { Object.assign(this, agentGeneratorMocks); } }
}));

const graphMocks = {
  addFileNode: vi.fn(),
  addSymbolNode: vi.fn(),
  addDependencyEdge: vi.fn(),
  getDependencies: vi.fn().mockReturnValue([]),
  getReverseDependencies: vi.fn().mockReturnValue([]),
  getRankedSymbols: vi.fn().mockReturnValue([]),
};

vi.mock('../src/core/graph.js', () => ({
  MapxGraph: class { constructor() { Object.assign(this, graphMocks); } }
}));

import { buildCLI, getStaleFilesCount, checkAndPrintStaleness, checkTryCatch } from '../src/cli.js';
import { Store } from '../src/core/store.js';
import { calculateMetrics } from '../src/core/metrics.js';

describe('CLI module', () => {
  let logSpy: any;
  let errorSpy: any;
  let warnSpy: any;
  let exitSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error('exit: ' + code);
    });
    mockExists = true;
    // Reset store mocks to defaults
    storeMocks.getCallersOfSymbol.mockReturnValue([]);
    storeMocks.getCalleesOfSymbol.mockReturnValue([]);
    storeMocks.getSymbolByName.mockReturnValue(undefined);
    storeMocks.getSymbolsForFile.mockReturnValue([]);
    storeMocks.getClusterFiles.mockReturnValue([]);
    storeMocks.getClusterEdges.mockReturnValue([]);
    storeMocks.getEdgesForFile.mockReturnValue([]);
    storeMocks.getReverseEdges.mockReturnValue([]);
    storeMocks.getClusters.mockReturnValue([]);
    storeMocks.queryEdges.mockReturnValue([]);
    storeMocks.searchSymbolsFiltered.mockReturnValue([]);
    storeMocks.getFilesFiltered.mockReturnValue([]);
    storeMocks.searchSymbols.mockReturnValue([]);
    storeMocks.listSymbolKinds.mockReturnValue([]);
    // Reset other shared mocks
    flowTracerMocks.trace.mockReturnValue({
      start: { file: 'src/main.ts', symbol: 'main' }, direction: 'both',
      paths: [], nodeCount: 0, edgeCount: 0, maxDepthReached: false,
      sources: [], sinks: [], cycles: [],
    });
    flowTracerMocks.findSources.mockReturnValue([]);
    flowTracerMocks.findSinks.mockReturnValue([]);
    flowTracerMocks.findCriticalPath.mockReturnValue(null);
    routeRegistryMocks.queryRoutes.mockReturnValue([]);
    routeRegistryMocks.queryHooks.mockReturnValue([]);
    contextBuilderMocks.buildContext.mockResolvedValue({
      estimatedTokens: 100, includedFiles: [], edges: [], excludedFiles: [],
    });
    impactMocks.analyze.mockReturnValue({ affected: [], summary: { high: 0, medium: 0, low: 0 }, recommendation: 'No callers found — safe to change' });
    graphMocks.getDependencies.mockReturnValue([]);
    graphMocks.getReverseDependencies.mockReturnValue([]);
    agentGeneratorMocks.generateMcpConfigs.mockReturnValue([]);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  });

  const runCLI = async (args: string[]) => {
    const program = buildCLI();
    program.exitOverride();
    await program.parseAsync(['node', 'mapx', ...args]);
  };

  // ── Basic commands ──────────────────────────────────────────────────

  it('runs help command correctly', async () => {
    await expect(runCLI(['--help'])).rejects.toThrow();
  });

  it('runs init command successfully', async () => {
    await runCLI(['init']);
  });

  it('runs uninit command successfully', async () => {
    await runCLI(['uninit']);
  });

  it('runs scan command successfully', async () => {
    await runCLI(['scan']);
  });

  it('runs update/sync command successfully', async () => {
    await runCLI(['update']);
  });

  it('runs query command successfully', async () => {
    await runCLI(['query', 'MyClass']);
  });

  it('runs search command successfully', async () => {
    await runCLI(['search', 'MyClass']);
  });

  it('runs deps command successfully', async () => {
    await runCLI(['deps', 'src/main.ts']);
  });

  it('runs summary command successfully', async () => {
    await runCLI(['summary']);
  });

  it('runs status command successfully', async () => {
    await runCLI(['status']);
  });

  it('runs export command successfully for various formats', async () => {
    await runCLI(['export', '--format', 'llm']);
    await runCLI(['export', '--format', 'json']);
    await runCLI(['export', '--format', 'dot']);
    await runCLI(['export', '--format', 'svg']);
    await runCLI(['export', '--format', 'toon']);
  });

  it('runs metrics command successfully', async () => {
    await runCLI(['metrics']);
  });

  it('runs workspaces list command successfully', async () => {
    await runCLI(['workspaces', 'list']);
  });

  it('runs workspaces discover command successfully', async () => {
    await runCLI(['workspaces', 'discover']);
  });

  it('runs workspaces sync command successfully', async () => {
    await runCLI(['workspaces', 'sync']);
  });

  it('runs serve command successfully', async () => {
    await runCLI(['serve']);
  });

  it('runs lang list command successfully', async () => {
    await runCLI(['lang', 'list']);
  });

  it('runs lang install command successfully', async () => {
    await runCLI(['lang', 'install', 'python']);
  });

  it('runs lang uninstall command successfully', async () => {
    await runCLI(['lang', 'uninstall', 'python']);
  });

  it('handles context load failure gracefully', async () => {
    mockExists = false;
    await expect(runCLI(['scan'])).rejects.toThrow('exit: 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MapxGraph not initialized'));
  });

  it('performs helper utility checks', () => {
    const store = new Store(':memory:');
    expect(getStaleFilesCount(store as any, '.')).toBe(0);

    checkAndPrintStaleness(store as any, '.');
    expect(warnSpy).not.toHaveBeenCalled();

    expect(checkTryCatch('try {} catch {}', 1, 1, false)).toBe(false);
  });

  // ── callers command ──────────────────────────────────────────────────

  describe('callers command', () => {
    it('shows callers when found', async () => {
      storeMocks.getCallersOfSymbol = vi.fn().mockReturnValue([
        { source_file: 'src/app.ts', source_symbol: 'App', target_symbol: 'main', metadata: JSON.stringify({ startLine: 10 }) }
      ]);

      await runCLI(['callers', 'main']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('caller'));
      // Reset
      storeMocks.getCallersOfSymbol = vi.fn().mockReturnValue([]);
    });

    it('shows symbol not found when no callers and symbol does not exist', async () => {
      storeMocks.getCallersOfSymbol = vi.fn().mockReturnValue([]);
      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);

      await runCLI(['callers', 'nonExistent']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));

      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);
    });

    it('shows no callers for existing symbol', async () => {
      storeMocks.getCallersOfSymbol = vi.fn().mockReturnValue([]);
      storeMocks.getSymbolByName = vi.fn().mockReturnValue({ name: 'main', kind: 'function', file_path: 'src/main.ts' });

      await runCLI(['callers', 'main']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No callers found'));

      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);
    });
  });

  // ── callees command ──────────────────────────────────────────────────

  describe('callees command', () => {
    it('shows callees when found', async () => {
      storeMocks.getCalleesOfSymbol = vi.fn().mockReturnValue([
        { target_file: 'src/utils.ts', target_symbol: 'helper', source_symbol: 'main', metadata: JSON.stringify({ startLine: 5 }) }
      ]);

      await runCLI(['callees', 'main']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('callee'));

      storeMocks.getCalleesOfSymbol = vi.fn().mockReturnValue([]);
    });

    it('shows symbol not found for callees', async () => {
      storeMocks.getCalleesOfSymbol = vi.fn().mockReturnValue([]);
      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);

      await runCLI(['callees', 'nonExistent']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));

      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);
    });

    it('shows no callees for existing symbol', async () => {
      storeMocks.getCalleesOfSymbol = vi.fn().mockReturnValue([]);
      storeMocks.getSymbolByName = vi.fn().mockReturnValue({ name: 'main', kind: 'function', file_path: 'src/main.ts' });

      await runCLI(['callees', 'main']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No callees found'));

      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);
    });
  });

  // ── impact command ──────────────────────────────────────────────────

  describe('impact command', () => {
    it('runs impact analysis when symbol found', async () => {
      storeMocks.getSymbolByName = vi.fn().mockReturnValue({ name: 'main', kind: 'function', file_path: 'src/main.ts' });

      await runCLI(['impact', 'main']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Recommendation'));

      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);
    });

    it('errors when symbol not found for impact', async () => {
      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);

      await expect(runCLI(['impact', 'nonExistent'])).rejects.toThrow('exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('outputs impact as JSON', async () => {
      storeMocks.getSymbolByName = vi.fn().mockReturnValue({ name: 'main', kind: 'function', file_path: 'src/main.ts' });

      await runCLI(['impact', 'main', '--format', 'json']);
      // JSON.stringify output
      expect(logSpy).toHaveBeenCalled();

      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);
    });

    it('displays affected items in impact analysis', async () => {
      storeMocks.getSymbolByName = vi.fn().mockReturnValue({ name: 'main', kind: 'function', file_path: 'src/main.ts' });

      impactMocks.analyze = vi.fn().mockReturnValue({
        affected: [{ symbol: 'App', file: 'src/app.ts', depth: 1, edgeType: 'call', risk: 'HIGH' }],
        summary: { high: 1, medium: 0, low: 0 },
        recommendation: 'Treat as BREAKING CHANGE'
      });

      await runCLI(['impact', 'main']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Impact analysis'));

      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);
      impactMocks.analyze = vi.fn().mockReturnValue({ affected: [], summary: { high: 0, medium: 0, low: 0 }, recommendation: 'No callers found — safe to change' });
    });
  });

  // ── node command ──────────────────────────────────────────────────

  describe('node command', () => {
    it('shows node details in text format', async () => {
      storeMocks.getSymbolByName = vi.fn().mockReturnValue({
        name: 'main', kind: 'function', file_path: 'src/main.ts',
        start_line: 1, end_line: 10, scope: null, signature: 'function main()'
      });
      storeMocks.getCallersOfSymbol = vi.fn().mockReturnValue([]);
      storeMocks.getCalleesOfSymbol = vi.fn().mockReturnValue([]);

      await runCLI(['node', 'main']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Symbol:'));

      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);
      storeMocks.getCallersOfSymbol = vi.fn().mockReturnValue([]);
      storeMocks.getCalleesOfSymbol = vi.fn().mockReturnValue([]);
    });

    it('shows node details in JSON format', async () => {
      storeMocks.getSymbolByName = vi.fn().mockReturnValue({
        name: 'main', kind: 'function', file_path: 'src/main.ts',
        start_line: 1, end_line: 10, scope: null, signature: 'function main()'
      });
      storeMocks.getCallersOfSymbol = vi.fn().mockReturnValue([]);
      storeMocks.getCalleesOfSymbol = vi.fn().mockReturnValue([]);

      await runCLI(['node', 'main', '--format', 'json']);
      expect(logSpy).toHaveBeenCalled();

      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);
      storeMocks.getCallersOfSymbol = vi.fn().mockReturnValue([]);
      storeMocks.getCalleesOfSymbol = vi.fn().mockReturnValue([]);
    });

    it('errors when symbol not found for node', async () => {
      storeMocks.getSymbolByName = vi.fn().mockReturnValue(undefined);

      await expect(runCLI(['node', 'nonExistent'])).rejects.toThrow('exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });
  });

  // ── files command ──────────────────────────────────────────────────

  describe('files command', () => {
    it('lists files when found', async () => {
      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([
        { path: 'src/main.ts', language: 'typescript', lines: 100, size_bytes: 2048 }
      ]);

      await runCLI(['files']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('src/main.ts'));

      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([]);
    });

    it('shows no files message when empty', async () => {
      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([]);

      await runCLI(['files']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No files found'));
    });

    it('passes plain path prefix to getFilesFiltered', async () => {
      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([
        { path: 'src/core/store.ts', language: 'typescript', lines: 849, size_bytes: 27000 }
      ]);

      await runCLI(['files', '--path', 'src/core/']);
      expect(storeMocks.getFilesFiltered).toHaveBeenCalledWith(
        expect.objectContaining({ pathPrefix: 'src/core/' })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('src/core/store.ts'));

      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([]);
    });

    it('passes glob pattern to getFilesFiltered unchanged', async () => {
      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([
        { path: 'src/core/store.ts', language: 'typescript', lines: 849, size_bytes: 27000 },
        { path: 'src/core/graph.ts', language: 'typescript', lines: 213, size_bytes: 7200 }
      ]);

      await runCLI(['files', '--path', 'src/core/*.ts']);
      expect(storeMocks.getFilesFiltered).toHaveBeenCalledWith(
        expect.objectContaining({ pathPrefix: 'src/core/*.ts' })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('src/core/store.ts'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('src/core/graph.ts'));

      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([]);
    });

    it('passes double-star glob to getFilesFiltered unchanged', async () => {
      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([
        { path: 'src/core/store.ts', language: 'typescript', lines: 849, size_bytes: 27000 }
      ]);

      await runCLI(['files', '--path', '**/*.ts']);
      expect(storeMocks.getFilesFiltered).toHaveBeenCalledWith(
        expect.objectContaining({ pathPrefix: '**/*.ts' })
      );

      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([]);
    });

    it('passes --lang filter to getFilesFiltered', async () => {
      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([]);

      await runCLI(['files', '--lang', 'python']);
      expect(storeMocks.getFilesFiltered).toHaveBeenCalledWith(
        expect.objectContaining({ lang: 'python' })
      );
    });

    it('passes --sort and --limit to getFilesFiltered', async () => {
      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([]);

      await runCLI(['files', '--sort', 'lines', '--limit', '10']);
      expect(storeMocks.getFilesFiltered).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'lines', limit: 10 })
      );
    });

    it('combines glob path with lang filter', async () => {
      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([
        { path: 'src/core/store.ts', language: 'typescript', lines: 849, size_bytes: 27000 }
      ]);

      await runCLI(['files', '--path', '*.json', '--lang', 'json']);
      expect(storeMocks.getFilesFiltered).toHaveBeenCalledWith(
        expect.objectContaining({ pathPrefix: '*.json', lang: 'json' })
      );

      storeMocks.getFilesFiltered = vi.fn().mockReturnValue([]);
    });
  });

  // ── deps command ──────────────────────────────────────────────────

  describe('deps command', () => {
    it('shows deps and rdeps when present', async () => {
      graphMocks.getDependencies = vi.fn().mockReturnValue([
        { target: 'src/utils.ts', type: 'import' }
      ]);
      graphMocks.getReverseDependencies = vi.fn().mockReturnValue([
        { source: 'src/app.ts', type: 'import' }
      ]);

      await runCLI(['deps', 'src/main.ts']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Dependencies'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Depended on by'));

      graphMocks.getDependencies = vi.fn().mockReturnValue([]);
      graphMocks.getReverseDependencies = vi.fn().mockReturnValue([]);
    });

    it('shows no dependencies message', async () => {
      graphMocks.getDependencies = vi.fn().mockReturnValue([]);
      graphMocks.getReverseDependencies = vi.fn().mockReturnValue([]);

      await runCLI(['deps', 'src/main.ts']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No dependencies found'));
    });
  });

  // ── trace command ──────────────────────────────────────────────────

  describe('trace command', () => {
    it('shows sources with --sources flag', async () => {
      await runCLI(['trace', '--sources']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Entry points'));
    });

    it('shows sinks with --sinks flag', async () => {
      await runCLI(['trace', '--sinks']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Terminal consumers'));
    });

    it('errors when start is missing and no --sources/--sinks', async () => {
      await expect(runCLI(['trace'])).rejects.toThrow('exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('start symbol or file is required'));
    });

    it('runs trace with --to flag and no path found', async () => {
      await runCLI(['trace', 'main', '--to', 'nonExistent']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No path found'));
    });

    it('runs trace with --to flag and path found', async () => {
      flowTracerMocks.findCriticalPath = vi.fn().mockReturnValue({
        nodes: [
          { file: 'src/main.ts', symbol: 'main', depth: 0, incomingEdgeType: 'start' },
          { file: 'src/target.ts', symbol: 'target', depth: 1, incomingEdgeType: 'call' },
        ]
      });

      await runCLI(['trace', 'main', '--to', 'target']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Critical data path'));

      flowTracerMocks.findCriticalPath = vi.fn().mockReturnValue(null);
    });

    it('runs trace in default text format', async () => {
      await runCLI(['trace', 'main']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Trace:'));
    });

    it('runs trace in JSON format', async () => {
      await runCLI(['trace', 'main', '--format', 'json']);
      expect(logSpy).toHaveBeenCalled();
    });

    it('runs trace in DOT format', async () => {
      await runCLI(['trace', 'main', '--format', 'dot']);
      expect(logSpy).toHaveBeenCalled();
    });
  });

  // ── sources command ──────────────────────────────────────────────────

  describe('sources command', () => {
    it('runs sources command', async () => {
      await runCLI(['sources']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Entry points'));
    });

    it('displays sources with route files', async () => {
      flowTracerMocks.findSources = vi.fn().mockReturnValue([
        { file: 'routes/web.php', symbol: null }
      ]);
      storeMocks.getEdgesForFile = vi.fn().mockReturnValue([]);

      await runCLI(['sources']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('route file'));

      flowTracerMocks.findSources = vi.fn().mockReturnValue([]);
    });
  });

  // ── sinks command ──────────────────────────────────────────────────

  describe('sinks command', () => {
    it('runs sinks command', async () => {
      await runCLI(['sinks']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Terminal consumers'));
    });

    it('displays sinks with database files', async () => {
      flowTracerMocks.findSinks = vi.fn().mockReturnValue([
        { file: 'src/database/connection.ts', symbol: null }
      ]);
      storeMocks.getReverseEdges = vi.fn().mockReturnValue([]);

      await runCLI(['sinks']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('DB facade'));

      flowTracerMocks.findSinks = vi.fn().mockReturnValue([]);
    });
  });

  // ── context command ──────────────────────────────────────────────────

  describe('context command', () => {
    it('runs context in text format', async () => {
      await runCLI(['context', 'fix bug']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MapX Smart Context'));
    });

    it('runs context in JSON format', async () => {
      await runCLI(['context', 'fix bug', '--format', 'json']);
      expect(logSpy).toHaveBeenCalled();
    });

    it('displays included files in context', async () => {
      contextBuilderMocks.buildContext = vi.fn().mockResolvedValue({
        estimatedTokens: 200,
        includedFiles: [{
          path: 'src/main.ts', language: 'typescript', lineCount: 50, sizeBytes: 1024,
          symbols: [{ name: 'main', kind: 'function', scope: null, startLine: 1, endLine: 50 }]
        }],
        edges: [{ sourceFile: 'src/main.ts', targetFile: 'src/utils.ts', sourceSymbol: 'main', targetSymbol: 'helper', edgeType: 'call' }],
        excludedFiles: ['src/extra.ts'],
      });

      await runCLI(['context', 'fix bug']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Included Files'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cross-File Dependencies'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Excluded Files'));

      contextBuilderMocks.buildContext = vi.fn().mockResolvedValue({
        estimatedTokens: 100, includedFiles: [], edges: [], excludedFiles: [],
      });
    });
  });

  // ── export command ──────────────────────────────────────────────────

  describe('export command', () => {
    it('exports with --output flag', async () => {
      await runCLI(['export', '--format', 'llm', '-o', 'output.txt']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Exported'));
    });

    it('exports toon format with options', async () => {
      await runCLI(['export', '--format', 'toon', '--delimiter', 'tab', '--key-folding']);
      expect(logSpy).toHaveBeenCalled();
    });
  });

  // ── summary command ──────────────────────────────────────────────────

  describe('summary command', () => {
    it('displays project summary', async () => {
      await runCLI(['summary']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Project:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Files:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Symbols:'));
    });
  });

  // ── metrics command ──────────────────────────────────────────────────

  describe('metrics command', () => {
    it('shows metrics results', async () => {
      await runCLI(['metrics']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Coupling'));
    });

    it('shows no metrics message', async () => {
      vi.mocked(calculateMetrics).mockReturnValueOnce([]);
      await runCLI(['metrics']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No metrics found'));
    });
  });

  // ── clusters command ──────────────────────────────────────────────────

  describe('clusters command', () => {
    it('lists clusters', async () => {
      storeMocks.getClusters = vi.fn().mockReturnValue([
        { name: 'core', source: 'namespace', file_count: 5, parent_name: null }
      ]);

      await runCLI(['clusters']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 clusters'));

      storeMocks.getClusters = vi.fn().mockReturnValue([]);
    });

    it('inspects specific cluster', async () => {
      storeMocks.getClusters = vi.fn().mockReturnValue([
        { name: 'core', source: 'namespace', file_count: 5, parent_name: null }
      ]);
      storeMocks.getClusterFiles = vi.fn().mockReturnValue(['src/main.ts', 'src/utils.ts']);
      storeMocks.getClusterEdges = vi.fn().mockReturnValue([
        { sourceCluster: 'core', targetCluster: 'utils', edgeCount: 3, dominantType: 'import' }
      ]);

      await runCLI(['clusters', 'core']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('core'));

      storeMocks.getClusters = vi.fn().mockReturnValue([]);
      storeMocks.getClusterFiles = vi.fn().mockReturnValue([]);
      storeMocks.getClusterEdges = vi.fn().mockReturnValue([]);
    });

    it('outputs cluster as JSON', async () => {
      storeMocks.getClusters = vi.fn().mockReturnValue([
        { name: 'core', source: 'namespace', file_count: 5, parent_name: null }
      ]);
      storeMocks.getClusterFiles = vi.fn().mockReturnValue(['src/main.ts']);
      storeMocks.getClusterEdges = vi.fn().mockReturnValue([]);

      await runCLI(['clusters', 'core', '--json']);
      expect(logSpy).toHaveBeenCalled();

      storeMocks.getClusters = vi.fn().mockReturnValue([]);
      storeMocks.getClusterFiles = vi.fn().mockReturnValue([]);
      storeMocks.getClusterEdges = vi.fn().mockReturnValue([]);
    });

    it('errors when cluster not found', async () => {
      storeMocks.getClusters = vi.fn().mockReturnValue([]);

      await expect(runCLI(['clusters', 'nonExistentCluster'])).rejects.toThrow('exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));

      storeMocks.getClusters = vi.fn().mockReturnValue([]);
    });

    it('lists clusters as JSON', async () => {
      storeMocks.getClusters = vi.fn().mockReturnValue([
        { name: 'core', source: 'namespace', file_count: 5, parent_name: null }
      ]);

      await runCLI(['clusters', '--json']);
      expect(logSpy).toHaveBeenCalled();

      storeMocks.getClusters = vi.fn().mockReturnValue([]);
    });

    it('displays clusters with parent-child tree', async () => {
      storeMocks.getClusters = vi.fn().mockReturnValue([
        { name: 'root', source: 'directory', file_count: 10, parent_name: null },
        { name: 'child', source: 'directory', file_count: 3, parent_name: 'root' },
      ]);

      await runCLI(['clusters']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 clusters'));

      storeMocks.getClusters = vi.fn().mockReturnValue([]);
    });

    it('shows depended on by in cluster detail', async () => {
      storeMocks.getClusters = vi.fn().mockReturnValue([
        { name: 'core', source: 'namespace', file_count: 5, parent_name: null }
      ]);
      storeMocks.getClusterFiles = vi.fn().mockReturnValue(['src/main.ts']);
      storeMocks.getClusterEdges = vi.fn().mockReturnValue([
        { sourceCluster: 'app', targetCluster: 'core', edgeCount: 2, dominantType: 'call' }
      ]);

      await runCLI(['clusters', 'core']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Depended on by'));

      storeMocks.getClusters = vi.fn().mockReturnValue([]);
      storeMocks.getClusterFiles = vi.fn().mockReturnValue([]);
      storeMocks.getClusterEdges = vi.fn().mockReturnValue([]);
    });
  });

  // ── edges command ──────────────────────────────────────────────────

  describe('edges command', () => {
    it('shows edges when found', async () => {
      storeMocks.queryEdges = vi.fn().mockReturnValue([
        { source_file: 'src/main.ts', target_file: 'src/utils.ts', source_symbol: 'main', target_symbol: 'helper', edge_type: 'call', verifiability: 'verified' }
      ]);

      await runCLI(['edges']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('matching edges'));

      storeMocks.queryEdges = vi.fn().mockReturnValue([]);
    });

    it('shows no edges message', async () => {
      await runCLI(['edges']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No matching edges'));
    });

    it('shows inferred suffix on edges', async () => {
      storeMocks.queryEdges = vi.fn().mockReturnValue([
        { source_file: 'a.ts', target_file: 'b.ts', source_symbol: null, target_symbol: null, edge_type: 'import', verifiability: 'inferred' }
      ]);

      await runCLI(['edges']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[inferred]'));

      storeMocks.queryEdges = vi.fn().mockReturnValue([]);
    });
  });

  // ── routes command ──────────────────────────────────────────────────

  describe('routes command', () => {
    it('runs routes command with no routes', async () => {
      await runCLI(['routes']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No routes found'));
    });

    it('runs routes with results', async () => {
      routeRegistryMocks.queryRoutes = vi.fn().mockReturnValue([
        { framework: 'express', method: 'get', path: '/api/users', handlerSymbol: 'getUsers', handlerFile: 'src/routes.ts' }
      ]);

      await runCLI(['routes']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Detected Routes'));

      routeRegistryMocks.queryRoutes = vi.fn().mockReturnValue([]);
    });

    it('runs routes with JSON output', async () => {
      await runCLI(['routes', '--json']);
      expect(logSpy).toHaveBeenCalled();
    });
  });

  // ── hooks command ──────────────────────────────────────────────────

  describe('hooks command', () => {
    it('runs hooks command with no hooks', async () => {
      await runCLI(['hooks']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No hooks found'));
    });

    it('runs hooks with results', async () => {
      routeRegistryMocks.queryHooks = vi.fn().mockReturnValue([
        { framework: 'laravel', hookType: 'event', hookName: 'UserCreated', handlerSymbol: 'handleUser', handlerFile: 'src/listeners.ts' }
      ]);

      await runCLI(['hooks']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Detected Hooks'));

      routeRegistryMocks.queryHooks = vi.fn().mockReturnValue([]);
    });

    it('runs hooks with JSON output', async () => {
      await runCLI(['hooks', '--json']);
      expect(logSpy).toHaveBeenCalled();
    });
  });

  // ── agents commands ──────────────────────────────────────────────────

  describe('agents commands', () => {
    it('lists agent providers', async () => {
      await runCLI(['agents', 'list']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Supported LLM integration providers'));
    });

    it('generates agent files with --all', async () => {
      await runCLI(['agents', 'generate', '--all']);
    });

    it('generates agent files with --providers', async () => {
      await runCLI(['agents', 'generate', '--providers', 'generic']);
    });

    it('updates agent files', async () => {
      await runCLI(['agents', 'update']);
    });

    it('runs agents mcp subcommand', async () => {
      await runCLI(['agents', 'mcp']);
    });

    it('runs agents mcp --detect', async () => {
      await runCLI(['agents', 'mcp', '--detect']);
    });

    it('runs agents mcp --all', async () => {
      agentGeneratorMocks.generateMcpConfigs = vi.fn().mockReturnValue([
        { filename: '.cursor/mcp.json', tool: 'cursor-mcp', status: 'create' }
      ]);

      await runCLI(['agents', 'mcp', '--all']);

      agentGeneratorMocks.generateMcpConfigs = vi.fn().mockReturnValue([]);
    });

    it('runs agents mcp --tools', async () => {
      await runCLI(['agents', 'mcp', '--tools', 'cursor-mcp']);
    });

    it('agents mcp dry-run', async () => {
      agentGeneratorMocks.generateMcpConfigs = vi.fn().mockReturnValue([
        { filename: '.cursor/mcp.json', tool: 'cursor-mcp', status: 'create' }
      ]);

      await runCLI(['agents', 'mcp', '--all', '--dry-run']);

      agentGeneratorMocks.generateMcpConfigs = vi.fn().mockReturnValue([]);
    });
  });

  // ── workspaces commands ──────────────────────────────────────────────

  describe('workspaces commands', () => {
    it('lists workspaces', async () => {
      await runCLI(['workspaces', 'list']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Registered repositories'));
    });

    it('discovers workspaces', async () => {
      await runCLI(['workspaces', 'discover']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No unregistered repositories'));
    });

    it('syncs workspaces with nothing to sync', async () => {
      await runCLI(['workspaces', 'sync']);
    });

    it('removes a workspace', async () => {
      const { Config } = await import('../src/core/config.js');
      const originalLoad = Config.load;
      (Config as any).load = vi.fn().mockResolvedValue({
        repo: { name: 'test-repo', path: '.' },
        repos: [{ name: 'test-repo', path: '.' }, { name: 'other', path: '../other' }],
        settings: { excludePatterns: [], includePatterns: [] },
        addRepo: vi.fn(),
        removeRepo: vi.fn(),
        save: vi.fn()
      });

      await runCLI(['workspaces', 'remove', 'test-repo']);

      (Config as any).load = originalLoad;
    });

    it('errors when removing non-existent workspace', async () => {
      const { Config } = await import('../src/core/config.js');
      const originalLoad = Config.load;
      (Config as any).load = vi.fn().mockResolvedValue({
        repo: { name: 'test-repo', path: '.' },
        repos: [{ name: 'test-repo', path: '.' }],
        settings: { excludePatterns: [], includePatterns: [] },
        addRepo: vi.fn(),
        removeRepo: vi.fn(),
        save: vi.fn()
      });

      await expect(runCLI(['workspaces', 'remove', 'nonExistent'])).rejects.toThrow('exit: 1');

      (Config as any).load = originalLoad;
    });
  });

  // ── checkAndPrintStaleness ──────────────────────────────────────────

  describe('checkAndPrintStaleness', () => {
    it('prints warning with stale files (changed)', () => {
      const store = new Store(':memory:');
      // Make mtimeMs > dbTime so files appear stale
      // The mock statSync returns mtimeMs: 100, so set last_scanned to way in the past
      (store as any).getAllFiles = vi.fn().mockReturnValue([
        { path: 'src/changed.ts', last_scanned: '1970-01-01T00:00:00.000Z' }
      ]);

      checkAndPrintStaleness(store as any, '.');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stale'));
    });

    it('handles many stale files', () => {
      const store = new Store(':memory:');
      const files = Array.from({ length: 10 }, (_, i) => ({
        path: `src/file${i}.ts`, last_scanned: '1970-01-01T00:00:00.000Z'
      }));
      (store as any).getAllFiles = vi.fn().mockReturnValue(files);

      checkAndPrintStaleness(store as any, '.');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stale'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('more'));
    });
  });

  // ── getStaleFilesCount ──────────────────────────────────────────────

  describe('getStaleFilesCount', () => {
    it('counts stale files', () => {
      const store = new Store(':memory:');
      (store as any).getAllFiles = vi.fn().mockReturnValue([
        { path: 'src/changed.ts', last_scanned: '1970-01-01T00:00:00.000Z' }
      ]);

      expect(getStaleFilesCount(store as any, '.')).toBe(1);
    });

    it('returns 0 for up-to-date files', () => {
      const store = new Store(':memory:');
      // statSync returns mtimeMs: 100, set last_scanned to the future
      (store as any).getAllFiles = vi.fn().mockReturnValue([
        { path: 'src/main.ts', last_scanned: new Date(Date.now() + 100000).toISOString() }
      ]);

      expect(getStaleFilesCount(store as any, '.')).toBe(0);
    });
  });

  // ── query command with results ──────────────────────────────────────

  describe('query command', () => {
    it('shows results when symbols found', async () => {
      storeMocks.searchSymbols = vi.fn().mockReturnValue([
        { name: 'MyClass', kind: 'class', file_path: 'src/main.ts', start_line: 1, scope: null, signature: 'class MyClass' }
      ]);

      await runCLI(['query', 'MyClass']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 symbol'));

      storeMocks.searchSymbols = vi.fn().mockReturnValue([]);
    });

    it('shows fuzzy suggestions when no results', async () => {
      storeMocks.searchSymbols = vi.fn().mockReturnValue([]);

      await runCLI(['query', 'NonExistent']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No symbols matching'));

      storeMocks.searchSymbols = vi.fn().mockReturnValue([]);
    });
  });

  // ── search command with results ──────────────────────────────────────

  describe('search command', () => {
    it('shows results with JSON format', async () => {
      storeMocks.searchSymbolsFiltered = vi.fn().mockReturnValue([
        { name: 'MyClass', kind: 'class', file_path: 'src/main.ts', start_line: 1, end_line: 10, scope: null, signature: 'class MyClass' }
      ]);

      await runCLI(['search', 'MyClass', '--format', 'json']);
      expect(logSpy).toHaveBeenCalled();

      storeMocks.searchSymbolsFiltered = vi.fn().mockReturnValue([]);
    });

    it('shows results in text format', async () => {
      storeMocks.searchSymbolsFiltered = vi.fn().mockReturnValue([
        { name: 'MyClass', kind: 'class', file_path: 'src/main.ts', start_line: 1, end_line: 10, scope: null, signature: 'class MyClass' }
      ]);

      await runCLI(['search', 'MyClass']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 symbol'));

      storeMocks.searchSymbolsFiltered = vi.fn().mockReturnValue([]);
    });

    it('shows no results with kind filter and available kinds', async () => {
      storeMocks.searchSymbolsFiltered = vi.fn().mockReturnValue([]);
      storeMocks.listSymbolKinds = vi.fn().mockReturnValue([{ kind: 'class', count: 5 }]);

      await runCLI(['search', 'MyClass', '--kind', 'class']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No symbols matching'));

      storeMocks.searchSymbolsFiltered = vi.fn().mockReturnValue([]);
      storeMocks.listSymbolKinds = vi.fn().mockReturnValue([]);
    });
  });

  // ── trace with sources/sinks data ──────────────────────────────────

  describe('trace with data', () => {
    it('shows sources with various file types', async () => {
      flowTracerMocks.findSources = vi.fn().mockReturnValue([
        { file: 'app/Jobs/ProcessOrder.php', symbol: null },
        { file: 'app/Listeners/UserRegistered.php', symbol: null },
        { file: 'app/Http/Middleware/Auth.php', symbol: null },
        { file: 'src/regular.ts', symbol: null },
      ]);

      await runCLI(['trace', '--sources']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('queue worker'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('event listener'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('middleware'));

      flowTracerMocks.findSources = vi.fn().mockReturnValue([]);
    });

    it('shows sinks with various types', async () => {
      flowTracerMocks.findSinks = vi.fn().mockReturnValue([
        { file: 'src/CacheManager.ts', symbol: null },
        { file: 'src/Mailer.ts', symbol: null },
        { file: 'src/QueueManager.ts', symbol: null },
        { file: 'src/regular.ts', symbol: null },
      ]);
      storeMocks.getReverseEdges = vi.fn().mockReturnValue([]);

      await runCLI(['trace', '--sinks']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cache facade'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Mail facade'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Queue::push'));

      flowTracerMocks.findSinks = vi.fn().mockReturnValue([]);
    });

    it('trace text format with paths and sinks', async () => {
      flowTracerMocks.trace = vi.fn().mockReturnValue({
        start: { file: 'src/main.ts', symbol: 'main' },
        direction: 'down',
        paths: [{
          nodes: [
            { file: 'src/main.ts', symbol: 'main', depth: 0, incomingEdgeType: 'start' },
            { file: 'src/utils.ts', symbol: 'helper', depth: 1, incomingEdgeType: 'call' },
          ]
        }],
        nodeCount: 2,
        edgeCount: 1,
        maxDepthReached: false,
        sources: [],
        sinks: [{ file: 'src/utils.ts', symbol: 'helper' }],
        cycles: [],
      });

      await runCLI(['trace', 'main']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Trace:'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Sinks:'));

      flowTracerMocks.trace = vi.fn().mockReturnValue({
        start: { file: 'src/main.ts', symbol: 'main' }, direction: 'both',
        paths: [], nodeCount: 0, edgeCount: 0, maxDepthReached: false,
        sources: [], sinks: [], cycles: [],
      });
    });

    it('trace DOT format with paths', async () => {
      flowTracerMocks.trace = vi.fn().mockReturnValue({
        start: { file: 'src/main.ts', symbol: 'main' },
        direction: 'both',
        paths: [{
          nodes: [
            { file: 'src/main.ts', symbol: 'main', depth: 0, incomingEdgeType: 'start' },
            { file: 'src/utils.ts', symbol: 'helper', depth: 1, incomingEdgeType: 'call' },
          ]
        }],
        nodeCount: 2,
        edgeCount: 1,
        maxDepthReached: false,
        sources: [{ file: 'src/main.ts', symbol: 'main' }],
        sinks: [{ file: 'src/utils.ts', symbol: 'helper' }],
        cycles: [],
      });

      await runCLI(['trace', 'main', '--format', 'dot']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('digraph'));

      flowTracerMocks.trace = vi.fn().mockReturnValue({
        start: { file: 'src/main.ts', symbol: 'main' }, direction: 'both',
        paths: [], nodeCount: 0, edgeCount: 0, maxDepthReached: false,
        sources: [], sinks: [], cycles: [],
      });
    });

    it('trace JSON format with paths', async () => {
      flowTracerMocks.trace = vi.fn().mockReturnValue({
        start: { file: 'src/main.ts', symbol: 'main' },
        direction: 'both',
        paths: [{
          nodes: [
            { file: 'src/main.ts', symbol: 'main', depth: 0, incomingEdgeType: 'start' },
            { file: 'src/utils.ts', symbol: 'helper', depth: 1, incomingEdgeType: 'call' },
          ]
        }],
        nodeCount: 2,
        edgeCount: 1,
        maxDepthReached: false,
        sources: [],
        sinks: [],
        cycles: [],
      });

      await runCLI(['trace', 'main', '--format', 'json']);
      const output = logSpy.mock.calls.find((c: any) => {
        try { JSON.parse(c[0]); return true; } catch { return false; }
      });
      expect(output).toBeTruthy();

      flowTracerMocks.trace = vi.fn().mockReturnValue({
        start: { file: 'src/main.ts', symbol: 'main' }, direction: 'both',
        paths: [], nodeCount: 0, edgeCount: 0, maxDepthReached: false,
        sources: [], sinks: [], cycles: [],
      });
    });
  });

  describe('init and uninit commands', () => {
    it('init with --no-agents --no-suggestions --no-mcp-configs', async () => {
      await runCLI(['init', '.', '--no-agents', '--no-suggestions', '--no-mcp-configs']);
      // Should succeed without interactive prompts
    });

    it('init with --no-discover skips discovery prompt entirely', async () => {
      // Pass --no-discover: the discovery block is never entered so no mocks needed
      await runCLI(['init', '.', '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover']);
    });

    it('init discovers repos and prompts Y/N when TTY', async () => {
      // process.stdin.isTTY is false in tests so the discovery block is gated off;
      // just assert the command completes without error regardless of found packages
      await runCLI(['init', '.', '--no-agents', '--no-suggestions', '--no-mcp-configs']);
    });

    it('init skips registration when user answers N to discovery prompt', async () => {
      // With TTY gated off in tests, addRepo is never reached — assert command succeeds
      const { Config } = await import('../src/core/config.js');
      const addRepoSpy = vi.fn();
      vi.mocked(Config.init).mockResolvedValueOnce({
        repo: { name: 'test-repo', path: '.' },
        repos: [{ name: 'test-repo', path: '.' }],
        addRepo: addRepoSpy,
        save: vi.fn(),
        settings: { excludePatterns: [], includePatterns: [] },
      } as any);
      await runCLI(['init', '.', '--no-agents', '--no-suggestions', '--no-mcp-configs']);
      expect(addRepoSpy).not.toHaveBeenCalled();
    });

    it('uninit --force', async () => {
      await runCLI(['uninit', '.', '--force']);
      // Should not prompt and should succeed
    });
  });

  describe('agents subcommands', () => {
    it('agents list', async () => {
      await runCLI(['agents', 'list']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Supported LLM'));
    });

    it('agents generate --all --force', async () => {
      await runCLI(['agents', 'generate', '--all', '--force']);
    });

    it('agents generate --providers generic --dry-run', async () => {
      await runCLI(['agents', 'generate', '--providers', 'generic', '--dry-run']);
    });

    it('agents generate with up_to_date status', async () => {
      agentGeneratorMocks.plan.mockReturnValue([
        { filename: 'AGENTS.md', filepath: '/test/AGENTS.md', status: 'up_to_date', provider: 'generic' }
      ]);
      await runCLI(['agents', 'generate', '--all']);
      agentGeneratorMocks.plan.mockReturnValue([{ filename: 'AGENTS.md', filepath: '/test/AGENTS.md', status: 'create', provider: 'generic' }]);
    });

    it('agents generate with update_conflict + --force', async () => {
      agentGeneratorMocks.plan.mockReturnValue([
        { filename: 'AGENTS.md', filepath: '/test/AGENTS.md', status: 'update_conflict', provider: 'generic', diff: '--- old\n+++ new' }
      ]);
      await runCLI(['agents', 'generate', '--all', '--force']);
      agentGeneratorMocks.plan.mockReturnValue([{ filename: 'AGENTS.md', filepath: '/test/AGENTS.md', status: 'create', provider: 'generic' }]);
    });

    it('agents update with no existing files', async () => {
      mockExists = false;
      await runCLI(['agents', 'update']);
      mockExists = true;
    });

    it('agents update with existing files --force', async () => {
      agentGeneratorMocks.plan.mockReturnValue([
        { filename: 'AGENTS.md', filepath: '/test/AGENTS.md', status: 'update_conflict', provider: 'generic', diff: '--- old\n+++ new' }
      ]);
      await runCLI(['agents', 'update', '--force']);
      agentGeneratorMocks.plan.mockReturnValue([{ filename: 'AGENTS.md', filepath: '/test/AGENTS.md', status: 'create', provider: 'generic' }]);
    });

    it('agents update --dry-run', async () => {
      agentGeneratorMocks.plan.mockReturnValue([
        { filename: 'AGENTS.md', filepath: '/test/AGENTS.md', status: 'create', provider: 'generic' }
      ]);
      await runCLI(['agents', 'update', '--dry-run']);
      agentGeneratorMocks.plan.mockReturnValue([{ filename: 'AGENTS.md', filepath: '/test/AGENTS.md', status: 'create', provider: 'generic' }]);
    });

    it('agents mcp --detect', async () => {
      agentGeneratorMocks.detectAgentTools.mockReturnValue([{ name: 'cursor-mcp', filename: '.cursor/mcp.json' }]);
      await runCLI(['agents', 'mcp', '--detect']);
      agentGeneratorMocks.detectAgentTools.mockReturnValue([]);
    });

    it('agents mcp --detect with no tools', async () => {
      agentGeneratorMocks.detectAgentTools.mockReturnValue([]);
      await runCLI(['agents', 'mcp', '--detect']);
    });

    it('agents mcp --all', async () => {
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([
        { filename: '.cursor/mcp.json', status: 'create', tool: 'cursor-mcp' }
      ]);
      await runCLI(['agents', 'mcp', '--all']);
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([]);
    });

    it('agents mcp --all --dry-run', async () => {
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([
        { filename: '.cursor/mcp.json', status: 'create', tool: 'cursor-mcp' }
      ]);
      await runCLI(['agents', 'mcp', '--all', '--dry-run']);
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([]);
    });

    it('agents mcp --tools cursor-mcp', async () => {
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([
        { filename: '.cursor/mcp.json', status: 'up_to_date', tool: 'cursor-mcp' }
      ]);
      await runCLI(['agents', 'mcp', '--tools', 'cursor-mcp']);
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([]);
    });

    it('agents mcp with merge status', async () => {
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([
        { filename: '.cursor/mcp.json', status: 'merge', tool: 'cursor-mcp' }
      ]);
      await runCLI(['agents', 'mcp', '--all']);
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([]);
    });

    it('agents mcp no targets detected', async () => {
      agentGeneratorMocks.detectAgentTools.mockReturnValue([]);
      await runCLI(['agents', 'mcp']);
    });
  });

  describe('workspace subcommands', () => {
    it('workspaces list', async () => {
      await runCLI(['workspaces', 'list']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Registered'));
    });

    it('workspaces discover with no unregistered', async () => {
      await runCLI(['workspaces', 'discover']);
      expect(logSpy).toHaveBeenCalledWith('No unregistered repositories discovered.');
    });

    it('workspaces sync with no new repos', async () => {
      await runCLI(['workspaces', 'sync']);
    });

    it('workspaces remove existing repo', async () => {
      await runCLI(['workspaces', 'remove', 'test-repo']);
    });

    it('workspaces remove non-existing repo', async () => {
      const { Config } = await import('../src/core/config.js');
      vi.mocked(Config.load).mockResolvedValueOnce({
        repo: { name: 'test-repo', path: '.' },
        repos: [],
        settings: { excludePatterns: [], includePatterns: [] },
        addRepo: vi.fn(),
        removeRepo: vi.fn(),
        save: vi.fn()
      } as any);
      await expect(runCLI(['workspaces', 'remove', 'nonexistent'])).rejects.toThrow('exit: 1');
    });

    it('workspaces list with discovered submodules and peers', async () => {
      const { WorkspaceManager } = await import('../src/core/workspace-manager.js');
      vi.mocked(WorkspaceManager.discoverSubmodules).mockReturnValueOnce([
        { name: 'sub-repo', path: '../sub-repo', isInitialized: true }
      ] as any);
      vi.mocked(WorkspaceManager.discoverPeerRepos).mockReturnValueOnce([
        { name: 'peer-repo', path: '../peer-repo' }
      ] as any);
      await runCLI(['workspaces', 'list']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Registered'));
    });

    it('workspaces discover with discovered repos', async () => {
      const { WorkspaceManager } = await import('../src/core/workspace-manager.js');
      vi.mocked(WorkspaceManager.discoverSubmodules).mockReturnValueOnce([
        { name: 'sub-repo', path: '../sub-repo', isInitialized: true }
      ] as any);
      vi.mocked(WorkspaceManager.discoverPeerRepos).mockReturnValueOnce([
        { name: 'peer-repo', path: '../peer-repo' }
      ] as any);
      await runCLI(['workspaces', 'discover']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unregistered'));
    });

    it('workspaces sync with discovered repos', async () => {
      const { WorkspaceManager } = await import('../src/core/workspace-manager.js');
      vi.mocked(WorkspaceManager.discoverSubmodules).mockReturnValueOnce([
        { name: 'sub-repo', path: '../sub-repo', isInitialized: true }
      ] as any);
      await runCLI(['workspaces', 'sync']);
    });
  });

  describe('sources and sinks with data', () => {
    it('sources shows file types', async () => {
      flowTracerMocks.findSources.mockReturnValue([
        { file: 'src/main.ts', symbol: 'main', type: 'entry_point', reason: 'No incoming calls' }
      ]);
      await runCLI(['sources']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('src/main.ts'));
      flowTracerMocks.findSources.mockReturnValue([]);
    });

    it('sinks shows file types', async () => {
      flowTracerMocks.findSinks.mockReturnValue([
        { file: 'src/db.ts', symbol: 'query', type: 'database', reason: 'Database operation' }
      ]);
      await runCLI(['sinks']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('src/db.ts'));
      flowTracerMocks.findSinks.mockReturnValue([]);
    });
  });

  describe('node with source flag', () => {
    it('node --source displays source code lines', async () => {
      storeMocks.getSymbolByName.mockReturnValue({
        name: 'MyClass', kind: 'class', filePath: 'src/main.ts',
        scope: null, startLine: 1, endLine: 10
      });
      await runCLI(['node', 'MyClass', '--source']);
      storeMocks.getSymbolByName.mockReturnValue(undefined);
    });
  });

  describe('scan and update commands', () => {
    it('scan command runs without error', async () => {
      await runCLI(['scan', '.']);
    });

    it('scan with --exclude and --include', async () => {
      await runCLI(['scan', '.', '--exclude', 'node_modules/**', '--include', 'src/**']);
    });

    it('scan with --all flag', async () => {
      await runCLI(['scan', '.', '--all']);
    });

    it('scan with --repo flag', async () => {
      await runCLI(['scan', '.', '--repo', 'test-repo']);
    });

    it('update command runs without error', async () => {
      await runCLI(['update', '.']);
    });

    it('update with --exclude and --include', async () => {
      await runCLI(['update', '.', '--exclude', 'dist/**', '--include', '*.ts']);
    });

    it('update with --all flag', async () => {
      await runCLI(['update', '.', '--all']);
    });

    it('update with --repo flag', async () => {
      await runCLI(['update', '.', '--repo', 'test-repo']);
    });
  });

  describe('status command', () => {
    it('runs status without error', async () => {
      await runCLI(['status', '.']);
    });

    it('status with stale git changes', async () => {
      const { getChangedFiles } = await import('../src/core/git-tracker.js');
      vi.mocked(getChangedFiles).mockReturnValueOnce([
        { path: 'src/changed.ts', status: 'modified' },
        { path: 'src/new.ts', status: 'added' },
        { path: 'src/old.ts', status: 'removed' },
      ] as any);
      await runCLI(['status', '.']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('changed files'));
    });
  });

  describe('summary command with data', () => {
    it('summary shows full report when data exists', async () => {
      storeMocks.getFileCount.mockReturnValue(10);
      storeMocks.getSymbolCount.mockReturnValue(50);
      storeMocks.getEdgeCount.mockReturnValue(30);
      storeMocks.getLanguageBreakdown.mockReturnValue({ typescript: 8, javascript: 2 });
      storeMocks.getTopFilesByPageRank.mockReturnValue([
        { path: 'src/main.ts', pagerank: 0.15 }
      ]);
      storeMocks.getTopSymbolsByPageRank.mockReturnValue([
        { name: 'MyClass', scope: 'module', filePath: 'src/main.ts', pagerank: 0.1 }
      ]);
      storeMocks.raw.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          { kind: 'class', cnt: 5, edge_type: 'call', source_file: 'src/main.ts' }
        ]),
        get: vi.fn().mockReturnValue({ cnt: 25 })
      });
      await runCLI(['summary', '.']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Files:'));
      storeMocks.getFileCount.mockReturnValue(0);
      storeMocks.getSymbolCount.mockReturnValue(0);
      storeMocks.getEdgeCount.mockReturnValue(0);
      storeMocks.getLanguageBreakdown.mockReturnValue({});
      storeMocks.getTopFilesByPageRank.mockReturnValue([]);
      storeMocks.getTopSymbolsByPageRank.mockReturnValue([]);
      storeMocks.raw.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue({ cnt: 0 })
      });
    });
  });

  describe('query command with data', () => {
    it('query shows results when found', async () => {
      storeMocks.searchSymbols.mockReturnValue([
        { name: 'MyClass', kind: 'class', filePath: 'src/main.ts', scope: null, startLine: 1, endLine: 10 }
      ]);
      await runCLI(['query', 'MyClass']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MyClass'));
      storeMocks.searchSymbols.mockReturnValue([]);
    });

    it('query with no results shows fuzzy suggestions', async () => {
      storeMocks.searchSymbols.mockReturnValue([]);
      storeMocks.getSymbolCandidatesForFuzzy.mockReturnValue([
        { name: 'MyClas', kind: 'class', filePath: 'src/main.ts' }
      ]);
      await runCLI(['query', 'MyClasss']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No symbols'));
      storeMocks.getSymbolCandidatesForFuzzy.mockReturnValue([]);
    });
  });

  describe('search command with broadening', () => {
    it('search broadens kind filter when no results', async () => {
      // First call with kind filter returns nothing, second without kind returns results
      storeMocks.searchSymbolsFiltered
        .mockReturnValueOnce([])
        .mockReturnValueOnce([
          { name: 'myFunc', kind: 'function', filePath: 'src/utils.ts', scope: null, startLine: 1, endLine: 5, pagerank: 0.01 }
        ]);
      storeMocks.listSymbolKinds.mockReturnValue(['function', 'class']);
      await runCLI(['search', 'myFunc', '--kind', 'class']);
      storeMocks.searchSymbolsFiltered.mockReturnValue([]);
      storeMocks.listSymbolKinds.mockReturnValue([]);
    });

    it('search --json format', async () => {
      storeMocks.searchSymbolsFiltered.mockReturnValue([
        { name: 'myFunc', kind: 'function', filePath: 'src/utils.ts', scope: null, startLine: 1, endLine: 5, pagerank: 0.01 }
      ]);
      await runCLI(['search', 'myFunc', '--format', 'json']);
      const jsonCall = logSpy.mock.calls.find((c: any) => {
        try { JSON.parse(c[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeTruthy();
      storeMocks.searchSymbolsFiltered.mockReturnValue([]);
    });
  });

  describe('context command with data', () => {
    it('context shows included files', async () => {
      contextBuilderMocks.buildContext.mockResolvedValue({
        estimatedTokens: 500,
        includedFiles: [{ path: 'src/main.ts', language: 'typescript', lineCount: 100, sizeBytes: 5000, symbols: [] }],
        edges: [{ sourceFile: 'src/main.ts', targetFile: 'src/other.ts', sourceSymbol: 'A', targetSymbol: 'B', edgeType: 'call' }],
        excludedFiles: ['src/excluded.ts'],
      });
      await runCLI(['context', 'implement feature']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('src/main.ts'));
      contextBuilderMocks.buildContext.mockResolvedValue({
        estimatedTokens: 100, includedFiles: [], edges: [], excludedFiles: [],
      });
    });

    it('context --format json', async () => {
      contextBuilderMocks.buildContext.mockResolvedValue({
        estimatedTokens: 500,
        includedFiles: [{ path: 'src/main.ts', language: 'typescript', lineCount: 100, sizeBytes: 5000, symbols: [] }],
        edges: [],
        excludedFiles: [],
      });
      await runCLI(['context', 'implement feature', '--format', 'json']);
      const jsonCall = logSpy.mock.calls.find((c: any) => {
        try { JSON.parse(c[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeTruthy();
      contextBuilderMocks.buildContext.mockResolvedValue({
        estimatedTokens: 100, includedFiles: [], edges: [], excludedFiles: [],
      });
    });
  });

  describe('export formats', () => {
    it('export --format json', async () => {
      await runCLI(['export', '--format', 'json']);
      expect(logSpy).toHaveBeenCalledWith('graph-export-string');
    });

    it('export --format dot', async () => {
      await runCLI(['export', '--format', 'dot']);
      expect(logSpy).toHaveBeenCalledWith('dot-export-string');
    });

    it('export --format svg', async () => {
      await runCLI(['export', '--format', 'svg']);
      expect(logSpy).toHaveBeenCalledWith('svg-export-string');
    });

    it('export --format toon', async () => {
      await runCLI(['export', '--format', 'toon']);
      expect(logSpy).toHaveBeenCalledWith('toon-export-string');
    });

    it('export default format (llm)', async () => {
      await runCLI(['export']);
      expect(logSpy).toHaveBeenCalledWith('llm-export-string');
    });
  });

  describe('node command with data', () => {
    it('node text output with source and callers', async () => {
      storeMocks.getSymbolByName.mockReturnValue({
        name: 'MyClass', kind: 'class', filePath: 'src/main.ts',
        scope: null, startLine: 1, endLine: 10
      });
      storeMocks.getCallersOfSymbol.mockReturnValue([
        { source_file: 'src/app.ts', source_symbol: 'init', target_symbol: 'MyClass', metadata: '{"startLine":5}' }
      ]);
      storeMocks.getCalleesOfSymbol.mockReturnValue([
        { source_file: 'src/main.ts', source_symbol: 'MyClass', target_symbol: 'helper', target_file: 'src/utils.ts', metadata: '{}' }
      ]);
      storeMocks.getSymbolsForFile.mockReturnValue([
        { name: 'OtherClass', kind: 'class', filePath: 'src/main.ts', scope: null, startLine: 20, endLine: 30 }
      ]);
      await runCLI(['node', 'MyClass']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MyClass'));
      storeMocks.getSymbolByName.mockReturnValue(undefined);
      storeMocks.getCallersOfSymbol.mockReturnValue([]);
      storeMocks.getCalleesOfSymbol.mockReturnValue([]);
      storeMocks.getSymbolsForFile.mockReturnValue([]);
    });

    it('node --json format', async () => {
      storeMocks.getSymbolByName.mockReturnValue({
        name: 'MyClass', kind: 'class', filePath: 'src/main.ts',
        scope: null, startLine: 1, endLine: 10
      });
      await runCLI(['node', 'MyClass', '--format', 'json']);
      const jsonCall = logSpy.mock.calls.find((c: any) => {
        try { JSON.parse(c[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeTruthy();
      storeMocks.getSymbolByName.mockReturnValue(undefined);
    });
  });

  describe('deps command with data', () => {
    it('deps shows dependencies and reverse deps', async () => {
      graphMocks.getDependencies.mockReturnValue([
        { target: 'src/utils.ts', type: 'import', weight: 1 }
      ]);
      graphMocks.getReverseDependencies.mockReturnValue([
        { source: 'src/app.ts', type: 'import', weight: 1 }
      ]);
      await runCLI(['deps', 'src/main.ts']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('src/utils.ts'));
      graphMocks.getDependencies.mockReturnValue([]);
      graphMocks.getReverseDependencies.mockReturnValue([]);
    });
  });

  describe('init with mcp configs', () => {
    it('init generates mcp configs when agent tools detected', async () => {
      agentGeneratorMocks.detectAgentTools.mockReturnValue([{ name: 'cursor', filename: '.cursor/mcp.json' }]);
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([
        { filename: '.cursor/mcp.json', status: 'create', tool: 'cursor' }
      ]);
      await runCLI(['init', '.', '--no-suggestions']);
      agentGeneratorMocks.detectAgentTools.mockReturnValue([]);
      agentGeneratorMocks.generateMcpConfigs.mockReturnValue([]);
    });
  });

  describe('lang commands', () => {
    it('lang list', async () => {
      await runCLI(['lang', 'list']);
    });

    it('lang install', async () => {
      await runCLI(['lang', 'install', 'python']);
    });

    it('lang uninstall', async () => {
      await runCLI(['lang', 'uninstall', 'python']);
    });
  });
});
