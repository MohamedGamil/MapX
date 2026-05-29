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
      return original.readFileSync(path, options);
    },
    writeFileSync: vi.fn(),
    readdirSync: () => [],
    statSync: () => ({ mtimeMs: 100 }),
    rmSync: vi.fn()
  };
});

vi.mock('../src/core/store.js', () => ({
  Store: class {
    getMeta = vi.fn().mockReturnValue('6');
    setMeta = vi.fn();
    getAllFiles = vi.fn().mockReturnValue([{ path: 'src/main.ts', last_scanned: new Date().toISOString() }]);
    raw = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue({ cnt: 0 })
      })
    };
    getAllSymbols = vi.fn().mockReturnValue([]);
    getAllEdges = vi.fn().mockReturnValue([]);
    close = vi.fn();
    queryEdges = vi.fn().mockReturnValue([]);
    searchSymbolsFiltered = vi.fn().mockReturnValue([]);
    getFilesFiltered = vi.fn().mockReturnValue([]);
    getLanguageBreakdown = vi.fn().mockReturnValue({});
    getClusters = vi.fn().mockReturnValue([]);
    listSymbolKinds = vi.fn().mockReturnValue([]);
    searchSymbols = vi.fn().mockReturnValue([]);
    getSymbolCandidatesForFuzzy = vi.fn().mockReturnValue([]);
    getFileCount = vi.fn().mockReturnValue(0);
    getSymbolCount = vi.fn().mockReturnValue(0);
    getEdgeCount = vi.fn().mockReturnValue(0);
    getTopFilesByPageRank = vi.fn().mockReturnValue([]);
    getTopSymbolsByPageRank = vi.fn().mockReturnValue([]);
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

vi.mock('../src/core/fuzzy-matcher.js', () => ({
  findSimilarSymbols: vi.fn().mockReturnValue([])
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

vi.mock('../src/core/metrics.js', () => ({
  calculateMetrics: vi.fn().mockReturnValue([
    { path: 'src/main.ts', language: 'typescript', afferentCoupling: 1, efferentCoupling: 2, instability: 0.5 }
  ])
}));

vi.mock('../src/core/context-builder.js', () => ({
  ContextBuilder: class {
    build = vi.fn().mockResolvedValue({ context: 'context-string', tokenUsage: 100 });
  }
}));

vi.mock('../src/core/flow-tracer.js', () => ({
  FlowTracer: class {
    traceFlow = vi.fn().mockReturnValue([]);
  }
}));

vi.mock('../src/agents/generator.js', () => ({
  AgentGenerator: class {
    generateAll = vi.fn().mockResolvedValue(true);
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

describe('MCP module', () => {
  let server: any;
  let transport: MockTransport;

  beforeEach(async () => {
    mockExists = true;
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

    transport.receive({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: {}
    });

    const res = await responsePromise;
    expect(res.result.tools.length).toBeGreaterThan(0);
  });

  it('executes mapx_scan and mapx_sync', async () => {
    const res1 = await callTool('mapx_scan');
    expect(res1.result.content[0].text).toContain('Scanned 1 files');

    const res2 = await callTool('mapx_sync');
    expect(res2.result.content[0].text).toContain('Updated 1');
  });

  it('executes mapx_query and mapx_search', async () => {
    const res1 = await callTool('mapx_query', { term: 'MyClass' });
    expect(res1.result.content[0].text).toBeDefined();

    const res2 = await callTool('mapx_search', { term: 'MyClass' });
    expect(res2.result.content[0].text).toBeDefined();
  });

  it('executes mapx_dependencies and mapx_export', async () => {
    const res1 = await callTool('mapx_dependencies', { file: 'src/main.ts' });
    expect(res1.result.content[0].text).toBeDefined();

    const res2 = await callTool('mapx_export', { format: 'llm' });
    expect(res2.result.content[0].text).toBeDefined();
  });

  it('executes mapx_status and mapx_metrics', async () => {
    const res1 = await callTool('mapx_status');
    expect(res1.result.content[0].text).toBeDefined();

    const res2 = await callTool('mapx_metrics');
    expect(res2.result.content[0].text).toBeDefined();
  });

  it('executes mapx_edges and mapx_clusters', async () => {
    const res1 = await callTool('mapx_edges');
    expect(res1.result.content[0].text).toBeDefined();

    const res2 = await callTool('mapx_clusters');
    expect(res2.result.content[0].text).toBeDefined();
  });

  it('executes mapx_trace, mapx_sources, mapx_sinks, mapx_impact, mapx_node, mapx_files', async () => {
    await callTool('mapx_trace', { symbol: 'MyClass' });
    await callTool('mapx_sources');
    await callTool('mapx_sinks');
    await callTool('mapx_impact', { symbol: 'MyClass' });
    await callTool('mapx_node', { symbol: 'MyClass' });
    await callTool('mapx_files');
  });

  it('executes mapx_context and mapx_batch', async () => {
    await callTool('mapx_context', { task: 'test task' });
    await callTool('mapx_batch', { operations: [] });
  });

  it('executes mapx_routes and mapx_hooks', async () => {
    await callTool('mapx_routes');
    await callTool('mapx_hooks');
  });

  it('executes mapx_lang_list, mapx_lang_install, mapx_lang_uninstall', async () => {
    await callTool('mapx_lang_list');
    await callTool('mapx_lang_install', { lang: 'python' });
    await callTool('mapx_lang_uninstall', { lang: 'python' });
  });

  it('executes mapx_workspaces', async () => {
    await callTool('mapx_workspaces', { op: 'list' });
  });

  it('handles tool execution failures gracefully when context cannot be loaded', async () => {
    mockExists = false;
    const res = await callTool('mapx_scan');
    expect(res.result.content[0].text).toContain('Mapx not initialized');
  });

  it('performs helper utility checks', () => {
    const store = new Store(':memory:');
    expect(getStaleFilesCount(store as any, '.')).toBe(0);
    expect(getStaleFileNames(store as any, '.')).toEqual([]);
    expect(getMcpStalenessWarning(store as any, '.')).toBe('');
    expect(checkTryCatch('try {} catch {}', 1, 1, false)).toBe(false);
  });
});
