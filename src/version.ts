/**
 * MapxGraph version — single source of truth.
 *
 * At build time, `MAPX_BUILD_VERSION` is replaced by the `--define` flag
 * in bun/esbuild with the value from the root VERSION file.
 * At dev time (tsx), the fallback reads the VERSION file from disk.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const MAPX_BUILD_VERSION: string | undefined;

function resolveVersion(): string {
  // 1. Build-time injected constant (bun build --define)
  if (typeof MAPX_BUILD_VERSION !== 'undefined') {
    return MAPX_BUILD_VERSION;
  }

  // 2. Fallback: read VERSION file from disk (dev mode via tsx)
  const base = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(base, 'VERSION'),
    join(base, '..', 'VERSION'),
    join(base, '..', '..', 'VERSION'),
  ]) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf-8').trim();
    }
  }

  return '0.0.0';
}

export const VERSION = resolveVersion();
