import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NPM_PACKAGE, TEMPLATES } from '../src/agents/templates.js';

// M0-07-R1: package name in generated configs and docs, NPM_TOKEN docs, binary version.
const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

describe('distribution correctness', () => {
  it('generated agent files reference the real npm package', () => {
    expect(NPM_PACKAGE).toBe(pkg.name);
    const all = Object.values(TEMPLATES).map((t: any) => String(t.content)).join('\n');
    expect(all).toContain(`"${pkg.name}"`);
    // No config may run the unscoped package (it is not ours and 404s).
    expect(all).not.toMatch(/"-y",\s*"mapx"/);
    expect(all).not.toMatch(/npx (-y )?mapx\b/);
  });

  it('documents the NPM_TOKEN secret and the scoped package name', () => {
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('NPM_TOKEN');
    expect(readme).toContain('@mgamil/mapx');
  });

  it('builds every native binary through build-all, which embeds VERSION', () => {
    for (const script of ['build:linux', 'build:linux-arm', 'build:mac-arm', 'build:mac-x64', 'build:win'])
      expect(pkg.scripts[script], script).toMatch(/^tsx scripts\/build-all\.ts [\w-]+$/);
    expect(readFileSync(resolve(ROOT, 'scripts/build-all.ts'), 'utf8')).toContain('MAPX_BUILD_VERSION');
  });

  const hasBun = spawnSync('bun', ['--version']).status === 0;
  it.skipIf(!hasBun)('a built linux binary reports the VERSION file', () => {
    execFileSync('npm', ['run', '-s', 'build:linux'], { cwd: ROOT, stdio: 'pipe' });
    const bin = resolve(ROOT, 'dist/mapx-linux-x64');
    expect(existsSync(bin)).toBe(true);
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()).toBe(readFileSync(resolve(ROOT, 'VERSION'), 'utf8').trim());
  }, 600000);
});
