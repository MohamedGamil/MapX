// Frontend HTTP call-site extraction (docs/baton M2-03, contract D008). Pure text analysis over
// JS/TS/Vue sources: find HTTP clients (axios, fetch, axios.create instances, factories returning
// one, aliases and configured receivers) and every call made through them.
import { posix } from 'node:path';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
export const HTTP_SOURCE = /\.(m?[jt]sx?|cjs|vue|svelte)$/;
/** Built or vendored bundles: compiled copies of the sources, not call sites of their own. */
export const HTTP_SKIP = /(^|\/)(public|dist|build|vendor|node_modules)\/|\.min\.[cm]?js$|\.bundle\.js$/;

export interface HttpClientRef {
  kind: 'axios' | 'fetch' | 'instance' | 'factory' | 'configured';
  /** Receiver as written at the call site (e.g. `api`, `Api()`, `http`). */
  name: string;
  /** Raw `baseURL` expression of the client, evaluated later (M2-05). */
  baseURL?: string;
  /** File that defines the client, when it is not the calling file. */
  definedIn?: string;
}
export interface HttpCallSite {
  file: string;
  line: number;
  method: string;
  /** First argument exactly as written (minus surrounding whitespace). */
  rawUrl: string;
  client: HttpClientRef;
}
export interface HttpClientConfig {
  receiver: string;
  baseURL?: string;
}
interface Provider {
  kind: 'instance' | 'factory';
  baseURL?: string;
  definedIn: string;
}
export interface ProviderIndex {
  named: Map<string, Map<string, Provider>>;
  defaults: Map<string, Provider>;
  /** Some file assigns `window.axios` (Laravel's bootstrap.js), making bare `axios` a client everywhere. */
  globalAxios?: boolean;
}

const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw)$/;

/**
 * Same-length copy of JS source with comments and the bodies of string, template and regex
 * literals replaced by spaces (newlines kept), so searches and bracket matching on it never see
 * code inside comments or literals, while indices and line numbers still match the original.
 */
export function maskCode(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let lastSignificant = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end - 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      blank(i, end < 0 ? text.length : end + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = Math.min(skipString(text, i), text.length - 1);
      blank(i + 1, end);
      i = end;
      lastSignificant = c;
      continue;
    }
    if (c === '/' && REGEX_PRECEDER.test(text.slice(Math.max(0, i - 8), i).trimEnd() || '(')) {
      let j = i + 1;
      let inClass = false;
      for (; j < text.length && text[j] !== '\n'; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
      }
      if (text[j] === '/') {
        blank(i + 1, j);
        i = j;
        lastSignificant = '/';
        continue;
      }
    }
    if (!/\s/.test(c)) lastSignificant = c;
  }
  void lastSignificant;
  return out.join('');
}

/** Masks a Vue/Svelte SFC so only its <script> blocks remain as code. */
function maskComponent(text: string): string {
  const out = text.replace(/[^\n]/g, ' ').split('');
  for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const start = m.index! + m[1]!.length;
    const masked = maskCode(m[2]!);
    for (let k = 0; k < masked.length; k++) out[start + k] = masked[k]!;
  }
  return out.join('');
}

export function maskSource(file: string, text: string): string {
  return /\.(vue|svelte)$/.test(file) ? maskComponent(text) : maskCode(text);
}

/** Index of the balanced closing bracket for the opener at `open`, skipping strings and templates. */
export function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (quote === '`' && c === '$' && text[i + 1] === '{') i = matchBracket(text, i + 1);
    else if (c === quote) return i;
    if (i < 0) return text.length;
  }
  return text.length;
}

/** Removes line and block comments outside string and template literals. */
export function stripComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end - 1;
    } else out += c;
  }
  return out;
}

/** Closing bracket for the opener at `open`, counting brackets in masked source only. */
function maskedClose(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return i;
  }
  return -1;
}

/**
 * Top-level comma-separated arguments of the call whose `(` is at `open`, without comments.
 * Bounds and commas come from the masked source, so quotes inside comments or regex literals
 * cannot derail them; the text comes from the original.
 */
export function callArguments(text: string, open: number, masked: string = maskCode(text)): string[] {
  const close = maskedClose(masked, open);
  if (close < 0) return [];
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const c = masked[i]!;
    if (i < close && '([{'.includes(c)) depth++;
    else if (i < close && ')]}'.includes(c)) depth--;
    else if (i === close || (c === ',' && depth === 0)) {
      const arg = stripComments(text.slice(start, i)).trim();
      if (arg) args.push(arg);
      start = i + 1;
    }
  }
  return args;
}

/** Index just past the call's closing bracket, for checking what follows it. */
export function callEnd(masked: string, open: number): number {
  return maskedClose(masked, open) + 1;
}

/** Raw `baseURL` value inside an options object such as `{ baseURL: X, timeout: 1 }`. */
export function objectProperty(objectText: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*:`).exec(objectText);
  if (!m) return undefined;
  const wrapped = `(${objectText.slice(m.index + m[0].length)})`;
  return callArguments(wrapped, 0)[0];
}

function createBaseURL(text: string, createAt: number): string | undefined {
  const open = text.indexOf('(', createAt);
  const options = callArguments(text, open)[0];
  return options?.startsWith('{') ? objectProperty(options.slice(1, -1), 'baseURL') : undefined;
}

/** Line lookup by binary search over newline offsets: linear setup, log-time queries. */
function lineIndex(text: string): (index: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Exported clients: `export const http = axios.create(..)`, `export default () => axios.create(..)`, … */
export function collectProviders(files: { path: string; content: string }[]): ProviderIndex {
  const index: ProviderIndex = { named: new Map(), defaults: new Map() };
  for (const { path, content } of files) {
    if (/(?:window|globalThis)\.axios\s*=/.test(maskCode(content))) index.globalAxios = true;
    if (!content.includes('axios')) continue;
    const named = new Map<string, Provider>();
    const add = (name: string | null, kind: Provider['kind'], at: number) => {
      const provider = { kind, baseURL: createBaseURL(content, at), definedIn: path };
      if (name) named.set(name, provider);
      else index.defaults.set(path, provider);
    };
    const patterns: [RegExp, Provider['kind'], boolean][] = [
      [/export\s+(?:const|let|var)\s+(\w+)\s*=\s*axios\.create\s*\(/g, 'instance', true],
      [/export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?:\(\s*)?axios\.create\s*\(/g, 'factory', true],
      [/export\s+function\s+(\w+)\s*\([^)]*\)\s*\{\s*return\s+axios\.create\s*\(/g, 'factory', true],
      [/export\s+default\s+axios\.create\s*\(/g, 'instance', false],
      [/export\s+default\s+(?:async\s*)?\([^)]*\)\s*=>\s*(?:\(\s*)?axios\.create\s*\(/g, 'factory', false],
      [/export\s+default\s+function\s*\w*\s*\([^)]*\)\s*\{\s*return\s+axios\.create\s*\(/g, 'factory', false],
      // async functions and block-bodied arrows
      [/export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{\s*return\s+axios\.create\s*\(/g, 'factory', true],
      [/export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*return\s+axios\.create\s*\(/g, 'factory', true],
      [/export\s+default\s+(?:async\s+)?function\s*\w*\s*\([^)]*\)\s*\{\s*return\s+axios\.create\s*\(/g, 'factory', false],
      [/export\s+default\s+(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*return\s+axios\.create\s*\(/g, 'factory', false],
    ];
    for (const [re, kind, hasName] of patterns)
      for (const m of content.matchAll(re)) add(hasName ? m[1]! : null, kind, m.index! + m[0].lastIndexOf('axios.create'));
    // `const x = axios.create(..); export default x` / `export { x }`
    for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*axios\.create\s*\(/g)) {
      const name = m[1]!;
      if (new RegExp(`export\\s+default\\s+${name}\\b`).test(content)) add(null, 'instance', m.index! + m[0].lastIndexOf('axios.create'));
      else if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(content)) add(name, 'instance', m.index! + m[0].lastIndexOf('axios.create'));
    }
    if (named.size) index.named.set(path, named);
  }
  // Re-exports: export { default as http, api } from './http'
  for (const { path, content } of files)
    for (const m of content.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const target = resolveImport(path, m[2]!, new Set(files.map(f => f.path)));
      if (!target) continue;
      for (const item of m[1]!.split(',')) {
        const [imported, exported] = item.trim().split(/\s+as\s+/);
        if (!imported) continue;
        const provider = imported === 'default' ? index.defaults.get(target) : index.named.get(target)?.get(imported);
        if (!provider) continue;
        const name = exported ?? imported;
        if (name === 'default') index.defaults.set(path, provider);
        else index.named.set(path, new Map([...(index.named.get(path) ?? []), [name, provider]]));
      }
    }
  return index;
}

/** Resolves an import specifier to an indexed file: relative paths and the `@/` → `src/` alias. */
export function resolveImport(fromFile: string, spec: string, files: Set<string>): string | null {
  let base: string;
  if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    const parts = fromFile.split('/');
    const src = parts.lastIndexOf('src');
    if (src < 0) return null;
    base = posix.join(...parts.slice(0, src + 1), spec.slice(2));
  } else return null;
  for (const ext of ['', '.ts', '.js', '.tsx', '.jsx', '.mjs', '.vue', '/index.ts', '/index.js'])
    if (files.has(base + ext)) return base + ext;
  return null;
}

interface Receiver {
  pattern: string;
  client: HttpClientRef;
}

function receiversFor(file: string, content: string, providers: ProviderIndex, files: Set<string>, configured: HttpClientConfig[]): Receiver[] {
  const receivers: Receiver[] = [];
  const own = (name: string, provider: Provider): HttpClientRef => ({
    kind: provider.kind, name, baseURL: provider.baseURL, ...(provider.definedIn !== file ? { definedIn: provider.definedIn } : {}),
  });
  const addProvider = (local: string, provider: Provider) => {
    if (provider.kind === 'instance') receivers.push({ pattern: escape(local), client: own(local, provider) });
    else {
      receivers.push({ pattern: `${escape(local)}\\s*\\(\\s*\\)`, client: own(`${local}()`, provider) });
      // Aliases: const api = Api();
      for (const m of content.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${escape(local)}\\s*\\(\\s*\\)`, 'g')))
        receivers.push({ pattern: escape(m[1]!), client: { ...own(m[1]!, provider), kind: 'factory' } });
    }
  };
  for (const m of content.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s*['"]axios['"]/g))
    receivers.push({ pattern: escape(m[1]!), client: { kind: 'axios', name: m[1]! } });
  for (const m of content.matchAll(/import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
    const [, def, namedList, spec] = m;
    if (spec === 'axios') {
      if (def) receivers.push({ pattern: escape(def), client: { kind: 'axios', name: def } });
      continue;
    }
    const target = resolveImport(file, spec!, files);
    if (!target) continue;
    if (def && providers.defaults.has(target)) addProvider(def, providers.defaults.get(target)!);
    for (const item of (namedList ?? '').split(',')) {
      const [imported, local] = item.trim().split(/\s+as\s+/);
      const provider = imported ? providers.named.get(target)?.get(imported) : undefined;
      if (provider) addProvider(local ?? imported!, provider);
    }
  }
  // CommonJS: const axios = require('axios')
  for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]axios['"]\s*\)/g))
    receivers.push({ pattern: escape(m[1]!), client: { kind: 'axios', name: m[1]! } });
  // A global window.axios (Laravel's bootstrap.js) makes bare `axios` a client in every file.
  if (providers.globalAxios && !receivers.some(r => r.client.kind === 'axios'))
    receivers.push({ pattern: '(?:window\\.|globalThis\\.)?axios', client: { kind: 'axios', name: 'axios' } });
  // Clients created or defined in this file.
  for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*axios\.create\s*\(/g))
    receivers.push({ pattern: escape(m[1]!), client: { kind: 'instance', name: m[1]!, baseURL: createBaseURL(content, m.index! + m[0].lastIndexOf('axios.create')) } });
  for (const [name, provider] of providers.named.get(file) ?? []) addProvider(name, provider);
  for (const c of configured)
    if (new RegExp(`(?<![\\w.$])${escape(c.receiver)}\\s*\\.`).test(content))
      receivers.push({ pattern: escape(c.receiver), client: { kind: 'configured', name: c.receiver, ...(c.baseURL !== undefined ? { baseURL: `'${c.baseURL}'` } : {}) } });
  return receivers;
}

/**
 * A URL argument as the requests it can make: each branch of a top-level `cond ? a : b`
 * (recursively), otherwise the argument itself.
 */
export function urlBranches(arg: string): string[] {
  let depth = 0;
  let question = -1;
  let pending = 0; // nested `?` inside the consequent awaiting their `:`
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i]!;
    if (c === "'" || c === '"' || c === '`') i = skipString(arg, i);
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === '?' && arg[i + 1] !== '.' && arg[i + 1] !== '?' && arg[i - 1] !== '?') {
      if (question < 0) question = i;
      else pending++;
    } else if (depth === 0 && c === ':' && question >= 0) {
      if (pending > 0) pending--;
      else return [...urlBranches(arg.slice(question + 1, i).trim()), ...urlBranches(arg.slice(i + 1).trim())];
    }
  }
  return [arg];
}

/** Every HTTP call site in one JS/TS/Vue file. */
export function extractHttpCalls(
  file: string,
  content: string,
  ctx: { providers: ProviderIndex; files: Set<string>; clients?: HttpClientConfig[] },
): HttpCallSite[] {
  const calls: HttpCallSite[] = [];
  const seen = new Set<number>();
  const methods = HTTP_METHODS.join('|');
  // Search the masked source: calls in comments, strings or SFC templates are not calls.
  const masked = maskSource(file, content);
  const lineAt = lineIndex(content);
  for (const r of receiversFor(file, content, ctx.providers, ctx.files, ctx.clients ?? [])) {
    const re = new RegExp(`(?<![\\w.$])${r.pattern}\\s*\\.\\s*(${methods})\\s*\\(`, 'g');
    for (const m of masked.matchAll(re)) {
      if (seen.has(m.index!)) continue;
      const args = callArguments(content, m.index! + m[0].length - 1, masked);
      if (!args[0]) continue;
      seen.add(m.index!);
      for (const rawUrl of urlBranches(args[0]))
        calls.push({ file, line: lineAt(m.index!), method: m[1]!.toUpperCase(), rawUrl, client: r.client });
    }
  }
  for (const m of masked.matchAll(/(?<![\w.$])(?:window\.|globalThis\.)?fetch\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    // `function fetch(url) {`, `async fetch(id) {` and `fetch(x) {` methods are definitions.
    if (/(?:function|async|get|set)\s+$/.test(masked.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    if (/^\s*(?:\{|=>|:\s*[\w<]+[^;{]*\{)/.test(masked.slice(callEnd(masked, open), callEnd(masked, open) + 80))) continue;
    const args = callArguments(content, open, masked);
    if (!args[0]) continue;
    const method = args[1]?.startsWith('{') ? objectProperty(args[1].slice(1, -1), 'method') : undefined;
    const literal = method?.match(/^['"`](\w+)['"`]$/)?.[1];
    for (const rawUrl of urlBranches(args[0]))
      calls.push({ file, line: lineAt(m.index!), method: (literal ?? 'GET').toUpperCase(), rawUrl, client: { kind: 'fetch', name: 'fetch' } });
  }
  return calls.sort((a, b) => a.line - b.line);
}
