#!/usr/bin/env node
// M4-09, M4-09-R1: run tests and check they leave the checkout alone. Before and after the run it
// snapshots `git status` (tracked changes, untracked and ignored paths, file by file) with a hash
// of each listed file, and a hash of every file under `.mapx/`; any difference fails the check.
// Usage:
//   node scripts/baton/check-test-cwd.mjs                      # the whole vitest suite
//   node scripts/baton/check-test-cwd.mjs tests/cli.test.ts    # some test files
//   node scripts/baton/check-test-cwd.mjs --cmd <command> [args…]   # any command (its own tests)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const hash = (path) => {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return st.isDirectory() ? 'dir' : 'other';
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
};

const snapshot = () => {
  const files = new Map();
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { encoding: 'utf8' });
  if (status.status !== 0) throw new Error(`git status failed: ${status.stderr}`);
  const entries = status.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the rename's source follows
    // Installed packages and build output change legitimately; their own tests own them.
    if (/^(node_modules|dist|coverage|test-results|playwright-report)\//.test(path)) continue;
    if (path.endsWith('/')) continue; // a directory collapsed by git; its files are listed or ignored
    files.set(path, `${code} ${hash(path)}`);
  }
  const walk = (dir) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else files.set(path, `.mapx ${hash(path)}`);
    }
  };
  walk('.mapx');
  return files;
};

const args = process.argv.slice(2);
const [cmd, ...cmdArgs] = args[0] === '--cmd' ? args.slice(1) : ['npx', 'vitest', 'run', ...args];
const before = snapshot();
const run = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
const after = snapshot();
const changed = [];
for (const path of new Set([...before.keys(), ...after.keys()])) {
  const a = before.get(path), b = after.get(path);
  if (a === b) continue;
  changed.push(!a ? `new ${path}` : !b ? `restored or removed ${path}` : `changed ${path}`);
}
// A tracked file the run deleted shows as a new " D" entry; one it edited as a new " M" entry.
if (changed.length) console.error(`The tests touched the checkout:\n  ${changed.sort().join('\n  ')}`);
process.exit(run.status !== 0 ? run.status ?? 1 : changed.length ? 1 : 0);
