// External references (M5-19, docs/research/deptrac/03-mapx-gap-and-integration.md gap G3): what a
// workspace file uses from outside the workspace, kept apart from edges, so edge counts, metrics and
// PageRank ignore them. Each reference that gave no edge and may name something outside the
// workspace is stored as a candidate (`external_ref_candidates`). Whether it does depends on other
// files too (package names, namespaces, Python packages, aliases, go.mod), so the scanner decides it
// again at the end of every scan and sync, without re-parsing; the `external_refs` view holds the
// candidates decided external. This module holds the row type and the syntax the scanner reads.

/** The package-manifest family that attributes a reference (M5-20 npm, M5-21 Composer … M5-23 Go modules). */
export type Ecosystem = 'npm' | 'composer' | 'pypi' | 'go';

/** One candidate reference to something outside the workspace, as stored. */
export interface ExternalRefRow {
  line: number;
  /** The enclosing function, method or class (`Class::method`); null at module level. */
  sourceSymbol: string | null;
  /**
   * What the file names, as it names it: an npm specifier (`pg`, `node:fs`), a Python module
   * (`os.path`), a Go import path, a PHP class or function (`GuzzleHttp\Client`, `strlen`).
   */
  specifier: string;
  /**
   * The name used from it: an imported or called name (`Pool`, `Client.connect`), `default`, `*` for a
   * namespace import, or null for the module as a whole. PHP: the class or function's short name.
   */
  symbol: string | null;
  /** The reference type: import, require, call, instantiation, extends, implements, param_type, return_type. */
  kind: string;
  ecosystem: Ecosystem;
  /** Decided outside the workspace, as the workspace stands when the row is written. */
  external: boolean;
  /**
   * What else decides the row or describes it: for a PHP function, the namespaced names PHP tries
   * before the global one (empty when none: a qualified call or a `use function` import); a `use
   * const` import (`phpConst`, M5-21); a facade's target class.
   */
  metadata?: { phpCandidates?: string[]; phpConst?: boolean; facadeTarget?: string };
}

/**
 * What an external reference belongs to (M5-20 npm … M5-23 Go), decided with the external flag at
 * the end of every scan and sync from the manifests and lockfiles as they stand. All null for a row
 * no ecosystem task attributes yet.
 */
export interface ExternalAttribution {
  /**
   * The package (`pg`, `@scope/pkg`, `guzzlehttp/guzzle`) or built-in module or extension (`node:fs`,
   * `ext-pdo`) the specifier names; null for a PHP name no input attributes to a package (M5-21).
   */
  package: string | null;
  /** `package`, `builtin` (the language's standard library or runtime) or `ambient`. */
  origin: 'package' | 'builtin' | 'ambient' | null;
  /**
   * A manifest of the file lists the package (true), or only a lockfile holds it or nothing does
   * (false); null for a built-in and when the package is unknown.
   */
  direct: boolean | null;
  /** A dev-only dependency; null when unknown (no lockfile tells) and for a built-in. */
  dev: boolean | null;
  /** `lock` when a lockfile was read, `manifest` when the manifests alone answered (missing or unreadable lockfile). */
  attribution: 'lock' | 'manifest' | null;
}

export const NO_ATTRIBUTION: ExternalAttribution = { package: null, origin: null, direct: null, dev: null, attribution: null };

/**
 * Whether a JS/TS specifier may name a module outside the workspace, by its form alone: not
 * relative or absolute, not a `#` subpath import, a `~`, `@/` or `$` alias (SvelteKit `$lib`, `$app`:
 * no npm package name starts with `$`), and no URL or other scheme than `node:` (a Deno or remote
 * import is no npm package). The workspace decides the rest (`jsExternalSpecifier` in the scanner).
 */
export function jsCandidateSpecifier(specifier: string): boolean {
  if (/^[./#~$]/.test(specifier) || specifier.startsWith('@/')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('node:');
}

/** PHP language constructs the parser may report as function calls: never external references. */
export const PHP_CONSTRUCTS = new Set([
  'isset', 'empty', 'unset', 'list', 'array', 'echo', 'print', 'die', 'exit', 'eval',
  'include', 'include_once', 'require', 'require_once',
]);

const ECOSYSTEMS: Record<string, Ecosystem> = {
  javascript: 'npm', typescript: 'npm', tsx: 'npm', vue: 'npm', svelte: 'npm',
  php: 'composer',
  python: 'pypi',
  go: 'go',
};

/** The ecosystem of a source language; null for a language no ecosystem task covers yet. */
export function ecosystemOf(language: string | null): Ecosystem | null {
  return language ? ECOSYSTEMS[language] ?? null : null;
}

/** Rows without duplicates (the same name used twice on a line), in a stable order. */
export function uniqueRows(rows: ExternalRefRow[]): ExternalRefRow[] {
  const seen = new Map<string, ExternalRefRow>();
  for (const r of rows) {
    const key = [r.line, r.sourceSymbol, r.specifier, r.symbol, r.kind].join('\0');
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

/** A name a JS/TS module statement brings in: `imported` is the exported name, `default`, or `*` (a namespace). */
export interface JsImportName { local: string | null; imported: string }

/** One `import … from`, side-effect `import`, `export … from` or `require` of a JS/TS module text. */
export interface JsImport {
  specifier: string;
  /** The line of the specifier's string, where the parser reports the reference. */
  line: number;
  require: boolean;
  /** A `require` binds the module object (`const m = require('m')`): no names, `local` set. */
  names: JsImportName[];
  /** The binding of a whole-module `require`. */
  local?: string;
}

const lineAt = (text: string, index: number) => {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
};

/** `{ a, b as c, type d }` (or `{ a: c }` for a require) → names. */
const namedList = (inner: string, rename: RegExp): JsImportName[] => inner.split(',').flatMap((part) => {
  const [imported, local] = part.trim().replace(/^type\s+/, '').split(rename).map((s) => s.trim());
  return imported && /^[\w$]+$/.test(imported) && (!local || /^[\w$]+$/.test(local)) ? [{ local: local ?? imported, imported }] : [];
});

/**
 * The import, export-from and require statements of comment-free JS/TS code (the scanner's
 * `scanModule` text, which keeps line breaks). Dynamic `import()` is not read: the parser reports
 * no reference for it.
 */
export function jsImports(code: string, masked?: string): JsImport[] {
  const out: JsImport[] = [];
  const at = (match: RegExpMatchArray, specifier: string) => lineAt(code, match.index! + match[0].lastIndexOf(specifier));
  // `masked` blanks literal contents at the same offsets: a statement quoted in a string is no statement.
  const real = (m: RegExpMatchArray) => !masked || masked.startsWith(m[0].slice(0, 6), m.index!);
  for (const m of code.matchAll(/\bimport\s+(?:([^'"`;()]+?)\s+from\s*)?(['"])([^'"\n]+)\2/g)) {
    if (!real(m)) continue;
    const clause = (m[1] ?? '').replace(/^type\s+(?=[\w${*])/, '');
    const names: JsImportName[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) names.push(...namedList(braces[1]!, /\s+as\s+/));
    const rest = clause.replace(/\{[^}]*\}/, '');
    const star = /\*\s*as\s+([\w$]+)/.exec(rest);
    if (star) names.push({ local: star[1]!, imported: '*' });
    const def = /^\s*([\w$]+)/.exec(rest.replace(/\*\s*as\s+[\w$]+/, ''));
    if (def) names.push({ local: def[1]!, imported: 'default' });
    out.push({ specifier: m[3]!, line: at(m, m[3]!), require: false, names });
  }
  for (const m of code.matchAll(/\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g)) {
    if (!real(m)) continue;
    const names = m[1]!.startsWith('{') ? namedList(m[1]!.slice(1, -1), /\s+as\s+/).map((n) => ({ local: null, imported: n.imported })) : [{ local: null, imported: '*' }];
    out.push({ specifier: m[3]!, line: at(m, m[3]!), require: false, names });
  }
  for (const m of code.matchAll(/\b(?:(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*)?require\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g)) {
    if (!real(m)) continue;
    const binding = m[1];
    const names = binding?.startsWith('{') ? namedList(binding.slice(1, -1), /\s*:\s*/) : [];
    out.push({ specifier: m[3]!, line: lineAt(code, m.index! + m[0].indexOf('require')), require: true, names, ...(binding && !binding.startsWith('{') ? { local: binding } : {}) });
  }
  return out;
}

/** One name a Python import binds: `module` and the name imported from it (null: the module itself). */
export interface PyBinding { local: string; module: string; imported: string | null }

/** One Python import statement's module and the names it binds. */
export interface PyImport { module: string; line: number; names: PyBinding[] }

/**
 * The absolute `import` and `from … import` statements of Python text (comments stripped), with
 * parenthesised continuation lines joined. Relative imports are left out.
 */
export function pythonImports(text: string): PyImport[] {
  const out: PyImport[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const start = i;
    if (/^\s*from\s+[\w.]+\s+import\s*\([^)]*$/.test(line)) {
      while (i + 1 < lines.length && !line.includes(')')) line += ' ' + lines[++i]!;
    }
    const from = /^\s*from\s+([\w.]+)\s+import\s+\(?([^)#]+)\)?/.exec(line);
    if (from) {
      if (from[1]!.startsWith('.')) continue;
      const names = from[2]!.split(',').flatMap((part) => {
        const [imported, alias] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
        return imported && /^\w+$/.test(imported) ? [{ local: alias ?? imported, module: from[1]!, imported }] : [];
      });
      out.push({ module: from[1]!, line: start + 1, names });
      continue;
    }
    const imp = /^\s*import\s+([^#]+)/.exec(line);
    if (!imp) continue;
    for (const part of imp[1]!.split(',')) {
      const [module, alias] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
      if (!module || !/^[\w.]+$/.test(module)) continue;
      // `import a.b as c` binds `c`; `import a.b` binds `a`, and `a.b.f()` names a.b's `f`.
      const top = module.split('.')[0]!;
      const names: PyBinding[] = alias ? [{ local: alias, module, imported: null }] : [{ local: module, module, imported: null }];
      if (!alias && top !== module) names.push({ local: top, module: top, imported: null });
      out.push({ module, line: start + 1, names });
    }
  }
  return out;
}
