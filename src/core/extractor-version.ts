import type { Store } from './store.js';

/**
 * The version of what a scan extracts (M5-26). Bump it when a change makes an unchanged file index
 * differently (new edges, symbols or resolution), so an index built before it counts as stale and the
 * next scan or sync re-parses every file once. 1: M5-25 (Go cross-package literals) and M2-08-R1
 * (import-bound calls through barrels).
 */
export const EXTRACTOR_VERSION = 1;

export const extractorVersionKey = (repo: string) => `extractor_version:${repo}`;

/** Scanned repos whose index an older extractor built (no recorded version counts as older). */
export function outdatedRepos(store: Store, repoNames: string[] = store.getRepoNames()): string[] {
  return repoNames.filter(r => !!store.getMeta('last_scan_time:' + r) && Number(store.getMeta(extractorVersionKey(r)) ?? 0) < EXTRACTOR_VERSION);
}

/** The warning for an index an older extractor built, or '' (M5-26). */
export function outdatedIndexWarning(store: Store, rescan: string): string {
  // A partial store (a test double without the meta API) records no version to compare.
  if (typeof store.getRepoNames !== 'function' || typeof store.getMeta !== 'function') return '';
  const repos = outdatedRepos(store);
  return repos.length ? `The index of ${repos.join(', ')} was built by an older MapX: ${rescan} to rebuild it.` : '';
}
