// M4-29: the installer replaces a binary that is running. Installing v0.3.9 failed with
// "cp: cannot create regular file ~/.local/bin/mapx: Text file busy" while `mapx serve` processes
// ran the old binary (D037): install.sh copied onto it. It now writes a temp file in the target
// folder and renames it over the old one; running processes keep the old inode.
//
// The "installed binary" is a copy of the system's `sleep`, a real executable, so the kernel
// refuses writes to it while it runs (a shell script would not reproduce ETXTBSY). The new binary
// is a small shell script. Every path is under a temp folder, HOME included: the real install is
// never touched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const NEW_BINARY = '#!/bin/sh\necho "mapx 9.9.9 (new)"\n';

describe.skipIf(process.platform === 'win32')('install.sh replaces a running mapx binary', () => {
  let tmp = '';
  let running: ChildProcess | undefined;
  const sleepBin = () => execFileSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim();

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mapx-installer-')); });
  afterEach(() => {
    running?.kill('SIGKILL');
    running = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** An extracted release folder: install.sh, VERSION and the new binary. */
  function release(dir: string): string {
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(ROOT, 'scripts/templates/install.sh'), join(dir, 'install.sh'));
    chmodSync(join(dir, 'install.sh'), 0o755);
    writeFileSync(join(dir, 'VERSION'), '9.9.9\n');
    writeFileSync(join(dir, 'mapx'), NEW_BINARY, { mode: 0o755 });
    return dir;
  }

  /** Installs the old binary at <prefix>/mapx and starts it; resolves once it is executing. */
  async function runOld(prefix: string, seconds: number): Promise<ChildProcess> {
    mkdirSync(prefix, { recursive: true });
    copyFileSync(sleepBin(), join(prefix, 'mapx'));
    chmodSync(join(prefix, 'mapx'), 0o755);
    const child = spawn(join(prefix, 'mapx'), [String(seconds)], { stdio: 'ignore' });
    await new Promise<void>((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
    return child;
  }

  const exited = (child: ChildProcess) => new Promise<{ code: number | null; signal: string | null }>((ok) => {
    if (child.exitCode !== null || child.signalCode !== null) ok({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code, signal) => ok({ code, signal }));
  });

  /** HOME in the temp folder and the prefix on PATH: add_to_path edits no real shell config. */
  const env = (prefix: string) => ({ ...process.env, HOME: join(tmp, 'home'), PATH: `${prefix}:${process.env.PATH}`, NO_COLOR: '1' });

  async function expectReplaced(cmd: string, args: string[], prefix: string) {
    running = await runOld(prefix, 4);
    const r = spawnSync(cmd, args, { encoding: 'utf8', env: env(prefix) });
    expect(r.stderr, r.stdout).not.toMatch(/Text file busy/);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    // The new binary is in place, executable, and no temp file is left beside it.
    expect(readFileSync(join(prefix, 'mapx'), 'utf8')).toBe(NEW_BINARY);
    expect(statSync(join(prefix, 'mapx')).mode & 0o111).not.toBe(0);
    expect(execFileSync(join(prefix, 'mapx'), { encoding: 'utf8' })).toContain('mapx 9.9.9 (new)');
    expect(readdirSync(prefix)).toEqual(['mapx']);
    // The running process kept its binary: still running after the install, then a normal exit.
    expect(running.exitCode).toBeNull();
    expect(await exited(running)).toEqual({ code: 0, signal: null });
  }

  it('install.sh --prefix <tmp> --force exits 0 while the old binary runs, and the process keeps working', async () => {
    mkdirSync(join(tmp, 'home'));
    const dir = release(join(tmp, 'mapx-9.9.9'));
    await expectReplaced('bash', [join(dir, 'install.sh'), '--prefix', join(tmp, 'bin'), '--force'], join(tmp, 'bin'));
  }, 30_000);

  it('the self-extracting installer from scripts/make-installer.sh does the same', async () => {
    mkdirSync(join(tmp, 'home'));
    release(join(tmp, 'pkg', 'mapx-9.9.9'));
    const archive = join(tmp, 'mapx-9.9.9-test.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', join(tmp, 'pkg'), 'mapx-9.9.9']);
    const installer = join(tmp, 'mapx-9.9.9-test-installer.sh');
    execFileSync('bash', [join(ROOT, 'scripts/make-installer.sh'), 'sh', archive, installer, '9.9.9', 'test'], { stdio: 'ignore' });
    await expectReplaced('sh', [installer, '--prefix', join(tmp, 'bin2'), '--force'], join(tmp, 'bin2'));
  }, 30_000);

  // Review of M4-29: a symlinked mapx, an interrupted install, a folder that cannot be written.
  it.each([['readlink -f', false], ['a readlink without -f', true]] as const)('a symlinked mapx is replaced at the file it points to; the link stays and keeps working (%s)', async (_, noDashF) => {
    mkdirSync(join(tmp, 'home'));
    const dir = release(join(tmp, 'mapx-9.9.9'));
    const real = join(tmp, 'opt', 'mapx-old');
    running = await runOld(real, 4); // <tmp>/opt/mapx-old/mapx, running
    const prefix = join(tmp, 'bin');
    mkdirSync(prefix);
    symlinkSync('../opt/mapx-old/mapx', join(prefix, 'mapx'));
    let path = `${prefix}:${process.env.PATH}`;
    if (noDashF) {
      // The portable fallback: a readlink that refuses -f, as older macOS's does.
      const shims = join(tmp, 'shims');
      mkdirSync(shims);
      const realReadlink = execFileSync('sh', ['-c', 'command -v readlink'], { encoding: 'utf8' }).trim();
      writeFileSync(join(shims, 'readlink'), `#!/bin/sh\n[ "$1" = "-f" ] && exit 1\nexec '${realReadlink}' "$@"\n`, { mode: 0o755 });
      path = `${shims}:${path}`;
    }
    const r = spawnSync('bash', [join(dir, 'install.sh'), '--prefix', prefix, '--force'], { encoding: 'utf8', env: { ...env(prefix), PATH: path } });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(lstatSync(join(prefix, 'mapx')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(prefix, 'mapx'))).toBe('../opt/mapx-old/mapx');
    expect(readFileSync(join(real, 'mapx'), 'utf8')).toBe(NEW_BINARY);
    expect(execFileSync(join(prefix, 'mapx'), { encoding: 'utf8' })).toContain('mapx 9.9.9 (new)');
    expect(readdirSync(real)).toEqual(['mapx']);
    expect(readdirSync(prefix)).toEqual(['mapx']);
    expect(await exited(running)).toEqual({ code: 0, signal: null });
  }, 30_000);

  it.each(['SIGTERM', 'SIGINT'] as const)('an install stopped by %s leaves no temp file beside the binary', async (signal) => {
    mkdirSync(join(tmp, 'home'));
    const dir = release(join(tmp, 'mapx-9.9.9'));
    const prefix = join(tmp, 'bin');
    mkdirSync(prefix);
    // A `chmod` that marks when the temp file exists, then waits: the moment to stop the install.
    const shims = join(tmp, 'shims');
    mkdirSync(shims);
    const realChmod = execFileSync('sh', ['-c', 'command -v chmod'], { encoding: 'utf8' }).trim();
    const marker = join(tmp, 'at-chmod');
    writeFileSync(join(shims, 'chmod'), `#!/bin/sh\ntouch '${marker}'\nsleep 2\nexec '${realChmod}' "$@"\n`, { mode: 0o755 });
    const child = spawn('bash', [join(dir, 'install.sh'), '--prefix', prefix, '--force'], {
      stdio: 'ignore', env: { ...env(prefix), PATH: `${shims}:${prefix}:${process.env.PATH}` },
    });
    const done = exited(child);
    for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(prefix).some((f) => f.startsWith('.mapx.'))).toBe(true); // the temp file is there now
    child.kill(signal);
    const { code } = await done;
    expect(code).toBe(signal === 'SIGTERM' ? 143 : 130);
    expect(readdirSync(prefix)).toEqual([]);
  }, 30_000);

  it.skipIf(process.getuid?.() === 0)('a writable binary in a folder it cannot write is overwritten in place, with a warning', () => {
    mkdirSync(join(tmp, 'home'));
    const dir = release(join(tmp, 'mapx-9.9.9'));
    const prefix = join(tmp, 'bin');
    mkdirSync(prefix);
    writeFileSync(join(prefix, 'mapx'), '#!/bin/sh\necho old\n', { mode: 0o755 });
    chmodSync(prefix, 0o555);
    try {
      const r = spawnSync('bash', [join(dir, 'install.sh'), '--prefix', prefix, '--force'], { encoding: 'utf8', env: env(prefix) });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(/overwriting .*mapx in place/);
      expect(readFileSync(join(prefix, 'mapx'), 'utf8')).toBe(NEW_BINARY);
    } finally {
      chmodSync(prefix, 0o755);
    }
  }, 30_000);
});
