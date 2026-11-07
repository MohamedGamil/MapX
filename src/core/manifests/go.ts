// Go modules attribution of external references (M5-23; docs/research/deptrac/02 AR-04 `package`
// and `builtin`, 03 gap G9), on M5-20's design for npm and M5-21's for Composer: which module of the
// build list provides an imported package, or whether the standard library does; whether the
// file's go.mod requires that module directly or marks it `// indirect` (transitive); whether only
// test code uses it (dev). Only go.mod, go.sum, go.work and go.work.sum are read, between the file
// and its repo's root: never the module cache, vendor/ or the network.
import type { ExternalAttribution } from '../external-refs.js';
import { repoParentDirs, type NpmWorkspace } from './npm.js';
import { UNREADABLE_INPUT } from './inputs.js';
import { GO_STDLIB } from './go-stdlib.js';

// ─── Standard library ───────────────────────────────────────────────────────────────────────

let stdlib: Set<string> | null = null;

/**
 * What the toolchain provides for an import path: `builtin` for a package of the standard library
 * (`fmt`, `net/http`; the static list of `go-stdlib.ts`, not the running Go), `ambient` for cgo's
 * pseudo-package `C` (the C symbols of the file's preamble), else null.
 */
export function goBuiltin(path: string): 'builtin' | 'ambient' | null {
  if (path === 'C') return 'ambient';
  return (stdlib ??= new Set(GO_STDLIB)).has(path) ? 'builtin' : null;
}

/** Go reserves import paths whose first element has no dot for the standard library (and cgo's `C`). */
const dotless = (path: string) => !path.split('/')[0]!.includes('.');

// ─── go.mod and go.sum ──────────────────────────────────────────────────────────────────────

/** A `replace` directive: of one version of a module, or of all (`version` null); by a module path or a local directory. */
export interface GoReplace { module: string; version: string | null; path: string; local: boolean }

export interface GoMod {
  module: string;
  /** The `go` directive (`1.22`); null when there is none (Go then reads the go.mod as 1.16). */
  go: string | null;
  /** Required module path → its version and whether the line is marked `// indirect`. */
  requires: Map<string, { version: string; indirect: boolean }>;
  /** `replace` directives, in order. */
  replaces: GoReplace[];
  /** `tool` packages (Go 1.24). */
  tools: string[];
}

const unquote = (s: string) => s.replace(/^["`]|["`]$/g, '');
/** A replacement that is a directory: `./x`, `../x`, an absolute path. */
const isLocal = (p: string) => /^(\.\.?(\/|$)|\/|[A-Za-z]:[\\/])/.test(p);

/**
 * Whether a line's comment marks a requirement indirect, by Go's rule (`modfile.isIndirect`): its
 * words are exactly `indirect`, or start with `indirect;` (`// indirect; used by x`). `// not
 * indirect` and `// indirect dependency` are not.
 */
export function goIndirectComment(comment: string): boolean {
  const words = comment.replace(/^\/\//, '').trim().split(/\s+/).filter(Boolean);
  return (words.length === 1 && words[0] === 'indirect') || (words.length > 1 && words[0] === 'indirect;');
}

/**
 * The replacement in force for a module at a version: the directive of that version, else the one
 * of all versions, else null. Go rejects two directives for the same module and version.
 */
export function goReplacement(replaces: readonly GoReplace[], module: string, version: string | null | undefined): GoReplace | null {
  let all: GoReplace | null = null;
  for (const r of replaces) {
    if (r.module !== module) continue;
    if (r.version === null) all ??= r;
    else if (r.version === version) return r;
  }
  return all;
}

/** Whether a `go` directive is at least 1.<minor>. */
const goAtLeast = (go: string | null, minor: number) => {
  const m = go?.match(/^1\.(\d+)/);
  return !!m && Number(m[1]) >= minor;
};

/**
 * go.mod: the module path, `require` lines (single or in a block) with their `// indirect` mark,
 * `replace` directives and `tool` lines. `exclude`, `retract`, `toolchain`, `godebug` and `ignore`
 * change no module of the build list's paths, and are skipped. Throws on text with no `module`.
 */
export function parseGoMod(text: string): GoMod {
  let module: string | null = null;
  let go: string | null = null;
  const requires = new Map<string, { version: string; indirect: boolean }>();
  const replaces: GoReplace[] = [];
  const tools: string[] = [];
  const handle = (verb: string, tokens: string[], indirect: boolean) => {
    if (!tokens.length) return;
    if (verb === 'module') module = tokens[0]!;
    else if (verb === 'go') go = tokens[0]!;
    else if (verb === 'require') requires.set(tokens[0]!, { version: tokens[1] ?? '', indirect });
    else if (verb === 'tool') tools.push(tokens[0]!);
    else if (verb === 'replace') {
      // `M [v] => R [v]`: the left version, when given, limits the directive to that version.
      const arrow = tokens.indexOf('=>');
      const to = arrow > 0 ? tokens[arrow + 1] : undefined;
      if (to) replaces.push({ module: tokens[0]!, version: arrow > 1 ? tokens[1]! : null, path: to, local: isLocal(to) });
    }
  };
  let block: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const at = raw.indexOf('//');
    const indirect = at >= 0 && goIndirectComment(raw.slice(at));
    const line = (at >= 0 ? raw.slice(0, at) : raw).trim();
    if (!line) continue;
    const tokens = line.split(/\s+/).map(unquote);
    if (block) {
      if (line === ')') block = null;
      else handle(block, tokens, indirect);
      continue;
    }
    if (tokens[1] === '(' || tokens[0]!.endsWith('(')) {
      block = tokens[0]!.replace(/\($/, '');
      continue;
    }
    handle(tokens[0]!, tokens.slice(1), indirect);
  }
  if (!module) throw new Error('not a go.mod');
  return { module, go, requires, replaces, tools };
}

/**
 * go.sum (and go.work.sum): the module paths it holds hashes for, whether of the module's content
 * or of its go.mod only. Throws on a line that is not `<path> <version>[/go.mod] h<n>:<hash>`.
 */
export function parseGoSum(text: string): Set<string> {
  const modules = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.trim().match(/^(\S+)\s+v\S+\s+h\d+:\S+$/);
    if (!m) throw new Error('not a go.sum');
    modules.add(m[1]!);
  }
  return modules;
}

/** The `use` directories and `replace` directives of a go.work. */
export function parseGoWork(text: string): { uses: string[]; replaces: GoReplace[] } {
  const uses: string[] = [];
  // A go.work reads like a go.mod with `use` lines and no `module`.
  const mod = parseGoMod(`module work\n${text.replace(/^\s*module\b.*$/gm, '')}`);
  let block = false;
  for (const raw of text.replace(/\/\/.*$/gm, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (block) {
      if (line === ')') block = false;
      else if (line) uses.push(unquote(line.split(/\s+/)[0]!));
      continue;
    }
    const m = line.match(/^use\s*(\(|\S+)/);
    if (m?.[1] === '(') block = true;
    else if (m) uses.push(unquote(m[1]!));
  }
  return { uses, replaces: mod.replaces };
}

// ─── Attribution ────────────────────────────────────────────────────────────────────────────

/** What the attributor reads (paths workspace-relative, as `NpmWorkspace`'s). */
export type GoWorkspace = Pick<NpmWorkspace, 'readText' | 'repoRootOf'> & {
  /** Whether something is at the path, readable or not (a folder, a file without permission). */
  exists?(path: string): boolean;
};

/** The build list a file's imports resolve against: its module's go.mod and go.sum, and its go.work's. */
interface GoContext {
  /** The folder of the file's go.mod; null when there is none up to the repo's root. */
  dir: string | null;
  /** That go.mod; null when absent, unreadable or not a go.mod. */
  mod: GoMod | null;
  /** The module paths of the readable go.sum (and the go.work's sums); null when go.sum is absent or unreadable. */
  sum: Set<string> | null;
  /** Module paths an import may name: go.mod's requirements, the go.work's other modules', go.sum's. */
  candidates: string[];
  /** The modules some go.mod requires: this one, or another module of its go.work. */
  required: Set<string>;
  /**
   * go.mod's `go` is 1.17 or later: it lists every module that provides a package (module graph
   * pruning), so a module only go.sum holds is in no requirement the build uses.
   */
  pruned: boolean;
  /** The replacement in force for a module (go.work's over the modules'), at its required version. */
  replacement(module: string): GoReplace | null;
  /** go.sum lacks a module go.mod requires: the lock is stale. */
  stale: boolean;
}

const inDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const normalize = (path: string) => {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
};

/**
 * The module of the build list that provides an import path: the longest module path that is the
 * path or a prefix of it at a `/` (Go's rule once a package moved to a nested module:
 * `cloud.google.com/go/storage` over `cloud.google.com/go`). A major-version element right after a
 * module path (`/v2`) is another module (`example.com/m/v2`), never a folder of `example.com/m`.
 */
export function goModuleOf(path: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  for (const m of candidates) {
    if (path !== m && !path.startsWith(`${m}/`)) continue;
    if (/^\/v([2-9]|[1-9]\d+)(\/|$)/.test(path.slice(m.length))) continue;
    if (!best || m.length > best.length) best = m;
  }
  return best;
}

/**
 * Attributes Go import paths for one decision pass; go.mod, go.sum and go.work files are read once
 * each, only between the file and its repo's root (as `NpmAttributor`).
 * - A standard-library package (`fmt`, `net/http`) is `builtin`, its package the import path; cgo's
 *   `C` is `ambient`.
 * - The file's module is the nearest go.mod up to its repo's root; a go.mod there that cannot be
 *   read ends the walk (never a parent module's). Its build list: go.mod's requirements, those of
 *   the other modules of a go.work that uses it, and the modules go.sum (and go.work.sum) holds.
 * - The package is the build list's longest module path that prefixes the import (`goModuleOf`).
 *   `direct` when go.mod requires it without `// indirect`; a module marked `// indirect`, or
 *   required by another go.work module, is transitive. A module only go.sum holds is transitive
 *   when go.mod predates 1.17; from 1.17 go.mod lists every module that provides a package, so it
 *   is not listed (`direct` and `dev` null). `replace` keeps the required path as the package: the
 *   import names it.
 * - `replace` applies to the required version only when it names one (`M v1.0.0 => …`), else to
 *   every version; go.work's directives override the modules'.
 * - `attribution` is `lock` when a readable go.sum holds the module (or its replacement), else
 *   `manifest`: no go.sum, an unreadable one, or a stale one that lacks a module go.mod requires
 *   (one replaced by a local directory needs no hash). A module replaced by a directory outside the
 *   workspace is always `manifest`: go.sum holds no hash of a directory (M5-25-R3).
 * - No module: the package is unknown (null). Not in the build list (`direct` 0) when a complete
 *   go.sum was read and the path has a dot; else `direct` null.
 * - `dev` is set by the caller from the code (`goTestOnlyModules`); Go has no dev requirements.
 */
export class GoAttributor {
  /** Every path read, with its text (null: absent; `UNREADABLE_INPUT`: there but unreadable). */
  readonly reads = new Map<string, string | null>();
  private contexts = new Map<string, GoContext>();

  constructor(private readonly workspace: GoWorkspace) {}

  /** A path's text, or null when it is absent or unreadable; an unreadable one is recorded as such. */
  private read(path: string): string | null {
    if (!this.reads.has(path)) this.reads.set(path, this.workspace.readText(path) ?? (this.workspace.exists?.(path) ? UNREADABLE_INPUT : null));
    const text = this.reads.get(path)!;
    return text === UNREADABLE_INPUT ? null : text;
  }

  /** Whether a file is there, readable or not. */
  private present(path: string): boolean {
    return this.read(path) !== null || this.reads.get(path) === UNREADABLE_INPUT;
  }

  private parse<T>(path: string, parse: (text: string) => T): T | null {
    const text = this.read(path);
    if (text === null) return null;
    try { return parse(text); } catch { return null; }
  }

  attribute(path: string, sourcePath: string): ExternalAttribution {
    const ctx = this.contextOf(sourcePath);
    // A dotless path a go.mod requires (with a replace) is that module, never the standard library.
    const module = goModuleOf(path, ctx.candidates);
    if (!module) {
      const origin = goBuiltin(path);
      if (origin) return { package: path, origin, direct: null, dev: null, attribution: null };
      const complete = ctx.sum !== null && !ctx.stale;
      return { package: null, origin: 'package', direct: complete && !dotless(path) ? false : null, dev: null, attribution: complete ? 'lock' : 'manifest' };
    }
    // From go 1.17 a module no go.mod requires provides no package of the build (review of M5-23).
    if (ctx.pruned && !ctx.required.has(module)) return { package: module, origin: 'package', direct: null, dev: null, attribution: 'lock' };
    // go.sum holds a replaced module's hash under its replacement. A module replaced by a local
    // directory has a row only when the directory is outside the workspace (M5-25-R1, M5-25-R3).
    // go.sum never holds a directory's hash, so no lock vouches for it: `manifest`, whether or not a
    // go.sum exists (review of M5-25-R3).
    const replacement = ctx.replacement(module);
    const locked = ctx.sum !== null && !replacement?.local && ctx.sum.has(replacement?.path ?? module);
    const required = ctx.mod?.requires.get(module);
    return { package: module, origin: 'package', direct: !!required && !required.indirect, dev: false, attribution: locked ? 'lock' : 'manifest' };
  }

  /** The folder of the go.mod that governs a file (its module), or null when none does. */
  moduleDirOf(sourcePath: string): string | null {
    return this.contextOf(sourcePath).dir;
  }

  private contextOf(sourcePath: string): GoContext {
    const dirs = repoParentDirs(sourcePath, this.workspace.repoRootOf(sourcePath));
    const key = dirs[0]!;
    let ctx = this.contexts.get(key);
    if (ctx) return ctx;
    const at = dirs.findIndex((d) => this.present(inDir(d, 'go.mod')));
    const dir = at < 0 ? null : dirs[at]!;
    const mod = dir === null ? null : this.parse(inDir(dir, 'go.mod'), parseGoMod);
    const candidates = new Set(mod?.requires.keys() ?? []);
    const required = new Set(candidates);
    // Each required module's version (this go.mod's first), for versioned replace directives.
    const versions = new Map([...mod?.requires ?? []].map(([m, r]) => [m, r.version]));
    // Replace directives by precedence: go.work's, this go.mod's, the other go.work modules'.
    const replaceLists: GoReplace[][] = [mod?.replaces ?? []];
    const sum = mod ? this.parse(inDir(dir!, 'go.sum'), parseGoSum) : null;
    // A go.work above the module that uses it: the other modules' requirements and sums join the build list.
    const workAt = dir === null ? -1 : dirs.slice(at).findIndex((d) => this.present(inDir(d, 'go.work')));
    if (mod && workAt >= 0) {
      const workDir = dirs[at + workAt]!;
      const work = this.parse(inDir(workDir, 'go.work'), parseGoWork);
      const uses = work?.uses.map((u) => normalize(inDir(workDir, u))) ?? [];
      if (work && uses.includes(normalize(dir!))) {
        for (const use of uses) {
          if (use === normalize(dir!) || use.startsWith('..')) continue;
          const other = this.parse(inDir(use, 'go.mod'), parseGoMod);
          for (const [m, r] of other?.requires ?? []) {
            candidates.add(m);
            required.add(m);
            if (!versions.has(m)) versions.set(m, r.version);
          }
          replaceLists.push(other?.replaces ?? []);
          const otherSum = this.parse(inDir(use, 'go.sum'), parseGoSum);
          if (sum && otherSum) for (const m of otherSum) sum.add(m);
        }
        replaceLists.unshift(work.replaces);
        const workSum = this.parse(inDir(workDir, 'go.work.sum'), parseGoSum);
        if (sum && workSum) for (const m of workSum) sum.add(m);
      }
    }
    for (const m of sum ?? []) candidates.add(m);
    const replacement = (m: string) => {
      for (const list of replaceLists) {
        const r = goReplacement(list, m, versions.get(m));
        if (r) return r;
      }
      return null;
    };
    // A module replaced by a local directory has no hash; one replaced by another module has the replacement's.
    const stale = !!sum && [...(mod?.requires.keys() ?? [])].some((m) => {
      const r = replacement(m);
      return r ? !r.local && !sum.has(r.path) : !sum.has(m);
    });
    // Replacement targets are not import paths; only the required paths are candidates.
    for (const r of replaceLists.flat()) if (!r.local && !required.has(r.path)) candidates.delete(r.path);
    ctx = { dir, mod, sum, candidates: [...candidates], required, pruned: goAtLeast(mod?.go ?? null, 17), replacement, stale };
    this.contexts.set(key, ctx);
    return ctx;
  }
}

/**
 * Go has no dev requirements; MapX calls a module dev-only when only test code (`_test.go` files)
 * of a Go module uses it, as `require-dev` would hold it (M5-23 decision). Given every Go row of
 * the pass attributed to a module, with the folder of its go.mod (the scope), the `scope\0module`
 * keys that no non-test file uses.
 */
export function goTestOnlyModules(rows: Iterable<{ file: string; scope: string; module: string }>): Set<string> {
  const used = new Map<string, boolean>();
  for (const r of rows) {
    const key = `${r.scope}\0${r.module}`;
    used.set(key, (used.get(key) ?? true) && r.file.endsWith('_test.go'));
  }
  return new Set([...used].filter(([, testOnly]) => testOnly).map(([key]) => key));
}

// ─── An unreadable go.mod (M5-23-R1) ────────────────────────────────────────────────────────

/**
 * The import paths a Go file's text names: `import "p"`, `import x "p"` and `import ( … )` blocks,
 * read with a small tokenizer (comments, interpreted and raw strings, runes), so a string or comment
 * that looks like an import is none (an `import` keyword is a token only outside them).
 */
export function goImportPaths(text: string): string[] {
  const tokens: string[] = [];
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      tokens.push(c === '"' ? `"${text.slice(i + 1, j)}` : "'");
      i = j + 1;
      continue;
    }
    if (c === '`') { const e = text.indexOf('`', i + 1); tokens.push(`"${text.slice(i + 1, e < 0 ? n : e)}`); i = e < 0 ? n : e + 1; continue; }
    const word = /^[A-Za-z_][\w]*/.exec(text.slice(i, i + 64))?.[0];
    if (word) { tokens.push(word); i += word.length; continue; }
    if (!/\s/.test(c)) tokens.push(c);
    i++;
  }
  const out: string[] = [];
  const path = (t: string | undefined) => (t?.startsWith('"') ? t.slice(1) : null);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t !== 'import') continue;
    const spec = (at: number): number => {
      // [name | . | _] "path"
      const named = path(tokens[at]) === null && path(tokens[at + 1]) !== null;
      const p = path(tokens[named ? at + 1 : at]);
      if (p) out.push(p);
      return named ? at + 2 : at + 1;
    };
    if (tokens[k + 1] === '(') {
      let j = k + 2;
      while (j < tokens.length && tokens[j] !== ')') j = tokens[j] === ';' ? j + 1 : spec(j);
      k = j;
    } else {
      k = spec(k + 1) - 1;
    }
  }
  return out;
}

/**
 * The module path of a go.mod MapX cannot read, from the folder layout (M5-23-R1 and its review):
 * an import path `M/rel` whose `rel` is a package folder of the module (relative to the go.mod's
 * folder) votes for `M`. A path is inferred only on strong evidence: one candidate alone, voted for
 * by imports of at least two distinct folders. Any competing candidate, a single folder, or no vote
 * gives null, and the module's imports stay unknown rows as before. So a third-party import whose
 * last element matches a folder (`github.com/google/uuid` and `uuid/`, `k8s.io/api` and `api/`)
 * never makes its prefix the module. A standard-library path never votes.
 */
export function goModuleByLayout(imports: Iterable<string>, packageDirs: Iterable<string>): string | null {
  const dirs = [...new Set(packageDirs)].filter(Boolean);
  const votes = new Map<string, Set<string>>();
  for (const path of new Set(imports)) {
    if (goBuiltin(path)) continue;
    for (const rel of dirs) {
      if (path.length <= rel.length + 1 || !path.endsWith(`/${rel}`)) continue;
      const module = path.slice(0, -rel.length - 1);
      let voters = votes.get(module);
      if (!voters) votes.set(module, (voters = new Set()));
      voters.add(rel);
    }
  }
  if (votes.size !== 1) return null;
  const [[module, voters]] = [...votes];
  return voters!.size >= 2 ? module! : null;
}
