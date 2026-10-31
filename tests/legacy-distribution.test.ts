import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NPM_PACKAGE, TEMPLATES } from '../src/agents/templates.js';

// M0-07-R1: package name in generated configs and docs, NPM_TOKEN docs, binary version.
// M0-07-R2: binaries are built into a temp dir, never into the repo; the package check rejects them.
const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const VERSION = readFileSync(resolve(ROOT, 'VERSION'), 'utf8').trim();
const TSX = pathToFileURL(resolve(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
const tsx = (cwd: string, script: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', TSX, resolve(ROOT, script), ...args], { cwd, encoding: 'utf8' });
const temps: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'mapx-dist-'));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
/** Identity of the repo's dist/mapx-linux-x64 (absent, or its mtime), to prove a build left it alone. */
const repoBinary = () => {
  const p = resolve(ROOT, 'dist/mapx-linux-x64');
  return existsSync(p) ? statSync(p).mtimeMs : 'absent';
};

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

  it('plans every binary with the VERSION define into the requested directory (no bun needed)', () => {
    const out = tempDir();
    const r = tsx(ROOT, 'scripts/build-all.ts', '--dry-run', '--outdir', out);
    expect(r.status, r.stderr).toBe(0);
    const commands = r.stdout.split('\n').filter((l) => l.includes('bun build'));
    expect(commands.map((c) => c.match(/--outfile "([^"]+)"/)?.[1])).toEqual(
      ['mapx-linux-x64', 'mapx-linux-arm64', 'mapx-darwin-arm64', 'mapx-darwin-x64', 'mapx-windows-x64.exe'].map((f) => join(out, f)),
    );
    for (const c of commands) expect(c).toContain(`--define MAPX_BUILD_VERSION='"${VERSION}"'`);
    // A single target via the package script, still into the requested directory.
    const one = spawnSync('npm', ['run', '-s', 'build:linux', '--', '--dry-run', '--outdir', out], { cwd: ROOT, encoding: 'utf8' });
    expect(one.stdout.match(/--outfile "([^"]+)"/g)).toEqual([`--outfile "${join(out, 'mapx-linux-x64')}"`]);
  });

  const hasBun = spawnSync('bun', ['--version']).status === 0;
  it.skipIf(!hasBun)('a built linux binary reports the VERSION file, built into a temp dir and not into the repo', () => {
    const before = repoBinary();
    const out = tempDir();
    execFileSync('npm', ['run', '-s', 'build:linux', '--', '--outdir', out], { cwd: ROOT, stdio: 'pipe' });
    const bin = join(out, 'mapx-linux-x64');
    expect(existsSync(bin)).toBe(true);
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()).toBe(VERSION);
    expect(repoBinary()).toBe(before);
  }, 600000);
});

describe('package check rejects native binaries', () => {
  // A throwaway package laid out like ours: `files: ["dist/"]`, a dashboard bundle, and
  // optionally a fake native binary (only its magic bytes matter).
  const pack = (extra: Record<string, Buffer>) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg-check-fixture', version: '0.0.0', files: ['dist/'] }));
    mkdirSync(join(dir, 'dist/ui'), { recursive: true });
    writeFileSync(join(dir, 'dist/main.js'), 'console.log(1);\n');
    writeFileSync(join(dir, 'dist/ui/main.js'), 'console.log(2);\n');
    for (const [f, data] of Object.entries(extra)) writeFileSync(join(dir, f), data);
    return tsx(dir, 'scripts/check-package.ts');
  };
  const fake = (magic: number[]) => Buffer.concat([Buffer.from(magic), Buffer.alloc(64)]);

  it('passes a package without binaries', () => {
    const r = pack({});
    expect(r.status, r.stderr).toBe(0);
  }, 60000);

  it('fails when an ELF, Mach-O or PE binary is in the pack list, naming each', () => {
    const r = pack({
      'dist/mapx-linux-x64': fake([0x7f, 0x45, 0x4c, 0x46]),
      'dist/mapx-darwin-arm64': fake([0xcf, 0xfa, 0xed, 0xfe]),
      'dist/mapx-windows-x64.exe': fake([0x4d, 0x5a]),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL native ELF binary packed: dist/mapx-linux-x64');
    expect(r.stderr).toContain('FAIL native Mach-O binary packed: dist/mapx-darwin-arm64');
    expect(r.stderr).toContain('FAIL native PE binary packed: dist/mapx-windows-x64.exe');
  }, 60000);
});
