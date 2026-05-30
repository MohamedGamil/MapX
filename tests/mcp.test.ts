import { vi, describe, it, expect, beforeEach } from 'vitest';

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
      return 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
    },
    writeFileSync: vi.fn(),
    readdirSync: () => [],
    statSync: () => ({ mtimeMs: 100 }),
    rmSync: vi.fn()
  };
});

/* ─── Module-level mock fns for Store (allows per-test overrides) ───── */
const storeMocks = {
  getMeta: vi.fn().mockReturnValue('6'),
  setMeta: vi.fn(),
  getAllFiles: vi.fn().mockReturnValue([{ path: 'src/main.ts', last_scanned: new Date().toISOString(), language: 'typescript', size_bytes: 100, lines: 10 }]),
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
  getFile: vi.fn().mockReturnValue(null),
  raw: {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue({ cnt: 0 })
    })
  },
};

vi.mock('../src/core/store.js', () => ({
  Store: class {
    getMeta = storeMocks.getMeta;
    setMeta = storeMocks.setMeta;
    getAllFiles = storeMocks.getAllFiles;
    getAllSymbols = storeMocks.getAllSymbols;
    getAllEdges = storeMocks.getAllEdges;
    close = storeMocks.close;
    queryEdges = storeMocks.queryEdges;
    searchSymbolsFiltered = storeMocks.searchSymbolsFiltered;
    getFilesFiltered = storeMocks.getFilesFiltered;
    getLanguageBreakdown = storeMocks.getLanguageBreakdown;
    getClusters = storeMocks.getClusters;
    listSymbolKinds = storeMocks.listSymbolKinds;
    searchSymbols = storeMocks.searchSymbols;
    getSymbolCandidatesForFuzzy = storeMocks.getSymbolCandidatesForFuzzy;
    getFileCount = storeMocks.getFileCount;
    getSymbolCount = storeMocks.getSymbolCount;
    getEdgeCount = storeMocks.getEdgeCount;
    getTopFilesByPageRank = storeMocks.getTopFilesByPageRank;
    getTopSymbolsByPageRank = storeMocks.getTopSymbolsByPageRank;
    getCallersOfSymbol = storeMocks.getCallersOfSymbol;
    getCalleesOfSymbol = storeMocks.getCalleesOfSymbol;
    getSymbolByName = storeMocks.getSymbolByName;
    getSymbolsForFile = storeMocks.getSymbolsForFile;
    getClusterFiles = storeMocks.getClusterFiles;
    getClusterEdges = storeMocks.getClusterEdges;
    getEdgesForFile = storeMocks.getEdgesForFile;
    getReverseEdges = storeMocks.getReverseEdges;
    deleteRepo = storeMocks.deleteRepo;
    getFile = storeMocks.getFile;
    raw = storeMocks.raw;
  }
}));

vi.mock('../src/core/config.js', () => ({
  Config: {
    load: vi.fn().mockResolvedValue({
      repo: { name: 'test-repo', path: '.' },
      repos: [{ name: 'test-repo', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] },
      addRepo: vi.fn(),
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
    scanFull = vi.fn().mockResolvedValue({ filesScanned: 1, symbolsFound: 2, edgesFound: 3, durationMs: 10, languageBreakdown: {} });
    scanIncremental = vi.fn().mockResolvedValue({ filesScanned: 1, symbolsFound: 2, edgesFound: 3, durationMs: 10, languageBreakdown: {} });
    abort = vi.fn();
  },
  buildMatcher: () => () => true
}));

vi.mock('../src/core/workspace-manager.js', () => ({
  WorkspaceManager: {
    discoverSubmodules: vi.fn().mockReturnValue([]),
    discoverPeerRepos: vi.fn().mockReturnValue([]),
    discoverVSCodeWorkspace: vi.fn().mockReturnValue([]),
    listWorkspaces: vi.fn().mockReturnValue([]),
    discoverWorkspaces: vi.fn().mockReturnValue([]),
    syncWorkspaces: vi.fn().mockReturnValue([])
  }
}));

const { mockFindSimilarSymbols, mockGetChangedFiles, mockIsGitRepo } = vi.hoisted(() => ({
  mockFindSimilarSymbols: vi.fn().mockReturnValue([]),
  mockGetChangedFiles: vi.fn().mockReturnValue([]),
  mockIsGitRepo: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/core/fuzzy-matcher.js', () => ({
  findSimilarSymbols: mockFindSimilarSymbols
}));

vi.mock('../src/core/impact-analyzer.js', () => ({
  ImpactAnalyzer: class {
    analyze = vi.fn().mockReturnValue({ blastRadius: [], riskScore: 0.1 });
  },
  checkTryCatch: vi.fn().mockReturnValue(false)
}));

vi.mock('../src/languages/installer.js', () => ({
  isLanguageInstalled: vi.fn().mockReturnValue(true),
  installLanguage: vi.fn().mockResolvedValue(true),
  uninstallLanguage: vi.fn().mockResolvedValue(true)
}));

vi.mock('../src/languages/registry.js', () => ({
  getBuiltinLanguages: vi.fn().mockReturnValue({
    typescript: { extensions: ['.ts', '.tsx'], tier: 'builtin' },
    python: { extensions: ['.py'], tier: 'dynamic' }
  })
}));

vi.mock('../src/core/git-tracker.js', () => ({
  getChangedFiles: mockGetChangedFiles,
  isGitRepo: mockIsGitRepo
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

vi.mock('../src/core/metrics.js', () => ({
  calculateMetrics: vi.fn().mockReturnValue([
    { path: 'src/main.ts', language: 'typescript', afferent: 1, efferent: 2, instability: 0.5 }
  ])
}));

vi.mock('../src/core/context-builder.js', () => ({
  ContextBuilder: class {
    buildContext = vi.fn().mockResolvedValue({
      includedFiles: [
        {
          path: 'src/main.ts',
          language: 'typescript',
          lineCount: 10,
          sizeBytes: 100,
          symbols: [{ name: 'MyClass', kind: 'class', scope: null, startLine: 1, endLine: 10 }]
        }
      ],
      excludedFiles: ['src/other.ts'],
      edges: [
        { sourceFile: 'src/main.ts', targetFile: 'src/other.ts', sourceSymbol: 'MyClass', targetSymbol: 'OtherClass', edgeType: 'call' }
      ],
      estimatedTokens: 500,
    });
  }
}));

vi.mock('../src/core/flow-tracer.js', () => ({
  FlowTracer: class {
    traceFlow = vi.fn().mockReturnValue([]);
    trace = vi.fn().mockReturnValue({
      start: { file: 'src/main.ts', symbol: 'MyClass' },
      direction: 'both',
      paths: [],
      sources: [],
      sinks: [],
      cycles: [],
      nodeCount: 0,
      edgeCount: 0,
      maxDepthReached: false,
    });
    findSources = vi.fn().mockReturnValue([]);
    findSinks = vi.fn().mockReturnValue([]);
  }
}));

vi.mock('../src/agents/generator.js', () => ({
  AgentGenerator: class {
    generateAll = vi.fn().mockResolvedValue(true);
    listProviders = vi.fn().mockReturnValue(['generic', 'claude', 'cursor']);
    plan = vi.fn().mockReturnValue([
      { filename: 'AGENTS.md', status: 'create', provider: 'generic' },
    ]);
    execute = vi.fn();
  }
}));

vi.mock('../src/frameworks/route-registry.js', () => ({
  RouteRegistry: class {
    load = vi.fn().mockResolvedValue(undefined);
    queryRoutes = vi.fn().mockReturnValue([]);
    queryHooks = vi.fn().mockReturnValue([]);
  }
}));

vi.mock('../src/ui-events.js', () => ({
  UiEventBus: {
    getInstance: () => ({
      setMapxDir: vi.fn(),
      emitToolCall: vi.fn(),
      mapxDir: null,
    }),
  }
}));

import { buildServer, getStaleFilesCount, getStaleFileNames, getMcpStalenessWarning, checkTryCatch } from '../src/mcp.js';
import { Store } from '../src/core/store.js';

class MockTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;

  sent: any[] = [];

  async start() {}
  async send(message: any) {
    this.sent.push(message);
  }
  close() {}

  receive(message: any) {
    if (this.onmessage) {
      this.onmessage(message);
    }
  }
}

/** Helper to reset all store mocks to their defaults */
function resetStoreMocks() {
  storeMocks.getMeta.mockReturnValue('6');
  storeMocks.getAllFiles.mockReturnValue([{ path: 'src/main.ts', last_scanned: new Date().toISOString(), language: 'typescript', size_bytes: 100, lines: 10 }]);
  storeMocks.getAllSymbols.mockReturnValue([]);
  storeMocks.getAllEdges.mockReturnValue([]);
  storeMocks.queryEdges.mockReturnValue([]);
  storeMocks.searchSymbolsFiltered.mockReturnValue([]);
  storeMocks.getFilesFiltered.mockReturnValue([]);
  storeMocks.getLanguageBreakdown.mockReturnValue({});
  storeMocks.getClusters.mockReturnValue([]);
  storeMocks.listSymbolKinds.mockReturnValue([]);
  storeMocks.searchSymbols.mockReturnValue([]);
  storeMocks.getSymbolCandidatesForFuzzy.mockReturnValue([]);
  storeMocks.getFileCount.mockReturnValue(0);
  storeMocks.getSymbolCount.mockReturnValue(0);
  storeMocks.getEdgeCount.mockReturnValue(0);
  storeMocks.getTopFilesByPageRank.mockReturnValue([]);
  storeMocks.getTopSymbolsByPageRank.mockReturnValue([]);
  storeMocks.getCallersOfSymbol.mockReturnValue([]);
  storeMocks.getCalleesOfSymbol.mockReturnValue([]);
  storeMocks.getSymbolByName.mockReturnValue(undefined);
  storeMocks.getSymbolsForFile.mockReturnValue([]);
  storeMocks.getClusterFiles.mockReturnValue([]);
  storeMocks.getClusterEdges.mockReturnValue([]);
  storeMocks.getEdgesForFile.mockReturnValue([]);
  storeMocks.getReverseEdges.mockReturnValue([]);

  mockFindSimilarSymbols.mockReturnValue([]);
  mockGetChangedFiles.mockReturnValue([]);
  mockIsGitRepo.mockReturnValue(true);
}

describe('MCP module', () => {
  let server: any;
  let transport: MockTransport;

  beforeEach(async () => {
    mockExists = true;
    resetStoreMocks();
    server = buildServer({ debug: false });
    transport = new MockTransport();
    await server.connect(transport);
  });

  const callTool = async (name: string, args: any = {}) => {
    const id = Math.floor(Math.random() * 1000000);
    const responsePromise = new Promise<any>((resolve) => {
      const interval = setInterval(() => {
        const respIdx = transport.sent.findIndex(m => m.id === id);
        if (respIdx !== -1) {
          clearInterval(interval);
          resolve(transport.sent.splice(respIdx, 1)[0]);
        }
      }, 10);
    });

    transport.receive({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name,
        arguments: { dir: '.', ...args }
      }
    });

    return responsePromise;
  };

  const callToolRaw = async (name: string, rawArgs: any) => {
    const id = Math.floor(Math.random() * 1000000);
    const responsePromise = new Promise<any>((resolve) => {
      const interval = setInterval(() => {
        const respIdx = transport.sent.findIndex(m => m.id === id);
        if (respIdx !== -1) {
          clearInterval(interval);
          resolve(transport.sent.splice(respIdx, 1)[0]);
        }
      }, 10);
    });
    transport.receive({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: rawArgs }
    });
    return responsePromise;
  };

  const getText = (res: any) => res.result.content[0].text;

  // ==================== LIST TOOLS ====================
  it('lists available tools correctly', async () => {
    const id = 123;
    const responsePromise = new Promise<any>((resolve) => {
      const interval = setInterval(() => {
        const respIdx = transport.sent.findIndex(m => m.id === id);
        if (respIdx !== -1) {
          clearInterval(interval);
          resolve(transport.sent.splice(respIdx, 1)[0]);
        }
      }, 10);
    });
    transport.receive({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
    const res = await responsePromise;
    expect(res.result.tools.length).toBeGreaterThan(0);
  });

  // ==================== SCAN & SYNC ====================
  it('executes mapx_scan and mapx_sync', async () => {
    const res1 = await callTool('mapx_scan');
    expect(getText(res1)).toContain('Scanned 1 files');

    const res2 = await callTool('mapx_sync');
    expect(getText(res2)).toContain('Updated 1');
  });

  it('handles tool execution failures gracefully when context cannot be loaded', async () => {
    mockExists = false;
    const res = await callTool('mapx_scan');
    expect(getText(res)).toContain('Mapx not initialized');
  });

  // ==================== MAPX_QUERY ====================
  describe('mapx_query', () => {
    it('returns results when symbols are found', async () => {
      storeMocks.searchSymbols.mockReturnValue([
        { name: 'MyClass', kind: 'class', file_path: 'src/main.ts', start_line: 1, scope: null, signature: 'class MyClass' }
      ]);

      const res = await callTool('mapx_query', { term: 'MyClass' });
      const text = getText(res);
      expect(text).toContain('Found 1 symbol');
      expect(text).toContain('MyClass');
    });

    it('returns results with scope', async () => {
      storeMocks.searchSymbols.mockReturnValue([
        { name: 'myMethod', kind: 'method', file_path: 'src/main.ts', start_line: 5, scope: 'MyClass', signature: 'myMethod()' }
      ]);

      const res = await callTool('mapx_query', { term: 'myMethod' });
      const text = getText(res);
      expect(text).toContain('MyClass::myMethod');
    });

    it('returns fuzzy suggestions when no results found', async () => {
      mockFindSimilarSymbols.mockReturnValue([
        { name: 'MyCoolClass', kind: 'class', filePath: 'src/cool.ts' }
      ]);

      const res = await callTool('mapx_query', { term: 'MyClas' });
      const text = getText(res);
      expect(text).toContain('No symbols matching');
      expect(text).toContain('Did you mean');
      expect(text).toContain('MyCoolClass');
    });

    it('returns error when term is missing', async () => {
      const res = await callToolRaw('mapx_query', { dir: '.' });
      expect(getText(res)).toContain('Missing required parameter: term');
    });
  });

  // ==================== MAPX_DEPENDENCIES ====================
  describe('mapx_dependencies', () => {
    it('returns "No dependencies found" when none exist', async () => {
      const res = await callTool('mapx_dependencies', { file: 'src/main.ts' });
      expect(getText(res)).toContain('No dependencies found');
    });

    it('returns error when file param is missing', async () => {
      const res = await callToolRaw('mapx_dependencies', { dir: '.' });
      expect(getText(res)).toContain('Missing required parameter: file');
    });
  });

  // ==================== MAPX_EXPORT ====================
  describe('mapx_export', () => {
    it('exports in json format', async () => {
      const res = await callTool('mapx_export', { format: 'json' });
      expect(getText(res)).toContain('graph-export-string');
    });

    it('exports in dot format', async () => {
      const res = await callTool('mapx_export', { format: 'dot' });
      expect(getText(res)).toContain('dot-export-string');
    });

    it('exports in svg format', async () => {
      const res = await callTool('mapx_export', { format: 'svg' });
      expect(getText(res)).toContain('svg-export-string');
    });

    it('exports in llm format (default)', async () => {
      const res = await callTool('mapx_export');
      expect(getText(res)).toContain('llm-export-string');
    });

    it('exports with exclude and include args', async () => {
      const res = await callTool('mapx_export', { format: 'llm', exclude: 'test/**', include: 'src/**' });
      expect(getText(res)).toContain('llm-export-string');
    });
  });

  // ==================== MAPX_STATUS ====================
  describe('mapx_status', () => {
    it('shows status with git repo and no changes', async () => {
      const res = await callTool('mapx_status');
      const text = getText(res);
      expect(text).toContain('Directory:');
      expect(text).toContain('No changes since last scan');
      expect(text).toContain('Index is up to date');
    });

    it('shows stale status when git has changes', async () => {
      mockGetChangedFiles.mockReturnValue(['src/changed.ts', 'src/another.ts']);

      const res = await callTool('mapx_status');
      const text = getText(res);
      expect(text).toContain('changed files');
      expect(text).toContain('stale');
      expect(text).toContain('Run `mapx sync`');
    });

    it('shows status when not a git repo', async () => {
      mockIsGitRepo.mockReturnValue(false);

      const res = await callTool('mapx_status');
      const text = getText(res);
      expect(text).toContain('Not a git repository');
    });
  });

  // ==================== MAPX_SEARCH ====================
  describe('mapx_search', () => {
    it('returns search results with pagerank', async () => {
      storeMocks.searchSymbolsFiltered.mockReturnValue([
        { name: 'UserService', kind: 'class', file_path: 'src/user.ts', start_line: 1, end_line: 50, scope: null, signature: 'class UserService' }
      ]);

      const res = await callTool('mapx_search', { term: 'User' });
      const text = getText(res);
      expect(text).toContain('Found 1 symbol');
      expect(text).toContain('UserService');
      expect(text).toContain('pagerank');
    });

    it('broadens search when kind filter yields 0 results', async () => {
      let callCount = 0;
      storeMocks.searchSymbolsFiltered.mockImplementation((args: any) => {
        callCount++;
        if (args.kind) return []; // kind filter yields 0
        return [{ name: 'UserHelper', kind: 'function', file_path: 'src/user.ts', start_line: 1, end_line: 10, scope: null, signature: '' }];
      });

      const res = await callTool('mapx_search', { term: 'User', kind: 'class' });
      const text = getText(res);
      expect(text).toContain('broadened');
      expect(text).toContain('UserHelper');
    });

    it('returns fuzzy suggestions when no results with kind param', async () => {
      storeMocks.searchSymbolsFiltered.mockReturnValue([]);
      storeMocks.listSymbolKinds.mockReturnValue([{ kind: 'class', count: 5 }, { kind: 'function', count: 10 }]);
      mockFindSimilarSymbols.mockReturnValue([
        { name: 'UserClass', kind: 'class', filePath: 'src/user.ts' }
      ]);

      const res = await callTool('mapx_search', { term: 'Userr', kind: 'class' });
      const text = getText(res);
      expect(text).toContain('No symbols matching');
      expect(text).toContain('Available kinds');
      expect(text).toContain('Did you mean');
    });

    it('returns json format output', async () => {
      storeMocks.searchSymbolsFiltered.mockReturnValue([
        { name: 'Main', kind: 'class', file_path: 'src/main.ts', start_line: 1, end_line: 10, scope: null, signature: '' }
      ]);

      const res = await callTool('mapx_search', { term: 'Main', format: 'json' });
      const text = getText(res);
      const parsed = JSON.parse(text);
      expect(parsed.total).toBe(1);
      expect(parsed.results[0].name).toBe('Main');
    });

    it('returns error when term is missing', async () => {
      const res = await callToolRaw('mapx_search', { dir: '.' });
      expect(getText(res)).toContain('Missing required parameter: term');
    });

    it('returns fuzzy fallback with no kind', async () => {
      storeMocks.searchSymbolsFiltered.mockReturnValue([]);
      mockFindSimilarSymbols.mockReturnValue([]);

      const res = await callTool('mapx_search', { term: 'NonExistent' });
      const text = getText(res);
      expect(text).toContain('No symbols matching');
      expect(text).toContain('Tip:');
    });
  });

  // ==================== MAPX_CONTEXT ====================
  describe('mapx_context', () => {
    it('returns context with text format', async () => {
      const res = await callTool('mapx_context', { task: 'refactor auth flow' });
      const text = getText(res);
      expect(text).toContain('Mapx smart Context');
      expect(text).toContain('Included Files');
      expect(text).toContain('src/main.ts');
      expect(text).toContain('Cross-File Dependencies');
      expect(text).toContain('Excluded Files');
    });

    it('returns context with json format', async () => {
      const res = await callTool('mapx_context', { task: 'refactor auth', format: 'json' });
      const text = getText(res);
      const parsed = JSON.parse(text);
      expect(parsed.includedFiles).toBeDefined();
      expect(parsed.estimatedTokens).toBe(500);
    });

    it('returns error when task is missing', async () => {
      const res = await callToolRaw('mapx_context', { dir: '.' });
      expect(getText(res)).toContain('Missing required parameter: task');
    });
  });

  // ==================== MAPX_CALLERS ====================
  describe('mapx_callers', () => {
    it('returns callers when found', async () => {
      storeMocks.getCallersOfSymbol.mockReturnValue([
        { source_file: 'src/caller.ts', source_symbol: 'CallerFunc', target_symbol: 'MyFunc', metadata: JSON.stringify({ startLine: 5 }) }
      ]);

      const res = await callTool('mapx_callers', { symbol: 'MyFunc' });
      const text = getText(res);
      expect(text).toContain('1 caller');
      expect(text).toContain('CallerFunc');
      expect(text).toContain('src/caller.ts');
    });

    it('returns no callers when symbol exists but has no callers', async () => {
      storeMocks.getCallersOfSymbol.mockReturnValue([]);
      storeMocks.getSymbolByName.mockReturnValue({ name: 'MyFunc', kind: 'function', file_path: 'src/main.ts' });

      const res = await callTool('mapx_callers', { symbol: 'MyFunc' });
      expect(getText(res)).toContain('No callers found');
    });

    it('returns fuzzy suggestions when symbol not found', async () => {
      storeMocks.getCallersOfSymbol.mockReturnValue([]);
      storeMocks.getSymbolByName.mockReturnValue(undefined);
      mockFindSimilarSymbols.mockReturnValue([
        { name: 'MyFunc', kind: 'function', filePath: 'src/main.ts' }
      ]);

      const res = await callTool('mapx_callers', { symbol: 'MyFnuc' });
      const text = getText(res);
      expect(text).toContain('not found');
      expect(text).toContain('Did you mean');
    });

    it('returns error when symbol is missing', async () => {
      const res = await callToolRaw('mapx_callers', { dir: '.' });
      expect(getText(res)).toContain('Missing required parameter: symbol');
    });

    it('handles metadata without startLine', async () => {
      storeMocks.getCallersOfSymbol.mockReturnValue([
        { source_file: 'src/caller.ts', source_symbol: 'CallerFunc', target_symbol: 'MyFunc', metadata: null }
      ]);

      const res = await callTool('mapx_callers', { symbol: 'MyFunc' });
      const text = getText(res);
      expect(text).toContain('CallerFunc');
    });

    it('traverses multi-depth callers', async () => {
      storeMocks.getCallersOfSymbol.mockImplementation((symName: string) => {
        if (symName === 'Target') return [{ source_file: 'src/mid.ts', source_symbol: 'Mid', target_symbol: 'Target', metadata: null }];
        if (symName === 'Mid') return [{ source_file: 'src/top.ts', source_symbol: 'Top', target_symbol: 'Mid', metadata: null }];
        return [];
      });

      const res = await callTool('mapx_callers', { symbol: 'Target', depth: 2 });
      const text = getText(res);
      expect(text).toContain('Mid');
      expect(text).toContain('Top');
      expect(text).toContain('depth 2');
    });
  });

  // ==================== MAPX_CALLEES ====================
  describe('mapx_callees', () => {
    it('returns callees when found', async () => {
      storeMocks.getCalleesOfSymbol.mockReturnValue([
        { target_file: 'src/dep.ts', target_symbol: 'DepFunc', source_symbol: 'MyFunc', metadata: JSON.stringify({ startLine: 3 }) }
      ]);

      const res = await callTool('mapx_callees', { symbol: 'MyFunc' });
      const text = getText(res);
      expect(text).toContain('1 callee');
      expect(text).toContain('DepFunc');
    });

    it('returns no callees when symbol exists but has none', async () => {
      storeMocks.getCalleesOfSymbol.mockReturnValue([]);
      storeMocks.getSymbolByName.mockReturnValue({ name: 'MyFunc', kind: 'function' });

      const res = await callTool('mapx_callees', { symbol: 'MyFunc' });
      expect(getText(res)).toContain('No callees found');
    });

    it('returns fuzzy suggestions when symbol not found for callees', async () => {
      storeMocks.getCalleesOfSymbol.mockReturnValue([]);
      storeMocks.getSymbolByName.mockReturnValue(undefined);
      mockFindSimilarSymbols.mockReturnValue([
        { name: 'MyFunc', kind: 'function', filePath: 'src/main.ts' }
      ]);

      const res = await callTool('mapx_callees', { symbol: 'MyFnuc' });
      const text = getText(res);
      expect(text).toContain('not found');
      expect(text).toContain('Did you mean');
    });

    it('returns error when symbol is missing for callees', async () => {
      const res = await callToolRaw('mapx_callees', { dir: '.' });
      expect(getText(res)).toContain('Missing required parameter: symbol');
    });

    it('traverses multi-depth callees', async () => {
      storeMocks.getCalleesOfSymbol.mockImplementation((symName: string) => {
        if (symName === 'Source') return [{ target_file: 'src/mid.ts', target_symbol: 'Mid', source_symbol: 'Source', metadata: null }];
        if (symName === 'Mid') return [{ target_file: 'src/bottom.ts', target_symbol: 'Bottom', source_symbol: 'Mid', metadata: null }];
        return [];
      });

      const res = await callTool('mapx_callees', { symbol: 'Source', depth: 2 });
      const text = getText(res);
      expect(text).toContain('Mid');
      expect(text).toContain('Bottom');
      expect(text).toContain('depth 2');
    });
  });

  // ==================== MAPX_IMPACT ====================
  describe('mapx_impact', () => {
    it('returns impact analysis when symbol is found', async () => {
      storeMocks.getSymbolByName.mockReturnValue({ name: 'MyFunc', kind: 'function', file_path: 'src/main.ts' });

      const res = await callTool('mapx_impact', { symbol: 'MyFunc' });
      expect(getText(res)).toContain('blastRadius');
    });

    it('returns fuzzy suggestions when symbol not found', async () => {
      storeMocks.getSymbolByName.mockReturnValue(undefined);
      mockFindSimilarSymbols.mockReturnValue([
        { name: 'MyFunc', kind: 'function', filePath: 'src/main.ts' }
      ]);

      const res = await callTool('mapx_impact', { symbol: 'NonExistent' });
      const text = getText(res);
      expect(text).toContain('not found');
      expect(text).toContain('Did you mean');
    });

    it('returns error when symbol is missing', async () => {
      const res = await callToolRaw('mapx_impact', { dir: '.' });
      expect(getText(res)).toContain('Missing required parameter: symbol');
    });
  });

  // ==================== MAPX_NODE ====================
  describe('mapx_node', () => {
    it('returns node details in text format with callers/callees/siblings', async () => {
      storeMocks.getSymbolByName.mockReturnValue({
        name: 'MyClass', kind: 'class', file_path: 'src/main.ts',
        start_line: 1, end_line: 10, scope: 'App', signature: 'class MyClass'
      });
      storeMocks.getCallersOfSymbol.mockReturnValue([
        { source_symbol: 'Caller1', source_file: 'src/a.ts', target_file: 'src/main.ts' }
      ]);
      storeMocks.getCalleesOfSymbol.mockReturnValue([
        { target_symbol: 'Dep1', target_file: 'src/b.ts', source_file: 'src/main.ts' }
      ]);
      storeMocks.getSymbolsForFile.mockReturnValue([
        { name: 'MyClass', kind: 'class', start_line: 1 },
        { name: 'helperFunc', kind: 'function', start_line: 20 }
      ]);

      const res = await callTool('mapx_node', { symbol: 'MyClass' });
      const text = getText(res);
      expect(text).toContain('Symbol: App::MyClass');
      expect(text).toContain('Kind:   class');
      expect(text).toContain('Callers: 1');
      expect(text).toContain('Callees: 1');
      expect(text).toContain('Top callers:');
      expect(text).toContain('Top callees:');
      expect(text).toContain('helperFunc');
    });

    it('returns node details in json format', async () => {
      storeMocks.getSymbolByName.mockReturnValue({
        name: 'MyClass', kind: 'class', file_path: 'src/main.ts',
        start_line: 1, end_line: 5, scope: null, signature: 'class MyClass'
      });

      const res = await callTool('mapx_node', { symbol: 'MyClass', format: 'json' });
      const text = getText(res);
      const parsed = JSON.parse(text);
      expect(parsed.name).toBe('MyClass');
      expect(parsed.kind).toBe('class');
      expect(parsed.callerCount).toBe(0);
    });

    it('includes source code in text format', async () => {
      storeMocks.getSymbolByName.mockReturnValue({
        name: 'MyClass', kind: 'class', file_path: 'src/main.ts',
        start_line: 1, end_line: 3, scope: null, signature: 'class MyClass'
      });

      const res = await callTool('mapx_node', { symbol: 'MyClass', source: true });
      const text = getText(res);
      expect(text).toContain('Source Code:');
      expect(text).toContain('line1');
    });

    it('includes source code in json format', async () => {
      storeMocks.getSymbolByName.mockReturnValue({
        name: 'MyClass', kind: 'class', file_path: 'src/main.ts',
        start_line: 1, end_line: 3, scope: null, signature: 'class MyClass'
      });

      const res = await callTool('mapx_node', { symbol: 'MyClass', format: 'json', source: true });
      const text = getText(res);
      const parsed = JSON.parse(text);
      expect(parsed.source).toBeDefined();
    });

    it('returns fuzzy suggestions when symbol not found', async () => {
      storeMocks.getSymbolByName.mockReturnValue(undefined);
      mockFindSimilarSymbols.mockReturnValue([
        { name: 'MyClass', kind: 'class', filePath: 'src/main.ts' }
      ]);

      const res = await callTool('mapx_node', { symbol: 'NonExistent' });
      const text = getText(res);
      expect(text).toContain('not found');
      expect(text).toContain('Did you mean');
      expect(text).toContain('Tip: Use mapx_search');
    });

    it('returns error when symbol is missing', async () => {
      const res = await callToolRaw('mapx_node', { dir: '.' });
      expect(getText(res)).toContain('Missing required parameter: symbol');
    });
  });

  // ==================== MAPX_FILES ====================
  describe('mapx_files', () => {
    it('returns files when found', async () => {
      storeMocks.getFilesFiltered.mockReturnValue([
        { path: 'src/main.ts', language: 'typescript', lines: 100, size_bytes: 2000 }
      ]);

      const res = await callTool('mapx_files');
      const text = getText(res);
      expect(text).toContain('1 file');
      expect(text).toContain('src/main.ts');
    });

    it('returns no files message when empty', async () => {
      storeMocks.getFilesFiltered.mockReturnValue([]);

      const res = await callTool('mapx_files');
      expect(getText(res)).toContain('No files found');
    });

    it('shows filter info in header', async () => {
      storeMocks.getFilesFiltered.mockReturnValue([
        { path: 'src/main.ts', language: 'typescript', lines: 100, size_bytes: 2000 }
      ]);

      const res = await callTool('mapx_files', { path: 'src/', lang: 'typescript' });
      const text = getText(res);
      expect(text).toContain('under src/');
      expect(text).toContain('typescript');
    });

    it('uses "matching" in header for glob path', async () => {
      storeMocks.getFilesFiltered.mockReturnValue([
        { path: 'src/core/store.ts', language: 'typescript', lines: 849, size_bytes: 27000 },
        { path: 'src/core/graph.ts', language: 'typescript', lines: 213, size_bytes: 7200 }
      ]);

      const res = await callTool('mapx_files', { path: 'src/core/*.ts' });
      const text = getText(res);
      expect(text).toContain('matching src/core/*.ts');
      expect(text).not.toContain('under src/core/*.ts');
      expect(text).toContain('src/core/store.ts');
    });

    it('uses "matching" in header for double-star glob', async () => {
      storeMocks.getFilesFiltered.mockReturnValue([
        { path: 'package.json', language: 'json', lines: 42, size_bytes: 1100 }
      ]);

      const res = await callTool('mapx_files', { path: '**/*.json' });
      const text = getText(res);
      expect(text).toContain('matching **/*.json');
    });

    it('uses "under" in header for plain prefix', async () => {
      storeMocks.getFilesFiltered.mockReturnValue([
        { path: 'src/core/store.ts', language: 'typescript', lines: 849, size_bytes: 27000 }
      ]);

      const res = await callTool('mapx_files', { path: 'src/core/' });
      const text = getText(res);
      expect(text).toContain('under src/core/');
      expect(text).not.toContain('matching');
    });

    it('shows no path header when path not provided', async () => {
      storeMocks.getFilesFiltered.mockReturnValue([
        { path: 'src/main.ts', language: 'typescript', lines: 100, size_bytes: 2000 }
      ]);

      const res = await callTool('mapx_files');
      const text = getText(res);
      expect(text).not.toContain('under');
      expect(text).not.toContain('matching');
      expect(text).toContain('1 file');
    });
  });

  // ==================== MAPX_METRICS ====================
  describe('mapx_metrics', () => {
    it('returns metrics table', async () => {
      const res = await callTool('mapx_metrics');
      const text = getText(res);
      expect(text).toContain('Coupling');
      expect(text).toContain('src/main.ts');
    });

    it('returns no metrics message when empty', async () => {
      const { calculateMetrics } = await import('../src/core/metrics.js');
      vi.mocked(calculateMetrics).mockReturnValue([]);

      const res = await callTool('mapx_metrics');
      expect(getText(res)).toContain('No metrics found');
    });
  });

  // ==================== MAPX_EDGES ====================
  describe('mapx_edges', () => {
    it('returns edges when found', async () => {
      storeMocks.queryEdges.mockReturnValue([
        { source_file: 'src/a.ts', target_file: 'src/b.ts', source_symbol: 'funcA', target_symbol: 'funcB', edge_type: 'call', verifiability: 'verified' }
      ]);

      const res = await callTool('mapx_edges');
      const text = getText(res);
      expect(text).toContain('Found 1 matching edges');
      expect(text).toContain('src/a.ts#funcA');
    });

    it('shows inferred suffix for inferred edges', async () => {
      storeMocks.queryEdges.mockReturnValue([
        { source_file: 'src/a.ts', target_file: 'src/b.ts', source_symbol: null, target_symbol: null, edge_type: 'call', verifiability: 'inferred' }
      ]);

      const res = await callTool('mapx_edges');
      expect(getText(res)).toContain('[inferred]');
    });

    it('returns no edges message when empty', async () => {
      storeMocks.queryEdges.mockReturnValue([]);

      const res = await callTool('mapx_edges');
      expect(getText(res)).toContain('No matching edges found');
    });
  });

  // ==================== MAPX_CLUSTERS ====================
  describe('mapx_clusters', () => {
    it('returns cluster listing with tree hierarchy', async () => {
      storeMocks.getClusters.mockReturnValue([
        { name: 'core', source: 'directory', file_count: 5, parent_name: null },
        { name: 'core/utils', source: 'directory', file_count: 3, parent_name: 'core' }
      ]);

      const res = await callTool('mapx_clusters');
      const text = getText(res);
      expect(text).toContain('core');
      expect(text).toContain('2 clusters detected');
    });

    it('filters clusters by source', async () => {
      storeMocks.getClusters.mockReturnValue([
        { name: 'ns1', source: 'namespace', file_count: 3, parent_name: null },
        { name: 'dir1', source: 'directory', file_count: 5, parent_name: null }
      ]);

      const res = await callTool('mapx_clusters', { source: 'namespace' });
      const text = getText(res);
      expect(text).toContain('1 clusters detected');
      expect(text).toContain('1 namespace');
    });

    it('returns specific cluster details with depends-on', async () => {
      storeMocks.getClusters.mockReturnValue([
        { name: 'core', source: 'directory', file_count: 5, parent_name: null }
      ]);
      storeMocks.getClusterFiles.mockReturnValue(['src/main.ts', 'src/app.ts']);
      storeMocks.getClusterEdges.mockReturnValue([
        { sourceCluster: 'core', targetCluster: 'utils', edgeCount: 3, dominantType: 'call' }
      ]);

      const res = await callTool('mapx_clusters', { cluster: 'core' });
      const text = getText(res);
      expect(text).toContain('core');
      expect(text).toContain('src/main.ts');
      expect(text).toContain('Depends on:');
      expect(text).toContain('utils');
    });

    it('returns specific cluster with depended-on-by', async () => {
      storeMocks.getClusters.mockReturnValue([
        { name: 'core', source: 'directory', file_count: 5, parent_name: null }
      ]);
      storeMocks.getClusterFiles.mockReturnValue([]);
      storeMocks.getClusterEdges.mockReturnValue([
        { sourceCluster: 'utils', targetCluster: 'core', edgeCount: 2, dominantType: 'import' }
      ]);

      const res = await callTool('mapx_clusters', { cluster: 'core' });
      const text = getText(res);
      expect(text).toContain('Depended on by:');
      expect(text).toContain('utils');
    });

    it('returns error when specific cluster not found', async () => {
      storeMocks.getClusters.mockReturnValue([]);

      const res = await callTool('mapx_clusters', { cluster: 'nonexistent' });
      expect(getText(res)).toContain('not found');
    });

    it('shows (none) for empty depends-on and depended-on-by', async () => {
      storeMocks.getClusters.mockReturnValue([
        { name: 'isolated', source: 'directory', file_count: 2, parent_name: null }
      ]);
      storeMocks.getClusterFiles.mockReturnValue(['src/iso.ts']);
      storeMocks.getClusterEdges.mockReturnValue([]);

      const res = await callTool('mapx_clusters', { cluster: 'isolated' });
      const text = getText(res);
      expect(text).toContain('(none)');
    });
  });

  // ==================== MAPX_TRACE ====================
  describe('mapx_trace', () => {
    it('returns text format trace', async () => {
      const res = await callTool('mapx_trace', { start: 'MyClass', format: 'text' });
      const text = getText(res);
      expect(text).toContain('Trace:');
      expect(text).toContain('MyClass');
      expect(text).toContain('Nodes:');
    });

    it('returns json format trace', async () => {
      const res = await callTool('mapx_trace', { start: 'MyClass', format: 'json' });
      const text = getText(res);
      const parsed = JSON.parse(text);
      expect(parsed.start).toBeDefined();
      expect(parsed.nodeCount).toBe(0);
    });

    it('returns dot format trace', async () => {
      const res = await callTool('mapx_trace', { start: 'MyClass', format: 'dot' });
      const text = getText(res);
      expect(text).toContain('digraph');
      expect(text).toContain('rankdir=TB');
    });

    it('returns error when start is missing', async () => {
      const res = await callToolRaw('mapx_trace', { dir: '.' });
      expect(getText(res)).toContain('"start" argument is required');
    });
  });

  // ==================== MAPX_SOURCES & SINKS ====================
  describe('mapx_sources and mapx_sinks', () => {
    it('executes mapx_sources', async () => {
      const res = await callTool('mapx_sources');
      expect(getText(res)).toContain('Entry points');
    });

    it('executes mapx_sinks', async () => {
      const res = await callTool('mapx_sinks');
      expect(getText(res)).toContain('Terminal consumers');
    });
  });

  // ==================== MAPX_AGENTS_GENERATE ====================
  describe('mapx_agents_generate', () => {
    it('generates with default provider', async () => {
      const res = await callTool('mapx_agents_generate');
      expect(getText(res)).toContain('AGENTS.md');
    });

    it('generates with specific providers', async () => {
      const res = await callTool('mapx_agents_generate', { providers: ['generic', 'claude'] });
      expect(getText(res)).toContain('AGENTS.md');
    });

    it('generates with all flag', async () => {
      const res = await callTool('mapx_agents_generate', { all: true });
      expect(getText(res)).toBeDefined();
    });
  });

  // ==================== MAPX_ROUTES & HOOKS ====================
  describe('mapx_routes and mapx_hooks', () => {
    it('executes mapx_routes', async () => {
      const res = await callTool('mapx_routes');
      expect(getText(res)).toBeDefined();
    });

    it('executes mapx_hooks', async () => {
      const res = await callTool('mapx_hooks');
      expect(getText(res)).toBeDefined();
    });
  });

  // ==================== MAPX_LANG_LIST/INSTALL/UNINSTALL ====================
  describe('mapx_lang_list, install, uninstall', () => {
    it('lists supported languages', async () => {
      const res = await callTool('mapx_lang_list');
      const text = getText(res);
      expect(text).toContain('Supported languages');
      expect(text).toContain('typescript');
    });

    it('installs a language', async () => {
      const res = await callTool('mapx_lang_install', { lang: 'python' });
      expect(getText(res)).toContain('Successfully installed');
    });

    it('uninstalls a language', async () => {
      const res = await callTool('mapx_lang_uninstall', { lang: 'python' });
      expect(getText(res)).toContain('Successfully uninstalled');
    });

    it('returns error when lang param is missing for install', async () => {
      const res = await callToolRaw('mapx_lang_install', { dir: '.' });
      expect(getText(res)).toContain('Missing "lang" parameter');
    });

    it('returns error when lang param is missing for uninstall', async () => {
      const res = await callToolRaw('mapx_lang_uninstall', { dir: '.' });
      expect(getText(res)).toContain('Missing "lang" parameter');
    });
  });

  // ==================== MAPX_WORKSPACES ====================
  describe('mapx_workspaces', () => {
    it('lists workspaces', async () => {
      const res = await callTool('mapx_workspaces', { action: 'list' });
      const text = getText(res);
      const parsed = JSON.parse(text);
      expect(parsed.repos).toBeDefined();
      expect(parsed.discovered).toBeDefined();
    });

    it('discovers workspaces', async () => {
      const res = await callTool('mapx_workspaces', { action: 'discover' });
      const text = getText(res);
      const parsed = JSON.parse(text);
      expect(parsed.discovered).toBeDefined();
    });
  });

  // ==================== MAPX_BATCH ====================
  describe('mapx_batch', () => {
    it('handles empty operations', async () => {
      const res = await callTool('mapx_batch', { operations: [] });
      expect(getText(res)).toContain('Missing or empty');
    });

    it('handles search operation with results', async () => {
      storeMocks.searchSymbolsFiltered.mockReturnValue([
        { name: 'MyClass', kind: 'class', file_path: 'src/main.ts', start_line: 1, scope: null }
      ]);

      const res = await callTool('mapx_batch', {
        operations: [{ op: 'search', term: 'MyClass' }]
      });
      const text = getText(res);
      expect(text).toContain('Operation 1: search');
      expect(text).toContain('MyClass');
    });

    it('handles search operation with no results', async () => {
      storeMocks.searchSymbolsFiltered.mockReturnValue([]);

      const res = await callTool('mapx_batch', {
        operations: [{ op: 'search', term: 'NonExistentSymbol' }]
      });
      expect(getText(res)).toContain('No symbols matching');
    });

    it('handles node operation with symbol found', async () => {
      storeMocks.getSymbolByName.mockReturnValue({
        name: 'MyClass', kind: 'class', file_path: 'src/main.ts',
        start_line: 1, end_line: 10, scope: null, signature: 'class MyClass'
      });

      const res = await callTool('mapx_batch', {
        operations: [{ op: 'node', symbol: 'MyClass' }]
      });
      const text = getText(res);
      expect(text).toContain('Operation 1: node');
      expect(text).toContain('MyClass');
    });

    it('handles node operation with symbol not found', async () => {
      storeMocks.getSymbolByName.mockReturnValue(undefined);

      const res = await callTool('mapx_batch', {
        operations: [{ op: 'node', symbol: 'NonExistent' }]
      });
      expect(getText(res)).toContain('not found');
    });

    it('handles callers operation with results', async () => {
      storeMocks.getCallersOfSymbol.mockReturnValue([
        { source_file: 'src/a.ts', source_symbol: 'funcA', target_symbol: 'funcB' }
      ]);

      const res = await callTool('mapx_batch', {
        operations: [{ op: 'callers', symbol: 'funcB' }]
      });
      expect(getText(res)).toContain('caller');
    });

    it('handles callers operation with no results', async () => {
      storeMocks.getCallersOfSymbol.mockReturnValue([]);

      const res = await callTool('mapx_batch', {
        operations: [{ op: 'callers', symbol: 'IsolatedFunc' }]
      });
      expect(getText(res)).toContain('No callers found');
    });

    it('handles callees operation with results', async () => {
      storeMocks.getCalleesOfSymbol.mockReturnValue([
        { target_file: 'src/b.ts', target_symbol: 'funcB', source_symbol: 'funcA' }
      ]);

      const res = await callTool('mapx_batch', {
        operations: [{ op: 'callees', symbol: 'funcA' }]
      });
      expect(getText(res)).toContain('callee');
    });

    it('handles callees operation with no results', async () => {
      storeMocks.getCalleesOfSymbol.mockReturnValue([]);

      const res = await callTool('mapx_batch', {
        operations: [{ op: 'callees', symbol: 'IsolatedFunc' }]
      });
      expect(getText(res)).toContain('No callees found');
    });

    it('handles deps operation', async () => {
      const res = await callTool('mapx_batch', {
        operations: [{ op: 'deps', file: 'src/main.ts' }]
      });
      expect(getText(res)).toContain('Operation 1: deps');
    });

    it('handles unknown operation', async () => {
      const res = await callTool('mapx_batch', {
        operations: [{ op: 'unknown_op' }]
      });
      expect(getText(res)).toContain('Unknown operation');
    });

    it('handles exceeding maxItems', async () => {
      const ops = Array.from({ length: 12 }, (_, i) => ({ op: 'search', term: `term${i}` }));
      const res = await callTool('mapx_batch', { operations: ops });
      expect(getText(res)).toContain('Too many operations');
    });

    it('handles multiple operations in sequence', async () => {
      storeMocks.searchSymbolsFiltered.mockReturnValue([
        { name: 'A', kind: 'class', file_path: 'a.ts', start_line: 1, scope: null }
      ]);
      storeMocks.getSymbolByName.mockReturnValue({
        name: 'A', kind: 'class', file_path: 'a.ts', start_line: 1, end_line: 5, scope: null, signature: 'class A'
      });

      const res = await callTool('mapx_batch', {
        operations: [
          { op: 'search', term: 'A' },
          { op: 'node', symbol: 'A' }
        ]
      });
      const text = getText(res);
      expect(text).toContain('Operation 1: search');
      expect(text).toContain('Operation 2: node');
    });
  });

  // ==================== HELPER FUNCTIONS ====================
  describe('helper functions', () => {
    it('getStaleFilesCount returns 0 when files are current', () => {
      const store = new Store(':memory:');
      expect(getStaleFilesCount(store as any, '.')).toBe(0);
    });

    it('getStaleFileNames returns empty array when current', () => {
      const store = new Store(':memory:');
      expect(getStaleFileNames(store as any, '.')).toEqual([]);
    });

    it('getMcpStalenessWarning returns empty when no stale files', () => {
      const store = new Store(':memory:');
      expect(getMcpStalenessWarning(store as any, '.')).toBe('');
    });

    it('checkTryCatch delegates correctly', () => {
      expect(checkTryCatch('try {} catch {}', 1, 1, false)).toBe(false);
    });
  });

  // ==================== DEBUG MODE ====================
  describe('debug mode', () => {
    it('handles debug logging in tool calls', async () => {
      const debugServer = buildServer({ debug: true });
      const debugTransport = new MockTransport();
      await debugServer.connect(debugTransport);

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const id = Math.floor(Math.random() * 1000000);
      const responsePromise = new Promise<any>((resolve) => {
        const interval = setInterval(() => {
          const respIdx = debugTransport.sent.findIndex(m => m.id === id);
          if (respIdx !== -1) {
            clearInterval(interval);
            resolve(debugTransport.sent.splice(respIdx, 1)[0]);
          }
        }, 10);
      });

      debugTransport.receive({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'mapx_scan', arguments: { dir: '.' } }
      });

      await responsePromise;
      expect(stderrSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
    });

    it('handles debug logging for list_tools', async () => {
      const debugServer = buildServer({ debug: true });
      const debugTransport = new MockTransport();
      await debugServer.connect(debugTransport);

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const id = 999;
      const responsePromise = new Promise<any>((resolve) => {
        const interval = setInterval(() => {
          const respIdx = debugTransport.sent.findIndex(m => m.id === id);
          if (respIdx !== -1) {
            clearInterval(interval);
            resolve(debugTransport.sent.splice(respIdx, 1)[0]);
          }
        }, 10);
      });

      debugTransport.receive({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
      await responsePromise;
      expect(stderrSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
    });
  });

  // ==================== UNKNOWN TOOL ====================
  it('handles unknown tool name', async () => {
    const res = await callTool('mapx_nonexistent_tool');
    expect(getText(res)).toContain('Unknown tool');
  });
});
