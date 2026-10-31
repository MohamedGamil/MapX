// Vue Router navigation (docs/baton M3-06): rule 9 of the Vue edge contract (docs/baton/iterations/M3-01.md).
// `router.push` / `replace`, `this.$router.push` and `<router-link :to>` give a `navigate` edge from
// the caller to the component of the route record they reach. Pure text analysis in three parts:
// the parser finds navigation targets in an SFC or a plain JS/TS module (M3-11), `routeRecords`
// reads a router file's route table, and the scanner matches the two with `matchRoute` (by exact
// name or path, never by similarity).
import type { ExtractedReference, ExtractedSymbol } from '../../types.js';
import { maskCode, matchBracket } from '../../frameworks/http/client-calls.js';
import { maskBlocks, moduleImports, templateNodes, templateRange } from './vue-template.js';

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

/**
 * `push` / `replace` calls on the router in JS code: `this.$router` (or any `$router`), a local bound
 * to `useRouter()` or `this.$router`, `useRouter()` itself, the router module's import, and a local
 * holding the router the file creates (`createRouter(…)`, `new VueRouter(…)`), which its guards use.
 */
function routerCalls(code: string): { index: number; target: NavTarget }[] {
  const masked = maskCode(code);
  const receivers = new Set<string>();
  const bound = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>]+\s*)?=\s*(?:useRouter\s*\(\s*\)|this\s*\.\s*\$router\b|createRouter\s*\(|new\s+(?:VueRouter|Router)\s*\()/g;
  for (const m of masked.matchAll(bound)) receivers.add(m[1]!);
  for (const [local, { specifier, imported }] of moduleImports(code, masked)) {
    if ((imported === 'default' || imported === 'router') && ROUTER_MODULE.test(specifier)) receivers.add(local);
  }
  const named = [...receivers].map(escapeRe).join('|');
  const call = new RegExp(String.raw`(?:(?<![\w$])\$router|(?<![\w$.])useRouter\s*\(\s*\)${named ? String.raw`|(?<![\w$.])(?:${named})(?![\w$])` : ''})\s*\.\s*(?:push|replace)\s*\(`, 'g');
  const calls: { index: number; target: NavTarget }[] = [];
  for (const m of masked.matchAll(call)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const first = topLevelParts(masked, open + 1, close)[0];
    const target = first && navTarget(code.slice(first.start, first.end));
    if (target) calls.push({ index: m.index!, target });
  }
  return calls;
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
  if (!/\b(?:push|replace)\s*\(/.test(source) || !/router/i.test(source)) return [];
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
  for (const m of source.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const start = m.index! + m[1]!.length;
    for (const { index, target } of routerCalls(m[2]!)) refs.push(navigateRef(target, lineAt(source, start + index)));
  }
  const masked = maskBlocks(source);
  const range = templateRange(masked);
  if (!range) return refs;
  for (const node of templateNodes(masked, range.start, range.end)) {
    const expressions: { code: string; at: number }[] = [];
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
      if (!code.includes('$router')) continue;
      for (const { index, target } of routerCalls(code)) refs.push(navigateRef(target, lineAt(source, at + index)));
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

/** The module a route's component comes from: a bound identifier, `import('s')` or `require('s')`. */
function componentSpecifier(value: string, bindings: Map<string, string>): string | null {
  const v = value.trim();
  if (IDENT.test(v)) return bindings.get(v) ?? null;
  return /\b(?:import|require)\s*\(\s*\[?\s*(['"`])([^'"`]+)\1/.exec(v)?.[2] ?? null;
}

function joinPath(parent: string, child: string): string {
  const full = child.startsWith('/') ? child : `${parent.replace(/\/+$/, '')}/${child}`;
  return ('/' + full.split('/').filter(Boolean).join('/'));
}

/** A route array's records (and their `children`, recursively). `masked` and `text` are aligned. */
function arrayRecords(text: string, masked: string, open: number, prefix: string, bindings: Map<string, string>, out: RouteRecord[]): void {
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
    if (path === null) continue;
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
 * `path` only.
 */
export function routeRecords(text: string): RouteRecord[] {
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
  return records;
}

/** A file that may hold a route table (cheap pre-filter before `routeRecords`). */
export function mayDefineRoutes(text: string): boolean {
  return /(?:routes|Routes|routerMap|routeMap|RouteMap)\b[^=\n]*[=:]\s*\[/.test(text) && /\bpath\s*:/.test(text);
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
  for (const file of files) {
    const text = readText(file);
    if (!text || !mayDefineRoutes(text)) continue;
    for (const record of routeRecords(text)) {
      table.push({ ...record, file, componentFile: record.component ? resolveImport(record.component, file) : null });
    }
  }
  return table;
}
