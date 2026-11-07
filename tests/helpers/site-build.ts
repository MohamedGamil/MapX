// Builds the GitHub Pages site for a test (M7-01, M7-02). `npm run site:build` regenerates the shared
// site/docs/ folder first, so two builds at once would wipe each other's input: vitest runs test files
// in parallel forks, and a Playwright run may start meanwhile. A lock folder inside site/ (gitignored)
// serialises every test that builds. A lock older than STALE_MS belongs to a killed process and is taken
// over. A hand-run `npm run site:build` does not take the lock.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
const LOCK = join(REPO, 'site', '.build.lock');
/** A build takes seconds; a lock this old was left by a process that died. */
const STALE_MS = 10 * 60_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `fn` while holding the lock; waits up to `timeoutMs` for another builder to finish. */
function withLock<T>(fn: () => T, timeoutMs = 300_000): T {
  const lock = LOCK;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error(`another site build held ${lock} for over ${timeoutMs} ms`);
      sleep(200);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Builds the site into `out` (an absolute path). `base` unset means the default base. Throws on failure. */
export function buildSite(out: string, base?: string): void {
  const env = { ...process.env, SITE_OUT: out } as NodeJS.ProcessEnv;
  if (base === undefined) delete env.SITE_BASE;
  else env.SITE_BASE = base;
  withLock(() => {
    const r = spawnSync('npm', ['run', 'site:build', '--silent'], { cwd: REPO, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`site:build exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  });
}

/** The file VitePress wrote for a URL path under `base` (cleanUrls: no .html), or null. Only a file counts: Pages answers a folder without an index with a 404. */
export function builtFileFor(out: string, base: string, pathname: string): string | null {
  if (!pathname.startsWith(base)) return null;
  const rel = pathname.slice(base.length);
  const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [`${rel}.html`, rel, `${rel}/index.html`];
  for (const c of candidates) if (existsSync(join(out, c)) && statSync(join(out, c)).isFile()) return join(out, c);
  return null;
}

/** Builds the site the way the Pages workflow does: no SITE_OUT, no SITE_BASE, so the output lands in site/.vitepress/dist. */
export function buildSiteDefaultOutput(): string {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.SITE_OUT;
  delete env.SITE_BASE;
  withLock(() => {
    const r = spawnSync('npm', ['run', 'site:build', '--silent'], { cwd: REPO, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`site:build exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  });
  return join(REPO, 'site', '.vitepress', 'dist');
}
