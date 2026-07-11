import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Find the root directory that contains wasm/ and queries/ subdirectories.
 * metaUrl is the import.meta.url from the calling file to ensure relative paths
 * resolve correctly across environments (Node, Bun, compiled binaries).
 */
export function findAssetRoot(metaUrl: string): string {
  let thisFile: string;
  try {
    thisFile = fileURLToPath(metaUrl);
  } catch {
    thisFile = '';
  }

  if (thisFile && existsSync(thisFile) && !thisFile.startsWith('/$bunfs') && !thisFile.startsWith('bun:')) {
    // Source/dev or npm-installed transpiled: navigate up from dist/parsers/ or src/parsers/
    return resolve(dirname(thisFile), '..', '..');
  }

  // Compiled binary or special runtime (like Bun bundle): search candidate directories for the wasm/ subdir
  const binDir = dirname(process.execPath);
  const candidates = [
    binDir,                                              // assets next to binary
    resolve(binDir, '..'),                               // dev build project root
    resolve(binDir, '..', 'share', 'mapx'),              // XDG system: /usr/local/share/mapx
    join(process.env['HOME'] ?? '', '.local', 'share', 'mapx'), // XDG user
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'wasm'))) return dir;
  }

  return binDir; // fallback — will produce a clear "file not found" on first use
}
