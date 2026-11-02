// Synthetic test fixture (M5-05-R1): counts walks of a workspace, i.e. listings of its root folder
// with `readdirSync(root, { withFileTypes: true })`, which the staleness walk does once per walk.
// As a preload (`--import`), it counts listings of MAPX_TEST_COUNT_WALKS and appends the count to
// the file MAPX_TEST_COUNT_WALKS_OUT at exit; in-process, `countWalks(root)` returns
// `{ count, restore }`. `syncBuiltinESMExports` makes `import { readdirSync } from 'node:fs'`
// bindings see the patch.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

export function countWalks(root) {
  const original = fs.readdirSync;
  const target = resolve(root);
  let n = 0;
  fs.readdirSync = function (path, options) {
    if (options && typeof options === 'object' && options.withFileTypes && resolve(String(path)) === target) n++;
    return original.apply(this, arguments);
  };
  syncBuiltinESMExports();
  return {
    count: () => n,
    restore: () => {
      fs.readdirSync = original;
      syncBuiltinESMExports();
    },
  };
}

const root = process.env.MAPX_TEST_COUNT_WALKS;
const out = process.env.MAPX_TEST_COUNT_WALKS_OUT;
if (root && out) {
  const counter = countWalks(root);
  process.on('exit', () => fs.appendFileSync(out, `${counter.count()}\n`));
}
