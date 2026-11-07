import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAssetRoot } from '../src/parsers/assets.js';

// M0-39: centralized WASM asset root resolution (CHANGELOG 0.3.4).
describe('findAssetRoot', () => {
  const home = process.env['HOME'];
  afterEach(() => { process.env['HOME'] = home; });

  it('resolves the package root from a source module URL', () => {
    const root = findAssetRoot(pathToFileURL(resolve(__dirname, '../src/parsers/assets.ts')).href);
    expect(root).toBe(resolve(__dirname, '..'));
    expect(existsSync(join(root, 'wasm'))).toBe(true);
  });

  it('falls back to the XDG user data directory for a compiled binary', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mapx-home-'));
    try {
      mkdirSync(join(fakeHome, '.local', 'share', 'mapx', 'wasm'), { recursive: true });
      process.env['HOME'] = fakeHome;
      // A bundled-binary module URL does not exist on disk.
      expect(findAssetRoot('file:///$bunfs/root/mapx')).toBe(join(fakeHome, '.local', 'share', 'mapx'));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
