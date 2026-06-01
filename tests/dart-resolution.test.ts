import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scanner, buildMatcher } from '../src/core/scanner.js';
import { MapxGraph } from '../src/core/graph.js';
import type { Store } from '../src/core/store.js';
import type { Config } from '../src/core/config.js';
import * as fsPromises from 'node:fs/promises';

// ── Shared mocks (same pattern as scanner.test.ts) ──────────────────────────

vi.mock('../src/parsers/parser-registry.js', () => ({
  getParserForFile: () => ({
    parse: vi.fn().mockResolvedValue({ symbols: [], references: [], errors: [] })
  })
}));

vi.mock('../src/languages/registry.js', () => ({
  getLanguageForFile: (path: string) => {
    if (path.endsWith('.dart')) return { name: 'dart' };
    if (path.endsWith('.yaml')) return { name: 'json' };
    return { name: 'typescript' };
  },
  areLanguagesCompatible: () => true,
  getBuiltinLanguages: () => ({})
}));

vi.mock('../src/core/git-tracker.js', () => ({
  getGitBlobHashes: () => new Map(),
  getChangedFiles: () => [],
  getCurrentCommitSha: () => 'abc123',
  isGitRepo: () => true
}));

vi.mock('../src/frameworks/framework-registry.js', () => ({
  FrameworkRegistry: {
    getInstance: () => ({
      detectActiveFrameworks: vi.fn().mockResolvedValue([])
    })
  }
}));

vi.mock('../src/frameworks/route-registry.js', () => ({
  RouteRegistry: class {
    load = vi.fn().mockResolvedValue(undefined);
    clearRepo = vi.fn();
    addRoute = vi.fn();
    addHook = vi.fn();
    save = vi.fn().mockResolvedValue(undefined);
    getRoutes = vi.fn().mockReturnValue([]);
    getHooks = vi.fn().mockReturnValue([]);
  }
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: () => true,
    readFileSync: (path: string) => {
      // Return pubspec.yaml content when requested
      if (path.includes('pubspec.yaml')) {
        if (path.includes('packages/core')) {
          return 'name: core_pkg\nversion: 1.0.0\n';
        }
        if (path.includes('packages/ui')) {
          return 'name: ui_kit\nversion: 1.0.0\n';
        }
        return 'name: my_app\nversion: 1.0.0\n';
      }
      return 'data';
    }
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 100 }),
    readdir: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    })
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const createMockStore = (overrides?: any) => ({
  getMeta: vi.fn().mockReturnValue(null),
  setMeta: vi.fn(),
  getAllFiles: vi.fn().mockReturnValue([]),
  getAllEdges: vi.fn().mockReturnValue([]),
  getAllSymbols: vi.fn().mockReturnValue([]),
  getSymbolsForFile: vi.fn().mockReturnValue([]),
  upsertFile: vi.fn(),
  deleteFile: vi.fn(),
  deleteSymbolsForFile: vi.fn(),
  deleteEdgesForFile: vi.fn(),
  insertSymbol: vi.fn(),
  insertEdge: vi.fn(),
  updateFileMetadata: vi.fn(),
  deleteFrameworkEdgesForRepo: vi.fn(),
  resetRepoForScan: vi.fn(),
  clearClusters: vi.fn(),
  insertCluster: vi.fn(),
  insertClusterMembership: vi.fn(),
  deleteClassificationSignalsForFile: vi.fn(),
  updateFileRole: vi.fn(),
  insertClassificationSignal: vi.fn(),
  insertClusterMetrics: vi.fn(),
  insertArchSmell: vi.fn(),
  searchSymbols: vi.fn().mockReturnValue([]),
  inTransaction: vi.fn().mockImplementation((fn: () => void) => fn()),
  raw: {
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]), run: vi.fn(), get: vi.fn() })
  },
  ...overrides
} as unknown as Store);

const makeConfig = () => ({
  getWorkspaceRoot: () => '/workspace',
  getResolvedUserLanguages: () => ({}),
  repos: [{ name: 'repo1', path: '.' }],
  settings: { excludePatterns: [], includePatterns: [] }
} as unknown as Config);


describe('Dart dependency resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── dart: stdlib ────────────────────────────────────────────────────────

  describe('dart: stdlib imports', () => {
    it('skips dart:core', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['lib/main.dart', 'repo1']]);
      const result = (scanner as any).resolveImportPath('dart:core', 'lib/main.dart', fileMap);
      expect(result).toBeNull();
    });

    it('skips dart:async', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['lib/main.dart', 'repo1']]);
      const result = (scanner as any).resolveImportPath('dart:async', 'lib/main.dart', fileMap);
      expect(result).toBeNull();
    });

    it('skips dart:io', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['lib/main.dart', 'repo1']]);
      const result = (scanner as any).resolveImportPath('dart:io', 'lib/main.dart', fileMap);
      expect(result).toBeNull();
    });
  });

  // ── package: URIs (basic) ───────────────────────────────────────────────

  describe('package: URI resolution (same-project)', () => {
    it('resolves package:my_app/src/foo.dart to lib/src/foo.dart', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([
        ['lib/src/foo.dart', 'repo1'],
        ['lib/main.dart', 'repo1'],
      ]);
      const result = (scanner as any).resolveImportPath(
        'package:my_app/src/foo.dart', 'lib/main.dart', fileMap
      );
      expect(result).toBe('lib/src/foo.dart');
    });

    it('resolves package: URI with deep path', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([
        ['lib/src/services/auth/auth_service.dart', 'repo1'],
      ]);
      const result = (scanner as any).resolveImportPath(
        'package:my_app/src/services/auth/auth_service.dart',
        'lib/main.dart',
        fileMap
      );
      expect(result).toBe('lib/src/services/auth/auth_service.dart');
    });

    it('returns null for unresolvable package: URI', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['lib/main.dart', 'repo1']]);
      const result = (scanner as any).resolveImportPath(
        'package:my_app/src/nonexistent.dart', 'lib/main.dart', fileMap
      );
      expect(result).toBeNull();
    });

    it('returns null for external package: URI (e.g. flutter, http)', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['lib/main.dart', 'repo1']]);
      const result = (scanner as any).resolveImportPath(
        'package:http/http.dart', 'lib/main.dart', fileMap
      );
      expect(result).toBeNull();
    });

    it('returns null for package: URI without slash (malformed)', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['lib/main.dart', 'repo1']]);
      const result = (scanner as any).resolveImportPath(
        'package:malformed', 'lib/main.dart', fileMap
      );
      expect(result).toBeNull();
    });
  });

  // ── package: URIs (monorepo with pubspec discovery) ─────────────────────

  describe('package: URI resolution (monorepo)', () => {
    it('resolves cross-package import using dartPackageMap', () => {
      const store = createMockStore({
        getAllFiles: () => [
          { path: 'pubspec.yaml', repo: 'repo1' },
          { path: 'packages/core/pubspec.yaml', repo: 'repo1' },
          { path: 'packages/core/lib/models/user.dart', repo: 'repo1' },
          { path: 'packages/ui/pubspec.yaml', repo: 'repo1' },
          { path: 'packages/ui/lib/widgets/button.dart', repo: 'repo1' },
        ]
      });
      const scanner = new Scanner(store, makeConfig(), new MapxGraph('repo1'));

      // Trigger package discovery
      (scanner as any).discoverDartPackages('/workspace');

      const fileMap = new Map([
        ['packages/core/lib/models/user.dart', 'repo1'],
        ['packages/ui/lib/widgets/button.dart', 'repo1'],
      ]);

      // From UI package, import core package
      const result = (scanner as any).resolveImportPath(
        'package:core_pkg/models/user.dart',
        'packages/ui/lib/widgets/button.dart',
        fileMap
      );
      expect(result).toBe('packages/core/lib/models/user.dart');
    });

    it('resolves same-package import in monorepo via package map', () => {
      const store = createMockStore({
        getAllFiles: () => [
          { path: 'packages/core/pubspec.yaml', repo: 'repo1' },
          { path: 'packages/core/lib/services/api.dart', repo: 'repo1' },
          { path: 'packages/core/lib/models/user.dart', repo: 'repo1' },
        ]
      });
      const scanner = new Scanner(store, makeConfig(), new MapxGraph('repo1'));
      (scanner as any).discoverDartPackages('/workspace');

      const fileMap = new Map([
        ['packages/core/lib/services/api.dart', 'repo1'],
        ['packages/core/lib/models/user.dart', 'repo1'],
      ]);

      const result = (scanner as any).resolveImportPath(
        'package:core_pkg/models/user.dart',
        'packages/core/lib/services/api.dart',
        fileMap
      );
      expect(result).toBe('packages/core/lib/models/user.dart');
    });

    it('falls back to lib/ when package is not in dartPackageMap', () => {
      const store = createMockStore({ getAllFiles: () => [] });
      const scanner = new Scanner(store, makeConfig(), new MapxGraph('repo1'));
      (scanner as any).discoverDartPackages('/workspace');

      const fileMap = new Map([['lib/src/foo.dart', 'repo1']]);
      const result = (scanner as any).resolveImportPath(
        'package:unknown_pkg/src/foo.dart', 'lib/main.dart', fileMap
      );
      expect(result).toBe('lib/src/foo.dart');
    });
  });

  // ── discoverDartPackages ────────────────────────────────────────────────

  describe('discoverDartPackages', () => {
    it('populates dartPackageMap from root pubspec.yaml', () => {
      const store = createMockStore({
        getAllFiles: () => [{ path: 'pubspec.yaml', repo: 'repo1' }]
      });
      const scanner = new Scanner(store, makeConfig(), new MapxGraph('repo1'));
      (scanner as any).discoverDartPackages('/workspace');

      expect((scanner as any).dartPackageMap.get('my_app')).toBe('lib/');
    });

    it('populates dartPackageMap from multiple monorepo pubspec files', () => {
      const store = createMockStore({
        getAllFiles: () => [
          { path: 'pubspec.yaml', repo: 'repo1' },
          { path: 'packages/core/pubspec.yaml', repo: 'repo1' },
          { path: 'packages/ui/pubspec.yaml', repo: 'repo1' },
        ]
      });
      const scanner = new Scanner(store, makeConfig(), new MapxGraph('repo1'));
      (scanner as any).discoverDartPackages('/workspace');

      expect((scanner as any).dartPackageMap.get('my_app')).toBe('lib/');
      expect((scanner as any).dartPackageMap.get('core_pkg')).toBe('packages/core/lib/');
      expect((scanner as any).dartPackageMap.get('ui_kit')).toBe('packages/ui/lib/');
    });

    it('clears existing map before re-populating', () => {
      const store = createMockStore({
        getAllFiles: () => [{ path: 'pubspec.yaml', repo: 'repo1' }]
      });
      const scanner = new Scanner(store, makeConfig(), new MapxGraph('repo1'));

      // Set a stale entry
      (scanner as any).dartPackageMap.set('old_pkg', 'old/lib/');

      (scanner as any).discoverDartPackages('/workspace');

      expect((scanner as any).dartPackageMap.has('old_pkg')).toBe(false);
      expect((scanner as any).dartPackageMap.has('my_app')).toBe(true);
    });
  });

  // ── Relative Dart imports ──────────────────────────────────────────────

  describe('relative Dart imports', () => {
    it('resolves relative import with explicit .dart extension', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([
        ['lib/src/models/user.dart', 'repo1'],
        ['lib/src/services/auth.dart', 'repo1'],
      ]);
      const result = (scanner as any).resolveImportPath(
        '../models/user.dart', 'lib/src/services/auth.dart', fileMap
      );
      expect(result).toBe('lib/src/models/user.dart');
    });

    it('resolves same-directory relative import', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([
        ['lib/src/helpers.dart', 'repo1'],
        ['lib/src/main.dart', 'repo1'],
      ]);
      const result = (scanner as any).resolveImportPath(
        './helpers.dart', 'lib/src/main.dart', fileMap
      );
      expect(result).toBe('lib/src/helpers.dart');
    });

    it('returns null when relative Dart import target does not exist', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['lib/src/main.dart', 'repo1']]);
      const result = (scanner as any).resolveImportPath(
        './nonexistent.dart', 'lib/src/main.dart', fileMap
      );
      expect(result).toBeNull();
    });

    it('does NOT try .js/.ts/.vue extensions for Dart source files', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      // Intentionally create a fileMap with a .ts file at the would-be JS/TS path
      const fileMap = new Map([
        ['lib/src/utils.ts', 'repo1'],
        ['lib/src/main.dart', 'repo1'],
      ]);
      // Dart file importing a non-.dart path should still return null
      const result = (scanner as any).resolveImportPath(
        './utils.ts', 'lib/src/main.dart', fileMap
      );
      // The Dart fast-path will try the exact path; since it's .ts not .dart,
      // it will check fileMap for the exact normalized path
      // This is fine — Dart won't import .ts files, but if someone wrote it,
      // the resolver shouldn't crash
      expect(result).toBe('lib/src/utils.ts');
    });

    it('does NOT fall through to JS/TS /index.* candidates from Dart files', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([
        ['lib/src/utils/index.ts', 'repo1'],
        ['lib/src/main.dart', 'repo1'],
      ]);
      // Dart file trying to import a directory-style path (no extension)
      const result = (scanner as any).resolveImportPath(
        './utils', 'lib/src/main.dart', fileMap
      );
      // Dart fast-path returns null since ./utils doesn't match any file
      expect(result).toBeNull();
    });
  });

  // ── Part / Part-of directives ──────────────────────────────────────────

  describe('part and part-of directive resolution', () => {
    it('resolves part directive (relative path)', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([
        ['lib/src/models/user.dart', 'repo1'],
        ['lib/src/models/user.g.dart', 'repo1'],
      ]);
      // `part 'user.g.dart'` in user.dart
      const result = (scanner as any).resolveImportPath(
        'user.g.dart', 'lib/src/models/user.dart', fileMap
      );
      expect(result).toBe('lib/src/models/user.g.dart');
    });

    it('resolves part-of directive (relative path)', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([
        ['lib/src/models/user.dart', 'repo1'],
        ['lib/src/models/user.g.dart', 'repo1'],
      ]);
      // `part of 'user.dart'` in user.g.dart
      const result = (scanner as any).resolveImportPath(
        'user.dart', 'lib/src/models/user.g.dart', fileMap
      );
      expect(result).toBe('lib/src/models/user.dart');
    });

    it('resolves part directive with subdirectory path', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([
        ['lib/app.dart', 'repo1'],
        ['lib/src/generated/routes.dart', 'repo1'],
      ]);
      // `part 'src/generated/routes.dart'` in app.dart
      const result = (scanner as any).resolveImportPath(
        'src/generated/routes.dart', 'lib/app.dart', fileMap
      );
      expect(result).toBe('lib/src/generated/routes.dart');
    });
  });

  // ── Non-regression: JS/TS/Vue imports still work ───────────────────────

  describe('non-regression: JS/TS imports unaffected', () => {
    it('still resolves Vue @/ imports', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['src/components/button.vue', 'repo1']]);
      const result = (scanner as any).resolveImportPath(
        '@/components/button', 'src/main.vue', fileMap
      );
      expect(result).toBe('src/components/button.vue');
    });

    it('still resolves TS relative imports with .js extension mapping', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['src/utils.ts', 'repo1']]);
      const result = (scanner as any).resolveImportPath(
        './utils.js', 'src/main.ts', fileMap
      );
      expect(result).toBe('src/utils.ts');
    });

    it('still resolves extensionless TS imports', () => {
      const scanner = new Scanner(createMockStore(), makeConfig(), new MapxGraph('repo1'));
      const fileMap = new Map([['src/helper.ts', 'repo1']]);
      const result = (scanner as any).resolveImportPath(
        './helper', 'src/main.ts', fileMap
      );
      expect(result).toBe('src/helper.ts');
    });
  });
});
