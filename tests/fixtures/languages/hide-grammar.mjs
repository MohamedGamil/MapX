// Synthetic test fixture (M0-12-R6): makes bundled grammar files look missing without deleting them.
// As a preload (`--import`), it hides the basenames listed in MAPX_TEST_HIDE_GRAMMAR (comma-separated);
// in-process, `hideGrammars([...])` hides them and returns a function that restores `existsSync`.
// `syncBuiltinESMExports` makes `import { existsSync } from 'node:fs'` bindings see the patch.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

export function hideGrammars(names) {
  const original = fs.existsSync;
  fs.existsSync = (p) => (names.some((n) => String(p).endsWith(`/${n}`)) ? false : original(p));
  syncBuiltinESMExports();
  return () => {
    fs.existsSync = original;
    syncBuiltinESMExports();
  };
}

const fromEnv = (process.env.MAPX_TEST_HIDE_GRAMMAR ?? '').split(',').filter(Boolean);
if (fromEnv.length) hideGrammars(fromEnv);
