import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { MapxConfig, RepoConfig, UserLanguageDefinition } from '../types.js';
import type { LanguageDefinition } from '../languages/registry.js';

/** Laravel noise excluded by default for `framework: laravel` repos (F10), relative to the repo root. */
export const LARAVEL_DEFAULT_EXCLUDES = [
  'database/migrations/**',
  'database/seeders/**',
  'database/factories/**',
  'storage/**',
  'bootstrap/cache/**',
  'public/**',
  'resources/views/**',
  '**/*.blade.php',
  'vendor/**',
];
import { getBuiltinLanguages } from '../languages/registry.js';
import { canonicalPath } from './workspace-manager.js';

export interface CollapsedRepo {
  dropped: RepoConfig;
  kept: RepoConfig;
}

/** Removes repo entries whose folder (symlinks resolved) an earlier entry already names; returns them. */
function collapseDuplicateRepos(config: MapxConfig, workspaceRoot: string): CollapsedRepo[] {
  if (!Array.isArray(config.repos)) return [];
  const byKey = new Map<string, RepoConfig>();
  const collapsed: CollapsedRepo[] = [];
  config.repos = config.repos.filter(repo => {
    const key = canonicalPath(resolve(workspaceRoot, repo.path));
    const kept = byKey.get(key);
    if (kept) {
      collapsed.push({ dropped: repo, kept });
      return false;
    }
    byKey.set(key, repo);
    return true;
  });
  return collapsed;
}

const DEFAULT_CONFIG: MapxConfig = {
  version: '1.0.0',
  repos: [],
  languages: {},
  settings: {
    maxTokenBudget: 16384,
    excludePatterns: [
      '.git/**',
      '.mapx/**',
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      'vendor/**',
      '**/vendor/**',
      'Vendor/**',
      '**/Vendor/**',
      '__pycache__/**',
      '**/__pycache__/**',
      '.venv/**',
      '.next/**',
      'res/**',
      '**/res/**',
      'gradle/**',
      '**/gradle/**',
      'build/**',
      '**/build/**',
      '*.min.js',
      '*.min.css',
      'monaco/vs/**/*.js',
      'bootstrap-*/bootstrap.js',
      'bootstrap-*/bootstrap.min.js',
      'bootstrap-*/bootstrap.bundle.js',
      'bootstrap-*/bootstrap.bundle.min.js',
      'vue.global.js',
      'vue.esm-browser.js',
      'vue.runtime.esm-browser.js',
      'vue.runtime.esm-browser.prod.js',
      'react.development.js',
      'react.production.min.js',
      'react-dom.development.js',
      'react-dom.production.min.js',
      'package.json',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'composer.json',
      'composer.lock',
      'pyproject.toml',
      'Pipfile',
      'Pipfile.lock',
      'poetry.lock',
      'go.mod',
      'go.sum',
      'Cargo.toml',
      'Cargo.lock',
      'bun.lock',
      'AndroidManifest.xml',
      'AndroidManifest.xml',
      '**/*.log',
      '**/*.lock',
      '**/*.tmp',
      '**/*.swp',
      '**/*.swo',
      '**/*.DS_Store',
    ],
    includePatterns: [],
    graphExcludePatterns: ['scratch/**', 'benchmarks/**', 'tests/**', '**/*.test.*', '**/*.spec.*'],
  },
};

export class Config {
  private configPath: string;
  private config: MapxConfig;
  /** Entries `load` dropped because an earlier entry names the same folder (M0-10-R3). */
  private collapsed: CollapsedRepo[] = [];

  private constructor(configPath: string, config: MapxConfig) {
    this.configPath = configPath;
    this.config = config;
  }

  static async load(workspaceRoot: string): Promise<Config> {
    const configPath = join(workspaceRoot, '.mapx', 'config.json');
    const mapxDir = join(workspaceRoot, '.mapx');

    if (!existsSync(configPath)) {
      await mkdir(mapxDir, { recursive: true });
      const defaultConfig = {
        ...DEFAULT_CONFIG,
        repos: [{
          name: resolve(workspaceRoot).split('/').pop() || 'default',
          path: '.',
        }],
      };
      await writeFile(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
      return new Config(configPath, defaultConfig);
    }

    const data = await readFile(configPath, 'utf-8');
    const config = JSON.parse(data) as MapxConfig;
    const loaded = new Config(configPath, config);
    // Configs written before M0-10-R2's de-dup, or by hand, can name one folder twice (a symlink,
    // another spelling): keep the first entry and save, so the folder is not indexed twice (M0-10-R3).
    loaded.collapsed = collapseDuplicateRepos(config, workspaceRoot);
    if (loaded.collapsed.length) await loaded.save();
    return loaded;
  }

  static async init(
    workspaceRoot: string,
    repoName?: string,
    isLaravel = false,
    shouldAddLaravelExcludes = false
  ): Promise<Config> {
    const mapxDir = join(workspaceRoot, '.mapx');
    await mkdir(mapxDir, { recursive: true });

    const configPath = join(mapxDir, 'config.json');

    // Read and merge existing config if present, preserving user customisations
    let existing: MapxConfig | null = null;
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(await readFile(configPath, 'utf-8')) as MapxConfig;
      } catch {
        existing = null; // corrupt file — overwrite cleanly
      }
    }

    const defaultExclude = [...DEFAULT_CONFIG.settings.excludePatterns];

    if (shouldAddLaravelExcludes) {
      for (const pattern of LARAVEL_DEFAULT_EXCLUDES) {
        if (!defaultExclude.includes(pattern)) {
          defaultExclude.push(pattern);
        }
      }
    } else {
      let isPHP = false;
      let isJSTS = false;
      try {
        const rootFiles = await readdir(workspaceRoot);
        for (const file of rootFiles) {
          if (file === 'composer.json' || file.endsWith('.php')) {
            isPHP = true;
          }
          if (
            file === 'package.json' ||
            file === 'tsconfig.json' ||
            file.endsWith('.ts') ||
            file.endsWith('.js') ||
            file.endsWith('.tsx') ||
            file.endsWith('.jsx')
          ) {
            isJSTS = true;
          }
        }
      } catch {
        // ignore readdir errors
      }

      if (isPHP) {
        defaultExclude.push('**/migrations/**', '**/seeds/**', '**/storage/**');
      }
      if (isJSTS) {
        defaultExclude.push('**/dist/**', '**/__tests__/**', '**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*.spec.tsx');
      }
    }

    // User patterns come first (higher priority); add any default patterns the
    // user hasn't already covered, then deduplicate the merged list.
    const userExclude = existing?.settings?.excludePatterns ?? [];
    const userInclude = existing?.settings?.includePatterns ?? [];
    const mergedExclude = [...new Set([...userExclude, ...defaultExclude.filter(p => !userExclude.includes(p))])];
    const mergedInclude = [...new Set([...userInclude, ...DEFAULT_CONFIG.settings.includePatterns])];

    const userGraphExclude = existing?.settings?.graphExcludePatterns ?? [];
    const defaultGraphExclude = DEFAULT_CONFIG.settings.graphExcludePatterns ?? [];
    const mergedGraphExclude = [...new Set([...userGraphExclude, ...defaultGraphExclude.filter(p => !userGraphExclude.includes(p))])];

    const defaultRepoName = repoName || resolve(workspaceRoot).split('/').pop() || 'default';
    // Keep existing repos; ensure there is at least the default entry
    const existingRepos: RepoConfig[] = existing?.repos ?? [];
    const repos: RepoConfig[] = existingRepos.length > 0
      ? existingRepos
      : [{
          name: defaultRepoName,
          path: '.',
          ...(isLaravel ? { framework: 'laravel' } : {}),
        }];

    if (repos[0] && isLaravel) {
      repos[0].framework = 'laravel';
    }

    const config: MapxConfig = {
      version: existing?.version ?? DEFAULT_CONFIG.version,
      repos,
      languages: existing?.languages ?? {},
      settings: {
        maxTokenBudget: existing?.settings?.maxTokenBudget ?? DEFAULT_CONFIG.settings.maxTokenBudget,
        excludePatterns: mergedExclude,
        includePatterns: mergedInclude,
        graphExcludePatterns: mergedGraphExclude,
        // A declined suggestion is remembered, so scans don't re-apply the Laravel excludes (F10).
        ...(isLaravel && !shouldAddLaravelExcludes ? { laravelDefaultExcludes: false } : {}),
        ...(existing?.settings?.laravelDefaultExcludes !== undefined && !(isLaravel && !shouldAddLaravelExcludes)
          ? { laravelDefaultExcludes: existing.settings.laravelDefaultExcludes } : {}),
      },
    };

    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return new Config(configPath, config);
  }

  async save(): Promise<void> {
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  get repos(): RepoConfig[] {
    return this.config.repos;
  }

  get settings() {
    return this.config.settings;
  }

  get languages(): Record<string, UserLanguageDefinition> {
    return this.config.languages;
  }

  getResolvedUserLanguages(): Record<string, LanguageDefinition> {
    const result: Record<string, LanguageDefinition> = {};
    const builtins = getBuiltinLanguages();

    for (const [name, userDef] of Object.entries(this.config.languages)) {
      if (builtins[name]) continue; // skip overrides for now
      result[name] = {
        name,
        extensions: userDef.extensions,
        grammarWasm: userDef.grammarWasm,
        queries: {
          symbols: userDef.queries.symbols || '',
          references: userDef.queries.references || '',
        },
        nodeMappings: userDef.nodeMappings as any,
        tier: 'user',
      };
    }

    return result;
  }

  /** Registers a repo unless its folder is already registered, under any spelling or symlink (M0-10-R2). */
  addRepo(name: string, path: string): boolean {
    const root = this.getWorkspaceRoot();
    const key = canonicalPath(resolve(root, path));
    if (this.config.repos.some(r => r.path === path || canonicalPath(resolve(root, r.path)) === key)) return false;
    this.config.repos.push({ name, path });
    return true;
  }

  removeRepo(nameOrPath: string): void {
    this.config.repos = this.config.repos.filter(r => r.name !== nameOrPath && r.path !== nameOrPath);
  }

  /** Duplicate entries the last `load` removed from the config file; the loaders report them. */
  get collapsedRepos(): CollapsedRepo[] {
    return this.collapsed;
  }

  getWorkspaceRoot(): string {
    return resolve(this.configPath, '..', '..');
  }

  get repo(): RepoConfig {
    return this.config.repos[0];
  }
}
