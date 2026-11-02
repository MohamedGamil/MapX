import type { Store } from './store.js';

/**
 * The version of what a scan extracts (M5-26). Bump it when a change makes an unchanged file index
 * differently (new edges, symbols or resolution), so an index built before it counts as stale and the
 * next scan or sync re-parses every file once.
 * - 1: M5-25 (Go cross-package literals), M2-08-R1 (import-bound calls through barrels).
 * - 2: M0-12-R11 (Svelte template scopes), M1-07-R3 (Laravel route-file arrays), M3-05-R2 (Pinia and
 *   Vuex members), M2-08-R2 (recorded unresolved imports).
 * - 3: M4-27 (every Lua file parses, not only the first of a process), M2-04-R4 (axios client
 *   scopes), M2-06-R4 (route-domain hosts).
 */
export const EXTRACTOR_VERSION = 3;

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
