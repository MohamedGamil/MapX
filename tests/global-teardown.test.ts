// M4-09-R5: the global teardown fails a run that leaves a temp entry, naming it; and a run that is
// interrupted leaves nothing, the built-CLI mirror included. Each case runs a real, tiny vitest
// project that uses tests/global-teardown.ts, in a temp folder of its own.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { TOOL_CACHE } from './helpers/run-tmp';

const ROOT = resolve(__dirname, '..');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const SETUP = join(ROOT, 'tests', 'global-teardown.ts');

/** This run's environment as an inner run's: TMPDIR at `tmp`, without the vitest worker variables and the run's own markers. */
function cleanEnv(tmp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('VITEST')) delete env[k];
  delete env['MAPX_RUN_TMP'];
  delete env['MAPX_RUN_TMP_OWNED'];
  return { ...env, ...extra };
}

describe('global teardown (vitest)', () => {
  it('is wired in: this run\'s tests, and the CLIs they spawn, see the private temp folder', () => {
    expect(process.env['MAPX_RUN_TMP']).toBeTruthy();
    expect(tmpdir()).toBe(process.env['MAPX_RUN_TMP']);
    const child = spawnSync(process.execPath, ['-p', "require('os').tmpdir()"], { encoding: 'utf8', env: process.env });
    expect(child.stdout.trim()).toBe(process.env['MAPX_RUN_TMP']);
  });

  let base = ''; // the inner run's TMPDIR: whatever it leaves outside its own private folder shows here
  let project = '';
  let n = 0;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-'));
    project = join(base, 'p');
    mkdirSync(project);
    writeFileSync(join(project, 'vitest.config.mjs'), `export default { test: { globals: true, pool: 'forks', testTimeout: 120000, include: ['*.test.mjs'], globalSetup: [${JSON.stringify(SETUP)}] } };\n`);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** The environment of the inner run: this run's, minus the vitest worker variables. */
  const innerEnv = (extra: Record<string, string> = {}) => cleanEnv(base, extra);
  const write = (body: string) => {
    const file = `case${n++}.test.mjs`;
    writeFileSync(join(project, file), `import { it } from 'vitest';\nimport { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nit('case', async () => {\n${body}\n});\n`);
    return file;
  };
  const run = (file: string) => spawnSync(process.execPath, [VITEST, 'run', file], { cwd: project, encoding: 'utf8', env: innerEnv() });
  /**
   * What the inner run left in `base` beyond the project and the tools' caches. vitest's own folder
   * (`<tmpdir>/<21-character id>`, made before the global setup, and left by vitest itself when a
   * signal ends the run) is not the tests'.
   */
  const outside = () => readdirSync(base).filter((e) => e !== 'p' && !TOOL_CACHE.test(e) && !/^[\w-]{21}$/.test(e));

  it('passes, and leaves no private folder behind, when every test removes what it creates', () => {
    const r = run(write("const d = mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-clean-')); writeFileSync(join(d, 'a'), 'a'); rmSync(d, { recursive: true });"));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(outside()).toEqual([]);
  }, 60_000);

  it('fails, naming the leaked folder and the file that makes such folders, when a test leaves one', () => {
    const r = run(write("const d = mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-leak-')); writeFileSync(join(d, 'a'), 'a');"));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/vitest: the run left 1 entry in its temp folder/);
    expect(out).toMatch(/mapx-teardown-probe-leak-\w{6}\/ \(a\)/);
    expect(out).toContain('tests/global-teardown.test.ts'); // the file that names the prefix
    expect(outside(), 'the teardown removes the leftover too').toEqual([]);
  }, 60_000);

  it('names every leftover, one line each, including a child process\'s mktemp folder', () => {
    const r = run(write("mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-one-')); mkdirSync(join(tmpdir(), 'tmp.child'));"));
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/left 2 entries/);
    expect(out).toMatch(/mapx-teardown-probe-one-\w{6}\/ \(empty\)/);
    expect(out).toMatch(/tmp\.child\/ \(empty\)  <- no test names this prefix/);
  }, 60_000);

  it('does not count the tools\' caches', () => {
    const r = run(write("mkdirSync(join(tmpdir(), 'tsx-1234')); mkdirSync(join(tmpdir(), 'node-compile-cache'));"));
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 60_000);

  it('does not look at the shared tmpdir: a folder a different process makes there meanwhile is no leak', () => {
    const other = join(tmpdir(), `mapx-teardown-probe-other-${process.pid}`);
    mkdirSync(other);
    try {
      expect(run(write('/* the test itself makes nothing */')).status).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 60_000);

  it('reuses a temp folder a wrapper owns instead of nesting a second one (the tsx socket path stays short)', () => {
    const file = write("writeFileSync(join(process.cwd(), 'tmpdir'), tmpdir()); mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-owned-'));");
    const r = spawnSync(process.execPath, [VITEST, 'run', file], { cwd: project, encoding: 'utf8', env: cleanEnv(base, { MAPX_RUN_TMP_OWNED: base }) });
    expect(readFileSync(join(project, 'tmpdir'), 'utf8')).toBe(base); // no mapx-run-tmp-* in between
    expect(r.stdout + r.stderr).not.toContain('the run left'); // the wrapper reports an owned folder, once
    expect(readdirSync(base).some((e) => e.startsWith('mapx-run-tmp-'))).toBe(false);
    rmSync(join(project, 'tmpdir'));
    for (const e of readdirSync(base)) if (e.startsWith('mapx-teardown-probe-owned-')) rmSync(join(base, e), { recursive: true });
  }, 60_000);

  it('makes the private folder absolute when TMPDIR is relative', () => {
    mkdirSync(join(project, 'rel'), { recursive: true });
    const file = write("writeFileSync(join(process.cwd(), 'tmpdir'), tmpdir());");
    const r = spawnSync(process.execPath, [VITEST, 'run', file], { cwd: project, encoding: 'utf8', env: cleanEnv('rel') });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const seen = readFileSync(join(project, 'tmpdir'), 'utf8');
    expect(isAbsolute(seen)).toBe(true);
    expect(seen.startsWith(join(project, 'rel', 'mapx-run-tmp-'))).toBe(true);
    rmSync(join(project, 'tmpdir'));
  }, 60_000);

  // The built-CLI mirror (useBuiltCli) is removed by an afterAll that a signal skips (M4-30 review).
  it.each([['SIGINT'], ['SIGTERM'], ['SIGHUP']] as const)('a run stopped by %s leaves nothing, and a mirror in the private folder goes with it', async (signal) => {
    const marker = join(project, `at-${signal}`);
    const file = write(`mkdirSync(join(tmpdir(), 'mapx-cli-mirror'));\nmkdtempSync(join(tmpdir(), 'mapx-teardown-probe-sig-'));\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nawait new Promise((r) => setTimeout(r, 60000));`);
    // Its own process group, signalled as a whole: what Ctrl+C does to a runner and its workers.
    const child = spawn(process.execPath, [VITEST, 'run', file], { cwd: project, env: innerEnv(), stdio: 'ignore', detached: true });
    const done = new Promise<number | null>((ok) => child.once('exit', (code) => ok(code)));
    for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(marker), 'the inner test never started').toBe(true);
    process.kill(-child.pid!, signal);
    await Promise.race([done, new Promise((r) => setTimeout(r, 20_000))]);
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await done;
    rmSync(marker, { force: true });
    expect(outside()).toEqual([]);
  }, 60_000);
});

// Review of M4-09-R5: a signal sent to the runner alone (a `kill <pid>`, a closed terminal) must end
// it. Our listener on the signal stops vitest's own (signal-exit re-kills only as the sole listener).
describe('global teardown (vitest): a signal to the runner process alone', () => {
  let base = '';
  let project = '';
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-main-'));
    project = join(base, 'p');
    mkdirSync(project);
    writeFileSync(join(project, 'vitest.config.mjs'), `export default { test: { pool: 'forks', testTimeout: 120000, include: ['*.test.mjs'], globalSetup: [${JSON.stringify(SETUP)}] } };\n`);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it.each([['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]] as const)('%s ends the run at once with exit code %i and leaves its folder removed', async (signal, code) => {
    const marker = join(project, `at-${signal}`);
    writeFileSync(join(project, `${signal}.test.mjs`), `import { it } from 'vitest';\nimport { mkdtempSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nit('sleep', async () => {\n  mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-main-x-'));\n  writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n  await new Promise((r) => setTimeout(r, 60000));\n});\n`);
    const child = spawn(process.execPath, [VITEST, 'run', `${signal}.test.mjs`], { cwd: project, env: { ...cleanEnv(base) }, stdio: 'ignore' });
    const done = new Promise<number | null>((ok) => child.once('exit', (c, sig) => ok(c ?? (sig ? 128 + (sig === 'SIGHUP' ? 1 : sig === 'SIGINT' ? 2 : 15) : null))));
    for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(marker), 'the inner test never started').toBe(true);
    const worker = Number(readFileSync(marker, 'utf8'));
    child.kill(signal); // the runner only, not its group
    const exit = await Promise.race([done, new Promise<string>((r) => setTimeout(() => r('still running'), 10_000))]);
    try { process.kill(worker, 'SIGKILL'); } catch { /* gone */ }
    if (exit === 'still running') child.kill('SIGKILL');
    expect(exit).toBe(code);
    expect(readdirSync(base).filter((e) => e !== 'p' && !TOOL_CACHE.test(e) && !/^[\w-]{21}$/.test(e))).toEqual([]);
  }, 60_000);
});

// The same checks for Playwright's global teardown (tests/ui/global-teardown.ts). Playwright runs the
// teardown after an interrupt too (vitest exits at once), so an interrupted run must not be reported
// as leaking. The inner project's setup is the one line of tests/ui/global-setup.ts that matters
// here: the real one builds the dashboard.
describe('global teardown (Playwright)', () => {
  it('is wired in: the Playwright config sets up and tears down the private temp folder', () => {
    const config = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');
    expect(config).toContain("globalSetup: './tests/ui/global-setup.ts'");
    expect(config).toContain("globalTeardown: './tests/ui/global-teardown.ts'");
    expect(readFileSync(join(ROOT, 'tests/ui/global-setup.ts'), 'utf8')).toMatch(/^\s+isolateTmp\(\);$/m);
  });

  let base = '';
  let project = '';
  let n = 0;
  const PLAYWRIGHT = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-pw-'));
    project = join(base, 'p');
    mkdirSync(join(project, 'node_modules'), { recursive: true });
    for (const pkg of ['@playwright', 'playwright', 'playwright-core']) symlinkSync(join(ROOT, 'node_modules', pkg), join(project, 'node_modules', pkg));
    writeFileSync(join(project, 'playwright.config.mjs'), `export default { testDir: '.', testMatch: /.*\\.spec\\.mjs$/, workers: 1, globalSetup: './setup.mjs', globalTeardown: ${JSON.stringify(join(ROOT, 'tests', 'ui', 'global-teardown.ts'))}, reporter: [['list']] };\n`);
    writeFileSync(join(project, 'setup.mjs'), `import { isolateTmp } from ${JSON.stringify(join(ROOT, 'tests', 'helpers', 'run-tmp.ts'))};\nexport default () => { isolateTmp(); };\n`);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const innerEnv = () => cleanEnv(base, { CI: '' });
  const write = (body: string) => {
    const file = `case${n++}.spec.mjs`;
    writeFileSync(join(project, file), `import { test } from '@playwright/test';\nimport { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\ntest('case', async () => {\n${body}\n});\n`);
    return file;
  };
  const outside = () => readdirSync(base).filter((e) => e !== 'p' && !TOOL_CACHE.test(e));

  it('fails, naming the leaked folder, when a spec leaves one; passes when it does not', () => {
    const leak = spawnSync(process.execPath, [PLAYWRIGHT, 'test', write("mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-pwleak-'));")], { cwd: project, encoding: 'utf8', env: innerEnv() });
    expect(leak.status, leak.stdout + leak.stderr).toBe(1);
    expect(leak.stdout + leak.stderr).toMatch(/test:ui: the run left 1 entry in its temp folder[\s\S]*mapx-teardown-probe-pwleak-\w{6}\/ \(empty\)/);
    expect(outside()).toEqual([]);
    const clean = spawnSync(process.execPath, [PLAYWRIGHT, 'test', write('/* nothing */')], { cwd: project, encoding: 'utf8', env: innerEnv() });
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(outside()).toEqual([]);
  }, 90_000);

  it.each([['SIGINT'], ['SIGTERM'], ['SIGHUP']] as const)('a run stopped by %s leaves nothing and reports no leak', async (signal) => {
    const marker = join(project, `at-${signal}`);
    const file = write(`mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-pwsig-'));\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nawait new Promise((r) => setTimeout(r, 60000));`);
    const child = spawn(process.execPath, [PLAYWRIGHT, 'test', file, '--timeout', '120000'], { cwd: project, env: innerEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { out += d; });
    const done = new Promise<void>((ok) => child.once('exit', () => ok()));
    for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(marker), 'the inner spec never started').toBe(true);
    process.kill(-child.pid!, signal);
    await Promise.race([done, new Promise((r) => setTimeout(r, 30_000))]);
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await done;
    rmSync(marker, { force: true });
    expect(out).not.toContain('the run left');
    expect(outside()).toEqual([]);
  }, 90_000);
  it.each([['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]] as const)('%s sent to the runner alone ends the run with exit code %i, no leak reported', async (signal, code) => {
    const marker = join(project, `main-${signal}`);
    const file = write(`mkdtempSync(join(tmpdir(), 'mapx-teardown-probe-pwmain-'));\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid));\nawait new Promise((r) => setTimeout(r, 60000));`);
    const child = spawn(process.execPath, [PLAYWRIGHT, 'test', file, '--timeout', '120000'], { cwd: project, env: innerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { out += d; });
    const done = new Promise<number | null>((ok) => child.once('exit', (c, sig) => ok(c ?? (sig ? 128 + (sig === 'SIGHUP' ? 1 : sig === 'SIGINT' ? 2 : 15) : null))));
    for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(marker), 'the inner spec never started').toBe(true);
    const worker = Number(readFileSync(marker, 'utf8'));
    child.kill(signal);
    const exit = await Promise.race([done, new Promise<string>((r) => setTimeout(() => r('still running'), 15_000))]);
    try { process.kill(worker, 'SIGKILL'); } catch { /* gone */ }
    if (exit === 'still running') child.kill('SIGKILL');
    expect(exit, out).toBe(code);
    expect(out).not.toContain('the run left');
    expect(outside()).toEqual([]);
  }, 60_000);
});
