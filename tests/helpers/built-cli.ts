// A transpiled copy of the CLI for e2e tests that spawn it many times (M4-30).
//
// Under tsx, about 400 ms of each ~600 ms CLI start is tsx resolving and loading the sources, so a
// file with a hundred `mapx check` calls spent a minute starting processes, and timed out at load
// 25+. This transpiles src/ once per test process with esbuild, unbundled and as ESM (what tsup
// does for the npm build), into a temporary mirror of the repository: src/ as .js beside its
// non-TypeScript files (presets, the agents stub), and the other top-level entries (node_modules,
// wasm, queries, VERSION, package.json…) as symlinks, so every import.meta.url lookup resolves as in
// a checkout. The CLI then starts as plain `node main.js` in ~200 ms. The sources are read at
// build time, so a test run always runs the current src/.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { buildSync } from 'esbuild';

const REPO = resolve(__dirname, '../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p !== join(REPO, 'src', 'ui')) sources(p, out); // the dashboard: built separately, not run by the CLI
    } else out.push(p);
  }
  return out;
}

/** Builds the mirror and returns its root; `main` is `<root>/src/main.js`. */
export function buildCli(): string {
  const root = mkdtempSync(join(tmpdir(), 'mapx-cli-'));
  try {
    for (const e of readdirSync(REPO)) {
      if (e !== 'src' && e !== '.git') symlinkSync(join(REPO, e), join(root, e));
    }
    const files = sources(join(REPO, 'src'));
    for (const f of files.filter((f) => !f.endsWith('.ts'))) {
      const to = join(root, relative(REPO, f));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(f, to);
    }
    buildSync({
      entryPoints: files.filter((f) => f.endsWith('.ts')),
      outdir: join(root, 'src'),
      outbase: join(REPO, 'src'),
      format: 'esm',
      platform: 'node',
      target: 'node20',
      logLevel: 'error',
    });
    return root;
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}
