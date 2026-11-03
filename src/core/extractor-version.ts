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
 * - 4: M5-25-R1 (Go package-qualified calls; generic, slice, array and map literals; go.work and
 *   local `replace` modules).
 * - 5: M5-03-R2 (C++ `.h` headers parsed as C++; calls in a one-line function sourced from it; the
 *   namespace of each C# and Scala declaration).
 * - 6: M2-10 (Lua `obj:m()` and `self:m()` method calls; global `function f()` symbols; no locals or
 *   `self.x` fields as constants, M2-11).
 * - 7: M2-09 (JS/TS member-assigned functions are symbols).
 * - 8: M5-10 (decorators, attributes and doc tags in symbol metadata: PHP, TS/JS, Python, Java,
 *   Kotlin, C#).
 * - 9: M5-19 (external references: candidates of references outside the workspace, decided again
 *   at the end of every scan and sync).
 * - 10: M5-11 (Go doc-comment tags; the restricted native visibility of Kotlin, C#, Java and Rust
 *   symbols in metadata).
 * - 11: M5-09 (TS `abstract class` symbols and their bases; TS and PHP interface `extends` edges; PHP
 *   trait uses in `metadata.mixins`).
 * - 12: M5-21 review (PHP `use function` / `use const` imports and a facade's named class, `\Cache`
 *   in a namespaced file, in external-reference candidates).
 * - 13: M5-25-R2 (Go methods with a generic receiver, `func (p *Pair[K, V]) Set()`, are symbols; a
 *   Go method called on a variable or parameter of a written type links that type's method, and a
 *   by-name match stays in the caller's package or a package its file imports).
 * - 14: M3-05-R3 (a Pinia/Vuex library declared at a monorepo root counts for the packages its
 *   workspace globs list, up to the repository root).
 * - 15: M2-08-R3 (a JS/TS name bound by an import from outside the project links no project symbol;
 *   a bare name an ES module neither imports nor declares links no other module's declaration; bare
 *   imports resolve under a tsconfig/jsconfig `baseUrl`; files record their global scope).
 */
export const EXTRACTOR_VERSION = 15;

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
