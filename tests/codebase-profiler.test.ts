import { describe, it, expect } from 'vitest';
import { CodebaseProfiler } from '../src/core/codebase-profiler.js';
import type { Store } from '../src/core/store.js';

describe('CodebaseProfiler', () => {
  it('profiles a CLI tool correctly', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'bin/mapx.ts', language: 'typescript' },
        { path: 'src/cli.ts', language: 'typescript' },
        { path: 'package.json', language: 'json' }
      ]
    } as unknown as Store;

    const profiler = new CodebaseProfiler(mockStore);
    const profile = profiler.profile('test-repo');

    expect(profile.archetype).toBe('cli-tool');
    expect(profile.hasBackend).toBe(false);
    expect(profile.hasFrontend).toBe(false);
    expect(profile.isMonorepo).toBe(false);
  });

  it('profiles a Web API project correctly', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'src/routes/users.ts', language: 'typescript' },
        { path: 'src/controllers/UserController.ts', language: 'typescript' },
        { path: 'src/app.ts', language: 'typescript' }
      ]
    } as unknown as Store;

    const profiler = new CodebaseProfiler(mockStore);
    const profile = profiler.profile('test-repo');

    expect(profile.archetype).toBe('web-api');
    expect(profile.hasBackend).toBe(true);
    expect(profile.hasFrontend).toBe(false);
    expect(profile.detectedPatterns).toContain('layered');
  });

  it('profiles a Web App frontend project correctly', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'src/components/Button.tsx', language: 'typescript' },
        { path: 'src/pages/Home.tsx', language: 'typescript' },
        { path: 'src/styles/theme.css', language: 'css' }
      ]
    } as unknown as Store;

    const profiler = new CodebaseProfiler(mockStore);
    const profile = profiler.profile('test-repo');

    expect(profile.archetype).toBe('web-app');
    expect(profile.hasBackend).toBe(false);
    expect(profile.hasFrontend).toBe(true);
  });

  it('profiles a monorepo structure correctly', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'apps/web/package.json', language: 'json' },
        { path: 'packages/shared/package.json', language: 'json' },
        { path: 'package.json', language: 'json' }
      ]
    } as unknown as Store;

    const profiler = new CodebaseProfiler(mockStore);
    const profile = profiler.profile('test-repo');

    expect(profile.isMonorepo).toBe(true);
    expect(profile.archetype).toBe('monorepo');
    expect(profile.componentBoundaries).toContain('apps/web');
    expect(profile.componentBoundaries).toContain('packages/shared');
  });

  it('profiles a clean architecture pattern correctly', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'src/domain/user.ts', language: 'typescript' },
        { path: 'src/usecases/GetUser.ts', language: 'typescript' },
        { path: 'src/infrastructure/db.ts', language: 'typescript' }
      ]
    } as unknown as Store;

    const profiler = new CodebaseProfiler(mockStore);
    const profile = profiler.profile('test-repo');

    expect(profile.detectedPatterns).toContain('clean');
  });
});
