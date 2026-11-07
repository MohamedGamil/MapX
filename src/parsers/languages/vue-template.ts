// Vue SFC template pass (docs/baton M3-02). Implements rules 1, 2, 4 and 5 of the Vue edge contract
// (docs/baton/iterations/M3-01.md): the component symbol, who owns a reference, template calls and
// component tags. Pure text analysis; the scanner resolves the references through `metadata.vue`.
import type { ExtractedReference, ExtractedSymbol } from '../../types.js';
import { maskCode, matchBracket } from '../../frameworks/http/client-calls.js';
import { vueThisScope, type OptionsComponent } from './vue-options.js';

/**
 * How the scanner resolves a template reference (`metadata.vue`, never stored on the edge). Hinted
 * references are resolved only this way, never by global name lookup. A template call in an
 * Options API component also carries `vueThis` (M3-03): after these steps it resolves as `this.x()`
 * does (the component's mixins, then its map helpers).
 */
export interface VueResolveHint {
  /** A call may target a symbol of the calling SFC. */
  sameFile?: boolean;
  /**
   * Then, in order: for a call, the first module that defines `name`; for a render, the `.vue`
   * file the (only) specifier resolves to.
   */
  from?: { specifier: string; name: string }[];
  /** A component tag with no local registration: looked up among the global registrations. */
  global?: boolean;
}

/** Rule 1: a `.vue` file's component is named after the file, without `.vue`, exactly as written. */
export function vueComponentName(filePath: string): string {
  return filePath.split(/[\\/]/).pop()!.replace(/\.vue$/, '');
}

/** Rule 1: the component symbol. M3-04 adds `props` / `emits` to its `metadata`. */
export function componentSymbol(filePath: string, source: string): ExtractedSymbol {
  const name = vueComponentName(filePath);
  return {
    name, kind: 'class', scope: null, signature: `<${name}>`,
    startLine: 1, endLine: source.split('\n').length, metadata: {},
  };
}

/**
 * Rule 2: a reference without an owner belongs to the narrowest named function or member around it;
 * outside any (template, top-level `<script setup>`, the body of `setup()`, component options) it
 * belongs to the component. Value declarations (`const prefs = usePrefs()`) and `setup` own nothing.
 */
export function assignOwners(refs: ExtractedReference[], symbols: ExtractedSymbol[], component: ExtractedSymbol): void {
  const owners = symbols.filter((s) => s !== component && s.kind !== 'constant' && s.kind !== 'variable' && s.name !== 'setup');
  for (const ref of refs) {
    if (ref.sourceSymbol) continue;
    let best: ExtractedSymbol | null = null;
    for (const s of owners) {
      if (s.startLine <= ref.startLine && ref.startLine <= s.endLine
        && (!best || s.endLine - s.startLine < best.endLine - best.startLine)) best = s;
    }
    ref.sourceSymbol = best ? (best.scope ? `${best.scope}::${best.name}` : best.name) : component.name;
  }
}

// ── Template ────────────────────────────────────────────────────────────────────────────────────

const HTML_TAGS = 'html,body,base,head,link,meta,style,title,address,article,aside,footer,header,hgroup,h1,h2,h3,h4,h5,h6,'
  + 'nav,section,div,dd,dl,dt,figcaption,figure,picture,hr,img,li,main,ol,p,pre,ul,a,b,abbr,bdi,bdo,br,cite,code,data,'
  + 'dfn,em,i,kbd,mark,q,rp,rt,ruby,s,samp,small,span,strong,sub,sup,time,u,var,wbr,area,audio,map,track,video,embed,'
  + 'object,param,source,canvas,script,noscript,del,ins,caption,col,colgroup,table,thead,tbody,td,th,tr,button,datalist,'
  + 'fieldset,form,input,label,legend,meter,optgroup,option,output,progress,select,textarea,details,dialog,menu,summary,'
  + 'template,blockquote,iframe,tfoot,search,slot';
const SVG_TAGS = 'svg,animate,animateMotion,animateTransform,circle,clipPath,defs,desc,ellipse,feBlend,feColorMatrix,'
  + 'feComponentTransfer,feComposite,feConvolveMatrix,feDiffuseLighting,feDisplacementMap,feDistantLight,feDropShadow,'
  + 'feFlood,feFuncA,feFuncB,feFuncG,feFuncR,feGaussianBlur,feImage,feMerge,feMergeNode,feMorphology,feOffset,'
  + 'fePointLight,feSpecularLighting,feSpotLight,feTile,feTurbulence,filter,foreignObject,g,image,line,linearGradient,'
  + 'marker,mask,metadata,mpath,path,pattern,polygon,polyline,radialGradient,rect,set,stop,switch,symbol,text,textPath,'
  + 'tspan,use,view';
/** Native elements, matched case-sensitively as the SFC compiler does (`<button>` native, `<Button>` not). */
const NATIVE_TAGS = new Set(`${HTML_TAGS},${SVG_TAGS},math`.split(','));
/** Vue, Vue Router built-ins (PascalCase): never a render edge (navigation is M3-06). */
const BUILTIN_COMPONENTS = new Set([
  'Component', 'Slot', 'Template', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense', 'RouterLink', 'RouterView',
]);
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'async', 'await', 'void', 'delete',
  'in', 'of', 'instanceof', 'do', 'else', 'with', 'yield', 'super', 'this', 'import',
]);
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** `price-tag`, `priceTag` and `PriceTag` all name the component `PriceTag`, as Vue resolves them. */
export function toPascal(name: string): string {
  return name.replace(/(?:^|[-_])(\w)/g, (_, c: string) => c.toUpperCase());
}

/** Same-length copy with HTML comments and `<script>` / `<style>` blocks blanked (newlines kept). */
export function maskBlocks(source: string): string {
  return source.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[\s\S]*?<\/\1\s*>/gi, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * An SFC's `<script>` blocks: the opening tag's attributes, the code and its offset. A quoted
 * attribute value may hold `>` (`generic="T extends Record<string, unknown>"`: M3-11-R1).
 */
export function scriptBlocks(source: string): { attrs: string; code: string; start: number }[] {
  return [...source.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/gi)]
    .map((m) => ({ attrs: m[1]!, code: m[2]!, start: m.index! + m[0].length - m[2]!.length - '</script>'.length }));
}

/**
 * The root `<template>`'s content range in `masked`, or null (none, self-closing, or not HTML: pug).
 * Only a top-level block counts: a custom block (`<docs>`, `<i18n>`) is raw text up to its closing
 * tag, as the SFC compiler reads it, even when it shows a `<template>` (M3-02-R1).
 */
export function templateRange(masked: string): { start: number; end: number } | null {
  const top = /<([A-Za-z][\w-]*)\b([^>]*)>/g;
  let open: RegExpExecArray | null = null;
  for (let m; (m = top.exec(masked));) {
    if (m[1]!.toLowerCase() === 'template') { open = m; break; }
    if (/\/\s*$/.test(m[2]!)) continue;
    const close = new RegExp(`</${m[1]}\\s*>`, 'gi');
    close.lastIndex = top.lastIndex;
    if (!close.exec(masked)) return null;
    top.lastIndex = close.lastIndex;
  }
  if (!open || /\/\s*$/.test(open[2]!)) return null;
  const lang = /\blang\s*=\s*["']?([\w-]+)/.exec(open[2]!)?.[1];
  if (lang && lang !== 'html') return null;
  const start = open.index + open[0].length;
  const tags = /<(\/?)template\b[^>]*?(\/?)>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let m; (m = tags.exec(masked));) {
    if (m[1]) { if (--depth === 0) return { start, end: m.index }; } else if (!m[2]) depth++;
  }
  return null;
}

export interface TemplateAttr { name: string; value: string | null; offset: number }
export interface TemplateTag {
  name: string;
  offset: number;
  attrs: TemplateAttr[];
  /** Names the template binds around this tag's attributes: enclosing and own v-for aliases, slot props. */
  locals: ReadonlySet<string>;
  /** The same without the tag's own bindings, for its `v-for` source expression. */
  outerLocals: ReadonlySet<string>;
}
export type TemplateNode = { tag: TemplateTag } | { interpolation: string; offset: number; locals: ReadonlySet<string> };

/** Native elements without content: never left open. */
const VOID_TAGS = new Set('area,base,br,col,embed,hr,img,input,link,meta,param,source,track,wbr'.split(','));
const NO_LOCALS: ReadonlySet<string> = new Set();

/** The names a binding pattern declares: `item`, `(item, index)`, `{ id, run: go, done = noop, ...rest }`. */
function patternNames(pattern: string): string[] {
  const masked = maskCode(pattern)
    .replace(/=[^,{}[\]()]*/g, ' ') // default values
    .replace(/[A-Za-z_$][\w$]*\s*:/g, ' '); // property keys
  return masked.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/** Names `tag` binds for its own attributes and children (v-for, slot-scope) and for its children only (v-slot). */
function tagBindings(tag: { name: string; attrs: TemplateAttr[] }): { own: string[]; children: string[] } {
  const own: string[] = [];
  const children: string[] = [];
  for (const { name, value } of tag.attrs) {
    if (value === null) continue;
    if (name === 'v-for') {
      const alias = /^([\s\S]*?)\s(?:in|of)\s/.exec(value)?.[1];
      if (alias) own.push(...patternNames(alias));
    } else if (name === 'slot-scope' || (name === 'scope' && tag.name === 'template')) {
      own.push(...patternNames(value)); // Vue 2 scoped slots: the element itself is the slot content
    } else if (/^(?:v-slot(?:$|:)|#)/.test(name)) {
      children.push(...patternNames(value));
    }
  }
  return { own, children };
}

/**
 * Opening tags (with attributes) and `{{ }}` interpolations of the template, in document order,
 * each with the names the template itself binds around it. A `v-pre` element and its subtree are
 * not compiled, so they yield no node (M3-02-R1).
 */
export function templateNodes(masked: string, start: number, end: number): TemplateNode[] {
  const nodes: TemplateNode[] = [];
  // Open elements: the names their children see, and whether they are inside a v-pre subtree.
  const open: { name: string; locals: ReadonlySet<string>; pre: boolean }[] = [];
  let i = start;
  while (i < end) {
    const parent = open[open.length - 1];
    const locals = parent?.locals ?? NO_LOCALS;
    if (masked.startsWith('{{', i)) {
      const close = masked.indexOf('}}', i + 2);
      if (close < 0 || close > end) break;
      if (!parent?.pre) nodes.push({ interpolation: masked.slice(i + 2, close), offset: i + 2, locals });
      i = close + 2;
      continue;
    }
    if (masked[i] !== '<') { i++; continue; }
    if (masked[i + 1] === '/') {
      const close = masked.indexOf('>', i);
      // Close up to the matching open element; a stray closing tag closes nothing.
      const name = /^<\/([A-Za-z][\w.:-]*)/.exec(masked.slice(i, i + 128))?.[1];
      const at = open.map((o) => o.name).lastIndexOf(name ?? '');
      if (at >= 0) open.length = at;
      i = close < 0 ? end : close + 1;
      continue;
    }
    const name = /^<([A-Za-z][\w.:-]*)/.exec(masked.slice(i, i + 128))?.[1];
    if (!name) { i++; continue; }
    const tag: TemplateTag = { name, offset: i, attrs: [], locals, outerLocals: locals };
    let selfClosing = false;
    let j = i + 1 + name.length;
    while (j < end) {
      while (j < end && /\s/.test(masked[j]!)) j++;
      if (masked[j] === '>') { j++; break; }
      if (masked.startsWith('/>', j)) { j += 2; selfClosing = true; break; }
      const attr = /^[^\s"'>/=]+/.exec(masked.slice(j, j + 256))?.[0];
      if (!attr) { j++; continue; }
      j += attr.length;
      let k = j;
      while (k < end && /\s/.test(masked[k]!)) k++;
      let value: string | null = null;
      let offset = j;
      if (masked[k] === '=') {
        k++;
        while (k < end && /\s/.test(masked[k]!)) k++;
        const q = masked[k];
        if (q === '"' || q === "'") {
          const close = masked.indexOf(q, k + 1);
          const stop = close < 0 || close > end ? end : close;
          value = masked.slice(k + 1, stop);
          offset = k + 1;
          k = stop + 1;
        } else {
          const raw = /^[^\s>]+/.exec(masked.slice(k, k + 256))?.[0] ?? '';
          value = raw;
          offset = k;
          k += raw.length;
        }
        j = k;
      }
      tag.attrs.push({ name: attr, value, offset });
    }
    const pre = !!parent?.pre || tag.attrs.some((a) => a.name === 'v-pre');
    let childLocals = locals;
    if (!pre) {
      const { own, children } = tagBindings(tag);
      if (own.length > 0) tag.locals = new Set([...locals, ...own]);
      childLocals = children.length > 0 ? new Set([...tag.locals, ...children]) : tag.locals;
      nodes.push({ tag });
    }
    if (!selfClosing && !VOID_TAGS.has(name)) open.push({ name, locals: childLocals, pre });
    i = j;
  }
  return nodes;
}

/** Bare function calls in a template expression (`save(x)`, not `cart.clear()`, `$emit()` or keywords). */
function callsIn(code: string): { name: string; index: number }[] {
  const masked = maskCode(code);
  const calls: { name: string; index: number }[] = [];
  for (const m of masked.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2]!;
    if (name.startsWith('$') || KEYWORDS.has(name)) continue;
    calls.push({ name, index: m.index! + m[1]!.length });
  }
  return calls;
}

/** Template expressions an attribute holds: a method-name handler, or code whose calls count. */
function attrExpression(attr: TemplateAttr): { handler?: string; code?: string; at: number } | null {
  const { name, value } = attr;
  if (value === null || value.trim() === '') return null;
  if (/^(?:@|v-on:)/.test(name)) {
    const v = value.trim();
    return IDENT.test(v) ? { handler: v, at: attr.offset + value.indexOf(v) } : { code: value, at: attr.offset };
  }
  if (/^(?::|v-bind(?::|$)|\.)/.test(name)) return { code: value, at: attr.offset };
  if (name === 'v-for') {
    const m = /^([\s\S]*?\s(?:in|of)\s)/.exec(value);
    return m ? { code: value.slice(m[1]!.length), at: attr.offset + m[1]!.length } : null;
  }
  // Other directives (v-if, v-show, v-html, custom ones) take an expression; these do not.
  if (/^v-(?:model|slot|on|pre|cloak|once|else)(?:$|[:.])/.test(name) || !name.startsWith('v-')) return null;
  return { code: value, at: attr.offset };
}

// ── Script bindings ─────────────────────────────────────────────────────────────────────────────

interface ScriptBindings {
  /** Local name → module specifier and imported name (`default` for a default import). */
  imports: Map<string, { specifier: string; imported: string }>;
  /** The SFC has `<script setup>`, whose imports the template sees. */
  setup: boolean;
  /** `components` option: PascalCase registered name → module specifier. */
  components: Map<string, string>;
  /** `const { a, b: c } = useX()`: local name → useX's module and the destructured name. */
  destructured: Map<string, { specifier: string; name: string }>;
}

/** The string literal whose opening quote is at `quote` in `masked` (bodies blanked), read from `text`. */
function stringAt(text: string, masked: string, quote: number): string | null {
  const q = masked[quote];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  const close = masked.indexOf(q, quote + 1);
  return close < 0 ? null : text.slice(quote + 1, close);
}

/** `import X, { a, b as c } from 's'` and `const X = require('s')` bindings of a JS module. */
export function moduleImports(text: string, masked = maskCode(text)): ScriptBindings['imports'] {
  const imports: ScriptBindings['imports'] = new Map();
  for (const m of masked.matchAll(/\bimport\s+(?!type\s)([\w$\s,{}*]*?)\s*from\s*(['"])/g)) {
    const specifier = stringAt(text, masked, m.index! + m[0].length - 1);
    if (!specifier) continue;
    const clause = m[1]!;
    const def = /^\s*([A-Za-z_$][\w$]*)/.exec(clause.split('{')[0]!.split(',')[0]!)?.[1];
    if (def && !clause.trimStart().startsWith('*')) imports.set(def, { specifier, imported: 'default' });
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    for (const part of named.split(',')) {
      const nm = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (nm) imports.set(nm[2] ?? nm[1]!, { specifier, imported: nm[1]! });
    }
  }
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])/g)) {
    const specifier = stringAt(text, masked, m.index! + m[0].length - 1);
    if (specifier) imports.set(m[1]!, { specifier, imported: 'default' });
  }
  return imports;
}

/** The module a component value comes from: an imported identifier, `require('s')` or `() => import('s')`. */
function valueSpecifier(value: string, imports: ScriptBindings['imports']): string | null {
  const ident = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(value)?.[1];
  if (ident) return imports.get(ident)?.specifier ?? null;
  return /\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1/.exec(value)?.[2] ?? null;
}

/** Top-level comma-separated parts of `text` between `from` and `to` (bracket depth 0), with offsets. */
function splitTopLevel(masked: string, from: number, to: number): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push({ start, end: i }); start = i + 1; }
  }
  parts.push({ start, end: to });
  return parts.filter((p) => masked.slice(p.start, p.end).trim() !== '');
}

/** The bracketed body after `key:` (`components: {…}`) as an offset range, or null. */
function optionBody(masked: string, key: string): { start: number; end: number } | null {
  const m = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(masked);
  if (!m) return null;
  const at = m.index + m[0].length - 1;
  const close = matchBracket(masked, at);
  return close < 0 ? null : { start: at + 1, end: close };
}

function scriptBindings(source: string): ScriptBindings {
  // The script blocks' code, read with comments and literal bodies masked.
  let code = '';
  let setup = false;
  for (const block of scriptBlocks(source)) {
    if (/\bsetup\b/.test(block.attrs)) setup = true;
    code += block.code + '\n';
  }
  const codeMasked = maskCode(code);
  const imports = moduleImports(code, codeMasked);

  const components = new Map<string, string>();
  const body = optionBody(codeMasked, 'components');
  if (body) {
    for (const part of splitTopLevel(codeMasked, body.start, body.end)) {
      const entry = code.slice(part.start, part.end);
      const colon = codeMasked.slice(part.start, part.end).indexOf(':');
      const key = (colon < 0 ? entry : entry.slice(0, colon)).trim().replace(/^(['"`])(.*)\1$/, '$2');
      if (!/^[\w$-]+$/.test(key)) continue;
      const specifier = valueSpecifier(colon < 0 ? key : entry.slice(colon + 1), imports);
      if (specifier) components.set(toPascal(key), specifier);
    }
  }

  const destructured = new Map<string, { specifier: string; name: string }>();
  for (const m of codeMasked.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const specifier = imports.get(m[2]!)?.specifier;
    if (!specifier) continue;
    for (const part of m[1]!.split(',')) {
      const d = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=[\s\S]*)?$/.exec(part);
      if (d) destructured.set(d[2] ?? d[1]!, { specifier, name: d[1]! });
    }
  }
  return { imports, setup, components, destructured };
}

// ── References ──────────────────────────────────────────────────────────────────────────────────

/** Rule 4: where a template call to `name` may resolve before the Options API steps, in order. */
function callHint(name: string, b: ScriptBindings): VueResolveHint {
  const d = b.destructured.get(name);
  if (d) return { sameFile: true, from: [d] };
  const imp = b.setup ? b.imports.get(name) : undefined;
  if (imp && imp.imported !== 'default') return { sameFile: true, from: [{ specifier: imp.specifier, name: imp.imported }] };
  return { sameFile: true };
}

/** Rule 5: a tag's local registration (`components`, or a `<script setup>` import), if any. */
function localComponent(pascal: string, b: ScriptBindings): string | null {
  const registered = b.components.get(pascal);
  if (registered) return registered;
  if (!b.setup) return null;
  for (const [local, { specifier }] of b.imports) if (toPascal(local) === pascal) return specifier;
  return null;
}

/**
 * Rules 4 and 5: call references for template handlers, bindings and interpolations, and one render
 * reference per child component, all owned by the component. Each carries its resolution hint;
 * with the component's Options API object (`analyzeOptionsComponent`), calls also carry `vueThis`.
 */
export function templateReferences(source: string, componentName: string, options?: OptionsComponent | null): ExtractedReference[] {
  const masked = maskBlocks(source);
  const range = templateRange(masked);
  if (!range) return [];
  const bindings = scriptBindings(source);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const refs: ExtractedReference[] = [];
  // A name the template binds (v-for alias, slot prop) is not a component member (M3-02-R1).
  const call = (name: string, offset: number, locals: ReadonlySet<string>) => locals.has(name) || refs.push({
    sourceSymbol: componentName, targetName: name, referenceType: 'call', startLine: lineAt(offset),
    metadata: { template: true, vue: callHint(name, bindings) },
    ...(options ? { vueThis: vueThisScope(options, name) } : {}),
  });
  const rendered = new Set<string>();
  for (const node of templateNodes(masked, range.start, range.end)) {
    if ('interpolation' in node) {
      for (const c of callsIn(node.interpolation)) call(c.name, node.offset + c.index, node.locals);
      continue;
    }
    const { tag } = node;
    const pascal = toPascal(tag.name);
    if (!NATIVE_TAGS.has(tag.name) && !BUILTIN_COMPONENTS.has(pascal) && /^[A-Za-z][\w-]*$/.test(tag.name) && !rendered.has(pascal)) {
      rendered.add(pascal);
      const specifier = localComponent(pascal, bindings);
      const hint: VueResolveHint = specifier ? { from: [{ specifier, name: pascal }] } : { global: true };
      refs.push({
        sourceSymbol: componentName, targetName: pascal, referenceType: 'render', startLine: lineAt(tag.offset),
        metadata: { template: true, vue: hint },
      });
    }
    for (const attr of tag.attrs) {
      const expr = attrExpression(attr);
      if (!expr) continue;
      // The v-for source is read outside the aliases it declares.
      const locals = attr.name === 'v-for' ? tag.outerLocals : tag.locals;
      if (expr.handler) call(expr.handler, expr.at, locals);
      else for (const c of callsIn(expr.code!)) call(c.name, expr.at + c.index, locals);
    }
  }
  return refs;
}

// ── Global registration ─────────────────────────────────────────────────────────────────────────

export interface GlobalRegistrations {
  /** `Vue.component('Name', X)` / `app.component('Name', X)`: PascalCase name → X's module. */
  named: { name: string; specifier: string }[];
  /** `require.context` / `import.meta.glob` of `.vue` files registered under their basenames. */
  globs: { dir: string; deep: boolean }[];
}

/** Global component registrations in a JS/TS module (rule 5); comments are ignored. */
export function globalRegistrations(text: string): GlobalRegistrations {
  const masked = maskCode(text);
  const imports = moduleImports(text, masked);
  const named: GlobalRegistrations['named'] = [];
  let computedName = false;
  for (const m of masked.matchAll(/\.component\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const [first, second] = splitTopLevel(masked, open + 1, close);
    if (!first) continue;
    const quote = masked.slice(first.start, first.end).search(/\S/) + first.start;
    const name = stringAt(text, masked, quote);
    // `Vue.component(key.split('/').pop()…, files(key).default)`: the auto-registration idiom.
    if (name === null || name.includes('${')) { computedName = true; continue; }
    if (!second || !/^[\w-]+$/.test(name)) continue;
    const specifier = valueSpecifier(text.slice(second.start, second.end), imports);
    if (specifier) named.push({ name: toPascal(name), specifier });
  }
  const globs: GlobalRegistrations['globs'] = [];
  if (computedName) {
    for (const m of masked.matchAll(/\brequire\.context\s*\(\s*(['"])/g)) {
      const dir = stringAt(text, masked, m.index! + m[0].length - 1);
      const rest = text.slice(m.index! + m[0].length + (dir?.length ?? 0) + 1, m.index! + m[0].length + 200);
      const args = /^\s*(?:,\s*(true|false)\s*)?(?:,\s*\/([^\n]*?)\/[a-z]*\s*)?\)/.exec(rest);
      if (dir !== null && args && (args[2] ?? '').includes('vue')) globs.push({ dir, deep: args[1] !== 'false' });
    }
    for (const m of masked.matchAll(/\bimport\.meta\.glob(?:Eager)?\s*\(\s*(['"])/g)) {
      const pattern = stringAt(text, masked, m.index! + m[0].length - 1);
      if (!pattern?.endsWith('.vue')) continue;
      const dir = pattern.split('/').filter((_, i, parts) => !parts.slice(0, i + 1).some((p) => /[*?{[]/.test(p))).join('/');
      globs.push({ dir, deep: pattern.includes('**') });
    }
  }
  return { named, globs };
}

/** The `.vue` files among `vueFiles` that a glob registration in `registrar` registers (relative folders only). */
export function vueGlobFiles(registrar: string, { dir, deep }: GlobalRegistrations['globs'][number], vueFiles: Iterable<string>): string[] {
  if (!dir.startsWith('.')) return [];
  const parts = registrar.split('/').slice(0, -1);
  for (const part of dir.split('/')) {
    if (part === '..') { if (parts.pop() === undefined) return []; } else if (part && part !== '.') parts.push(part);
  }
  const prefix = parts.join('/');
  return [...vueFiles].filter((file) => {
    const rest = prefix ? (file.startsWith(prefix + '/') ? file.slice(prefix.length + 1) : null) : file;
    return rest !== null && (deep || !rest.includes('/'));
  });
}

/**
 * Component names whose global registration differs between two records of a repo's registrations
 * (registrar file → `globalRegistrations()`), M3-08: a named entry added, removed or retargeted;
 * the `.vue` files under a changed glob's old and new folders; and `movedVue` (added or deleted
 * `.vue` files) under any glob of `next`.
 */
export function changedGlobalNames(
  previous: Record<string, GlobalRegistrations>, next: Record<string, GlobalRegistrations>, vueFiles: string[], movedVue: string[],
): Set<string> {
  const names = new Set<string>();
  const entries = (r?: GlobalRegistrations) => new Set((r?.named ?? []).map((n) => `${n.name}\0${n.specifier}`));
  for (const path of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const [before, after] = [previous[path], next[path]];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const [a, b] = [entries(before), entries(after)];
    for (const e of a) if (!b.has(e)) names.add(e.split('\0')[0]!);
    for (const e of b) if (!a.has(e)) names.add(e.split('\0')[0]!);
    if (JSON.stringify(before?.globs ?? []) === JSON.stringify(after?.globs ?? [])) continue;
    for (const glob of [...(before?.globs ?? []), ...(after?.globs ?? [])]) {
      for (const file of vueGlobFiles(path, glob, [...vueFiles, ...movedVue])) names.add(vueComponentName(file));
    }
  }
  for (const [path, { globs }] of Object.entries(next)) {
    for (const glob of globs) for (const file of vueGlobFiles(path, glob, movedVue)) names.add(vueComponentName(file));
  }
  return names;
}

/** Whether an SFC's text has a tag naming one of `names` (`<user-card>` names `UserCard`); text only, so it may over-match. */
export function usesTag(text: string, names: Set<string>): boolean {
  if (names.size === 0) return false;
  for (const m of text.matchAll(/<([A-Za-z][\w-]*)/g)) if (names.has(toPascal(m[1]!))) return true;
  return false;
}
