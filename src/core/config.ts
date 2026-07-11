import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { MapxConfig, RepoConfig, UserLanguageDefinition } from '../types.js';
import type { LanguageDefinition } from '../languages/registry.js';
import { getBuiltinLanguages } from '../languages/registry.js';

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
  },
};

export class Config {
  private configPath: string;
  private config: MapxConfig;

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
    return new Config(configPath, config);
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
      const LARAVEL_DEFAULT_EXCLUDES = [
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

  addRepo(name: string, path: string): void {
    if (!this.config.repos.find(r => r.path === path)) {
      this.config.repos.push({ name, path });
    }
  }

  removeRepo(nameOrPath: string): void {
    this.config.repos = this.config.repos.filter(r => r.name !== nameOrPath && r.path !== nameOrPath);
  }

  getWorkspaceRoot(): string {
    return resolve(this.configPath, '..', '..');
  }

  get repo(): RepoConfig {
    return this.config.repos[0];
  }
}
