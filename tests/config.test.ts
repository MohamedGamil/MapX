import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Config } from '../src/core/config.js';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Config manager', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mapx-config-test-'));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('init should create .mapx/config.json with defaults', async () => {
    const workspace = join(tempDir, 'repo1');
    await mkdir(workspace);

    const config = await Config.init(workspace, 'repo1');
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0].name).toBe('repo1');
    expect(config.repos[0].path).toBe('.');
    expect(config.settings.excludePatterns).toBeDefined();
    expect(config.settings.excludePatterns.length).toBeGreaterThan(0);

    const configPath = join(workspace, '.mapx', 'config.json');
    expect(existsSync(configPath)).toBe(true);

    // load it
    const loaded = await Config.load(workspace);
    expect(loaded.repos[0].name).toBe('repo1');
    expect(loaded.getWorkspaceRoot()).toBe(workspace);
    expect(loaded.repo.name).toBe('repo1');
  });

  it('init with laravel options adds laravel defaults', async () => {
    const workspace = join(tempDir, 'repo-laravel');
    await mkdir(workspace);

    const config = await Config.init(workspace, 'laravel-repo', true, true);
    expect(config.repos[0].framework).toBe('laravel');
    expect(config.settings.excludePatterns).toContain('database/migrations/**');
    expect(config.settings.excludePatterns).toContain('bootstrap/cache/**');
  });

  it('init auto-detects PHP / JS files', async () => {
    const workspace = join(tempDir, 'repo-detect');
    await mkdir(workspace);
    await writeFile(join(workspace, 'composer.json'), '{}');
    await writeFile(join(workspace, 'package.json'), '{}');

    const config = await Config.init(workspace, 'detect-repo');
    expect(config.settings.excludePatterns).toContain('**/migrations/**'); // from PHP detection
    expect(config.settings.excludePatterns).toContain('**/*.test.ts'); // from JS/TS detection
  });

  it('can add/remove repos and save', async () => {
    const workspace = join(tempDir, 'repo-edit');
    await mkdir(workspace);

    const config = await Config.init(workspace, 'main-repo');
    config.addRepo('sub-repo', './sub');
    expect(config.repos).toHaveLength(2);
    expect(config.repos[1]).toEqual({ name: 'sub-repo', path: './sub' });

    // duplicates ignored
    config.addRepo('sub-repo', './sub');
    expect(config.repos).toHaveLength(2);

    config.removeRepo('./sub');
    expect(config.repos).toHaveLength(1);

    await config.save();
  });

  it('resolves user language configurations', async () => {
    const workspace = join(tempDir, 'repo-lang');
    await mkdir(workspace);

    const config = await Config.init(workspace, 'lang-repo');
    config.languages['my-custom-lang'] = {
      extensions: ['.custom'],
      grammarWasm: 'custom.wasm',
      queries: {
        symbols: '(name) @name',
        references: '(call) @call'
      },
      nodeMappings: {}
    };

    const resolved = config.getResolvedUserLanguages();
    expect(resolved['my-custom-lang']).toBeDefined();
    expect(resolved['my-custom-lang'].extensions).toEqual(['.custom']);
    expect(resolved['my-custom-lang'].queries.symbols).toBe('(name) @name');
  });

  it('load uses default repository configuration if config file does not exist', async () => {
    const workspace = join(tempDir, 'repo-load-new');
    const config = await Config.load(workspace);
    expect(config.repos).toHaveLength(1);
    expect(existsSync(join(workspace, '.mapx', 'config.json'))).toBe(true);
  });
});
