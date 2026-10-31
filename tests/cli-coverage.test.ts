import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { resolve, basename, relative, join } from 'path';
import * as clack from '@clack/prompts';
import { tmpdir } from 'node:os';
import { Scanner } from '../src/core/scanner.js';

// Initialize global variables for mocks before imports
(globalThis as any).mockExists = true;
(globalThis as any).mockIsGitRepo = true;

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (p: string) => {
      if (p.includes('.mapx')) return true;
      if (p.includes('missing-path')) return false;
      // Mark f1.ts...f6.ts and deleted-file.ts as deleted/non-existent
      if (p.includes('deleted-file') || p.match(/f[1-6]\.ts/)) return false;
      return (globalThis as any).mockExists ?? true;
    },
    readFileSync: (p: string, options: any) => {
      if (p.includes('.mapx/config.json')) {
        return JSON.stringify({
          version: '1.0.0',
          repo: { name: 'test-repo', path: '.' },
          repos: [{ name: 'test-repo', path: '.' }],
          languages: {},
          settings: {
            maxTokenBudget: 16384,
            excludePatterns: []
          }
        });
      }
      return '{}';
    },
    writeFileSync: vi.fn(),
    readdirSync: () => ['project.code-workspace'],
    statSync: (p: string) => {
      if (p.includes('cli-coverage.test.ts')) {
        return { mtimeMs: Date.now() + 100000 };
      }
      return { mtimeMs: 100 };
    },
    rmSync: vi.fn()
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: async (p: string, options?: any) => {
      if (p.includes('.mapx/config.json')) {
        return JSON.stringify({
          version: '1.0.0',
          repo: { name: 'test-repo', path: '.' },
          repos: [{ name: 'test-repo', path: '.' }],
          languages: {},
          settings: {
            maxTokenBudget: 16384,
            excludePatterns: []
          }
        });
      }
      return original.readFile(p, options);
    },
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: async (p: string, options?: any) => {
      return ['project.code-workspace'];
    }
  };
});

vi.mock('../src/core/git-tracker.js', () => ({
  isGitRepo: (p: string) => {
    if (p.includes('not-git')) return false;
    return (globalThis as any).mockIsGitRepo ?? true;
  },
  getChangedFiles: () => [],
  getCurrentCommitSha: () => '',
}));

vi.mock('../src/languages/installer.js', () => ({
  isLanguageInstalled: (lang: string) => lang === 'typescript',
  formatLanguageList: () => 'Supported languages (all grammars are bundled):\n  - typescript (.ts | tier: built-in | status: bundled)',
  formatLanguageInfo: (lang: string) => lang,
  installLanguage: vi.fn().mockImplementation((lang: string) => {
    if (lang === 'invalid') throw new Error('Simulated install error');
    return Promise.resolve();
  }),
  uninstallLanguage: vi.fn().mockImplementation((lang: string) => {
    if (lang === 'invalid') throw new Error('Simulated uninstall error');
    return Promise.resolve();
  })
}));

vi.mock('../src/mcp.js', () => ({
  startMcpServer: vi.fn().mockResolvedValue(undefined),
  getStaleFilesCount: () => 0,
  checkAndPrintStaleness: vi.fn(),
}));

vi.mock('../src/ui-server.js', () => ({
  startUiServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/core/workspace-manager.js', () => ({
  WorkspaceManager: {
    discoverSubmodules: () => [
      { name: 'sub1', path: 'packages/sub1', isInitialized: true },
      { name: 'sub2', path: 'packages/sub2', isInitialized: false }
    ],
    discoverPeerRepos: () => [
      { name: 'peer1', path: '../peer1' }
    ],
    discoverVSCodeWorkspace: () => [
      { name: 'vscode1', path: 'src/vscode1' }
    ],
    discoverNestedGitRepos: () => [
      { name: 'nested1', path: 'nested1' }
    ],
    discoverMonorepoPackages: () => [
      { name: 'mono1', path: 'packages/mono1', packageManager: 'npm' }
    ],
  }
}));

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
  multiselect: vi.fn().mockImplementation((opt: any) => {
    return opt.options.map((o: any) => o.value);
  }),
  confirm: vi.fn().mockResolvedValue(true),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}));

vi.mock('../src/core/scanner.js', () => ({
  Scanner: class {
    scanFull() {
      return Promise.resolve({
        filesScanned: 10,
        symbolsFound: 50,
        edgesFound: 100,
        durationMs: 15,
        languageBreakdown: { typescript: 10 }
      });
    }
    scanIncremental() {
      return Promise.resolve({
        filesScanned: 2,
        symbolsFound: 5,
        edgesFound: 10,
        durationMs: 5,
        languageBreakdown: { typescript: 2 }
      });
    }
    abort() {}
  },
  buildMatcher: () => () => true
}));

// Import cli.ts after mocks are set up
import { buildCLI, getStaleFilesCount, checkAndPrintStaleness, checkTryCatch, loadContext } from '../src/cli.js';
import type { Store } from '../src/core/store.js';

describe('CLI Additional Coverage Boost', () => {
  let logSpy: any;
  let errorSpy: any;
  let warnSpy: any;
  let exitSpy: any;

  beforeAll(async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    if (!fs.existsSync('.mapx')) {
      fs.mkdirSync('.mapx', { recursive: true });
    }
  });

  afterAll(async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    if (fs.existsSync('.mapx/mapx.db')) {
      try { fs.unlinkSync('.mapx/mapx.db'); } catch {}
    }
    if (fs.existsSync('.mapx/config.json')) {
      try { fs.unlinkSync('.mapx/config.json'); } catch {}
    }
    try {
      fs.rmdirSync('.mapx');
    } catch {}
  });

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error('exit: ' + code);
    });
    (globalThis as any).mockExists = true;
    (globalThis as any).mockIsGitRepo = true;
  });

  const runCLI = async (args: string[]) => {
    const program = buildCLI();
    program.exitOverride();
    await program.parseAsync(['node', 'mapx', ...args]);
  };

  it('covers catch block in getStaleFilesCount', () => {
    const mockStore = {
      getAllFiles: () => {
        throw new Error('Database error');
      }
    } as unknown as Store;

    expect(getStaleFilesCount(mockStore, '.')).toBe(0);
  });

  it('covers checkAndPrintStaleness warning and deleted files list', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'tests/cli-coverage.test.ts', last_scanned: '2000-01-01' },
        { path: 'deleted-file.ts', last_scanned: '2000-01-01' }
      ]
    } as unknown as Store;

    // A non-git directory, so the repo's own untracked files never leak into the count.
    checkAndPrintStaleness(mockStore, tmpdir());

    expect(warnSpy).toHaveBeenCalled();
    const calls = warnSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(calls).toContain('index may be stale');
    expect(calls).toContain('tests/cli-coverage.test.ts');
    expect(calls).toContain('deleted-file.ts (deleted)');
  });

  it('covers checkAndPrintStaleness with more than 5 stale files', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'tests/cli-coverage.test.ts', last_scanned: '2000-01-01' },
        { path: 'f1.ts', last_scanned: '2000-01-01' },
        { path: 'f2.ts', last_scanned: '2000-01-01' },
        { path: 'f3.ts', last_scanned: '2000-01-01' },
        { path: 'f4.ts', last_scanned: '2000-01-01' },
        { path: 'f5.ts', last_scanned: '2000-01-01' },
        { path: 'f6.ts', last_scanned: '2000-01-01' }
      ]
    } as unknown as Store;

    // A non-git directory, so the repo's own untracked files never leak into the count.
    checkAndPrintStaleness(mockStore, tmpdir());

    expect(warnSpy).toHaveBeenCalled();
    const calls = warnSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(calls).toContain('and 2 more');
  });

  it('covers checkTryCatch basic cases', () => {
    expect(checkTryCatch('try { doSomething(); } catch (e) {}', 1, 1, false)).toBe(false);
  });

  // Test workspaces add command logic
  it('runs workspaces add on non-existent path', async () => {
    await expect(runCLI(['workspaces', 'add', 'missing-path'])).rejects.toThrow('exit: 1');
  });

  it('runs workspaces add on non-git path', async () => {
    await expect(runCLI(['workspaces', 'add', 'not-git'])).rejects.toThrow('exit: 1');
  });

  it('runs workspaces add successfully', async () => {
    await runCLI(['workspaces', 'add', 'valid-git-path']);
  });

  it('runs workspaces add with duplicate registration', async () => {
    await runCLI(['workspaces', 'add', '.', '--name', 'test-repo']);
  });

  // Test workspaces discover and sync command logic with mocked WorkspaceManager outputs
  it('runs workspaces discover with items', async () => {
    await runCLI(['workspaces', 'discover']);
    expect(logSpy).toHaveBeenCalled();
  });

  it('runs workspaces sync with items', async () => {
    await runCLI(['workspaces', 'sync']);
    expect(logSpy).toHaveBeenCalled();
  });

  it('covers various other CLI subcommands', async () => {
    // 1. lang list
    await runCLI(['lang', 'list']);
    expect(logSpy).toHaveBeenCalled();

    // 2. lang install & uninstall success paths
    await runCLI(['lang', 'install', 'typescript']);
    await runCLI(['lang', 'uninstall', 'typescript']);

    // 3. lang install & uninstall failure paths
    await expect(runCLI(['lang', 'install', 'invalid'])).rejects.toThrow('exit: 1');
    await expect(runCLI(['lang', 'uninstall', 'invalid'])).rejects.toThrow('exit: 1');

    // 4. serve subcommand configurations
    await runCLI(['serve']);
    await runCLI(['serve', '--sse', '--port', '4000']);
    await runCLI(['serve', '--ui', '--ui-port', '4001', '--ui-host', '127.0.0.1', '--ui-token', 'abc']);

    // 5. ui subcommand configurations
    await runCLI(['ui', '--port', '4002', '--host', '127.0.0.1', '--token', 'def', '--no-open']);
  });

  it('covers scan and update command error paths and SIGINT', async () => {
    // 1. scan command with lock error
    const scanFullSpy = vi.spyOn(Scanner.prototype, 'scanFull').mockRejectedValueOnce(new Error('Another scan is already running (PID 123)'));
    await expect(runCLI(['scan'])).rejects.toThrow('exit: 1');
    scanFullSpy.mockRestore();

    // 2. scan command with generic error
    const scanFullSpy2 = vi.spyOn(Scanner.prototype, 'scanFull').mockRejectedValueOnce(new Error('Generic scan error'));
    await expect(runCLI(['scan'])).rejects.toThrow('Generic scan error');
    scanFullSpy2.mockRestore();

    // 3. scan command interrupted result
    const scanFullSpy3 = vi.spyOn(Scanner.prototype, 'scanFull').mockResolvedValueOnce({
      filesScanned: 5,
      totalFiles: 10,
      symbolsFound: 20,
      edgesFound: 50,
      durationMs: 100,
      languageBreakdown: {},
      interrupted: true
    });
    await runCLI(['scan']);
    scanFullSpy3.mockRestore();

    // 4. scan command SIGINT trigger
    let sigintHandler: any = null;
    const processOnceSpy = vi.spyOn(process, 'once').mockImplementation((event, cb) => {
      if (event === 'SIGINT') sigintHandler = cb;
      return process;
    });
    const scanFullSpy4 = vi.spyOn(Scanner.prototype, 'scanFull').mockImplementationOnce(async () => {
      if (sigintHandler) sigintHandler();
      return {
        filesScanned: 0,
        symbolsFound: 0,
        edgesFound: 0,
        durationMs: 0,
        languageBreakdown: {},
        interrupted: true
      };
    });
    await runCLI(['scan']);
    processOnceSpy.mockRestore();
    scanFullSpy4.mockRestore();

    // 5. update command with lock error
    const scanIncSpy = vi.spyOn(Scanner.prototype, 'scanIncremental').mockRejectedValueOnce(new Error('Another scan is already running (PID 123)'));
    await expect(runCLI(['update'])).rejects.toThrow('exit: 1');
    scanIncSpy.mockRestore();

    // 6. update command with generic error
    const scanIncSpy2 = vi.spyOn(Scanner.prototype, 'scanIncremental').mockRejectedValueOnce(new Error('Generic update error'));
    await expect(runCLI(['update'])).rejects.toThrow('Generic update error');
    scanIncSpy2.mockRestore();

    // 7. update command interrupted result
    const scanIncSpy3 = vi.spyOn(Scanner.prototype, 'scanIncremental').mockResolvedValueOnce({
      filesScanned: 5,
      totalFiles: 10,
      symbolsFound: 20,
      edgesFound: 50,
      durationMs: 100,
      languageBreakdown: {},
      interrupted: true
    });
    await runCLI(['update']);
    scanIncSpy3.mockRestore();
  });

  it('covers all read/query CLI commands with test data', async () => {
    const { store } = await loadContext('.');
    store.inTransaction(() => {
      store.raw.exec('DELETE FROM symbols');
      store.raw.exec('DELETE FROM edges');
      store.raw.exec('DELETE FROM files');
      store.raw.exec('DELETE FROM classification_signals');
      store.raw.exec('DELETE FROM cluster_metrics');
      store.raw.exec('DELETE FROM arch_smells');

      store.upsertFile({
        path: 'src/main.ts',
        repo: 'test-repo',
        language: 'typescript',
        gitBlobHash: null,
        contentHash: null,
        lastScanned: new Date().toISOString(),
        sizeBytes: 100,
        lines: 10
      });
      store.insertSymbol({
        filePath: 'src/main.ts',
        repo: 'test-repo',
        name: 'myFunc',
        kind: 'function',
        scope: null,
        signature: 'myFunc()',
        startLine: 1,
        endLine: 10,
        metadata: '{}'
      });
      store.insertClassificationSignal({
        filePath: 'src/main.ts',
        repo: 'test-repo',
        source: 'framework',
        role: 'api',
        confidence: 0.9,
        reason: 'reason'
      });
      store.insertArchSmell({
        repo: 'test-repo',
        type: 'cyclic-dependency',
        severity: 'high',
        description: 'desc',
        involvedFiles: ['src/main.ts'],
        involvedClusters: ['c1'],
        suggestion: 'sug'
      });
    });

    await runCLI(['summary']);
    await runCLI(['status']);
    await runCLI(['query', 'myFunc']);
    await runCLI(['query', 'nonExistentSym']);
    await runCLI(['search', 'myFunc']);
    await runCLI(['search', 'myFunc', '--format', 'json']);
    await runCLI(['explain', 'src/main.ts']);
    await runCLI(['layers']);
    await runCLI(['metrics']);
    await runCLI(['clusters']);
    await runCLI(['edges']);
    await runCLI(['routes']);
    await runCLI(['hooks']);
    await runCLI(['profile']);
    await runCLI(['arch']);
    await runCLI(['export', '--format', 'dot']);
    await runCLI(['export', '--format', 'svg']);
    await runCLI(['trace', 'myFunc']);
  });

  it('covers remaining CLI command subcommands', async () => {
    await runCLI(['agents', 'list']);

    const oldTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await runCLI(['agents', 'generate', '--providers', 'generic,copilot']);
      await runCLI(['agents', 'generate', '--all', '--dry-run']);
    } finally {
      process.stdin.isTTY = oldTTY;
    }

    process.stdin.isTTY = true;
    try {
      vi.mocked(clack.multiselect).mockResolvedValueOnce(Symbol('cancel'));
      vi.mocked(clack.isCancel).mockReturnValueOnce(true);
      await expect(runCLI(['agents', 'generate'])).rejects.toThrow('exit: 0');
    } finally {
      process.stdin.isTTY = oldTTY;
    }

    await runCLI(['agents', 'update']);

    await runCLI(['agents', 'mcp', '--detect']);
    await runCLI(['agents', 'mcp', '--all', '--dry-run']);
    await runCLI(['agents', 'mcp', '--tools', 'cursor-mcp']);
  });
});
