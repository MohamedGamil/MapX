import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { uiBundleStale } from '../src/ui-server.js';

// M4-05: installs no longer bundle the dashboard; packing, publishing and serving from source do.
const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

describe('package scripts', () => {
  it('no install lifecycle script builds the dashboard', () => {
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
      expect(pkg.scripts[hook] ?? '', hook).not.toMatch(/build-ui|build:ui|build:npm/);
    }
    expect(pkg.scripts.prepare).toBe('tsup');
  });

  it('packing and publishing build the dashboard', () => {
    expect(pkg.scripts.prepack).toBe('npm run build:ui');
    expect(pkg.scripts['build:ui']).toBe('tsx scripts/build-ui.ts');
    expect(pkg.scripts['build:npm']).toBe('tsup && npm run build:ui');
    const publish = readFileSync(join(ROOT, '.github/workflows/publish-npm.yml'), 'utf8');
    expect(publish).toMatch(/run: npm run build:npm\n/);
  });

  it("tsup's clean keeps dist/ui: npm pack and publish run prepack (the dashboard) before prepare (tsup)", () => {
    const tsup = readFileSync(join(ROOT, 'tsup.config.ts'), 'utf8');
    expect(tsup).toMatch(/^\s*clean: \['!ui\/\*\*'\],$/m);
  });

  it('CI builds the package before checking its contents', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const test = ci.match(/^ {2}test:\n((?: {4,}.*\n|\n)+)/m)?.[1] ?? '';
    const build = test.indexOf('run: npm run build:npm');
    const check = test.indexOf('run: npx tsx scripts/check-package.ts');
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    // The lifecycle as npm runs it: a pack with scripts from a tree without dist/ui must contain the dashboard.
    expect(ci).toMatch(/run: rm -rf dist\/ui && npm pack --dry-run --json \| node scripts\/check-pack-ui\.mjs\n/);
  });
});

describe('uiBundleStale', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const at = (path: string, seconds: number) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'x');
    utimesSync(path, seconds, seconds);
  };

  it('is stale when an output is missing, or the build script or lockfile is newer', () => {
    root = mkdtempSync(join(tmpdir(), 'mapx-ui-bundle-'));
    at(join(root, 'src/ui/main.ts'), 1000);
    at(join(root, 'scripts/build-ui.ts'), 1000);
    at(join(root, 'package-lock.json'), 1000);
    at(join(root, 'dist/ui/main.js'), 2000);
    expect(uiBundleStale(root)).toBe(true); // index.html missing
    at(join(root, 'dist/ui/index.html'), 2000);
    expect(uiBundleStale(root)).toBe(true); // layout-worker.js missing (M4-20)
    at(join(root, 'dist/ui/layout-worker.js'), 2000);
    expect(uiBundleStale(root)).toBe(false);
    utimesSync(join(root, 'package-lock.json'), 3000, 3000);
    expect(uiBundleStale(root)).toBe(true); // dependencies changed
    utimesSync(join(root, 'package-lock.json'), 1000, 1000);
    utimesSync(join(root, 'scripts/build-ui.ts'), 3000, 3000);
    expect(uiBundleStale(root)).toBe(true); // the build changed
  });

  it('is stale when the bundle is missing or older than any src/ui file, nested files included', () => {
    root = mkdtempSync(join(tmpdir(), 'mapx-ui-bundle-'));
    at(join(root, 'src/ui/main.ts'), 1000);
    at(join(root, 'src/ui/views/graph.ts'), 1000);
    expect(uiBundleStale(root)).toBe(true); // no bundle

    at(join(root, 'dist/ui/main.js'), 2000);
    at(join(root, 'dist/ui/index.html'), 2000);
    at(join(root, 'dist/ui/layout-worker.js'), 2000);
    expect(uiBundleStale(root)).toBe(false);

    utimesSync(join(root, 'src/ui/views/graph.ts'), 3000, 3000);
    expect(uiBundleStale(root)).toBe(true); // a nested source is newer
  });
});
