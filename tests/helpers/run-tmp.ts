// A private temp directory for one test run, and the check that the run left it empty (M4-09-R5).
//
// `isolateTmp()` runs in the runner's main process before any worker starts (vitest's and
// Playwright's global setup): it creates `<tmpdir>/mapx-run-tmp-XXXXXX` and points TMPDIR, TMP and
// TEMP at it. Workers are forked afterwards, so they and every CLI they spawn inherit it:
// `os.tmpdir()` reads the environment on each call. Every `mkdtempSync(join(tmpdir(), …))` of a test
// then lands in that one folder, and `finishTmp()` (the global teardown) can tell, whatever other
// processes put in the shared /tmp meanwhile, what this run left: anything but the tools' caches.
//
// A private folder rather than a before/after snapshot of the shared tmpdir, because other agent
// sessions and test runs create mapx-* folders there at the same time, and /tmp can hold tens of
// thousands of entries. It is removed at the end either way, so a failing, killed or interrupted
// run does not leave its folders (the built-CLI mirror `mapx-cli-*` included) behind.
//
// The folder must stay on a short path: tsx puts a unix socket in it, and socket paths are limited
// to ~107 bytes, so it is made under the OS tmpdir the run was started with, not under the checkout.
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Environment variable that names the run's private folder, for the teardown and for tests. */
export const RUN_TMP_ENV = 'MAPX_RUN_TMP';

/**
 * Caches the tools keep in the temp directory are no leftovers: Node's compile cache, tsx's
 * per-user cache (`tsx-<uid>`, or `tsx-<username>` where there is no uid) and Playwright's
 * transform cache.
 */
export const TOOL_CACHE = /^(?:node-compile-cache|v8-compile-cache(?:-\d+)?|tsx-[^/\\]+|playwright-transform-cache-[^/\\]+)$/;

const REPO = resolve(import.meta.dirname, '../..');

/** Set when SIGINT or SIGTERM arrived: an interrupted run's leftovers are expected, not a failure. */
let interrupted = false;

/** Whether this run was interrupted by a signal. */
export function wasInterrupted(): boolean {
  return interrupted;
}

/** Removes `dir`, making read-only folders writable first when the plain removal fails. */
export function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    const writable = (d: string) => {
      chmodSync(d, 0o700);
      for (const name of readdirSync(d)) if (lstatSync(join(d, name)).isDirectory()) writable(join(d, name));
    };
    writable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Set by a wrapper that already gave the run a private temp folder and checks it itself
 * (scripts/baton/check-test-cwd.mjs): the path of that folder.
 */
export const OWNED_TMP_ENV = 'MAPX_RUN_TMP_OWNED';

export interface IsolateOptions {
  /**
   * Exit on SIGINT, SIGTERM and SIGHUP after removing the folder, whatever else listens. vitest needs
   * this: its own listener (signal-exit) re-kills the process only when it is the sole listener, so
   * ours would keep a signalled runner alive (SIGHUP, which vitest has no handler of its own for).
   * Playwright shuts down in its own way and runs its teardown, so there ours exits only when nothing
   * else listens.
   */
  exitOnSignal?: boolean;
}

/**
 * Creates the run's private temp folder, points the temp variables at it and returns its path, or
 * returns '' when a wrapper already owns the run's temp folder (OWNED_TMP_ENV names the current
 * one): a second, nested folder would only lengthen the path of tsx's unix socket, which is limited
 * to ~104 bytes (the wrapper's folder is `<tmpdir>/mapx-check-cwd-tmp-XXXXXX`; with macOS's ~49-character
 * tmpdir the socket path would be 49+28+20+19 = 116 nested, 96 not). It also removes the folder when
 * the process gets SIGINT, SIGTERM or SIGHUP, so an interrupted run leaves nothing. Call it once per
 * run, in the main process.
 */
export function isolateTmp(options: IsolateOptions = {}): string {
  const owned = process.env[OWNED_TMP_ENV];
  if (owned && resolve(owned) === resolve(tmpdir())) {
    delete process.env[RUN_TMP_ENV];
    return '';
  }
  // Absolute: a relative TMPDIR would name a different folder for every child with another cwd.
  const dir = mkdtempSync(join(resolve(tmpdir()), 'mapx-run-tmp-'));
  process.env['TMPDIR'] = process.env['TMP'] = process.env['TEMP'] = process.env[RUN_TMP_ENV] = dir;
  interrupted = false;

  const sweep = () => { try { removeTree(dir); } catch { /* best effort: the teardown reports it */ } };
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    const onSignal = () => {
      interrupted = true;
      sweep();
      if (options.exitOnSignal || process.listenerCount(signal) <= 1) process.exit(code);
    };
    process.on(signal, onSignal);
  }
  return dir;
}

/** The names a test file could have made `name` with: files under tests/ and scripts/ that name its prefix. */
function likelySources(name: string): string[] {
  // mkdtemp appends six random characters: `mapx-arch-sel-foo-aB3dE9` -> `mapx-arch-sel-foo-`.
  const stem = name.replace(/[A-Za-z0-9]{6}$/, '');
  const parts = stem.split('-').filter(Boolean);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') walk(p); }
      else if (/\.(?:ts|mts|mjs|sh)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ['tests', 'scripts']) if (existsSync(join(REPO, d))) walk(join(REPO, d));
  // The longest leading run of segments that some source names literally (the code builds the rest).
  for (let n = parts.length; n >= 2; n--) {
    const needle = parts.slice(0, n).join('-');
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(needle)).map((f) => f.slice(REPO.length + 1));
    if (hits.length > 0) return hits.slice(0, 4);
  }
  return [];
}

/** What a leftover holds, for the message: its first few entries. */
function describeEntry(dir: string, name: string): string {
  try {
    const st = lstatSync(join(dir, name));
    if (!st.isDirectory()) return name;
    const inside = readdirSync(join(dir, name));
    return `${name}/ (${inside.length ? inside.slice(0, 3).join(', ') + (inside.length > 3 ? ', …' : '') : 'empty'})`;
  } catch {
    return name;
  }
}

/**
 * The global teardown: reports every entry the run left in its private folder (tool caches
 * excepted) and removes the folder. Throws, naming each leftover and the files that probably made
 * it, unless the run was interrupted. `label` says which runner it was.
 */
export function finishTmp(dir: string | undefined, label: string): void {
  // No folder: a wrapper owns the run's temp folder and checks it (see isolateTmp).
  if (!dir || !existsSync(dir)) return;
  const left = readdirSync(dir).filter((n) => !TOOL_CACHE.test(n)).sort();
  const details = left.map((n) => {
    const src = likelySources(n);
    return `  ${describeEntry(dir, n)}  <- ${src.length ? src.join(', ') : 'no test names this prefix: made by a child process (mktemp?) or by the runner'}`;
  });
  try {
    removeTree(dir);
  } catch (err) {
    console.error(`[${label}] could not remove ${dir}: ${(err as Error).message}`);
  }
  if (left.length > 0 && !interrupted) {
    // The runners only print an error thrown by a global teardown; the exit code must say it too.
    process.exitCode = 1;
    throw new Error(`${label}: the run left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its temp folder (every test must remove what it creates):\n${details.join('\n')}`);
  }
}
