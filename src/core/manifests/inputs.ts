// The manifests and lockfiles the external-reference attribution read (M5-20 review). They are not
// indexed files, so the end-of-run pass records their content hashes in meta. The next pass compares
// them to skip re-attribution when nothing changed, and the stale check reports a change to them as
// a stale index (`mapx status`, `check --sync`).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { YarnRoots } from './npm.js';

export const EXTERNAL_INPUTS_KEY = 'external_inputs';

export interface ExternalInputs {
  /** When the pass started reading (ms since the epoch). */
  at: number;
  /** Workspace-relative path → md5 of its text, or null when absent or unreadable. */
  files: Record<string, string | null>;
  /** The yarn locks' roots, which the set of indexed folders decides. */
  yarnRoots: YarnRoots[];
  /** The attribution-rules version of the pass that recorded them (ATTRIBUTION_VERSION; 1 when not recorded, M5-19-R1). */
  rules: number;
}

export const contentHash = (text: string | null): string | null => (text === null ? null : createHash('md5').update(text).digest('hex'));

/**
 * What a path that is there but cannot be read (a folder, a file without permission) is recorded
 * as, so removing or fixing it is a change (M5-20-R1 review): it ends a lockfile walk, absence does not.
 */
export const UNREADABLE_INPUT = '\u0000unreadable';

/**
 * Composer's generated autoload metadata under a Composer root's `vendor/` (M5-21-R1), read as data
 * (never executed) and never a package's sources: the classmap (class → file), the `files` autoload
 * (the files each package loads) and installed.json (each package's install path). The attributor
 * records each one it reads, or probes and finds absent, with the other inputs, so a sync and the
 * stale check notice `composer install` or `composer dump-autoload` rewriting them.
 */
export const COMPOSER_VENDOR_INPUTS = {
  classmap: 'vendor/composer/autoload_classmap.php',
  files: 'vendor/composer/autoload_files.php',
  installed: 'vendor/composer/installed.json',
} as const;
const UNREADABLE_HASH = contentHash(UNREADABLE_INPUT);

export function parseExternalInputs(value: string | null | undefined): ExternalInputs | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    return v && typeof v.at === 'number' && v.files && typeof v.files === 'object' ? { at: v.at, files: v.files, yarnRoots: Array.isArray(v.yarnRoots) ? v.yarnRoots : [], rules: typeof v.rules === 'number' ? v.rules : 1 } : null;
  } catch {
    return null;
  }
}

/**
 * A file untouched since well before the recording (its mtime two seconds before it, for file
 * systems with coarse timestamps) is unchanged without reading it; any other is hashed.
 */
const SLACK_MS = 2000;

/** The names that match a basename pattern whose `*` stands for any text (`*requirements*.txt`), sorted. */
export function matchGlob(names: Iterable<string>, pattern: string): string[] {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return [...names].filter((n) => re.test(n)).sort();
}

/**
 * The text a glob input is recorded with (M5-22): the folder's names that match, one per line; null
 * when the folder cannot be listed. A file created or removed there changes it.
 */
export function globInputText(root: string, path: string): string | null {
  const at = path.lastIndexOf('/');
  try {
    return matchGlob(readdirSync(resolve(root, at < 0 ? '.' : path.slice(0, at))), path.slice(at + 1)).join('\n');
  } catch {
    return null;
  }
}

/** The recorded files whose content differs now: changed, created or removed. A path with `*` is a folder's matching names. */
export function changedInputFiles(root: string, inputs: ExternalInputs): string[] {
  const changed: string[] = [];
  for (const [path, expected] of Object.entries(inputs.files)) {
    if (path.includes('*')) {
      if (contentHash(globInputText(root, path)) !== expected) changed.push(path);
      continue;
    }
    const abs = resolve(root, path);
    let exists = false;
    let isFile = false;
    let mtime = 0;
    try {
      const st = statSync(abs);
      exists = true;
      isFile = st.isFile();
      mtime = st.mtimeMs;
    } catch { /* absent */ }
    if (!exists) {
      if (expected !== null) changed.push(path);
      continue;
    }
    if (!isFile) {
      if (expected !== UNREADABLE_HASH) changed.push(path);
      continue;
    }
    if (expected !== null && expected !== UNREADABLE_HASH && mtime < inputs.at - SLACK_MS) continue;
    let text: string | null = null;
    try { text = readFileSync(abs, 'utf-8'); } catch { /* unreadable */ }
    if (contentHash(text ?? UNREADABLE_INPUT) !== expected) changed.push(path);
  }
  return changed;
}
