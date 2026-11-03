// Type ancestry (M5-09; docs/research/deptrac AR-04 `extends`, `implements`, `inherits`, `mixes`,
// `inheritanceDepth`, and AR-02 inherited dependencies). A type's direct bases come from:
//
//   a. the stored `extends` and `implements` edges (bases the index resolved to a workspace type);
//   b. the base list its signature declares (the declaration's first line), for the bases outside
//      the index. Each is named through what the file records: PHP's `extends`/`implements`
//      candidates (M5-19; fully qualified through `use`), a TS class's `extends` candidate
//      (`sequelize#Model`), TS and Python import candidates (`models.Model` after
//      `from django.db import models` is `django.db.models.Model`), and Java, Kotlin and Scala
//      `import` lines, PHP `use` and namespace; otherwise as written, generics dropped. A name so
//      qualified that is a workspace type links to it. Where an edge linked a same-named workspace
//      type the file does not mean (its import names a package, or resolution another name), the
//      declared base wins (review of M5-09);
//   c. PHP trait uses (`metadata.mixins`), and Scala and Dart `with` clauses, as mixin hops.
//
// Bases outside the workspace are leaves: nothing is known of their own ancestry. Closure is a
// breadth-first search over (type, path kind) states, each visited once, so a cycle (invalid code,
// valid input) terminates and a type is never its own ancestor; each state links to the one it was
// reached from, and a path is rebuilt only when shown. Depth is computed once, over the strongly
// connected components of the base graph. Every hierarchy selector is symbol-level: inapplicable to
// a file; a member is judged by its type (src/arch/selectors/index.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Element, ElementView } from '../elements.js';
import { TYPE_SYMBOL_KINDS } from '../elements.js';

export type HopKind = 'extends' | 'implements' | 'mixin';

/** An ancestor: a workspace type, or a base outside the index known by name. */
export type Ancestor = { element: Element; name: string } | { element?: undefined; name: string; written: string; qualified: boolean };

interface Base { ancestor: Ancestor; kind: HopKind }

/** One way to reach an ancestor: the first (shortest) path for each kind of path. */
export interface Reach {
  ancestor: Ancestor;
  /** The types from the subject to the ancestor, both included. */
  path: Ancestor[];
  /** Every hop is `extends`. */
  allExtends: boolean;
  /** Some hop is `implements`. */
  implementing: boolean;
  /** The last hop is a mixin (a trait use, `with`). */
  mixin: boolean;
}

const SEP = /::|\\|\.|#|\//;
const tailOf = (name: string) => name.split(SEP).filter(Boolean).pop() ?? name;
const stripGenerics = (s: string) => {
  let out = '';
  let depth = 0;
  for (const c of s) {
    if (c === '<' || c === '[') depth++;
    else if (c === '>' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
};
const splitTop = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if ('(<[{'.includes(c)) depth++;
    else if (')>]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
};
/** A base as written, without generics, call arguments or modifiers: `public Base<T>()` → `Base`. */
const cleanBase = (s: string) => {
  const t = stripGenerics(s).replace(/\(.*$/s, '').replace(/^(public|protected|private|virtual|open)\s+/g, '').trim();
  return /^[\\A-Za-z_$][\w$\\.:]*$/.test(t) ? t.replace(/^\\/, '') : null;
};

/**
 * The bases a declaration's first line names, with the kind of each hop. Exported for tests. The
 * header is cut at its body (`{`, `:` in Python, `where`), so a base list that wraps to the next
 * line is lost (the signature holds one line).
 */
export function declaredBases(signature: string, language: string, symbolKind: string): Array<{ written: string; kind: HopKind }> {
  const out: Array<{ written: string; kind: HopKind }> = [];
  const push = (list: string[], kind: HopKind) => { for (const raw of list) { const w = cleanBase(raw); if (w) out.push({ written: w, kind }); } };
  const iface = symbolKind === 'interface' || symbolKind === 'trait';
  const sig = signature.replace(/\{.*$/s, '').trim();
  const lang = language === 'tsx' || language === 'javascript' ? 'typescript' : language;
  // Keyword clauses: `extends A implements B, C` (PHP, Java, TS), `extends A with B` (Scala, Dart).
  const clauses = (text: string) => {
    const re = /\b(extends|implements|with)\b/g;
    const marks: Array<{ kw: string; at: number; end: number }> = [];
    for (let m; (m = re.exec(text));) marks.push({ kw: m[1]!, at: m.index, end: m.index + m[0].length });
    marks.forEach((m, i) => {
      const body = text.slice(m.end, i + 1 < marks.length ? marks[i + 1]!.at : undefined);
      const kind: HopKind = m.kw === 'with' ? 'mixin' : m.kw === 'implements' ? 'implements' : 'extends';
      // Scala: `extends A with B with C` lists one base per keyword. A TS base that is a call
      // (`extends Mixin(Base)`) names no type.
      push((lang === 'scala' ? [body] : splitTop(body)).filter((b) => lang !== 'typescript' || !b.includes('(')), kind);
    });
  };
  switch (lang) {
    case 'php': case 'java': case 'typescript': case 'scala': case 'dart': case 'groovy':
      // Drop generics, and a Java record's or Scala class's parameter list, before the clauses.
      clauses(lang === 'typescript' ? stripGenerics(sig) : stripGenerics(sig).replace(/\([^)]*\)/g, ' '));
      break;
    case 'python': {
      // `class C(A, B, metaclass=M):  # note`, `class C[T](Base): pass`: the balanced argument list.
      const m = /^\s*class\s+\w+\s*(?:\[[^\]]*\]\s*)?\(/.exec(sig);
      if (!m) break;
      let depth = 1;
      let end = m[0].length;
      for (; end < sig.length && depth > 0; end++) {
        if (sig[end] === '(' || sig[end] === '[') depth++;
        else if (sig[end] === ')' || sig[end] === ']') depth--;
      }
      if (depth === 0) push(splitTop(sig.slice(m[0].length, end - 1)).filter((b) => !b.includes('=') && !b.startsWith('*')), 'extends');
      break;
    }
    case 'ruby': {
      const m = /^\s*class\s+[\w:]+\s*<\s*([\w:]+)/.exec(sig);
      if (m) push([m[1]!], 'extends');
      break;
    }
    case 'kotlin': case 'c-sharp': case 'swift': {
      // `class X(val a: Int) : Base(), Iface where …`: the list after the header's top-level colon.
      const head = stripGenerics(sig).replace(/\bwhere\b.*$/s, '');
      let at = -1;
      for (let i = 0, depth = 0; i < head.length && at < 0; i++) {
        if (head[i] === '(') depth++;
        else if (head[i] === ')') depth--;
        else if (head[i] === ':' && depth === 0) at = i;
      }
      if (at < 0) break;
      splitTop(head.slice(at + 1)).forEach((b, i) => {
        // Kotlin calls the superclass constructor; C# and Swift list the class first, by convention
        // interfaces are `IName` in C#. An interface's bases are all `extends`.
        const kind: HopKind = iface ? 'extends'
          : lang === 'kotlin' ? (b.includes('(') ? 'extends' : 'implements')
            : i === 0 && !(lang === 'c-sharp' && /^I[A-Z]/.test(b.trim())) ? 'extends' : 'implements';
        push([b], kind);
      });
      break;
    }
    default:
      break;
  }
  return out;
}

/** `import a.b.C;` / `import a.b.C` lines of a Java, Kotlin or Scala file: short name → qualified name. */
function jvmImports(root: string, path: string): Map<string, string> {
  const map = new Map<string, string>();
  const file = join(root, path);
  if (!existsSync(file)) return map;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return map; }
  for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\.(\w+)\s*(?:as\s+(\w+))?\s*;?\s*$/gm)) {
    map.set(m[3] ?? m[2]!, `${m[1]}.${m[2]}`);
  }
  return map;
}

/** `use A\B\C;`, `use A\B\C as D;` and `use A\{B, C as D};` lines of a PHP file: alias (lower case) → FQN. */
function phpUses(root: string, path: string): Map<string, string> {
  const map = new Map<string, string>();
  const file = join(root, path);
  if (!existsSync(file)) return map;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return map; }
  const add = (fqn: string, alias?: string) => {
    const name = fqn.trim().replace(/^\\/, '');
    if (name) map.set((alias ?? name.split('\\').pop()!).toLowerCase(), name);
  };
  // Top-level `use` only: a trait use sits inside a class body, indented.
  for (const m of text.matchAll(/^use\s+(?!function\b|const\b)([^;{]+?)(?:\{([^}]*)\})?\s*;/gm)) {
    if (m[2] !== undefined) {
      for (const part of m[2].split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/i);
        if (name) add(`${m[1]!.trim()}${name}`, alias?.trim());
      }
    } else {
      for (const part of m[1]!.split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/i);
        if (name) add(name, alias?.trim());
      }
    }
  }
  return map;
}

export interface Hierarchy {
  /** The direct bases of a type element. */
  bases(el: Element): Base[];
  /** Ancestry search of a type (shortest paths, BFS order); null for any other element. */
  reaches(el: Element): Reaches | null;
  /** The longest chain of bases above a type (a base outside the index counts one; see depthOf). */
  depth(el: Element): number;
  /** That longest chain, from the type itself, by name. */
  longestChain(el: Element): string[];
  /** A type's own members (methods, properties, fields, constants …), not inherited ones. */
  members(el: Element): Element[];
  /** The type a member belongs to (its innermost enclosing type in the file), or null. */
  ownerType(el: Element): Element | null;
}

const EXTENDS_ONLY = 1;
const IMPLEMENTING = 2;
const MIXIN_LAST = 4;

/**
 * The ancestors a type reaches, one entry per (ancestor, path kind) state in breadth-first order,
 * so each state's path is a shortest one. Paths are not stored: each entry links to the entry it
 * was reached from (memory linear in the ancestors), and `path(i)` rebuilds one when it is shown.
 */
export interface Reaches {
  length: number;
  ancestor(i: number): Ancestor;
  /** Every hop is `extends` / some hop is `implements` / the last hop is a mixin. */
  allExtends(i: number): boolean;
  implementing(i: number): boolean;
  mixin(i: number): boolean;
  /** The types from the subject to entry i's ancestor, both included. */
  path(i: number): Ancestor[];
}

const hierarchies = new WeakMap<ElementView, Hierarchy>();

export const isType = (el: Element) => el.kind === 'symbol' && TYPE_SYMBOL_KINDS.has(el.symbolKind ?? '');

/** The ancestry of the types of `view`, computed lazily and once per view. */
export function hierarchyOf(view: ElementView): Hierarchy {
  let h = hierarchies.get(view);
  if (!h) {
    h = buildHierarchy(view);
    hierarchies.set(view, h);
  }
  return h;
}

/** How a base the signature names was qualified: from what tells where it is, or a guess. */
interface Named { name: string; qualified: boolean; source: 'external' | 'resolved' | 'written' }

function buildHierarchy(view: ElementView): Hierarchy {
  // Types by qualified name and per file, for edges and qualified external names.
  const byQn = new Map<string, Element[]>();
  const typesOfFile = new Map<string, Element[]>();
  for (const e of view.elements) {
    if (!isType(e)) continue;
    byQn.set(e.qualifiedName, [...(byQn.get(e.qualifiedName) ?? []), e]);
    typesOfFile.set(e.file.path, [...(typesOfFile.get(e.file.path) ?? []), e]);
  }
  const typeIn = (file: string, symbol: string | null): Element | null => {
    if (!symbol) return null;
    const types = typesOfFile.get(file) ?? [];
    const exact = types.filter((t) => t.qualifiedName === symbol);
    if (exact.length) return exact[0]!;
    const tail = tailOf(symbol.replace(/::.*$/, ''));
    const named = types.filter((t) => t.name === tail);
    return named.length === 1 ? named[0]! : null;
  };
  const workspaceType = (qn: string): Element | null => {
    const hits = byQn.get(qn.replace(/^\\/, '')) ?? [];
    return hits.length === 1 ? hits[0]! : null;
  };

  // Ancestry nodes: workspace types and external bases, by number.
  const nodes: Ancestor[] = [];
  const nodeOfElement = new Map<string, number>();
  const nodeOfExternal = new Map<string, number>();
  const nodeOf = (a: Ancestor): number => {
    const map = a.element ? nodeOfElement : nodeOfExternal;
    const key = a.element ? a.element.id : a.name;
    let n = map.get(key);
    if (n === undefined) { n = nodes.length; nodes.push(a); map.set(key, n); }
    return n;
  };
  const typeNode = (el: Element) => nodeOf({ element: el, name: el.qualifiedName });

  // Edges and candidates per source type.
  const edgeBases = new Map<string, Base[]>();
  for (const e of view.inheritance.edges) {
    const source = typeIn(e.sourceFile, e.sourceSymbol);
    const target = typeIn(e.targetFile, e.targetSymbol);
    if (!source || !target || source.id === target.id) continue;
    const list = edgeBases.get(source.id) ?? [];
    if (!list.some((b) => b.ancestor.element?.id === target.id)) list.push({ ancestor: { element: target, name: target.qualifiedName }, kind: e.type });
    edgeBases.set(source.id, list);
  }
  const candidatesOf = new Map<string, typeof view.inheritance.candidates>();
  for (const c of view.inheritance.candidates) candidatesOf.set(c.file, [...(candidatesOf.get(c.file) ?? []), c]);
  const fileMaps = new Map<string, Map<string, string>>();
  const importsOf = (path: string, read: (root: string, path: string) => Map<string, string>) => {
    let m = fileMaps.get(path);
    if (!m) { m = read(view.root, path); fileMaps.set(path, m); }
    return m;
  };

  /**
   * A base the signature names, qualified through what the file records. `external`: a candidate
   * (M5-19) says the name is not a workspace file's; `resolved`: the language's own name resolution
   * (PHP `use` and namespace, a JVM `import`) qualified it; `written`: as written.
   */
  const nameBase = (type: Element, written: string): Named => {
    const lang = type.file.language;
    const cands = candidatesOf.get(type.file.path) ?? [];
    const [head, ...rest] = written.split('.');
    if (lang === 'php') {
      const c = cands.find((x) => (x.kind === 'extends' || x.kind === 'implements') && x.sourceSymbol === type.name && (x.symbol === tailOf(written) || x.specifier === written));
      if (c) return { name: c.specifier.replace(/^\\/, ''), qualified: true, source: 'external' };
      // PHP name resolution: `\A\B` is absolute; otherwise the first segment through `use`, else the namespace.
      if (written.startsWith('\\')) return { name: written.slice(1), qualified: true, source: 'resolved' };
      const [first, ...more] = written.split('\\');
      const used = importsOf(type.file.path, phpUses).get(first!.toLowerCase());
      if (used) return { name: [used, ...more].join('\\'), qualified: true, source: 'resolved' };
      const ns = type.file.namespace;
      return ns ? { name: `${ns}\\${written}`, qualified: true, source: 'resolved' } : { name: written, qualified: true, source: 'resolved' };
    }
    if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
      const own = cands.find((x) => (x.kind === 'extends' || x.kind === 'implements') && x.sourceSymbol === type.name && x.symbol === written);
      if (own) return { name: `${own.specifier}#${own.symbol}`, qualified: true, source: 'external' };
      const imp = cands.find((x) => x.kind === 'import' && x.symbol === head);
      if (imp) return { name: `${imp.specifier}#${[imp.symbol, ...rest].join('.')}`, qualified: true, source: 'external' };
      const ns = cands.find((x) => x.kind === 'import' && x.symbol === '*');
      if (ns && rest.length) return { name: `${ns.specifier}#${rest.join('.')}`, qualified: true, source: 'external' };
      return { name: written, qualified: false, source: 'written' };
    }
    if (lang === 'python') {
      const imp = cands.find((x) => x.kind === 'import' && x.symbol === head);
      if (imp) return { name: [imp.specifier, imp.symbol, ...rest].join('.'), qualified: true, source: 'external' };
      const mod = cands.find((x) => x.kind === 'import' && x.symbol === null && (written === x.specifier || written.startsWith(`${x.specifier}.`)));
      return mod ? { name: written, qualified: true, source: 'external' } : { name: written, qualified: false, source: 'written' };
    }
    if (lang === 'java' || lang === 'kotlin' || lang === 'scala') {
      const fq = importsOf(type.file.path, jvmImports).get(head!);
      if (fq) return { name: [fq, ...rest].join('.'), qualified: true, source: 'resolved' };
      return { name: written, qualified: written.includes('.'), source: 'written' };
    }
    return { name: written, qualified: false, source: 'written' };
  };

  /**
   * Whether a base the file names as `named` is not the workspace type `target` an edge linked by
   * name (review of M5-09): a candidate says it is outside the workspace, or name resolution gives
   * another qualified name. A path-form qualified name (Kotlin, whose package MapX does not capture)
   * cannot be compared, and the edge stands.
   */
  const contradicts = (named: Named, target: Element): boolean => {
    if (named.source === 'external') return workspaceType(named.name)?.id !== target.id;
    if (named.source !== 'resolved' || !target.file.namespace) return false;
    const norm = (n: string) => n.replace(/^\\/, '').toLowerCase();
    return norm(named.name) !== norm(target.qualifiedName);
  };

  const basesCache = new Map<string, Base[]>();
  const bases = (type: Element): Base[] => {
    let out = basesCache.get(type.id);
    if (out) return out;
    const iface = type.symbolKind === 'interface';
    const declared = type.signature ? declaredBases(type.signature, type.file.language, type.symbolKind ?? '') : [];
    const used = new Set<number>();
    out = [];
    for (const b of edgeBases.get(type.id) ?? []) {
      const target = b.ancestor.element!;
      const at = declared.findIndex((d, i) => !used.has(i) && tailOf(d.written) === target.name);
      const d = at >= 0 ? declared[at]! : undefined;
      if (at >= 0) used.add(at);
      // The edge linked a same-named workspace type the file does not mean: the declared base wins.
      if (d && contradicts(nameBase(type, d.written), target)) { used.delete(at); continue; }
      // An interface's bases are `extends` (Kotlin and C# store `interface B : A` as implements);
      // a `with` base the index stored as `extends` (Scala) is a mixin hop.
      const kind: HopKind = d?.kind === 'mixin' ? 'mixin' : iface ? 'extends' : b.kind;
      out.push({ ancestor: b.ancestor, kind });
    }
    const has = (name: string) => out!.some((b) => b.ancestor.name === name);
    declared.forEach((d, i) => {
      if (used.has(i)) return;
      const named = nameBase(type, d.written);
      if (has(named.name)) return;
      const linked = named.qualified ? workspaceType(named.name) : null;
      if (linked && linked.id !== type.id) out!.push({ ancestor: { element: linked, name: linked.qualifiedName }, kind: d.kind });
      else if (!linked) out!.push({ ancestor: { name: named.name, written: d.written, qualified: named.qualified }, kind: d.kind });
    });
    // PHP's external bases the signature does not show in full (a wrapped line): the candidates.
    if (type.file.language === 'php') {
      for (const c of candidatesOf.get(type.file.path) ?? []) {
        if ((c.kind !== 'extends' && c.kind !== 'implements') || c.sourceSymbol !== type.name) continue;
        const name = c.specifier.replace(/^\\/, '');
        if (!has(name)) out.push({ ancestor: { name, written: c.symbol ?? name, qualified: true }, kind: iface ? 'extends' : c.kind });
      }
    }
    for (const m of type.mixins ?? []) {
      const name = m.replace(/^\\/, '');
      const linked = workspaceType(name);
      if (has(name) || linked?.id === type.id) continue;
      out.push({ ancestor: linked ? { element: linked, name: linked.qualifiedName } : { name, written: m, qualified: true }, kind: 'mixin' });
    }
    basesCache.set(type.id, out);
    return out;
  };
  const baseNodes = new Map<number, Array<{ node: number; kind: HopKind }>>();
  const basesOfNode = (n: number) => {
    let list = baseNodes.get(n);
    if (!list) {
      const el = nodes[n]!.element;
      list = el ? bases(el).map((b) => ({ node: nodeOf(b.ancestor), kind: b.kind })) : [];
      baseNodes.set(n, list);
    }
    return list;
  };

  // Closure: a breadth-first search over (node, path kind) states, each visited once; an entry
  // keeps the entry it was reached from, not its path.
  const reachCache = new Map<string, Reaches>();
  const reaches = (el: Element): Reaches | null => {
    if (!isType(el)) return null;
    const cached = reachCache.get(el.id);
    if (cached) return cached;
    const self = typeNode(el);
    const node: number[] = [];
    const parent: number[] = [];
    const flags: number[] = [];
    const seen = new Set<number>();
    const expand = (from: number, fromNode: number, fromFlags: number) => {
      for (const b of basesOfNode(fromNode)) {
        if (b.node === self) continue; // a cycle back to the subject
        const f = ((fromFlags & EXTENDS_ONLY) && b.kind === 'extends' ? EXTENDS_ONLY : 0) | ((fromFlags & IMPLEMENTING) || b.kind === 'implements' ? IMPLEMENTING : 0) | (b.kind === 'mixin' ? MIXIN_LAST : 0);
        const key = b.node * 8 + f;
        if (seen.has(key)) continue;
        seen.add(key);
        node.push(b.node); parent.push(from); flags.push(f);
      }
    };
    expand(-1, self, EXTENDS_ONLY);
    for (let i = 0; i < node.length; i++) expand(i, node[i]!, flags[i]!);
    const N = Int32Array.from(node);
    const P = Int32Array.from(parent);
    const F = Uint8Array.from(flags);
    const subject: Ancestor = nodes[self]!;
    const r: Reaches = {
      length: N.length,
      ancestor: (i) => nodes[N[i]!]!,
      allExtends: (i) => (F[i]! & EXTENDS_ONLY) !== 0,
      implementing: (i) => (F[i]! & IMPLEMENTING) !== 0,
      mixin: (i) => (F[i]! & MIXIN_LAST) !== 0,
      path: (i) => {
        const out: Ancestor[] = [];
        for (let j = i; j >= 0; j = P[j]!) out.push(nodes[N[j]!]!);
        out.push(subject);
        return out.reverse();
      },
    };
    reachCache.set(el.id, r);
    return r;
  };

  // Depth: the longest chain of bases, over the condensation of the base graph (Tarjan's strongly
  // connected components, iterative): a cycle's types count once each, so `A extends B extends A`
  // gives both depth 1. Linear in the types and their bases.
  let depthOfNode: Map<number, number> | null = null;
  const computeDepths = () => {
    const depth = new Map<number, number>();
    const index = new Map<number, number>();
    const low = new Map<number, number>();
    const onStack = new Set<number>();
    const stack: number[] = [];
    let counter = 0;
    const roots = view.elements.filter(isType).map(typeNode);
    for (const root of roots) {
      if (index.has(root)) continue;
      const work: Array<{ n: number; i: number }> = [{ n: root, i: 0 }];
      index.set(root, counter); low.set(root, counter++); stack.push(root); onStack.add(root);
      while (work.length) {
        const top = work[work.length - 1]!;
        const out = basesOfNode(top.n);
        if (top.i < out.length) {
          const next = out[top.i++]!.node;
          if (!nodes[next]!.element) continue; // an external base: a leaf, depth 0
          if (!index.has(next)) {
            index.set(next, counter); low.set(next, counter++); stack.push(next); onStack.add(next);
            work.push({ n: next, i: 0 });
          } else if (onStack.has(next)) low.set(top.n, Math.min(low.get(top.n)!, index.get(next)!));
          continue;
        }
        work.pop();
        if (work.length) { const up = work[work.length - 1]!.n; low.set(up, Math.min(low.get(up)!, low.get(top.n)!)); }
        if (low.get(top.n) !== index.get(top.n)) continue;
        // A component, emitted after every component it reaches: its depth is final.
        const members: number[] = [];
        for (let m; (m = stack.pop()) !== undefined;) { onStack.delete(m); members.push(m); if (m === top.n) break; }
        const inside = new Set(members);
        let below = 0;
        for (const m of members) for (const b of basesOfNode(m)) if (!inside.has(b.node)) below = Math.max(below, 1 + (depth.get(b.node) ?? 0));
        for (const m of members) depth.set(m, members.length - 1 + below);
      }
    }
    return depth;
  };
  const depthOf = (el: Element) => {
    if (!isType(el)) return 0;
    depthOfNode ??= computeDepths();
    return depthOfNode.get(typeNode(el)) ?? 0;
  };
  /** A longest chain: from the type, the base of greatest depth, never revisiting a type. */
  const longestChain = (el: Element): string[] => {
    if (!isType(el)) return [];
    depthOfNode ??= computeDepths();
    const chain = [typeNode(el)];
    const visited = new Set(chain);
    for (;;) {
      let best = -1;
      let bestDepth = -1;
      for (const b of basesOfNode(chain[chain.length - 1]!)) {
        if (visited.has(b.node)) continue;
        const d = nodes[b.node]!.element ? depthOfNode.get(b.node) ?? 0 : 0;
        if (d > bestDepth) { best = b.node; bestDepth = d; }
      }
      if (best < 0) break;
      chain.push(best);
      visited.add(best);
    }
    return chain.map((n) => nodes[n]!.name);
  };

  const memberIndex = new Map<string, Element[]>();
  const members = (el: Element): Element[] => {
    if (!isType(el)) return [];
    let list = memberIndex.get(el.id);
    if (!list) {
      list = view.ofFile(el.file.path).filter((m) => m.kind === 'symbol' && m.id !== el.id && m.scope === el.name
        && m.qualifiedName.startsWith(el.qualifiedName) && /^(::|\.|#|\\)/.test(m.qualifiedName.slice(el.qualifiedName.length)));
      memberIndex.set(el.id, list);
    }
    return list;
  };
  // The type each member belongs to: the longest qualified name among the types that own it.
  let owners: Map<string, Element> | null = null;
  const ownerType = (el: Element): Element | null => {
    if (el.kind !== 'symbol' || isType(el)) return null;
    if (!owners) {
      owners = new Map();
      for (const t of view.elements) {
        if (!isType(t)) continue;
        for (const m of members(t)) {
          const prev = owners.get(m.id);
          if (!prev || t.qualifiedName.length > prev.qualifiedName.length) owners.set(m.id, t);
        }
      }
    }
    return owners.get(el.id) ?? null;
  };

  return { bases, reaches, members, ownerType, depth: depthOf, longestChain };
}

// ─── Matching ancestor values ────────────────────────────────────────────────────────────────

const segments = (name: string) => name.replace(/^\\/, '').toLowerCase().split(SEP).filter(Boolean);
const endsWith = (whole: string[], tail: string[]) => tail.length > 0 && whole.length >= tail.length && tail.every((t, i) => whole[whole.length - tail.length + i] === t);
const valueMatchers = new Map<string, (a: Ancestor) => boolean>();

/**
 * A compiled ancestor value: a name or its trailing namespace segments, case-insensitive
 * (`Model`, `Eloquent\Model`, `django.db.models.Model`, `sequelize#Model`), or `/regex/flags` on the
 * ancestor's name. A base outside the index known only as written (`AbstractPersistable`, no
 * import to qualify it) also matches a qualified value it ends.
 */
export function ancestorMatcher(value: string): (a: Ancestor) => boolean {
  let fn = valueMatchers.get(value);
  if (!fn) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(value);
    if (m) {
      const re = new RegExp(m[1]!, m[2]);
      fn = (a) => re.test(a.name);
    } else {
      const want = segments(value);
      fn = (a) => endsWith(segments(a.name), want) || (!a.element && !a.qualified && endsWith(want, segments(a.name)));
    }
    // Each ancestor is tested once per value, however many types reach it.
    const test = fn;
    const memo = new WeakMap<Ancestor, boolean>();
    fn = (a) => { let r = memo.get(a); if (r === undefined) { r = test(a); memo.set(a, r); } return r; };
    valueMatchers.set(value, fn);
  }
  return fn;
}

export type HierarchyKey = 'extends' | 'implements' | 'inherits' | 'mixes';

/** The first (shortest) path by which `el` has an ancestor matching `value` under `key`, or null. */
export function hierarchyMatch(view: ElementView, el: Element, key: HierarchyKey, value: string): string[] | null {
  const r = hierarchyOf(view).reaches(el);
  if (!r) return null;
  const test = ancestorMatcher(value);
  for (let i = 0; i < r.length; i++) {
    const kindOk = key === 'extends' ? r.allExtends(i) : key === 'implements' ? r.implementing(i) : key === 'mixes' ? r.mixin(i) : true;
    if (kindOk && test(r.ancestor(i))) return r.path(i).map((a) => a.name);
  }
  return null;
}

/**
 * An inheritance path as findings show it (`via`): whole up to `VIA_LIMIT` names, otherwise its
 * first and last names around one `… N more …` entry, so a deep chain cannot bloat a report.
 */
export const VIA_LIMIT = 8;
export function shownPath(names: string[]): string[] {
  if (names.length <= VIA_LIMIT) return names;
  const head = names.slice(0, VIA_LIMIT - 3);
  const tail = names.slice(-2);
  return [...head, `… ${names.length - head.length - tail.length} more …`, ...tail];
}
