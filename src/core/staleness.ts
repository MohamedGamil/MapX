// Is the graph index stale? Shared by CLI and MCP (docs/baton M0-11-R1): a file counts as changed
// only if its content differs from what was scanned (a rewrite with identical content is not
// stale), deleted files count, and new untracked source files count too.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import picomatch from 'picomatch';
import type { Store } from './store.js';
import { getLanguageForFile } from '../languages/registry.js';

export interface StaleReport {
  changed: string[];
  deleted: string[];
  added: string[];
}

function configExcludes(dir: string): (path: string) => boolean {
  try {
    const config = JSON.parse(readFileSync(join(dir, '.mapx', 'config.json'), 'utf-8'));
    const patterns: string[] = config?.settings?.excludePatterns ?? [];
    return patterns.length ? picomatch(patterns, { dot: true }) : () => false;
  } catch {
    return () => false;
  }
}

/** New source files git does not track yet and the index has not seen. */
function untrackedSourceFiles(dir: string, known: Set<string>): string[] {
  let out = '';
  try {
    out = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26,
    });
  } catch {
    return [];
  }
  const excluded = configExcludes(dir);
  return out.split('\n').filter(p => p && !known.has(p) && !p.startsWith('.mapx/') && !excluded(p) && getLanguageForFile(p) !== null);
}

export function findStaleFiles(store: Store, dir: string): StaleReport {
  const report: StaleReport = { changed: [], deleted: [], added: [] };
  try {
    const files = store.getAllFiles();
    for (const file of files) {
      const path = file.path as string;
      const abs = resolve(dir, path);
      if (!existsSync(abs)) {
        report.deleted.push(path);
        continue;
      }
      const scannedAt = new Date(file.last_scanned as string).getTime();
      if (statSync(abs).mtimeMs <= scannedAt) continue;
      // Touched since the scan: stale only if the content really differs.
      const stored = file.content_hash as string | null;
      if (stored) {
        const hash = createHash('md5').update(readFileSync(abs, 'utf-8')).digest('hex');
        if (hash === stored) continue;
      }
      report.changed.push(path);
    }
    report.added = untrackedSourceFiles(dir, new Set(files.map(f => f.path as string)));
  } catch {
    // An unreadable index is reported elsewhere; never fail a query on staleness.
  }
  return report;
}

export const staleCount = (r: StaleReport) => r.changed.length + r.deleted.length + r.added.length;

/** Up to `max` names: changed first, then `(deleted)` and `(new)` entries. */
export function staleNames(r: StaleReport, max = 5): string[] {
  return [...r.changed, ...r.deleted.map(p => `${p} (deleted)`), ...r.added.map(p => `${p} (new)`)].slice(0, max);
}
