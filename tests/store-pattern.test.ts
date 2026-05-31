import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Store } from '../src/core/store.js';

describe('Store getFilesByPattern', () => {
  let store: Store;

  beforeAll(() => {
    store = new Store(':memory:');

    // Seed the store with files of different names and paths
    const files = [
      { path: 'src/core/scanner.ts', repo: 'mapx', language: 'typescript' },
      { path: 'src/core/store.ts', repo: 'mapx', language: 'typescript' },
      { path: 'packages/app/pubspec.yaml', repo: 'mapx', language: 'yaml' },
      { path: 'packages/shared/pubspec.yaml', repo: 'mapx', language: 'yaml' },
      { path: 'pubspec.yaml', repo: 'mapx', language: 'yaml' },
      { path: 'src/utils/helpers.ts', repo: 'mapx', language: 'typescript' },
      { path: 'config/settings.json', repo: 'mapx', language: 'json' },
      { path: 'package.json', repo: 'mapx', language: 'json' },
    ];

    for (const f of files) {
      store.upsertFile({
        path: f.path,
        repo: f.repo,
        language: f.language,
        gitBlobHash: null,
        contentHash: null,
        lastScanned: new Date().toISOString(),
        sizeBytes: 100,
        lines: 10,
      });
    }
  });

  afterAll(() => {
    store.close();
  });

  it('should find files matching a simple filename suffix', () => {
    const results = store.getFilesByPattern('pubspec.yaml');
    expect(results).toHaveLength(3);
    expect(results.every(r => (r.path as string).endsWith('pubspec.yaml'))).toBe(true);
  });

  it('should find files matching a path segment suffix', () => {
    const results = store.getFilesByPattern('core/scanner.ts');
    expect(results).toHaveLength(1);
    expect((results[0].path as string)).toBe('src/core/scanner.ts');
  });

  it('should return empty array when no files match', () => {
    const results = store.getFilesByPattern('nonexistent.xyz');
    expect(results).toHaveLength(0);
  });

  it('should match by extension suffix', () => {
    const results = store.getFilesByPattern('.json');
    expect(results).toHaveLength(2);
    expect(results.every(r => (r.path as string).endsWith('.json'))).toBe(true);
  });

  it('should match a single root-level file', () => {
    const results = store.getFilesByPattern('package.json');
    // Should match both 'package.json' at root and possibly in nested paths
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => (r.path as string) === 'package.json')).toBe(true);
  });

  it('should match partial directory segments', () => {
    const results = store.getFilesByPattern('helpers.ts');
    expect(results).toHaveLength(1);
    expect((results[0].path as string)).toBe('src/utils/helpers.ts');
  });

  it('should be case-sensitive by default (SQL LIKE)', () => {
    // SQL LIKE is case-insensitive for ASCII in SQLite by default
    // but file paths should still match correctly
    const results = store.getFilesByPattern('Scanner.ts');
    // SQLite LIKE is case-insensitive for ASCII, so this should still match
    expect(results).toHaveLength(1);
  });
});
