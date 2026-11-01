// Vue Router navigation (docs/baton M3-06): rule 9 of the Vue edge contract (docs/baton/iterations/M3-01.md).
// `router.push` / `replace`, `this.$router.push` and `<router-link :to>` give a `navigate` edge from
// the caller to the component of the route record they reach. Pure text analysis in three parts:
// the parser finds navigation targets in an SFC or a plain JS/TS module (M3-11), `routeRecords`
// reads a router file's route table, and the scanner matches the two with `matchRoute` (by exact
// name or path, never by similarity).
import type { ExtractedReference, ExtractedSymbol } from '../../types.js';
import { maskCode, matchBracket } from '../../frameworks/http/client-calls.js';
import { maskBlocks, moduleImports, scriptBlocks, templateNodes, templateRange } from './vue-template.js';

/**
 * Where a navigation goes: a route `name`, or an absolute `path` (query and hash dropped) in which
 * `${}` stands for a dynamic part of a segment (`/tickets/${id}` → `/tickets/${}`).
 */
export interface NavTarget {
  name?: string;
  path?: string;
}

/** One route record of a router file's route table. */
export interface RouteRecord {
  name: string | null;
  /** The full path, with the paths of its parent records (`/tickets/:id`). */
  path: string;
  /** The component's module specifier (an import, `() => import()`, `require()`); null when none is found. */
  component: string | null;
  /** A `redirect` to a path or a `{ name }`. */
  redirect: NavTarget | null;
  /** The record has `children`; at its own path, an empty-path child is what Vue Router resolves. */
  parent: boolean;
  line: number;
}

/** A route record of the repo, with its router file and the file its component resolves to. */
export interface ResolvedRoute extends RouteRecord {
  file: string;
  componentFile: string | null;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** A module that exports the app's router (`import router from '@/router'`). */
const ROUTER_MODULE = /(?:^|\/)router(?:\/index)?(?:\.[cm]?[jt]s)?$/;
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;
const escapeRe = (s: string) => s.replace(/[$]/g, '\\$');

// ── Navigation targets ──────────────────────────────────────────────────────────────────────────

/** Top-level comma-separated parts of `masked` between `from` and `to`. */
function topLevelParts(masked: string, from: number, to: number): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push({ start, end: i });
      start = i + 1;
    }
  }
  if (masked.slice(start, to).trim()) parts.push({ start, end: to });
  return parts;
}

/** The value of a string literal that is the whole of `raw` (template literals: `${…}` → `${}`), else null. */
function literal(raw: string, allowTemplate: boolean): string | null {
  const text = raw.trim();
  const q = text[0];
  if (q !== "'" && q !== '"' && !(q === '`' && allowTemplate)) return null;
  const close = maskCode(text).indexOf(q, 1);
  if (close !== text.length - 1) return null;
  if (q !== '`') return text.slice(1, close);
  let out = '';
  for (let i = 1; i < close; i++) {
    if (text[i] === '$' && text[i + 1] === '{') {
      const end = matchBracket(text, i + 1);
      if (end < 0) return null;
      out += '${}';
      i = end;
    } else out += text[i];
  }
  return out;
}

/** An absolute path target, without its query and hash; relative paths name no record. */
function pathTarget(value: string): NavTarget | null {
  const path = value.replace(/[?#][\s\S]*$/, '').trim();
  return path.startsWith('/') ? { path } : null;
}

/**
 * The properties of the object literal whose `{` is at `brace` (`text` and `masked` aligned): key →
 * the range of its value. Keys may be quoted; comments before a key are skipped.
 */
function objectProps(text: string, masked: string, brace: number): Map<string, { start: number; end: number }> {
  const props = new Map<string, { start: number; end: number }>();
  const close = matchBracket(masked, brace);
  if (close < 0) return props;
  for (const part of topLevelParts(masked, brace + 1, close)) {
    let at = part.start;
    while (at < part.end && /\s/.test(masked[at]!)) at++;
    const m = /^(['"]?)([A-Za-z_$][\w$]*)\1\s*:/.exec(text.slice(at, part.end));
    if (m) props.set(m[2]!, { start: at + m[0].length, end: part.end });
  }
  return props;
}

/** The string-literal properties of an object literal (`raw` starts at `{`). */
function stringProps(raw: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const [key, r] of objectProps(raw, maskCode(raw), 0)) {
    const value = literal(raw.slice(r.start, r.end), true);
    if (value !== null) props.set(key, value);
  }
  return props;
}

/**
 * The target of a navigation argument or a `:to` binding: a path literal, or an object with a
 * string `name` (which wins, as in Vue Router) or `path`. Anything computed names no target.
 */
export function navTarget(expr: string): NavTarget | null {
  const raw = expr.trim();
  if (raw.startsWith('{')) {
    const props = stringProps(raw);
    const name = props.get('name');
    if (name !== undefined) return name.includes('${}') || !name ? null : { name };
    const path = props.get('path');
    return path !== undefined ? pathTarget(path) : null;
  }
  const value = literal(raw, true);
  return value === null ? null : pathTarget(value);
}

/** The router as JS code names it: receivers (`router` in `router.push`) and functions taken from it (`push`). */
interface RouterBindings {
  receivers: Set<string>;
  /** Locals destructured from the router: `const { push, replace: go } = useRouter()` (M3-11-R1). */
  functions: Set<string>;
}

/**
 * The router bindings of JS code: a local bound to `useRouter()` or `this.$router`, the router
 * module's import, a local holding the router the file creates (`createRouter(…)`, `new
 * VueRouter(…)`), which its guards use, and `push` / `replace` destructured from any of these.
 */
function routerBindings(code: string, masked = maskCode(code)): RouterBindings {
  const receivers = new Set<string>();
  const bound = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>]+\s*)?=\s*(?:useRouter\s*\(\s*\)|this\s*\.\s*\$router\b|createRouter\s*\(|new\s+(?:VueRouter|Router)\s*\()/g;
  for (const m of masked.matchAll(bound)) receivers.add(m[1]!);
  for (const [local, { specifier, imported }] of moduleImports(code, masked)) {
    if ((imported === 'default' || imported === 'router') && ROUTER_MODULE.test(specifier)) receivers.add(local);
  }
  const functions = new Set<string>();
  const named = [...receivers].map(escapeRe).join('|');
  const destructured = new RegExp(String.raw`\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:useRouter\s*\(\s*\)|this\s*\.\s*\$router\b${named ? String.raw`|(?:${named})(?![\w$.(])` : ''})`, 'g');
  for (const m of masked.matchAll(destructured)) {
    for (const part of m[1]!.split(',')) {
      const d = /^\s*(push|replace)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (d) functions.add(d[2] ?? d[1]!);
    }
  }
  return { receivers, functions };
}

/** The first argument of the call whose `(` is at `open`, as a navigation target. */
function callTarget(code: string, masked: string, open: number): NavTarget | null {
  const close = matchBracket(masked, open);
  if (close < 0) return null;
  const first = topLevelParts(masked, open + 1, close)[0];
  return (first && navTarget(code.slice(first.start, first.end))) || null;
}

/**
 * Navigations in JS code: `push` / `replace` calls on the router (`this.$router` or any `$router`,
 * `useRouter()` itself, the receivers of `routerBindings`, and `this.router` in a Pinia store, which
 * a store plugin adds: M3-11-R1), the functions destructured from it, and guard redirects
 * (`guardRedirects`). `outer` adds the bindings of the code around (a template sees its `<script
 * setup>`).
 */
function routerCalls(code: string, outer?: RouterBindings): { index: number; target: NavTarget }[] {
  const masked = maskCode(code);
  const own = routerBindings(code, masked);
  const receivers = [...own.receivers, ...(outer?.receivers ?? [])].map(escapeRe);
  const functions = [...own.functions, ...(outer?.functions ?? [])].map(escapeRe);
  const pinia = /\bdefineStore\s*\(/.test(masked);
  const call = new RegExp([
    String.raw`(?:(?<![\w$])\$router|(?<![\w$.])useRouter\s*\(\s*\)`
      + (receivers.length ? String.raw`|(?<![\w$.])(?:${receivers.join('|')})(?![\w$])` : '')
      + (pinia ? String.raw`|(?<![\w$.])this\s*\.\s*router(?![\w$])` : '')
      + String.raw`)\s*\.\s*(?:push|replace)\s*\(`,
    // A destructured function: not a member (`list.push(`) nor its own declaration.
    ...(functions.length ? [String.raw`(?<![\w$.])(?<!\.\s*)(?<!function\s+)(?:${functions.join('|')})\s*\(`] : []),
  ].join('|'), 'g');
  const calls: { index: number; target: NavTarget }[] = [];
  // A destructured `push` a function rebinds (a parameter, a local) is not the router's (M0-17-R6).
  const shadow = new Map([...own.functions, ...(outer?.functions ?? [])].map((f) => [f, shadowedRanges(masked, f, 0, masked.length)]));
  for (const m of masked.matchAll(call)) {
    const fn = /^[A-Za-z_$][\w$]*/.exec(m[0])?.[0];
    if (fn && shadow.get(fn)?.some((r) => r.start < m.index! && m.index! < r.end)) continue;
    const target = callTarget(code, masked, m.index! + m[0].length - 1);
    if (target) calls.push({ index: m.index!, target });
  }
  const seen = new Set(calls.map((c) => c.index));
  for (const r of guardRedirects(code, masked, own.receivers)) if (!seen.has(r.index)) calls.push(r);
  return calls.sort((a, b) => a.index - b.index);
}

// ── Guard redirects (M3-11-R1) ──────────────────────────────────────────────────────────────────

interface FunctionRange {
  params: { start: number; end: number };
  body: { start: number; end: number };
  /** A `{ … }` body, whose `return` statements are the function's; else an arrow's expression. */
  block: boolean;
}

/** End of the expression starting at `from`: a top-level `,`, `;` or line end, or an unopened bracket. */
function expressionEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === ',' || c === ';' || c === '\n')) return i;
  }
  return masked.length;
}

/**
 * The function written at `at`: `function name?(…) {`, `async`, an arrow (`(…) =>`, `x =>`) or the
 * parameters of a method (`(…) {`), with an optional return type. Null for anything else.
 */
function functionAt(masked: string, at: number): FunctionRange | null {
  const head = /\s*(?:async\b\s*)?(function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*)?/y;
  head.lastIndex = at;
  const h = head.exec(masked)!;
  let i = at + h[0].length;
  let params: { start: number; end: number };
  const paren = masked[i] === '(';
  if (paren) {
    const close = matchBracket(masked, i);
    if (close < 0) return null;
    params = { start: i + 1, end: close };
    i = close + 1;
  } else {
    const id = /[A-Za-z_$][\w$]*/y;
    id.lastIndex = i;
    if (h[1] || !id.exec(masked)) return null;
    params = { start: i, end: id.lastIndex };
    i = id.lastIndex;
  }
  const tail = /\s*(?::[^{}();=]*?)?\s*(=>)?\s*/y;
  tail.lastIndex = i;
  const t = tail.exec(masked)!;
  i += t[0].length;
  // Without an arrow, only `function (…) {` or a method's `(…) {`.
  if (!t[1] && !(paren && masked[i] === '{')) return null;
  if (masked[i] === '{') {
    const close = matchBracket(masked, i);
    return close < 0 ? null : { params, body: { start: i + 1, end: close }, block: true };
  }
  return { params, body: { start: i, end: expressionEnd(masked, i) }, block: false };
}

/** A same-file function by name: `function name(`, or `const name = (…) => / function`. */
function namedFunction(masked: string, name: string): FunctionRange | null {
  const decl = new RegExp(String.raw`\bfunction\s*\*?\s*${escapeRe(name)}\s*(?=\()|\b(?:const|let|var)\s+${escapeRe(name)}\s*(?::[^=]+)?=(?!=)`, 'g');
  for (const m of masked.matchAll(decl)) {
    const fn = functionAt(masked, m.index! + m[0].length);
    if (fn) return fn;
  }
  return null;
}

/** The guard written at `at` (a function, or the name of a same-file one); an array holds several. */
function guardsAt(masked: string, at: number): FunctionRange[] {
  const start = at + (/^\s*/.exec(masked.slice(at, at + 200))![0].length);
  if (masked[start] === '[') {
    const close = matchBracket(masked, start);
    return close < 0 ? [] : topLevelParts(masked, start + 1, close).flatMap((p) => guardsAt(masked, p.start));
  }
  const fn = functionAt(masked, start);
  if (fn) return [fn];
  const name = /[A-Za-z_$][\w$]*/y;
  name.lastIndex = start;
  const m = name.exec(masked);
  const named = m && namedFunction(masked, m[0]);
  return named ? [named] : [];
}

/**
 * The `)` closing the parameters when `masked[from..j]` ends with a return type annotation
 * (`): Type`), else -1. Walks back over balanced brackets, angle brackets and string literals, and
 * stops at a `;`, an `=` that is no arrow, or 200 characters (M0-17-R6).
 */
function returnTypeParen(masked: string, j: number, from: number): number {
  // `try {`, `else {`, `finally {`, `do {` open statements, never a typed function's body.
  if (/(?:^|[^\w$])(?:try|else|finally|do)$/.test(masked.slice(Math.max(from, j - 8), j + 1))) return -1;
  let depth = 0;
  for (let i = j; i >= from && i > j - 200; i--) {
    const c = masked[i]!;
    // A statement boundary in code without semicolons: `ok ? a() : b()` on an earlier line is no type.
    if (depth === 0 && c === '\n') return -1;
    if (c === '>' && masked[i - 1] === '=') { i--; continue; }
    if (c === ')' || c === ']' || c === '}' || c === '>') depth++;
    else if (c === '(' || c === '[' || c === '{' || c === '<') { if (--depth < 0) return -1; }
    else if (depth === 0 && (c === ';' || c === '=')) return -1;
    else if (depth === 0 && c === ':' && i < j) {
      let k = i - 1;
      while (k >= from && /\s/.test(masked[k]!)) k--;
      return masked[k] === ')' ? k : -1;
    }
  }
  return -1;
}

/**
 * Where `name` means something else than in `[from, to)`'s own scope: the bodies of the functions
 * and arrows nested in it that take a parameter `name` (also a method's or a `catch`'s), and the
 * blocks declaring `const` / `let` / `var` / `function name` (M0-17-R6).
 */
function shadowedRanges(masked: string, name: string, from: number, to: number): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const word = new RegExp(String.raw`(?<![\w$])${escapeRe(name)}(?![\w$])`);
  const params = /(?<![\w$])([A-Za-z_$][\w$]*)\s*=>|\(([^()]*)\)\s*(?::[^={;]*)?(=>|\{)/g;
  params.lastIndex = from;
  for (let m = params.exec(masked); m && m.index < to; m = params.exec(masked)) {
    const list = m[1] ?? m[2]!;
    // Only a binding position rebinds: `{ push: p }` binds p; a default value or a type does not.
    if (!word.test(list) || !boundNames(list).includes(name)) continue;
    if (m[3] === '{') {
      // `if (push) {` is a condition, not parameters.
      if (/(?:^|[^\w$])(?:if|for|while|switch|with)\s*$/.test(masked.slice(Math.max(0, m.index - 10), m.index))) continue;
    }
    const after = m.index + m[0].length;
    const open = m[3] === '{' ? after - 1 : /^\s*\{/.test(masked.slice(after)) ? masked.indexOf('{', after) : -1;
    if (open >= 0) {
      const close = matchBracket(masked, open);
      if (close > open) ranges.push({ start: open, end: close });
    } else {
      ranges.push({ start: after, end: expressionEnd(masked, after) });
    }
  }
  const declared = new RegExp(String.raw`\b(?:const|let|var|function)\s+${escapeRe(name)}(?![\w$])`, 'g');
  declared.lastIndex = from;
  for (let m = declared.exec(masked); m && m.index < to; m = declared.exec(masked)) {
    // A `for (const x of …)` header binds x in the loop's body only.
    const head = /\bfor\s*(?:await\s*)?\(\s*$/.exec(masked.slice(Math.max(from, m.index - 16), m.index));
    if (head) {
      const close = matchBracket(masked, m.index - head[0].length + head[0].lastIndexOf('('));
      const open = close > 0 ? masked.indexOf('{', close) : -1;
      if (open > 0 && /^\s*$/.test(masked.slice(close + 1, open))) {
        const end = matchBracket(masked, open);
        if (end > open) ranges.push({ start: close, end });
      }
      continue;
    }
    // The innermost block around the declaration.
    let depth = 0;
    for (let i = m.index; i >= from; i--) {
      if (masked[i] === '}') depth++;
      else if (masked[i] === '{' && depth-- === 0) {
        const close = matchBracket(masked, i);
        if (close > i) ranges.push({ start: i, end: close });
        break;
      }
    }
  }
  return ranges;
}

/**
 * The names a parameter list binds: each top-level part without its default value and type, and
 * the binding targets of a destructuring (`{ a, b: c }` binds a and c; `[d, ...e]` d and e).
 */
function boundNames(list: string): string[] {
  const names: string[] = [];
  const walk = (part: string) => {
    const p = part.trim().replace(/^\.\.\./, '');
    if (p.startsWith('{') || p.startsWith('[')) {
      const inner = p.slice(1, matchBracket(p, 0) > 0 ? matchBracket(p, 0) : undefined);
      for (const item of topLevelParts(inner, 0, inner.length).map((r) => inner.slice(r.start, r.end))) {
        const colon = p.startsWith('{') ? item.search(/:(?![^{[]*[}\]])/) : -1;
        walk(colon >= 0 ? item.slice(colon + 1) : item);
      }
      return;
    }
    const id = /^([A-Za-z_$][\w$]*)/.exec(p)?.[1];
    if (id) names.push(id);
  };
  for (const r of topLevelParts(list, 0, list.length)) walk(list.slice(r.start, r.end).replace(/\s*[=:][\s\S]*$/, (m) => (/^\s*:/.test(m) && /^\s*[{[]/.test(list.slice(r.start, r.end)) ? m : '')));
  return names;
}

/** `{ … }` bodies of the functions nested in `[from, to)` (arrows, `function`, methods). */
function nestedBodies(masked: string, from: number, to: number): { start: number; end: number }[] {
  const bodies: { start: number; end: number }[] = [];
  for (let i = from; i < to; i++) {
    if (masked[i] !== '{') continue;
    let j = i - 1;
    while (j >= from && /\s/.test(masked[j]!)) j--;
    // A return type (`function f(): Target {`, also `{ name: string }`, `'a' | 'b'`, `() => void`)
    // stands between the parameters and the body (M0-17-R6).
    const typed = returnTypeParen(masked, j, from);
    if (typed >= 0) j = typed;
    let fn = masked[j] === '>' && masked[j - 1] === '=';
    if (!fn && masked[j] === ')') {
      let depth = 0;
      let open = j;
      for (; open >= from; open--) {
        if (masked[open] === ')') depth++;
        else if (masked[open] === '(' && --depth === 0) break;
      }
      fn = open >= from && !/(?:^|[^\w$])(?:if|for|while|switch|catch|with)\s*$/.test(masked.slice(Math.max(from, open - 12), open));
    }
    if (!fn) continue;
    const close = matchBracket(masked, i);
    if (close < 0) break;
    bodies.push({ start: i, end: close });
    i = close;
  }
  return bodies;
}

/**
 * Guard redirects (M3-11-R1): in a navigation guard, `next(target)` (its third parameter, also from a
 * callback inside it) and a returned target (`return { name }`, `return '/path'`; not the returns of a
 * function nested in it). Guards: the function passed to `beforeEach` / `beforeResolve` on a receiver
 * of the file or a `…router` / `…Router` local, `onBeforeRouteLeave` / `onBeforeRouteUpdate`, a record's `beforeEnter`
 * (a function, a same-file function's name, or an array of these), the in-component
 * `beforeRouteEnter` / `beforeRouteUpdate` / `beforeRouteLeave`, and any function with the guard
 * signature `(to, from, next)`, which a guards module exports for the router file.
 */
function guardRedirects(code: string, masked: string, receivers: Set<string>): { index: number; target: NavTarget }[] {
  const named = [...receivers].map(escapeRe).join('|');
  const guards: FunctionRange[] = [];
  const sites = [
    // Global guards are Vue Router's own methods: also on a `router` parameter or `./index` import.
    new RegExp(String.raw`(?:(?<![\w$])\$router|(?<![\w$.])useRouter\s*\(\s*\)|(?<![\w$.])[\w$]*[Rr]outer${named ? String.raw`|(?<![\w$.])(?:${named})` : ''})(?![\w$])\s*\.\s*before(?:Each|Resolve)\s*\(`, 'g'),
    /(?<![\w$.])onBeforeRoute(?:Leave|Update)\s*\(/g,
    /(?<![\w$.])beforeEnter\s*:/g,
    /(?<![\w$.])beforeRoute(?:Enter|Update|Leave)\s*:?(?=\s*(?:[(\w$]))/g,
  ];
  for (const site of sites) for (const m of masked.matchAll(site)) guards.push(...guardsAt(masked, m.index! + m[0].length));
  const signature = /\(\s*to\b\s*(?::[^,()]*)?,\s*from\b\s*(?::[^,()]*)?,\s*next\b\s*(?::[^,()]*)?\)/g;
  for (const m of masked.matchAll(signature)) {
    const fn = functionAt(masked, m.index!);
    if (fn) guards.push(fn);
  }

  const out: { index: number; target: NavTarget }[] = [];
  const done = new Set<number>();
  for (const guard of guards) {
    if (done.has(guard.body.start)) continue;
    done.add(guard.body.start);
    const { body } = guard;
    const next = topLevelParts(masked, guard.params.start, guard.params.end)[2];
    const nextName = next && /^\s*([A-Za-z_$][\w$]*)/.exec(masked.slice(next.start, next.end))?.[1];
    if (nextName) {
      const call = new RegExp(String.raw`(?<![\w$.])${escapeRe(nextName)}\s*\(`, 'g');
      // A `next` a nested function rebinds is not the guard's (M0-17-R6).
      const shadowed = shadowedRanges(masked, nextName, body.start + 1, body.end);
      call.lastIndex = body.start;
      for (let m = call.exec(masked); m && m.index < body.end; m = call.exec(masked)) {
        if (shadowed.some((r) => r.start < m!.index && m!.index < r.end)) continue;
        const target = callTarget(code, masked, m.index + m[0].length - 1);
        if (target) out.push({ index: m.index, target });
      }
    }
    if (!guard.block) continue;
    const nested = nestedBodies(masked, body.start, body.end);
    const ret = /\breturn\b[ \t]*/g;
    ret.lastIndex = body.start;
    for (let m = ret.exec(masked); m && m.index < body.end; m = ret.exec(masked)) {
      if (nested.some((n) => n.start < m!.index && m!.index < n.end)) continue;
      const from = m.index + m[0].length;
      const target = navTarget(code.slice(from, expressionEnd(masked, from)));
      if (target) out.push({ index: m.index, target });
    }
  }
  return out;
}

/**
 * A file that may navigate (cheap pre-filter; over-matches): it names the router (`$router`,
 * `useRouter`, `vue-router`, `<router-link>`), or holds a guard that may not (`beforeEnter`, an
 * in-component guard, the `(to, from, next)` signature: M3-11-R1).
 */
export function mayNavigate(source: string): boolean {
  return /router|beforeEnter|beforeRoute(?:Enter|Update|Leave)|\(\s*to\b[^()]*,\s*from\b[^()]*,\s*next\b/i.test(source);
}

function navigateRef(target: NavTarget, startLine: number): ExtractedReference {
  return {
    sourceSymbol: null,
    targetName: target.name ?? target.path!,
    referenceType: 'navigate',
    startLine,
    metadata: { navigate: target },
  };
}

/**
 * Parser side, plain JS/TS modules (M3-11): the navigations of a store, a guard or a composable,
 * each owned by the narrowest function or method symbol around it (bare name, rule 2); outside any,
 * by none. `.vue` files are read by `navigationReferences` instead.
 */
export function moduleNavigationReferences(source: string, symbols: ExtractedSymbol[]): ExtractedReference[] {
  if (!mayNavigate(source)) return [];
  const owners = symbols.filter((s) => s.kind === 'function' || s.kind === 'method');
  return routerCalls(source).map(({ index, target }) => {
    const ref = navigateRef(target, lineAt(source, index));
    let best: ExtractedSymbol | null = null;
    for (const s of owners) {
      if (s.startLine <= ref.startLine && ref.startLine <= s.endLine
        && (!best || s.endLine - s.startLine < best.endLine - best.startLine)) best = s;
    }
    ref.sourceSymbol = best?.name ?? null;
    return ref;
  });
}

/**
 * Parser side: the navigations of an SFC, from its `<script>` blocks and its template
 * (`<router-link>` / `<RouterLink>` `to`, and `$router.push(…)` in template expressions). The
 * references have no owner; rule 2 (`assignOwners`) gives them the member or the component.
 */
export function navigationReferences(source: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  // The template sees the bindings of `<script setup>` (`router`, a destructured `push`: M3-11-R1).
  const setup: RouterBindings = { receivers: new Set(), functions: new Set() };
  for (const { attrs, code, start } of scriptBlocks(source)) {
    for (const { index, target } of routerCalls(code)) refs.push(navigateRef(target, lineAt(source, start + index)));
    if (!/\bsetup\b/.test(attrs)) continue;
    const b = routerBindings(code);
    for (const r of b.receivers) setup.receivers.add(r);
    for (const f of b.functions) setup.functions.add(f);
  }
  const templateNames = [...setup.receivers, ...setup.functions];
  const masked = maskBlocks(source);
  const range = templateRange(masked);
  if (!range) return refs;
  for (const node of templateNodes(masked, range.start, range.end)) {
    const expressions: { code: string; at: number }[] = [];
    // A v-for / v-slot name hides the <script setup> binding of the same name (M0-17-R6).
    const locals = 'interpolation' in node ? node.locals : node.tag.locals;
    const visible: RouterBindings = {
      receivers: new Set([...setup.receivers].filter((r) => !locals.has(r))),
      functions: new Set([...setup.functions].filter((f) => !locals.has(f))),
    };
    if ('interpolation' in node) expressions.push({ code: node.interpolation, at: node.offset });
    else {
      const link = node.tag.name === 'router-link' || node.tag.name === 'RouterLink';
      for (const attr of node.tag.attrs) {
        if (attr.value === null) continue;
        if (link && attr.name === 'to') {
          const target = pathTarget(attr.value);
          if (target) refs.push(navigateRef(target, lineAt(source, attr.offset)));
        } else if (link && (attr.name === ':to' || attr.name === 'v-bind:to')) {
          const target = navTarget(attr.value);
          if (target) refs.push(navigateRef(target, lineAt(source, attr.offset)));
        } else expressions.push({ code: attr.value, at: attr.offset });
      }
    }
    for (const { code, at } of expressions) {
      if (!code.includes('$router') && !templateNames.some((n) => code.includes(n))) continue;
      for (const { index, target } of routerCalls(code, visible)) refs.push(navigateRef(target, lineAt(source, at + index)));
    }
  }
  return refs;
}

// ── Route records ───────────────────────────────────────────────────────────────────────────────

/**
 * Component bindings of a router file: imports (`import Home from '…'`, `require`) and lazy
 * constants (`const Home = () => import('…')`, also inside `defineAsyncComponent`). Local name → specifier.
 */
export function componentBindings(text: string): Map<string, string> {
  const masked = maskCode(text);
  const bindings = new Map<string, string>();
  for (const [local, { specifier }] of moduleImports(text, masked)) bindings.set(local, specifier);
  const lazy = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:defineAsyncComponent\s*\(\s*)?(?:async\s*)?\(\s*\)\s*=>\s*import\s*\(\s*(['"`])/g;
  for (const m of masked.matchAll(lazy)) {
    const quote = m.index! + m[0].length - 1;
    const close = masked.indexOf(m[2]!, quote + 1);
    if (close > quote) bindings.set(m[1]!, text.slice(quote + 1, close));
  }
  return bindings;
}

/**
 * The module a route's component comes from: a bound identifier, `import('s')` or `require('s')`,
 * also with block comments before the specifier (`import(/* webpackChunkName: "x" *\/ 's')`).
 */
function componentSpecifier(value: string, bindings: Map<string, string>): string | null {
  const v = value.trim();
  if (IDENT.test(v)) return bindings.get(v) ?? null;
  return /\b(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*\[?\s*(?:\/\*[\s\S]*?\*\/\s*)*(['"`])([^'"`]+)\1/.exec(v)?.[2] ?? null;
}

function joinPath(parent: string, child: string): string {
  const full = child.startsWith('/') ? child : `${parent.replace(/\/+$/, '')}/${child}`;
  return ('/' + full.split('/').filter(Boolean).join('/'));
}

/**
 * A route array's records (and their `children`, recursively). `masked` and `text` are aligned.
 * `absoluteOnly` skips records with a relative path (children written for a parent elsewhere).
 */
function arrayRecords(text: string, masked: string, open: number, prefix: string, bindings: Map<string, string>, out: RouteRecord[], absoluteOnly = false): void {
  const close = matchBracket(masked, open);
  if (close < 0) return;
  for (const { start, end } of topLevelParts(masked, open + 1, close)) {
    const brace = masked.indexOf('{', start);
    if (brace < 0 || brace >= end || masked.slice(start, brace).trim()) continue;
    const props = objectProps(text, masked, brace);
    const value = (key: string, from = props) => {
      const r = from.get(key);
      return r ? text.slice(r.start, r.end) : null;
    };
    const pathValue = value('path');
    const path = pathValue === null ? null : literal(pathValue, false);
    if (path === null || (absoluteOnly && !path.startsWith('/'))) continue;
    const full = joinPath(prefix, path);
    const nameValue = value('name');
    let component = value('component');
    const components = props.get('components');
    if (component === null && components) {
      // Named views: the `default` view is the route's component.
      const brace2 = masked.indexOf('{', components.start);
      if (brace2 >= 0 && brace2 < components.end) component = value('default', objectProps(text, masked, brace2));
    }
    const redirect = value('redirect');
    const children = props.get('children');
    out.push({
      name: nameValue === null ? null : literal(nameValue, false),
      path: full,
      component: component === null ? null : componentSpecifier(component, bindings),
      redirect: redirect === null ? null : navTarget(redirect),
      parent: !!children,
      line: lineAt(text, brace),
    });
    if (children) {
      const bracket = masked.indexOf('[', children.start);
      if (bracket >= 0 && bracket < children.end) arrayRecords(text, masked, bracket, full, bindings, out);
    }
  }
}

/**
 * The route records of a JS/TS file: every `routes: [ … ]` / `const routes = [ … ]` array (also
 * `routerMap` / `routeMap` and typed `const routes: RouteRecordRaw[] = [`), records with a string
 * `path` only. A route module's `export default [ … ]` (also `<RouteRecordRaw[]>[`), which the router
 * file spreads into its routes (`...adminRoutes`), counts when one of its records has a component
 * (M3-11-R1) and, in `buildRouteTable`, when a router file imports the module; a record there with a relative path is a child of a parent elsewhere, whose full path
 * is unknown, and is left out.
 */
export function routeRecords(text: string, options: { modules?: boolean } = {}): RouteRecord[] {
  const masked = maskCode(text);
  const records: RouteRecord[] = [];
  const arrays = /\b[\w$]*(?:routes|Routes|routerMap|routeMap|RouteMap)\b(?:\s*:\s*[\w$.<>[\]| ]+?)?\s*[=:]\s*\[/g;
  const bindings = componentBindings(text);
  for (let m = arrays.exec(masked); m; m = arrays.exec(masked)) {
    const open = m.index + m[0].length - 1;
    arrayRecords(text, masked, open, '', bindings, records);
    // Nested route arrays (`children`) are read with their parent.
    const close = matchBracket(masked, open);
    arrays.lastIndex = close < 0 ? open + 1 : close + 1;
  }
  for (const m of options.modules === false ? [] : masked.matchAll(MODULE_ARRAY)) {
    const own: RouteRecord[] = [];
    arrayRecords(text, masked, m.index! + m[0].length - 1, '', bindings, own, true);
    if (own.some((r) => r.component !== null)) records.push(...own);
  }
  return records;
}

/** `export default [` of a route module, optionally cast (`export default <RouteRecordRaw[]>[`). */
const MODULE_ARRAY = /\bexport\s+default\s*(?:<[^<>\n]*(?:<[^<>\n]*>[^<>\n]*)?>\s*)?\[/g;

/** A file that may hold a route table (cheap pre-filter before `routeRecords`). */
export function mayDefineRoutes(text: string): boolean {
  return (/(?:routes|Routes|routerMap|routeMap|RouteMap)\b[^=\n]*[=:]\s*\[/.test(text) || new RegExp(MODULE_ARRAY.source).test(text))
    && /\bpath\s*:/.test(text);
}

// ── Matching ────────────────────────────────────────────────────────────────────────────────────

const segments = (path: string) => path.split('/').filter(Boolean);
/** A record whose path matches anything (`*`, `/:pathMatch(.*)*`, repeatable params) is never a target. */
const catchAll = (path: string) => segments(path).some((s) => s === '*' || /^:.*(?:\(\.\*\)|[*+])/.test(s));

/** Static segments of `record` matched by the target path, or -1 when it does not match. */
function pathScore(record: string, target: string): number {
  if (catchAll(record)) return -1;
  const r = segments(record);
  const t = segments(target);
  if (r.length !== t.length) return -1;
  let score = 0;
  for (let i = 0; i < r.length; i++) {
    if (r[i]!.startsWith(':')) continue;
    if (r[i] !== t[i]) return -1;
    score++;
  }
  return score;
}

/** Leading directory segments two paths share. */
function sharedDirs(a: string, b: string): number {
  const x = a.split('/').slice(0, -1);
  const y = b.split('/').slice(0, -1);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/** The records `target` names: by exact name; by path, the exact path, else the most specific pattern. */
function candidates(target: NavTarget, routes: ResolvedRoute[]): { routes: ResolvedRoute[]; exact: boolean } {
  if (target.name !== undefined) return { routes: routes.filter((r) => r.name === target.name), exact: true };
  const path = target.path!;
  // A parent and its empty-path child share a path; Vue Router resolves the child.
  const leaves = (hits: ResolvedRoute[]) => (hits.some((r) => !r.parent) ? hits.filter((r) => !r.parent) : hits);
  if (!path.includes('${}')) {
    const exact = routes.filter((r) => segments(r.path).join('/') === segments(path).join('/'));
    if (exact.length) return { routes: leaves(exact), exact: true };
  }
  let best = -1;
  let hits: ResolvedRoute[] = [];
  for (const r of routes) {
    const score = pathScore(r.path, path);
    if (score < 0 || score < best) continue;
    if (score > best) hits = [];
    best = score;
    hits.push(r);
  }
  return { routes: leaves(hits), exact: false };
}

/**
 * Scanner side: the route record `target` reaches from `sourcePath`, and whether it was matched
 * exactly (name or literal path) rather than by a `:param` pattern. When several router files
 * define the target, the one nearest to the caller wins; records that still disagree give null. A
 * record with a redirect and no component is followed.
 */
export function matchRoute(target: NavTarget, routes: ResolvedRoute[], sourcePath: string): { route: ResolvedRoute; exact: boolean } | null {
  let current = target;
  let exact = true;
  for (let hop = 0; hop < 4; hop++) {
    const found = candidates(current, routes);
    if (!found.routes.length) return null;
    exact &&= found.exact;
    const nearest = Math.max(...found.routes.map((r) => sharedDirs(r.file, sourcePath)));
    const near = found.routes.filter((r) => sharedDirs(r.file, sourcePath) === nearest);
    const key = (r: ResolvedRoute) => r.componentFile ?? `redirect:${JSON.stringify(r.redirect)}`;
    if (new Set(near.map(key)).size !== 1) return null;
    const route = near[0]!;
    if (route.componentFile) return { route, exact };
    if (!route.redirect || route.component) return null;
    current = route.redirect;
  }
  return null;
}

/**
 * The route table of a set of files: the records of every file that holds one, each component
 * resolved by `resolveImport` from its router file.
 */
export function buildRouteTable(
  files: Iterable<string>,
  readText: (file: string) => string | null,
  resolveImport: (specifier: string, fromFile: string) => string | null,
): ResolvedRoute[] {
  const table: ResolvedRoute[] = [];
  const list = [...files];
  // A route module (`export default [ … ]`) counts only when a router file of the table imports it:
  // a sidebar menu config of `{ path, component }` items is no route table (review 2026-11-01).
  const modules = new Set<string>();
  for (const file of list) {
    const text = readText(file);
    if (!text || !(/\bcreateRouter\s*\(|\bnew\s+(?:Vue)?Router\s*\(/.test(text) || /(?:routes|Routes)\b[^=\n]*[=:]\s*\[/.test(text))) continue;
    for (const m of text.matchAll(/\bimport\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g)) {
      const target = resolveImport(m[1]!, file);
      if (target && target !== file) modules.add(target);
    }
  }
  for (const file of list) {
    const text = readText(file);
    if (!text || !mayDefineRoutes(text)) continue;
    for (const record of routeRecords(text, { modules: modules.has(file) })) {
      table.push({ ...record, file, componentFile: record.component ? resolveImport(record.component, file) : null });
    }
  }
  return table;
}

// ── Sync (M3-08) ────────────────────────────────────────────────────────────────────────────────

/** A route record as the scanner keeps it between scans: without its line. */
export type StoredRoute = Omit<RouteRecord, 'line'>;

const asResolved = (routes: StoredRoute[]): ResolvedRoute[] => routes.map((r) => ({ ...r, line: 0, file: '', componentFile: null }));

/**
 * The route records that differ between two records of a repo's route tables (router file →
 * records): added, removed or changed (name, path, component, redirect), with the records whose
 * redirect reaches one of them (up to 4 hops, as `matchRoute` follows).
 */
export function changedRoutes(previous: Record<string, StoredRoute[]>, next: Record<string, StoredRoute[]>): StoredRoute[] {
  const changed: StoredRoute[] = [];
  for (const file of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const before = (previous[file] ?? []).map((r) => JSON.stringify(r));
    const after = (next[file] ?? []).map((r) => JSON.stringify(r));
    for (const r of before) if (!after.includes(r)) changed.push(JSON.parse(r));
    for (const r of after) if (!before.includes(r)) changed.push(JSON.parse(r));
  }
  if (changed.length === 0) return changed;
  const seen = new Set(changed.map((r) => JSON.stringify(r)));
  const redirects = [...Object.values(previous), ...Object.values(next)].flat().filter((r) => r.redirect);
  for (let hop = 0; hop < 4; hop++) {
    const reached = redirects.filter((r) => !seen.has(JSON.stringify(r)) && candidates(r.redirect!, asResolved(changed)).routes.length > 0);
    if (reached.length === 0) break;
    for (const r of reached) if (!seen.has(JSON.stringify(r))) { seen.add(JSON.stringify(r)); changed.push(r); }
  }
  return changed;
}

/**
 * Whether a file (an SFC, or a JS/TS module as M3-11 reads it) navigates to a target one of `routes`
 * may answer (by name, path or pattern); over-matches.
 */
export function navigatesTo(filePath: string, source: string, routes: StoredRoute[]): boolean {
  if (routes.length === 0 || !mayNavigate(source)) return false;
  const table = asResolved(routes);
  const refs = filePath.endsWith('.vue') ? navigationReferences(source) : moduleNavigationReferences(source, []);
  return refs.some((ref) => candidates(ref.metadata!.navigate as NavTarget, table).routes.length > 0);
}
