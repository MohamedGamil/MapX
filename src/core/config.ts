import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { CodeGraphConfig, RepoConfig, UserLanguageDefinition } from '../types.js';
import type { LanguageDefinition } from '../languages/registry.js';
import { getBuiltinLanguages } from '../languages/registry.js';

const DEFAULT_CONFIG: CodeGraphConfig = {
  version: '1.0.0',
  repos: [],
  languages: {},
  settings: {
    maxTokenBudget: 16384,
    excludePatterns: [
      'node_modules/**',
      'vendor/**',
      '.git/**',
      'dist/**',
      '.codegraph/**',
      '*.min.js',
      '*.min.css',
      'package-lock.json',
      'composer.lock',
    ],
    includePatterns: [],
  },
};

export class Config {
  private configPath: string;
  private config: CodeGraphConfig;

  private constructor(configPath: string, config: CodeGraphConfig) {
    this.configPath = configPath;
    this.config = config;
  }

  static async load(workspaceRoot: string): Promise<Config> {
    const configPath = join(workspaceRoot, '.codegraph', 'config.json');
    const codegraphDir = join(workspaceRoot, '.codegraph');

    if (!existsSync(configPath)) {
      await mkdir(codegraphDir, { recursive: true });
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
    const config = JSON.parse(data) as CodeGraphConfig;
    return new Config(configPath, config);
  }

  static async init(workspaceRoot: string, repoName?: string): Promise<Config> {
    const codegraphDir = join(workspaceRoot, '.codegraph');
    await mkdir(codegraphDir, { recursive: true });

    const configPath = join(codegraphDir, 'config.json');

    // Read and merge existing config if present, preserving user customisations
    let existing: CodeGraphConfig | null = null;
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(await readFile(configPath, 'utf-8')) as CodeGraphConfig;
      } catch {
        existing = null; // corrupt file — overwrite cleanly
      }
    }

    const defaultExclude = DEFAULT_CONFIG.settings.excludePatterns;

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
      : [{ name: defaultRepoName, path: '.' }];

    const config: CodeGraphConfig = {
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

  removeRepo(path: string): void {
    this.config.repos = this.config.repos.filter(r => r.path !== path);
  }

  getWorkspaceRoot(): string {
    return resolve(this.configPath, '..', '..');
  }

  get repo(): RepoConfig {
    return this.config.repos[0];
  }
}
