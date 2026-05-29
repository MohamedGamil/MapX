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
    discoverVSCodeWorkspace: vi.fn().mockReturnValue([])
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

vi.mock('../src/mcp.js', () => ({
  startMcpServer: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../src/core/metrics.js', () => ({
  calculateMetrics: vi.fn().mockReturnValue([
    { path: 'src/main.ts', language: 'typescript', afferentCoupling: 1, efferentCoupling: 2, instability: 0.5 }
  ])
}));

import { buildCLI, getStaleFilesCount, checkAndPrintStaleness, checkTryCatch } from '../src/cli.js';
import { Store } from '../src/core/store.js';

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
});
