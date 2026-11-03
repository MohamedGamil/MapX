// Internal markers (M5-11; docs/research/deptrac AR-07 §2). An internal element is reachable only
// from its own layers: the evaluator reports any other layer's dependency on it as an
// `internal-element` violation (AR-08 step 5). Two kinds of marker:
//
// - **Doc tags** (`visibility.internalTags`, default `@internal`, `@mapx-internal`), compared like
//   the `docTag` selector. They are MapX's own rule: internal to the layer, whatever the compiler.
// - **Native markers** (`visibility.nativeMarkers`, off by default): a language's module-scoped
//   visibility. A reference counts only when the language itself would refuse it (review of
//   M5-11), so code the compiler or convention accepts is never flagged; where MapX cannot see the
//   boundary (no project or module file), it reports nothing.
//
//   Go          a file under `internal/`: refused unless the referrer is rooted at internal's parent
//   Python      a module or package `_x` (not a dunder): refused when the referrer, outside the
//               package that holds it, imports it directly (a re-export by the public package is
//               the public path); a symbol `_x`: refused from another module
//   Dart        a symbol `_x`: refused from another file that is not a `part of`; `lib/src/`:
//               refused from another package (nearest pubspec.yaml)
//   Kotlin      `internal`: refused from another module (nearest build.gradle(.kts) or pom.xml)
//   C#          `internal`, `private protected`, a top-level type without access modifier (every
//               part of a partial type agreeing): refused from another project (nearest .csproj)
//               unless the target's project grants InternalsVisibleTo to the referrer's assembly
//   Java        package-private: refused from another package
//   Rust        `pub(crate)` from another crate (nearest Cargo.toml); `pub(self)`, `pub(super)`,
//               `pub(in path)` from outside the module, its parent, or the path
//   TS, TSX, JS (Vue, Svelte)  `@internal` (what `stripInternal` strips): refused from another
//               workspace package (nearest package.json name)
//   PHP and the rest: none (PHP's `@internal` is a doc tag: keep it in internalTags)
//
// Either kind marks a member of a marked type (the type is how it is reached), and a file whose
// top-level symbols are all marked (an import of the file names them).
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { ArchitectureConfig } from './schema.js';
import type { Element, ElementView } from './elements.js';
import { hasDocTag } from './selectors/doc-tag.js';

export interface InternalMarker {
  /** The element that carries the marker: the target itself, its type, or its file. */
  element: Element;
  /** Why it is internal: the doc tag as configured (`@internal`), or a native marker (`Go internal/`). */
  marker: string;
}

/** One dependency: the native markers depend on who refers, and how. */
export interface Reference { source: Element; target: Element; edgeType: string; line?: number }

export interface InternalMarkers {
  /** The marker of a reference, or null when the target is not internal to it. */
  check(ref: Reference): InternalMarker | null;
  /** The native marker an element carries itself, or through its type or file, whoever refers (for introspection). */
  native(el: Element): InternalMarker | null;
}

type NativeKind = 'go-internal' | 'python-module' | 'python-name' | 'dart-name' | 'dart-src' | 'kotlin' | 'csharp' | 'java' | 'rust' | 'ts';
interface Candidate extends InternalMarker { kind: NativeKind | 'tag' }

const TS_LIKE = new Set(['typescript', 'tsx', 'javascript', 'vue', 'svelte']);
const CSHARP_TYPE_KINDS = new Set(['class', 'struct', 'interface', 'enum']);
const isDunder = (name: string) => /^__.+__$/.test(name);
const privateName = (name: string) => name.startsWith('_') && !isDunder(name);
const under = (path: string, dir: string) => dir === '.' || dir === '' || path === dir || path.startsWith(`${dir}/`);
const within = (mod: string, scope: string) => mod === scope || mod.startsWith(`${scope}::`);

/** A file's segments: its directories and its own name without extension. */
const segments = (path: string) => [...posix.dirname(path).split('/').filter((s) => s !== '.'), posix.basename(path).replace(/\.[^.]+$/, '')];

/**
 * The internal markers of `view` under `visibility`. `ownerOf` gives a member's top-level
 * declaration (the evaluator's `reportElement`); `imports` maps a file to the files it imports
 * (import edges), for Python's re-export rule.
 */
export function internalMarkers(
  view: ElementView,
  visibility: ArchitectureConfig['visibility'],
  ownerOf: (el: Element) => Element,
  imports: Map<string, Set<string>> = new Map(),
): InternalMarkers {
  const tags = visibility.internalTags;
  const nativeOn = visibility.nativeMarkers;

  // ─── The file system around the index, read lazily and cached ───
  const listings = new Map<string, string[]>();
  const list = (dir: string) => {
    let names = listings.get(dir);
    if (!names) {
      try { names = readdirSync(join(view.root, dir)); } catch { names = []; }
      listings.set(dir, names);
    }
    return names;
  };
  const texts = new Map<string, string>();
  const read = (path: string) => {
    let text = texts.get(path);
    if (text === undefined) {
      try { text = readFileSync(join(view.root, path), 'utf8'); } catch { text = ''; }
      texts.set(path, text);
    }
    return text;
  };
  const nearestCache = new Map<string, string | null>();
  /** The nearest directory of `path` (its own first) holding a file `test` accepts, or null. */
  const nearest = (path: string, key: string, test: (name: string) => boolean): string | null => {
    let d = posix.dirname(path);
    const seen: string[] = [];
    let found: string | null = null;
    for (;;) {
      const k = `${key}\u0000${d}`;
      if (nearestCache.has(k)) { found = nearestCache.get(k)!; break; }
      seen.push(k);
      if (list(d).some(test)) { found = d; break; }
      if (d === '.' || d === '' || d === '/') break;
      d = posix.dirname(d);
    }
    for (const k of seen) nearestCache.set(k, found);
    return found;
  };
  const csproj = (path: string) => nearest(path, 'csproj', (n) => n.endsWith('.csproj'));
  const gradleModule = (path: string) => nearest(path, 'gradle', (n) => n === 'build.gradle' || n === 'build.gradle.kts' || n === 'pom.xml');
  const pubspec = (path: string) => nearest(path, 'pubspec', (n) => n === 'pubspec.yaml');
  const crate = (path: string) => nearest(path, 'cargo', (n) => n === 'Cargo.toml');

  /** A C# project's assembly name: `<AssemblyName>`, else the .csproj file's name. */
  const assemblyOf = (dir: string): string => {
    const file = list(dir).find((n) => n.endsWith('.csproj'))!;
    return /<AssemblyName>\s*([^<\s]+)\s*<\/AssemblyName>/.exec(read(posix.join(dir, file)))?.[1] ?? file.replace(/\.csproj$/, '');
  };
  const grants = new Map<string, Set<string>>();
  /** The assemblies a C# project grants its internals to: the .csproj's items and `[assembly: InternalsVisibleTo]`. */
  const grantsOf = (dir: string): Set<string> => {
    let set = grants.get(dir);
    if (set) return set;
    set = new Set();
    const file = list(dir).find((n) => n.endsWith('.csproj'))!;
    for (const m of read(posix.join(dir, file)).matchAll(/<InternalsVisibleTo\s+Include\s*=\s*"([^",]+)/g)) set.add(m[1]!.trim());
    for (const f of view.files.values()) {
      if (f.language !== 'c-sharp' || !under(f.path, dir) || csproj(f.path) !== dir) continue;
      for (const m of read(f.path).matchAll(/\[\s*assembly\s*:\s*(?:System\.Runtime\.CompilerServices\.)?InternalsVisibleTo(?:Attribute)?\s*\(\s*"([^",]+)/g)) set.add(m[1]!.trim());
    }
    grants.set(dir, set);
    return set;
  };

  // ─── Candidates: what marks an element, whoever refers ───

  /** C# types by (qualified name, kind): every part of a partial type. */
  let csharpParts: Map<string, Element[]> | null = null;
  const partsOf = (el: Element) => {
    if (!csharpParts) {
      csharpParts = new Map();
      for (const e of view.elements) {
        if (e.kind !== 'symbol' || e.file.language !== 'c-sharp' || !CSHARP_TYPE_KINDS.has(e.symbolKind ?? '')) continue;
        const key = `${e.qualifiedName}\u0000${e.symbolKind}`;
        csharpParts.set(key, [...(csharpParts.get(key) ?? []), e]);
      }
    }
    return csharpParts.get(`${el.qualifiedName}\u0000${el.symbolKind}`) ?? [el];
  };

  /** The native marker a symbol carries itself. */
  const ownNative = (el: Element): Candidate | null => {
    const lang = el.file.language;
    const at = (kind: NativeKind, marker: string): Candidate => ({ element: el, marker, kind });
    if (lang === 'python' && privateName(el.name ?? '')) return at('python-name', 'Python _name');
    if (lang === 'dart' && el.name?.startsWith('_')) return at('dart-name', 'Dart _name');
    if (lang === 'java' && el.visibility === 'package') return at('java', 'Java package-private');
    if (lang === 'kotlin' && el.visibility) return at('kotlin', `Kotlin ${el.visibility}`);
    if (lang === 'rust' && el.visibility) return at('rust', `Rust ${el.visibility}`);
    if (lang === 'c-sharp' && el.visibility) {
      // A partial type is as accessible as its most accessible part (review of M5-11).
      if (CSHARP_TYPE_KINDS.has(el.symbolKind ?? '') && partsOf(el).some((p) => !p.visibility)) return null;
      return at('csharp', `C# ${el.visibility}`);
    }
    if (TS_LIKE.has(lang) && hasDocTag(el, '@internal')) return at('ts', 'TypeScript @internal');
    return null;
  };

  /** The native marker of a whole file. */
  const fileNative = (path: string): Candidate | null => {
    const fileEl = view.byId.get(`file:${path}`);
    const file = view.files.get(path);
    if (!fileEl || !file) return null;
    const dirs = posix.dirname(path).split('/');
    if (file.language === 'go' && dirs.includes('internal')) return { element: fileEl, marker: 'Go internal/', kind: 'go-internal' };
    if (file.language === 'python' && segments(path).some(privateName)) return { element: fileEl, marker: 'Python _module', kind: 'python-module' };
    if (file.language === 'dart' && /(^|\/)lib\/src\//.test(path)) return { element: fileEl, marker: 'Dart lib/src/', kind: 'dart-src' };
    return null;
  };

  /** Candidates for an element, nearest first: its own tag or marker, its type's, its file's. */
  const candidates = (el: Element, depth = 0): Candidate[] => {
    const out: Candidate[] = [];
    if (el.kind === 'symbol') {
      const tag = tags.find((t) => hasDocTag(el, t));
      if (tag) out.push({ element: el, marker: tag.startsWith('@') ? tag : `@${tag}`, kind: 'tag' });
      const own = nativeOn ? ownNative(el) : null;
      if (own) out.push(own);
      if (!el.topLevel && depth < 16) {
        const owner = ownerOf(el);
        if (owner !== el) out.push(...candidates(owner, depth + 1).filter((c) => c.element.kind === 'symbol'));
      }
    }
    const file = nativeOn ? fileNative(el.file.path) : null;
    if (file) out.push(file);
    return out;
  };

  // ─── Legality: would the language refuse this reference? ───

  const goInternalLegal = (source: Element, target: Element): boolean => {
    const t = target.file.namespace;
    const s = source.file.namespace;
    if (t && s) {
      const segs = t.split('/');
      return under(s, segs.slice(0, segs.lastIndexOf('internal')).join('/'));
    }
    const segs = posix.dirname(target.file.path).split('/');
    return under(posix.dirname(source.file.path), segs.slice(0, segs.lastIndexOf('internal')).join('/') || '.');
  };

  const pythonModuleLegal = (ref: Reference, carrier: Element): boolean => {
    const segs = segments(carrier.file.path);
    const i = segs.findIndex(privateName);
    const pkg = segs.slice(0, i).join('/') || '.';
    if (under(posix.dirname(ref.source.file.path), pkg)) return true; // inside the package that holds it
    const priv = segs.slice(0, i + 1).join('/');
    const direct = (f: string) => f.replace(/\.pyi?$/, '') === priv || f.startsWith(`${priv}/`);
    if (ref.edgeType === 'import') return !direct(ref.target.file.path);
    // Reached through the public package's re-export, unless the referrer imports the private part itself.
    return ![...(imports.get(ref.source.file.path) ?? [])].some(direct);
  };

  const rustLegal = (source: Element, carrier: Element): boolean => {
    if (source.file.language !== 'rust') return true; // another language's reference: MapX cannot place it
    const vis = carrier.visibility!;
    const mod = view.byId.get(`file:${carrier.file.path}`)?.qualifiedName ?? 'crate';
    const src = view.byId.get(`file:${source.file.path}`)?.qualifiedName ?? 'crate';
    const parent = (m: string) => (m.includes('::') ? m.slice(0, m.lastIndexOf('::')) : m);
    if (vis === 'pub(crate)') return true;
    if (vis === 'pub(self)') return within(src, mod);
    if (vis === 'pub(super)') return within(src, parent(mod));
    const path = /^pub\(in (.+)\)$/.exec(vis)?.[1]?.trim();
    if (!path) return true;
    let scope = path;
    if (path === 'self' || path.startsWith('self::')) scope = mod + path.slice(4);
    else if (path === 'super' || path.startsWith('super::')) scope = parent(mod) + path.slice(5);
    else if (!path.startsWith('crate')) return true; // a path MapX cannot place: no finding
    return within(src, scope);
  };

  const legal = (ref: Reference, c: Candidate): boolean => {
    const { source } = ref;
    const carrier = c.element;
    switch (c.kind) {
      case 'tag': return false; // the layer rule: the evaluator checks the layers
      case 'go-internal': return goInternalLegal(source, carrier);
      case 'python-module': return pythonModuleLegal(ref, carrier);
      case 'python-name': return source.file.path === carrier.file.path;
      case 'dart-name': return source.file.path === carrier.file.path || /^\s*part\s+of\b/m.test(read(source.file.path));
      case 'dart-src': {
        const a = pubspec(source.file.path);
        const b = pubspec(carrier.file.path);
        return !a || !b || a === b;
      }
      case 'kotlin': {
        const a = gradleModule(source.file.path);
        const b = gradleModule(carrier.file.path);
        return !a || !b || a === b;
      }
      case 'csharp': {
        const a = csproj(source.file.path);
        const b = csproj(carrier.file.path);
        return !a || !b || a === b || grantsOf(b).has(assemblyOf(a));
      }
      case 'java': return (source.file.namespace ?? '') === (carrier.file.namespace ?? '');
      case 'rust': {
        // A crate boundary refuses every restricted visibility.
        if (source.file.language === 'rust' && crate(source.file.path) !== crate(carrier.file.path)) return false;
        return rustLegal(source, carrier);
      }
      case 'ts': {
        const a = view.workspacePackage(source.file.path);
        const b = view.workspacePackage(carrier.file.path);
        return !a || !b || a === b;
      }
    }
  };

  /** The names a Python `from M import a, b as c` statement at `line` of `path` imports. */
  const pythonImportedNames = (path: string, line: number): string[] => {
    const lines = read(path).split('\n');
    let text = lines[line - 1] ?? '';
    const m = /^\s*from\s+\S+\s+import\s+(.*)$/.exec(text);
    if (!m) return [];
    let names = m[1]!;
    if (names.trimStart().startsWith('(')) {
      for (let i = line; !names.includes(')') && i < lines.length; i++) names += ` ${lines[i]}`;
    } else {
      for (let i = line; names.trimEnd().endsWith('\\') && i < lines.length; i++) names = names.trimEnd().slice(0, -1) + ` ${lines[i]}`;
    }
    text = names.replace(/[()]/g, ' ').replace(/#.*$/, '');
    return text.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!.trim()).filter((n) => n && n !== '*');
  };

  const check = (ref: Reference, depth = 0): InternalMarker | null => {
    const { source, target } = ref;
    if (target.kind === 'symbol') {
      const hit = candidates(target).find((c) => !legal(ref, c));
      return hit ? { element: hit.element, marker: hit.marker } : null;
    }
    // A Python `from M import a, b`: each name is a reference to M's symbol of that name.
    if (source.file.language === 'python' && ref.edgeType === 'import' && ref.line && depth === 0) {
      const tops = view.ofFile(target.file.path).filter((e) => e.kind === 'symbol' && e.topLevel);
      for (const name of pythonImportedNames(source.file.path, ref.line)) {
        const sym = tops.find((e) => e.name === name);
        const hit = sym ? check({ ...ref, target: sym }, depth + 1) : null;
        if (hit) return hit;
      }
    }
    const file = nativeOn ? fileNative(target.file.path) : null;
    if (file && !legal(ref, file)) return { element: file.element, marker: file.marker };
    // A file names its top-level symbols: internal when there are some and every one is.
    const tops = view.ofFile(target.file.path).filter((e) => e.kind === 'symbol' && e.topLevel);
    if (!tops.length) return null;
    const marks = tops.map((t) => check({ ...ref, target: t }, depth + 1));
    return marks.every(Boolean) ? marks[0]! : null;
  };

  const native = (el: Element): InternalMarker | null => {
    const c = candidates(el).find((x) => x.kind !== 'tag');
    if (c) return { element: c.element, marker: c.marker };
    if (el.kind !== 'file') return null;
    const tops = view.ofFile(el.file.path).filter((e) => e.kind === 'symbol' && e.topLevel);
    const marks = tops.map(native);
    return tops.length && marks.every(Boolean) ? marks[0]! : null;
  };

  return { check, native };
}
