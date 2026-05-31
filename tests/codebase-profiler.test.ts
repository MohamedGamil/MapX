import { describe, it, expect } from 'vitest';
import { CodebaseProfiler } from '../src/core/codebase-profiler.js';
import type { Store } from '../src/core/store.js';

function makeStore(files: Array<{ path: string; language?: string }>): Store {
  return {
    getAllFiles: () => files.map(f => ({ path: f.path, language: f.language ?? 'typescript' })),
  } as unknown as Store;
}

describe('CodebaseProfiler', () => {
  it('profiles a CLI tool correctly', () => {
    const profiler = new CodebaseProfiler(makeStore([
      { path: 'bin/mapx.ts' },
      { path: 'src/cli.ts' },
      { path: 'package.json', language: 'json' },
    ]));
    const profile = profiler.profile('test-repo');
    expect(profile.archetype).toBe('cli-tool');
    expect(profile.hasBackend).toBe(false);
    expect(profile.hasFrontend).toBe(false);
    expect(profile.isMonorepo).toBe(false);
  });

  it('profiles a Web API project correctly', () => {
    const profiler = new CodebaseProfiler(makeStore([
      { path: 'src/routes/users.ts' },
      { path: 'src/controllers/UserController.ts' },
      { path: 'src/app.ts' },
    ]));
    const profile = profiler.profile('test-repo');
    expect(profile.archetype).toBe('web-api');
    expect(profile.hasBackend).toBe(true);
    expect(profile.hasFrontend).toBe(false);
    expect(profile.detectedPatterns).toContain('layered');
  });

  it('profiles a Web App frontend project correctly', () => {
    const profiler = new CodebaseProfiler(makeStore([
      { path: 'src/components/Button.tsx' },
      { path: 'src/pages/Home.tsx' },
      { path: 'src/styles/theme.css', language: 'css' },
    ]));
    const profile = profiler.profile('test-repo');
    expect(profile.archetype).toBe('web-app');
    expect(profile.hasBackend).toBe(false);
    expect(profile.hasFrontend).toBe(true);
  });

  it('profiles a monorepo structure correctly', () => {
    const profiler = new CodebaseProfiler(makeStore([
      { path: 'apps/web/package.json', language: 'json' },
      { path: 'packages/shared/package.json', language: 'json' },
      { path: 'package.json', language: 'json' },
    ]));
    const profile = profiler.profile('test-repo');
    expect(profile.isMonorepo).toBe(true);
    expect(profile.archetype).toBe('monorepo');
    expect(profile.componentBoundaries).toContain('apps/web');
    expect(profile.componentBoundaries).toContain('packages/shared');
  });

  it('profiles a clean architecture pattern correctly', () => {
    const profiler = new CodebaseProfiler(makeStore([
      { path: 'src/domain/user.ts' },
      { path: 'src/usecases/GetUser.ts' },
      { path: 'src/infrastructure/db.ts' },
    ]));
    const profile = profiler.profile('test-repo');
    expect(profile.detectedPatterns).toContain('clean');
  });

  it('profiles a Flutter mobile app correctly', () => {
    const profiler = new CodebaseProfiler(makeStore([
      { path: 'lib/main.dart', language: 'dart' },
      { path: 'lib/screens/home.dart', language: 'dart' },
      { path: 'lib/blocs/auth_bloc.dart', language: 'dart' },
      { path: 'pubspec.yaml', language: 'yaml' },
    ]));
    const profile = profiler.profile('test-repo');
    expect(profile.archetype).toBe('mobile-app');
    expect(profile.hasFrontend).toBe(true);
  });

  it('recognises pubspec.yaml as a monorepo package boundary', () => {
    const profiler = new CodebaseProfiler(makeStore([
      { path: 'apps/mobile/pubspec.yaml', language: 'yaml' },
      { path: 'apps/web/package.json', language: 'json' },
      // root entry to make it a monorepo
      { path: 'apps/mobile/lib/screens/home_screen.dart', language: 'dart' },
      { path: 'apps/web/src/components/Button.tsx', language: 'typescript' },
    ]));
    const profile = profiler.profile('test-repo');
    expect(profile.componentBoundaries).toContain('apps/mobile');
    expect(profile.componentBoundaries).toContain('apps/web');
  });

  it('detects MVC pattern from controllers + components', () => {
    const profiler = new CodebaseProfiler(makeStore([
      { path: 'src/controllers/UsersController.ts' },
      { path: 'src/components/UserList.tsx' },
    ]));
    const profile = profiler.profile('test-repo');
    expect(profile.detectedPatterns).toContain('mvc');
  });

  it('falls back to library archetype for plain src directory', () => {
    const profiler = new CodebaseProfiler(makeStore([
      { path: 'src/index.ts' },
      { path: 'src/utils.ts' },
    ]));
    const profile = profiler.profile('test-repo');
    expect(profile.archetype).toBe('library');
  });

  it('passes active frameworks into detectedFrameworks', () => {
    const profiler = new CodebaseProfiler(makeStore([{ path: 'src/index.ts' }]));
    const profile = profiler.profile('test-repo', ['express', 'react']);
    expect(profile.detectedFrameworks).toContain('express');
    expect(profile.detectedFrameworks).toContain('react');
  });
});
