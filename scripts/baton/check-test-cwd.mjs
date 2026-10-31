#!/usr/bin/env node
// M4-09: run test files and check they leave the checkout alone: the bytes of every file under
// `.mapx/` and the list of top-level entries are the same before and after.
// Usage: node scripts/baton/check-test-cwd.mjs tests/cli.test.ts tests/cli-coverage.test.ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const snapshot = () => {
  const mapx = {};
  const walk = (dir) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else mapx[path] = createHash('sha1').update(readFileSync(path)).digest('hex');
    }
  };
  walk('.mapx');
  return { mapx, top: readdirSync('.').sort() };
};
const before = snapshot();
const run = spawnSync('npx', ['vitest', 'run', ...process.argv.slice(2)], { stdio: 'inherit' });
const after = snapshot();
const changed = [
  ...Object.keys({ ...before.mapx, ...after.mapx }).filter((p) => before.mapx[p] !== after.mapx[p]).map((p) => `changed ${p}`),
  ...after.top.filter((n) => !before.top.includes(n)).map((n) => `new ${n}`),
  ...before.top.filter((n) => !after.top.includes(n)).map((n) => `removed ${n}`),
];
if (changed.length) console.error(`The tests touched the checkout:\n  ${changed.join('\n  ')}`);
process.exit(run.status !== 0 ? run.status ?? 1 : changed.length ? 1 : 0);
