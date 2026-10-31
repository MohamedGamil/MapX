// JS/TS import aliases (docs/baton M3-09): `@/x`, `~/x`, `#utils` and the like, read statically from
// the configuration nearest to the importing file. Nothing is executed: tsconfig/jsconfig are
// parsed as JSON with comments, and bundler configs are read for literal alias entries only.
import { posix } from 'node:path';
import { maskCode, matchBracket } from '../frameworks/http/client-calls.js';

export interface AliasContext {
  /** Every indexed workspace-relative path (identifies the file set for caching). */
  files: Set<string>;
  /** Reads a workspace-relative file that may not be indexed; null when absent. */
  readText(path: string): string | null;
}

/** A TypeScript `paths` entry, or a bundler alias: `pattern` with at most one `*`, workspace-relative targets. */
interface AliasRule { pattern: string; targets: string[] }

/** The aliases one directory's config files declare: compiler `paths` first, then bundler aliases. */
interface DirAliases { compiler: AliasRule[]; bundler: AliasRule[] }

const TS_CONFIGS = ['tsconfig.json', 'jsconfig.json'];
const BUNDLER_CONFIGS = [
  'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs',
  'vue.config.js', 'vue.config.cjs', 'webpack.config.js', 'webpack.config.cjs', 'webpack.mix.js',
];

const dirOf = (p: string) => (posix.dirname(p) === '.' ? '' : posix.dirname(p));
/** Workspace-relative, normalised; null when it leaves the workspace. */
function norm(p: string): string | null {
  const n = posix.normalize(p).replace(/\/$/, '');
  if (n === '.') return '';
  return n === '..' || n.startsWith('../') || n.startsWith('/') ? null : n;
}
const join = (dir: string, p: string) => norm(posix.join(dir || '.', p.replace(/^\//, '')));

// One cache per file set: the scanner hands every resolution of a phase the same Set.
const caches = new WeakMap<Set<string>, Map<string, DirAliases | null>>();

/**
 * Workspace-relative module paths (without extension probing) an aliased import may name, in
 * order: the first directory, from the importing file's upwards, whose config declares an alias
 * matching `target` decides (tsconfig/jsconfig `compilerOptions.paths` before a vite / vue-cli /
 * webpack / Laravel Mix alias). `@/x` with no declared alias falls back to `src/x` under the
 * nearest package.json folder, then under the workspace root. Empty for relative or bare imports.
 */
export function jsAliasTargets(target: string, sourcePath: string, ctx: AliasContext): string[] {
  if (target.startsWith('.') || target.startsWith('/')) return [];
  let cache = caches.get(ctx.files);
  if (!cache) caches.set(ctx.files, (cache = new Map()));
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    let aliases = cache.get(dir);
    if (aliases === undefined) cache.set(dir, (aliases = dirAliases(dir, ctx)));
    const hit = aliases && (match(aliases.compiler, target) ?? match(aliases.bundler, target));
    if (hit) return hit;
    if (!dir) break;
  }
  if (!target.startsWith('@/')) return [];
  const rest = target.slice(2);
  const out: string[] = [];
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    if (ctx.readText(posix.join(dir, 'package.json')) !== null) {
      const p = join(dir, `src/${rest}`);
      if (p) out.push(p);
      break;
    }
    if (!dir) break;
  }
  if (!out.includes(`src/${rest}`)) out.push(`src/${rest}`);
  return out;
}

/** TypeScript's matching: an exact pattern wins, else the wildcard pattern with the longest prefix. */
function match(rules: AliasRule[], target: string): string[] | null {
  let best: { rule: AliasRule; star: string; prefix: number } | null = null;
  for (const rule of rules) {
    const star = rule.pattern.indexOf('*');
    if (star < 0) {
      if (rule.pattern === target) return rule.targets;
      continue;
    }
    const prefix = rule.pattern.slice(0, star);
    const suffix = rule.pattern.slice(star + 1);
    if (target.length >= prefix.length + suffix.length && target.startsWith(prefix) && target.endsWith(suffix)
      && (!best || prefix.length > best.prefix)) {
      best = { rule, star: target.slice(prefix.length, target.length - suffix.length), prefix: prefix.length };
    }
  }
  return best ? best.rule.targets.map((t) => t.replace('*', best!.star)) : null;
}

function dirAliases(dir: string, ctx: AliasContext): DirAliases | null {
  const compiler: AliasRule[] = [];
  for (const name of TS_CONFIGS) {
    compiler.push(...tsConfigRules(posix.join(dir, name), ctx));
    if (compiler.length) break;
  }
  const bundler: AliasRule[] = [];
  for (const name of BUNDLER_CONFIGS) {
    const text = ctx.readText(posix.join(dir, name));
    if (text !== null) bundler.push(...bundlerRules(text, dir));
  }
  return compiler.length || bundler.length ? { compiler, bundler } : null;
}

// ── tsconfig / jsconfig ─────────────────────────────────────────────────────────────────────────

/** JSON with comments and trailing commas (tsconfig's dialect); null when unreadable. */
export function parseJsonc(text: string | null): any {
  if (text === null) return null;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

interface TsPaths { paths?: Record<string, unknown>; pathsDir?: string; baseUrl?: string }

/** `compilerOptions` `paths` / `baseUrl` of a config, after its relative `extends` chain. */
function tsPaths(path: string, ctx: AliasContext, depth = 0): { json: any; paths: TsPaths } | null {
  const json = parseJsonc(ctx.readText(path));
  if (!json || typeof json !== 'object' || depth > 5) return null;
  const dir = dirOf(path);
  let paths: TsPaths = {};
  // `extends` packages (`@vue/tsconfig/…`) live in node_modules and are not followed.
  for (const ext of [json.extends].flat()) {
    if (typeof ext !== 'string' || !ext.startsWith('.')) continue;
    const parentPath = join(dir, ext.endsWith('.json') ? ext : `${ext}.json`);
    const parent = parentPath === null ? null : tsPaths(parentPath, ctx, depth + 1);
    if (parent) paths = { ...paths, ...parent.paths };
  }
  const options = json.compilerOptions;
  if (typeof options?.baseUrl === 'string') {
    const base = join(dir, options.baseUrl);
    if (base !== null) paths.baseUrl = base;
  }
  if (options?.paths && typeof options.paths === 'object') paths = { ...paths, paths: options.paths, pathsDir: dir };
  return { json, paths };
}

/**
 * Alias rules of a tsconfig/jsconfig: its `paths` (relative to `baseUrl`, else to the config that
 * declares them), else the `paths` of the configs it `references` (create-vue's tsconfig.app.json).
 */
function tsConfigRules(path: string, ctx: AliasContext, depth = 0): AliasRule[] {
  const config = tsPaths(path, ctx);
  if (!config) return [];
  const { paths, baseUrl, pathsDir } = config.paths;
  if (paths) {
    const base = baseUrl ?? pathsDir ?? '';
    return Object.entries(paths).flatMap(([pattern, targets]) => {
      const list = (Array.isArray(targets) ? targets : []).filter((t): t is string => typeof t === 'string');
      const resolved = list.map((t) => join(base, t)).filter((t): t is string => t !== null);
      return resolved.length ? [{ pattern, targets: resolved }] : [];
    });
  }
  if (depth > 0 || !Array.isArray(config.json.references)) return [];
  return config.json.references.flatMap((ref: any) => {
    if (typeof ref?.path !== 'string') return [];
    const target = join(dirOf(path), ref.path.endsWith('.json') ? ref.path : `${ref.path}/tsconfig.json`);
    return target === null ? [] : tsConfigRules(target, ctx, depth + 1);
  });
}

// ── Bundler configs ─────────────────────────────────────────────────────────────────────────────

/**
 * Literal aliases of a vite / vue-cli / webpack / Laravel Mix config in `dir`:
 * `alias: { '@': path.resolve(__dirname, 'src') }`, `alias: [{ find: '@', replacement: … }]`,
 * `mix.alias({ … })` and `config.resolve.alias.set('@', …)`. A key `x` covers `x` and `x/…`
 * (`x$` only `x`, as in webpack). Entries whose value is not a literal path are skipped.
 */
export function bundlerRules(text: string, dir: string): AliasRule[] {
  const masked = maskCode(text);
  const rules: AliasRule[] = [];
  const add = (key: string | null, value: string) => {
    if (!key || key.includes('*')) return;
    const target = aliasPath(value, dir);
    if (target === null) return;
    if (key.endsWith('$')) rules.push({ pattern: key.slice(0, -1), targets: [target] });
    else rules.push({ pattern: key, targets: [target] }, { pattern: `${key}/*`, targets: [`${target}/*`] });
  };
  for (const m of masked.matchAll(/\balias\s*(?::|\(\s*)\s*([{[])/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    for (const part of splitTopLevel(masked, open + 1, close)) {
      const entry = { text: text.slice(part.start, part.end), masked: masked.slice(part.start, part.end) };
      if (m[1] === '{') {
        const colon = entry.masked.indexOf(':');
        if (colon > 0) add(literal(entry.text.slice(0, colon)) ?? identifier(entry.text.slice(0, colon)), entry.text.slice(colon + 1));
      } else {
        // `{ find: '@', replacement: … }`; a RegExp `find` is skipped.
        const find = /\bfind\s*:\s*(['"])([^'"]*)\1/.exec(entry.text)?.[2] ?? null;
        const at = /\breplacement\s*:/.exec(entry.masked);
        if (at) {
          const valueStart = at.index + at[0].length;
          const valueEnd = splitTopLevel(entry.masked, valueStart, entry.masked.lastIndexOf('}'))[0]?.end ?? valueStart;
          add(find, entry.text.slice(valueStart, valueEnd));
        }
      }
    }
  }
  for (const m of masked.matchAll(/\.alias\s*\.\s*set\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const [key, value] = splitTopLevel(masked, open + 1, close);
    if (key && value) add(literal(text.slice(key.start, key.end)), text.slice(value.start, value.end));
  }
  return rules;
}

/** The workspace-relative directory an alias value names, or null when it is not a literal path. */
function aliasPath(value: string, dir: string): string | null {
  const v = value.trim();
  let path = literal(v);
  if (path === null) {
    // fileURLToPath(new URL('./src', import.meta.url))
    path = /^(?:url\.)?fileURLToPath\s*\(\s*new\s+URL\s*\(\s*(['"])([^'"]*)\1\s*,\s*import\.meta\.url\s*\)\s*\)$/.exec(v)?.[2] ?? null;
  }
  if (path === null) {
    // path.resolve(__dirname, 'resources/js'), join(__dirname, 'src', 'app'), resolve('src')
    const call = /^(?:path\s*\.\s*|posix\s*\.\s*)?(?:resolve|join)\s*\(([\s\S]*)\)$/.exec(v);
    if (!call) return null;
    const args = call[1]!.split(',').map((a) => a.trim()).filter(Boolean);
    if (args[0] && /^(?:__dirname|process\.cwd\(\)|import\.meta\.dirname)$/.test(args[0])) args.shift();
    const parts = args.map(literal);
    if (!parts.length || parts.some((p) => p === null)) return null;
    path = posix.join(...(parts as string[]).map((p, i) => (i === 0 ? p.replace(/^\//, '') : p)));
  }
  // Vite and Laravel's `'@': '/resources/js'` is relative to the project root, which is `dir`.
  return join(dir, path);
}

function literal(s: string): string | null {
  return /^\s*(['"`])([^'"`$]*)\1\s*$/.exec(s)?.[2] ?? null;
}

function identifier(s: string): string | null {
  return /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(s)?.[1] ?? null;
}

/** Top-level comma-separated parts between `from` and `to` (bracket depth 0) of masked code. */
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
