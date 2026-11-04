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
import { docInstallerCommands } from './helpers/installer-docs.js';

const ROOT = resolve(__dirname, '..');
const NEW_BINARY = '#!/bin/sh\necho "mapx 9.9.9 (new)"\n';

describe.skipIf(process.platform === 'win32')('install.sh replaces a running mapx binary', () => {
  let tmp = '';
  let running: ChildProcess | undefined;
  const sleepBin = () => execFileSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mapx-installer-'));
    mkdirSync(join(tmp, 'scratch'));
  });
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

  /**
   * HOME in the temp folder and the prefix on PATH: add_to_path edits no real shell config. TMPDIR is
   * in the temp folder too (M4-09-R5), so a stray file from any run cannot leak into the real one.
   * The installer removes its own unpacked archive (M0-07-R4); the tests assert the folder is empty.
   */
  const env = (prefix: string) => ({ ...process.env, HOME: join(tmp, 'home'), TMPDIR: join(tmp, 'scratch'), PATH: `${prefix}:${process.env.PATH}`, NO_COLOR: '1' });

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
    expect(readdirSync(join(tmp, 'scratch'))).toEqual([]); // M0-07-R4: the installer's unpacked archive is gone
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

// M0-07-R4: the self-extracting installer unpacked its archive into `mktemp -d` and then `exec`ed
// install.sh, so its EXIT trap never ran and every real run left tmp.*/mapx-<version> in $TMPDIR.
// It now runs install.sh as a child, removes the folder whatever the status, and exits with
// install.sh's status. The release inside is a stub install.sh that records what it was given.
describe.skipIf(process.platform === 'win32')('the self-extracting installer removes its unpacked archive', () => {
  let tmp = '';
  let scratch = '';
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mapx-installer-clean-'));
    scratch = join(tmp, 'scratch');
    mkdirSync(scratch);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** Builds an installer around a stub install.sh; `body` is its shell body. Returns the installer path. */
  function build(body: string): string {
    const rel = join(tmp, 'pkg', 'mapx-9.9.9');
    mkdirSync(rel, { recursive: true });
    writeFileSync(join(rel, 'install.sh'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const archive = join(tmp, 'mapx-9.9.9-test.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', join(tmp, 'pkg'), 'mapx-9.9.9']);
    const installer = join(tmp, 'mapx-9.9.9-test-installer.sh');
    execFileSync('bash', [join(ROOT, 'scripts/make-installer.sh'), 'sh', archive, installer, '9.9.9', 'test'], { stdio: 'ignore' });
    return installer;
  }
  const run = (installer: string, args: string[], input = '') =>
    spawnSync('sh', [installer, ...args], { encoding: 'utf8', input, env: { ...process.env, TMPDIR: scratch, NO_COLOR: '1' } });

  it('leaves TMPDIR empty after a successful install and exits 0', () => {
    const r = run(build('echo "stub ran"'), ['--local']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('stub ran');
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('leaves TMPDIR empty after a failing install and exits with install.sh\'s status', () => {
    const r = run(build('echo "stub failing" >&2; exit 7'), ['--local']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(7);
    expect(r.stderr).toContain('stub failing');
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('the real install.sh failing (unknown option) also leaves TMPDIR empty and exits 1', () => {
    const rel = join(tmp, 'pkg', 'mapx-9.9.9');
    mkdirSync(rel, { recursive: true });
    copyFileSync(join(ROOT, 'scripts/templates/install.sh'), join(rel, 'install.sh'));
    chmodSync(join(rel, 'install.sh'), 0o755);
    const archive = join(tmp, 'mapx-9.9.9-test.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', join(tmp, 'pkg'), 'mapx-9.9.9']);
    const installer = join(tmp, 'real-installer.sh');
    execFileSync('bash', [join(ROOT, 'scripts/make-installer.sh'), 'sh', archive, installer, '9.9.9', 'test'], { stdio: 'ignore' });
    const r = run(installer, ['--local', '--bogus']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain('Unknown option');
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('passes arguments through intact, spaces included, after the scope flag', () => {
    const out = join(tmp, 'args.txt');
    const installer = build(`for a in "$@"; do printf '[%s]\\n' "$a"; done > '${out}'`);
    const r = run(installer, ['--prefix', '/a b/c', '--force', 'x  y']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('[--prefix]\n[/a b/c]\n[--force]\n[x  y]\n');
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('the menu choice and install.sh\'s own prompt both read the caller\'s stdin', () => {
    const out = join(tmp, 'stdin.txt');
    const installer = build(`printf '%s\\n' "$@" > '${out}'; read -r answer; echo "answer=$answer" >> '${out}'`);
    const r = run(installer, [], '3\n/my prefix\nyes\n');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('--prefix\n/my prefix\nanswer=yes\n');
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('keeps the installer path for the uninstall hint outside the removed folder', () => {
    const out = join(tmp, 'env.txt');
    const installer = build(`printf '%s' "$MAPX_INSTALLER" > '${out}'`);
    const r = run(installer, ['--local']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const recorded = readFileSync(out, 'utf8');
    expect(recorded).toBe(installer);
    expect(existsSync(recorded)).toBe(true);
  });

  it.each(['sh', 'bash'])('a closed stdin does not abort the installer (%s): install.sh runs and the folder is removed', (shell) => {
    const out = join(tmp, 'ran.txt');
    const installer = build(`echo ran > '${out}'`);
    const r = spawnSync('sh', ['-c', `${shell} "$1" --local <&-`, 'x', installer], { encoding: 'utf8', env: { ...process.env, TMPDIR: scratch, NO_COLOR: '1' } });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('ran\n');
    expect(readdirSync(scratch)).toEqual([]);
  });

  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const spawnInstaller = (installer: string, env: NodeJS.ProcessEnv = {}) => {
    const child = spawn('sh', [installer, '--local'], { stdio: 'ignore', env: { ...process.env, TMPDIR: scratch, NO_COLOR: '1', ...env } });
    const done = new Promise<{ code: number | null; signal: string | null }>((ok) => child.once('exit', (c, sg) => ok({ code: c, signal: sg })));
    return { child, done };
  };
  const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25)); };

  // install.sh answers the forwarded TERM slowly: the installer must wait for it before removing the
  // folder and exiting, so the child is already gone when the installer's exit is seen (no polling).
  it.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const)('%s while install.sh runs stops it, waits for it, removes the folder and exits %i', async (signal, code) => {
    const marker = join(tmp, 'started');
    const pidFile = join(tmp, 'stub.pid');
    const installer = build(`echo $$ > '${pidFile}'; trap 'sleep 1; exit 0' TERM; touch '${marker}'; sleep 30 & wait`);
    const { child, done } = spawnInstaller(installer);
    await until(() => existsSync(marker));
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(scratch).length).toBe(1); // the unpacked archive exists while install.sh runs
    child.kill(signal);
    expect(await done).toEqual({ code, signal: null });
    expect(gone(Number(readFileSync(pidFile, 'utf8').trim()))).toBe(true);
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  // A `tar` that stalls makes extraction observable; the signal must still remove the folder.
  it.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const)('%s during extraction removes the folder and exits %i', async (signal, code) => {
    const installer = build('echo should not run');
    const shims = join(tmp, 'shims');
    mkdirSync(shims);
    const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
    const marker = join(tmp, 'at-tar');
    writeFileSync(join(shims, 'tar'), `#!/bin/sh\ntouch '${marker}'\nsleep 1\nexec '${realTar}' "$@"\n`, { mode: 0o755 });
    const { child, done } = spawnInstaller(installer, { PATH: `${shims}:${process.env.PATH}` });
    await until(() => existsSync(marker));
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(scratch).length).toBe(1);
    child.kill(signal);
    expect(await done).toEqual({ code, signal: null });
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);
});

// M0-07-R5: README.md and docs/getting-started.md document `curl -fsSL <url> | sh`. The installer
// read its payload from "$0", which is the shell when piped (`awk: cannot open sh`). It now reads
// the script's remainder from stdin, and its prompts from the terminal (/dev/tty), or asks nothing
// when there is none. These tests run the commands the docs show, with a `curl` that serves a
// locally built installer, in a private HOME and TMPDIR; every shell that can be `sh` is tried.
describe.skipIf(process.platform === 'win32')('the documented `curl | sh` install (M0-07-R5)', () => {
  const STUB_BIN = '#!/bin/sh\necho "mapx 9.9.9 (piped)"\n';
  let tmp = '';
  let home = '';
  let scratch = '';
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mapx-installer-piped-'));
    home = join(tmp, 'home');
    scratch = join(tmp, 'scratch');
    mkdirSync(home);
    mkdirSync(scratch);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
  /** `sh` can be dash, bash, busybox ash...: the piped script must run under each that is here. */
  const shells = [['dash', 'dash'], ['bash', 'bash'], ['busybox sh', 'busybox']].filter(([, bin]) => has(bin!)).map(([sh]) => sh!);

  /** Builds `<dir>/mapx-<platform>-installer.sh` around the real install.sh and a stub binary. */
  function build(dir: string, platform: string, binary = STUB_BIN): string {
    const rel = join(tmp, 'pkg', 'mapx-9.9.9');
    mkdirSync(join(rel, 'wasm'), { recursive: true });
    mkdirSync(join(rel, 'queries'), { recursive: true });
    copyFileSync(join(ROOT, 'scripts/templates/install.sh'), join(rel, 'install.sh'));
    chmodSync(join(rel, 'install.sh'), 0o755);
    writeFileSync(join(rel, 'VERSION'), '9.9.9\n');
    writeFileSync(join(rel, 'mapx'), binary, { mode: 0o755 });
    writeFileSync(join(rel, 'wasm', 'g.wasm'), 'wasm');
    writeFileSync(join(rel, 'queries', 'q.scm'), 'query');
    const archive = join(tmp, `${platform}.tar.gz`);
    execFileSync('tar', ['czf', archive, '-C', join(tmp, 'pkg'), 'mapx-9.9.9']);
    mkdirSync(dir, { recursive: true });
    const installer = join(dir, `mapx-${platform}-installer.sh`);
    execFileSync('bash', [join(ROOT, 'scripts/make-installer.sh'), 'sh', archive, installer, '9.9.9', platform], { stdio: 'ignore' });
    return installer;
  }

  interface Result { status: number | null; stdout: string; stderr: string }
  /**
   * Runs `argv` with no controlling terminal (setsid): /dev/tty cannot be opened, as in CI. Without
   * it a test run from a terminal would prompt on the developer's real tty.
   */
  function run(argv: string[], env: NodeJS.ProcessEnv = {}, cwd?: string): Promise<Result> {
    return new Promise((ok) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, TMPDIR: scratch, NO_COLOR: '1', ...env } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.once('close', (status) => ok({ status, stdout, stderr }));
    });
  }
  /** `cat <installer> | <shell> -s -- <args>`: the script on a pipe, as `curl ... | sh` sends it. */
  const piped = (installer: string, shell: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    run(['sh', '-c', `f=$1; shift; cat "$f" | ${shell} -s -- "$@"`, 'x', installer, ...args], env);
  const detail = (r: Result) => `${r.stdout}\n${r.stderr}`;
  const installed = () => join(home, '.local', 'bin', 'mapx');

  it.each(shells)('`cat installer | %s -s -- --local` installs, with data, and leaves TMPDIR empty', async (shell) => {
    const installer = build(tmp, 'test');
    const r = await piped(installer, shell, ['--local']);
    expect(r.status, detail(r)).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toBe(STUB_BIN);
    expect(readFileSync(join(home, '.local', 'share', 'mapx', 'wasm', 'g.wasm'), 'utf8')).toBe('wasm');
    expect(readFileSync(join(home, '.local', 'share', 'mapx', 'queries', 'q.scm'), 'utf8')).toBe('query');
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  it('the script redirected from a file (`sh < installer`) installs too', async () => {
    const installer = build(tmp, 'test');
    const r = await run(['sh', '-c', 'sh -s -- --local < "$1"', 'x', installer]);
    expect(r.status, detail(r)).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toBe(STUB_BIN);
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  // The payload comes after a pad because a shell reads its script ahead (dash: 8 KiB): what it
  // took from the pipe before running is lost to the installer, so the marker must lie beyond it.
  it('the payload marker lies at least 64 KiB past the last line the shell runs', () => {
    const text = readFileSync(build(tmp, 'test'), 'latin1');
    const call = text.indexOf('\n_mapx_installer "$@"\nexit 1\n');
    const marker = text.indexOf('\n__PAYLOAD__\n');
    expect(call).toBeGreaterThan(0);
    expect(marker - call).toBeGreaterThanOrEqual(64 * 1024);
    expect(text.indexOf('\n__PAYLOAD__\n', marker + 1)).toBe(-1); // one marker
  });

  it('prints no menu without a terminal: it installs for the user, and says how to choose', async () => {
    const r = await piped(build(tmp, 'test'), 'sh');
    expect(r.status, detail(r)).toBe(0);
    expect(r.stdout).toContain('No terminal to ask on');
    expect(r.stdout).not.toContain('Choice [1]');
    expect(existsSync(installed())).toBe(true);
  }, 30_000);

  it('an installed mapx is not overwritten without a terminal to ask, unless --force; the old one stays', async () => {
    const installer = build(tmp, 'test');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(installed(), '#!/bin/sh\necho old\n', { mode: 0o755 });
    const refused = await piped(installer, 'sh', ['--local']);
    expect(refused.status, detail(refused)).toBe(1);
    expect(refused.stderr).toContain('--force');
    expect(readFileSync(installed(), 'utf8')).toBe('#!/bin/sh\necho old\n');
    expect(readdirSync(scratch)).toEqual([]);
    const forced = await piped(installer, 'sh', ['--local', '--force']);
    expect(forced.status, detail(forced)).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toBe(STUB_BIN);
  }, 30_000);

  it('a file run with nothing on stdin and no scope flag takes the menu default (user install) instead of aborting', async () => {
    const r = await run(['sh', build(tmp, 'test')]);
    expect(r.status, detail(r)).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toBe(STUB_BIN);
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  // An untrusted checkout holds a file named like the shell, carrying the installer's header: the
  // documented one-liner must install the legitimate installer, not that file.
  it.each(['sh', ...shells.filter((sh) => !sh.includes(' '))])('a file named `%s` in the current folder is not taken for the installer when piped', async (shell) => {
    const legit = build(tmp, 'legit');
    const evilDir = join(tmp, 'checkout');
    mkdirSync(evilDir);
    copyFileSync(build(tmp, 'evil', '#!/bin/sh\necho EVIL\n'), join(evilDir, shell));
    const r = await run(['sh', '-c', `cat "$1" | ${shell} -s -- --local`, 'x', legit], {}, evilDir);
    expect(r.status, detail(r)).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toBe(STUB_BIN);
    expect(r.stdout).toContain('| sh -s -- --uninstall'); // the stream hint, not the path of the file in the checkout
    expect(r.stdout).not.toContain(join(evilDir, shell));
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  it.each([['sh installer.sh', ['sh', 'installer.sh']], ['./installer.sh', ['sh', './installer.sh']], ['bash dir/x.sh', ['bash', 'dir/x.sh']]] as const)('a file run is still a file run when named `%s`', async (_, [shell, name]) => {
    const dir = join(tmp, 'work');
    mkdirSync(join(dir, 'dir'), { recursive: true });
    copyFileSync(build(tmp, 'test'), join(dir, name));
    const r = await run([shell, name, '--local'], {}, dir);
    expect(r.status, detail(r)).toBe(0);
    expect(r.stdout).toContain(`${dir}/${name.replace(/^\.\//, '')} --uninstall`); // MAPX_INSTALLER, not the curl hint
    expect(readFileSync(installed(), 'utf8')).toBe(STUB_BIN);
  }, 30_000);

  it('without a terminal the PATH question is a no: the shell config is left alone and the export line is printed', async () => {
    writeFileSync(join(home, '.bashrc'), '# rc\n');
    const r = await piped(build(tmp, 'test'), 'sh', ['--local']);
    expect(r.status, detail(r)).toBe(0);
    expect(r.stdout).toContain('export PATH=');
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('# rc\n');
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  it('the uninstall hint names the command that runs the installer again, not a path', async () => {
    const r = await piped(build(tmp, 'linux-x64'), 'sh', ['--local']);
    expect(r.status, detail(r)).toBe(0);
    expect(r.stdout).toContain('Uninstall: curl -fsSL https://github.com/MohamedGamil/mapx/releases/latest/download/mapx-linux-x64-installer.sh | sh -s -- --uninstall');
  }, 30_000);

  it('a download cut short fails with a message and leaves TMPDIR empty', async () => {
    const installer = build(tmp, 'test');
    const whole = readFileSync(installer);
    const cut = join(tmp, 'cut-installer.sh');
    writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.9)));
    const r = await piped(cut, 'sh', ['--local']);
    expect(r.status, detail(r)).not.toBe(0);
    expect(r.stderr).toMatch(/Failed to extract archive/);
    expect(existsSync(installed())).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  it('a script that was cut before its payload (no marker) fails with a message', async () => {
    const whole = readFileSync(build(tmp, 'test'), 'latin1');
    const cut = join(tmp, 'cut-installer.sh');
    writeFileSync(cut, whole.slice(0, whole.indexOf('\n__PAYLOAD__\n')), 'latin1');
    const r = await piped(cut, 'sh', ['--local']);
    expect(r.status, detail(r)).toBe(1);
    expect(r.stderr).toMatch(/Failed to extract archive/);
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  it('a corrupted installer file (header, no marker) fails clearly instead of waiting on stdin', async () => {
    const whole = readFileSync(build(tmp, 'test'), 'latin1');
    const cut = join(tmp, 'cut-installer.sh');
    writeFileSync(cut, whole.slice(0, whole.indexOf('\n__PAYLOAD__\n')), 'latin1');
    const r = await run(['sh', cut, '--local']);
    expect(r.status, detail(r)).toBe(1);
    expect(r.stderr).toContain('Payload marker not found');
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  // SIGTERM / SIGINT / SIGHUP while a piped installer extracts: the folder goes, as from a file.
  it.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const)('%s during a piped extraction removes the folder and exits %i', async (signal, code) => {
    const installer = build(tmp, 'test');
    const shims = join(tmp, 'shims');
    mkdirSync(shims);
    const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
    const marker = join(tmp, 'at-tar');
    writeFileSync(join(shims, 'tar'), `#!/bin/sh\ntouch '${marker}'\nsleep 1\nexec '${realTar}' "$@"\n`, { mode: 0o755 });
    const child = spawn('sh', ['-s', '--', '--local'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, env: { ...process.env, HOME: home, TMPDIR: scratch, PATH: `${shims}:${process.env.PATH}` } });
    child.stdin.on('error', () => {});
    child.stdin.end(readFileSync(installer));
    const done = new Promise<number | null>((ok) => child.once('exit', (c) => ok(c)));
    for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(scratch).length).toBe(1);
    process.kill(child.pid!, signal); // the shell alone, as `kill` would
    expect(await done).toBe(code);
    expect(readdirSync(scratch)).toEqual([]);
  }, 30_000);

  // The documented commands, verbatim. `curl` is a shim that serves the installer built for the
  // platform in the URL and refuses any other URL; the commands run in the order the docs give
  // them, in one HOME: install, install elsewhere with flags, uninstall.
  describe('the commands README.md and docs/getting-started.md show', () => {
    const docs = docInstallerCommands();

    it('the docs show at least a bare install, one with options, and an uninstall', () => {
      expect(docs.length).toBeGreaterThanOrEqual(4);
      expect(docs.some((c) => c.args.length === 0)).toBe(true);
      expect(docs.some((c) => c.args.includes('--prefix'))).toBe(true);
      expect(docs.some((c) => c.args.includes('--uninstall'))).toBe(true);
      expect(new Set(docs.map((c) => c.platform)).size).toBeGreaterThanOrEqual(2);
    });

    it('run as written, each installs into a private HOME (or uninstalls what is there) and leaves TMPDIR empty', async () => {
      const served = join(tmp, 'served');
      for (const platform of new Set(docs.map((c) => c.platform))) build(served, platform);
      const shims = join(tmp, 'curl-shim');
      mkdirSync(shims);
      writeFileSync(join(shims, 'curl'), [
        '#!/bin/sh',
        'for a; do url="$a"; done',
        `case "$url" in https://github.com/MohamedGamil/mapx/releases/latest/download/mapx-*-installer.sh) exec cat "${served}/\${url##*/}" ;; esac`,
        'echo "curl: not a release URL: $url" >&2; exit 22',
      ].join('\n') + '\n', { mode: 0o755 });
      const env = { PATH: `${shims}:${process.env.PATH}` };
      let sawUninstall = false;
      for (const [n, c] of docs.entries()) {
        const h = join(tmp, `home-${n}`); // a fresh HOME per command: an install does not see the last one
        mkdirSync(h);
        const uninstall = c.args.includes('--uninstall');
        if (uninstall) {
          const pre = await run(['sh', '-c', c.line.replace(/ -s -- .*$/, ' -s -- --local')], { ...env, HOME: h });
          expect(pre.status, `${c.line}\n${detail(pre)}`).toBe(0); // something to remove
          expect(existsSync(join(h, '.local', 'bin', 'mapx'))).toBe(true);
        }
        const r = await run(['sh', '-c', c.line], { ...env, HOME: h });
        expect(r.status, `${c.file}: ${c.line}\n${detail(r)}`).toBe(0);
        expect(readdirSync(scratch), c.line).toEqual([]);
        const prefix = c.args.includes('--prefix') ? join(h, 'bin') : join(h, '.local', 'bin');
        if (uninstall) {
          sawUninstall = true;
          expect(existsSync(join(prefix, 'mapx')), c.line).toBe(false);
          expect(existsSync(join(h, '.local', 'share', 'mapx')), c.line).toBe(false);
        } else {
          expect(readFileSync(join(prefix, 'mapx'), 'utf8'), c.line).toBe(STUB_BIN);
          expect(readFileSync(join(resolve(prefix, '..'), 'share', 'mapx', 'wasm', 'g.wasm'), 'utf8'), c.line).toBe('wasm');
        }
      }
      expect(sawUninstall).toBe(true);
    }, 90_000);
  });

  // Prompts: with a terminal the answers are read from it though stdin is the pipe. A pseudo-terminal
  // is driven with Python's pty module (skipped where there is no python3).
  describe.skipIf(!has('python3'))('with a terminal', () => {
    const DRIVER = `
import json, os, pty, re, select, signal, sys
argv, script = json.loads(sys.argv[1]), json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
seen, i, deadline = '', 0, 25
while True:
    r, _, _ = select.select([fd], [], [], deadline)
    if not r:
        os.kill(pid, signal.SIGKILL); seen += '\\n[timeout]'; break
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    seen += d.decode('utf8', 'replace')
    if i < len(script) and re.search(script[i][0], seen):
        os.write(fd, (script[i][1] + '\\n').encode()); seen += '[answered %d]' % i; i += 1
_, st = os.waitpid(pid, 0)
print(json.dumps({'status': os.waitstatus_to_exitcode(st), 'out': seen, 'answered': i}))
`;
    /** Runs argv on a pty and types \`script\`: [pattern, reply] pairs, each once, in order. */
    function onPty(argv: string[], script: [string, string][]): { status: number; out: string; answered: number } {
      const r = spawnSync('python3', ['-I', '-c', DRIVER, JSON.stringify(argv), JSON.stringify(script)], { encoding: 'utf8', env: { ...process.env, HOME: home, TMPDIR: scratch, NO_COLOR: '1' } });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout);
    }

    it.each(shells)('`cat installer | %s -s --` asks the menu, the prefix and install.sh\'s prompts on the terminal', (shell) => {
      const installer = build(tmp, 'test');
      const prefix = join(tmp, 'my bin');
      mkdirSync(prefix);
      writeFileSync(join(prefix, 'mapx'), '#!/bin/sh\necho old\n', { mode: 0o755 });
      writeFileSync(join(home, '.bashrc'), '# rc\n');
      const rc = readFileSync(join(home, '.bashrc'), 'utf8');
      const r = onPty(['sh', '-c', `cat "$0" | ${shell} -s --`, installer], [
        ['Choice \\[1\\]: $', '3'],
        ['Install prefix: $', prefix],
        ['Overwrite\\? \\[y/N\\] $', 'y'],
        ['to PATH in .*\\? \\[y/N\\] $', 'n'],
      ]);
      expect(r.status, r.out).toBe(0);
      expect(r.answered, r.out).toBe(4);
      expect(readFileSync(join(prefix, 'mapx'), 'utf8')).toBe(STUB_BIN);
      expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe(rc); // "n": the shell config is untouched
      expect(readdirSync(scratch)).toEqual([]);
    }, 60_000);

    // `bash <(curl ...)` and `sh -c "$(curl ...)"` leave stdin on the terminal: there is no payload on
    // it, and reading the terminal would hang. The installer stops before it asks or unpacks.
    it.each([['bash <(cat "$0")', 'bash'], ['sh -c "$(sed \'/^#####/,$d\' "$0")"', 'sh']] as const)('`%s` on a terminal stops at once with a message', (cmd, shell) => {
      if (!has(shell)) return;
      const r = onPty([shell, '-c', cmd, build(tmp, 'test')], [['Choice \\[1\\]: $', '1']]);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('No installer payload to read');
      expect(r.answered, r.out).toBe(0); // no menu
      expect(r.out).not.toContain('[timeout]');
      expect(existsSync(installed())).toBe(false);
      expect(readdirSync(scratch)).toEqual([]);
    }, 60_000);

    // The payload is read before the first question. The installer is bigger than a pipe holds, so a
    // reader that stopped at the prompt would leave `cat` blocked, then killed by SIGPIPE when "q"
    // ends the installer: the marker `cat && touch` writes would be missing (curl: "Failure writing output").
    it('the whole script is read before the menu: quitting leaves the sender finished, not cut off', () => {
      const done = join(tmp, 'sender-done');
      const r = onPty(['sh', '-c', '(cat "$0" && touch "$1") | sh -s --', build(tmp, 'test'), done], [['Choice \\[1\\]: $', 'q']]);
      expect(r.status, r.out).toBe(0);
      expect(existsSync(done), r.out).toBe(true);
      expect(readdirSync(scratch)).toEqual([]);
    }, 60_000);

    it('"q" at the menu quits without installing, and leaves TMPDIR empty', () => {
      const r = onPty(['sh', '-c', 'cat "$0" | sh -s --', build(tmp, 'test')], [['Choice \\[1\\]: $', 'q']]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('Aborted.');
      expect(existsSync(installed())).toBe(false);
      expect(readdirSync(scratch)).toEqual([]);
    }, 60_000);

    it('a bare Enter at the menu takes the user install', () => {
      const r = onPty(['sh', '-c', 'cat "$0" | sh -s --', build(tmp, 'test')], [['Choice \\[1\\]: $', '']]);
      expect(r.status, r.out).toBe(0);
      expect(readFileSync(installed(), 'utf8')).toBe(STUB_BIN);
      expect(readdirSync(scratch)).toEqual([]);
    }, 60_000);
  });
});
