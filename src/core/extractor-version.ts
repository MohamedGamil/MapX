import type { Store } from './store.js';
import { EXTERNAL_INPUTS_KEY, parseExternalInputs } from './manifests/inputs.js';

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
 * - 16: M2-12 (a method called on a new instance, `new X().m()`, `(new X())->m()`, Python `X().m()`,
 *   links the method class X declares, in JS/TS, PHP, Java, C# and Python).
 * - 17: M2-13 (a PHP reference inside a one-line declaration comes from it, and one in no
 *   declaration from the file, by the syntax tree; PHP names resolve in the namespace block or
 *   statement in force where they are written).
 * - 18: M5-23-R1 (under a go.mod that is there but cannot be read, imports of the module's own
 *   packages resolve by the folder layout: import edges, no external rows).
 * - 19: M5-21-R1 (PHP names of PECL extensions are ambient; with vendor/composer metadata, classmap
 *   and files names are attributed to their installed package. The stored attribution of an index
 *   built before is skipped while its recorded inputs stand, so it is rebuilt once).
 * - 20: M2-20 (a JS/TS `require('./m')` of a project module is an import edge, and the names it binds
 *   link the module's `module.exports` / `exports.f` declarations; `module.exports = function f` and
 *   `= class C` declare f and C).
 * - 21: M5-25-R4 (a Go method whose receiver type is in parentheses, `func (b (*Box)) M()`, is a symbol
 *   scoped to the type).
 * - 22: M2-25, M2-26 (a call through a for / for-of / for-in variable, a catch parameter, a comprehension
 *   variable or a local destructured from a call result, not an import or a `require`, links no
 *   same-named function or class elsewhere).
 * - 23: M5-24-R1 (ambient access, `process.env`, `window`, `$_GET`, `os.environ`, `os.Getenv`, is an
 *   external reference of origin ambient, in JS/TS, PHP, Python and Go).
 * - 24: M2-08-R5 (a Python or Java name bound by an import from outside the project, `from stripe
 *   import Order`, `import os.path as osp`, `import com.vendor.Invoice;`, links no same-named project
 *   symbol).
 * - 25: M2-08-R4 (an ES module's parse records the bare names it reached under the global rule, so a
 *   sync can re-parse the files a module turning script, or gaining `declare global` names, may now
 *   link; every declarator of a `declare global { var a, b }` list and `function *gen` are global).
 * - 26: M2-08-R6 (a bare JS/TS specifier, `import 'express'` or `require('express')`, is never read as a
 *   path from the repo root: it no longer links a project `express.js`; `paths`, `baseUrl` and bundler
 *   aliases are the only ways a bare specifier resolves to a project file).
 * - 27: M2-08-R11 (a bare JS/TS specifier resolves under a module root the project configures: webpack
 *   `resolve.modules`, jest `moduleDirectories` / `modulePaths`, `NODE_PATH=` in a package.json script;
 *   such an import links its file again and is no npm external candidate).
 * - 28: M2-08-R7 (a bare Python name the module neither defines nor imports, such as the builtin
 *   `open`, no longer links a same-named function of another module; a star import of a project
 *   module still makes its names visible).
 * - 29: M2-08-R8 (a Java or Python parse records the imports whose "outside the project" decision
 *   other files make, `jvmDecl`, `jvmImports`, `pyImports`, so a sync that adds, deletes or moves a
 *   project package, class or top-level module re-parses the importers it may flip).
 */
export const EXTRACTOR_VERSION = 29;

/**
 * The version of the external-reference attribution rules (M5-19-R1): how a candidate decided
 * external gets its package, origin, direct, dev and attribution from manifests, locks and the
 * built-in lists. The end-of-run pass records it with its inputs (`external_inputs`), and keeps a
 * stored attribution only while both stand. Bump it when a change attributes unchanged inputs
 * differently, so the next scan or sync re-attributes every repo's candidates without parsing a
 * file. A change to what a scan extracts bumps EXTRACTOR_VERSION instead. Evaluation rules, which
 * `check` computes from the stored rows (M5-24), need no version.
 * - 1: M5-20 (npm), M5-21 (Composer), M5-22 (pip, Poetry, uv), M5-23 (Go modules). A record
 *   without a version counts as 1.
 * - 2: M5-21-R1 (PECL names ambient; vendor/composer classmap and files names attributed to their
 *   installed package), M5-23-R1 (the module path of an unreadable go.mod from the folder layout),
 *   M5-25-R3 (a module replaced by a folder outside the workspace or the registered repos is
 *   external, attributed `manifest`: go.sum holds no hash of a directory).
 */
export const ATTRIBUTION_VERSION = 2;

export const extractorVersionKey = (repo: string) => `extractor_version:${repo}`;

/** Scanned repos whose index an older extractor built (no recorded version counts as older). */
export function outdatedRepos(store: Store, repoNames: string[] = store.getRepoNames()): string[] {
  return repoNames.filter(r => !!store.getMeta('last_scan_time:' + r) && Number(store.getMeta(extractorVersionKey(r)) ?? 0) < EXTRACTOR_VERSION);
}

/**
 * True when the external-reference attribution of the index was made by older rules (M5-19-R1 and
 * its review): the inputs record names an earlier ATTRIBUTION_VERSION (none counts as 1). The next
 * scan or sync attributes the stored candidates again without parsing a file, so it is not an
 * outdated extractor (`outdatedRepos`), which re-parses.
 */
export function outdatedAttribution(store: Store): boolean {
  if (typeof store.getMeta !== 'function') return false;
  const inputs = parseExternalInputs(store.getMeta(EXTERNAL_INPUTS_KEY));
  return !!inputs && inputs.rules < ATTRIBUTION_VERSION;
}

/**
 * The scanned repos whose index an older MapX built: by an older extractor, or, for every scanned
 * repo, with older attribution rules (the record is the workspace's). What the index gate, `status`
 * and the warnings report; `outdatedRepos` alone decides a re-parse.
 */
export function outdatedIndexRepos(store: Store, repoNames: string[] = store.getRepoNames()): string[] {
  const attribution = outdatedAttribution(store);
  return repoNames.filter(r => !!store.getMeta('last_scan_time:' + r)
    && (attribution || Number(store.getMeta(extractorVersionKey(r)) ?? 0) < EXTRACTOR_VERSION));
}

/** The warning for an index an older MapX built, or '' (M5-26, M5-19-R1). */
export function outdatedIndexWarning(store: Store, rescan: string): string {
  // A partial store (a test double without the meta API) records no version to compare.
  if (typeof store.getRepoNames !== 'function' || typeof store.getMeta !== 'function') return '';
  const repos = outdatedIndexRepos(store);
  return repos.length ? `The index of ${repos.join(', ')} was built by an older MapX: ${rescan} to rebuild it.` : '';
}
