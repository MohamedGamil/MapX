// The manifests and lockfiles the external-reference attribution read (M5-20 review). They are not
// indexed files, so the end-of-run pass records their content hashes in meta. The next pass compares
// them to skip re-attribution when nothing changed, and the stale check reports a change to them as
// a stale index (`mapx status`, `check --sync`).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
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
}

export const contentHash = (text: string | null): string | null => (text === null ? null : createHash('md5').update(text).digest('hex'));

export function parseExternalInputs(value: string | null | undefined): ExternalInputs | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    return v && typeof v.at === 'number' && v.files && typeof v.files === 'object' ? { at: v.at, files: v.files, yarnRoots: Array.isArray(v.yarnRoots) ? v.yarnRoots : [] } : null;
  } catch {
    return null;
  }
}

/**
 * A file untouched since well before the recording (its mtime two seconds before it, for file
 * systems with coarse timestamps) is unchanged without reading it; any other is hashed.
 */
const SLACK_MS = 2000;

/** The recorded files whose content differs now: changed, created or removed. */
export function changedInputFiles(root: string, inputs: ExternalInputs): string[] {
  const changed: string[] = [];
  for (const [path, expected] of Object.entries(inputs.files)) {
    const abs = resolve(root, path);
    let isFile = false;
    let mtime = 0;
    try {
      const st = statSync(abs);
      isFile = st.isFile();
      mtime = st.mtimeMs;
    } catch { /* absent */ }
    if (!isFile) {
      if (expected !== null) changed.push(path);
      continue;
    }
    if (expected !== null && mtime < inputs.at - SLACK_MS) continue;
    let text: string | null = null;
    try { text = readFileSync(abs, 'utf-8'); } catch { /* unreadable */ }
    if (contentHash(text) !== expected) changed.push(path);
  }
  return changed;
}
