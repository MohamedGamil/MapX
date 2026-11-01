// JS/TS import aliases (docs/baton M3-09): `@/x`, `~/x`, `#utils` and the like, read statically from
// the configuration of the app the importing file belongs to (M3-09-R1). Nothing is executed:
// tsconfig/jsconfig are parsed as JSON with comments, and bundler configs are read for literal alias
// entries only.
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

/**
 * One directory's config files: `compiler` is null without a tsconfig/jsconfig, `bundler` is null
 * unless the directory is a package root. `root` is 'app' for a separately built app (a bundler
 * config, or a bundler or dev server among its package.json dependencies), 'package' for any other
 * package.json naming a package or dependencies, 'none' otherwise (a `{"type": "module"}` marker).
 */
interface DirAliases { compiler: AliasRule[] | null; bundler: AliasRule[] | null; root: 'none' | 'package' | 'app' }

/** Dependencies that make a package.json folder its own build, with its own resolution. */
export const BUILD_TOOLS = [
  'vite', 'webpack', '@vue/cli-service', 'nuxt', 'next', 'react-scripts', '@angular/cli', '@angular-devkit/build-angular',
  'laravel-mix', 'parcel', '@rspack/cli', '@rsbuild/core', '@quasar/app-vite', '@quasar/app-webpack',
];

const TS_CONFIGS = ['tsconfig.json', 'jsconfig.json'];
export const BUNDLER_CONFIGS = [
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
const caches = new WeakMap<Set<string>, Map<string, DirAliases>>();

/**
 * Workspace-relative module paths (without extension probing) an aliased import may name, in
 * order. Aliases never cross an app's boundary (M3-09-R1):
 * - `compilerOptions.paths` come from the nearest tsconfig/jsconfig (with its `extends` chain), as
 *   tsc finds it, but not from above a separately built app (its own bundler config or bundler
 *   dependency): a package of a monorepo uses the root tsconfig, a nested Vue CLI app does not;
 * - bundler aliases (vite / vue-cli / webpack / Laravel Mix) come from the nearest app root, a
 *   folder with a bundler config or a build tool among its package.json dependencies;
 * - compiler `paths` come before bundler aliases.
 * `@/x` with no matching alias falls back to `src/x` under the nearest package.json folder, then
 * under the nearest `src` folder above the importing file, then under the workspace root. Empty for
 * relative or bare imports.
 */
export function jsAliasTargets(target: string, sourcePath: string, ctx: AliasContext): string[] {
  if (target.startsWith('.') || target.startsWith('/')) return [];
  let cache = caches.get(ctx.files);
  if (!cache) caches.set(ctx.files, (cache = new Map()));
  const at = (dir: string) => {
    let aliases = cache!.get(dir);
    if (aliases === undefined) cache!.set(dir, (aliases = dirAliases(dir, ctx)));
    return aliases;
  };
  let compiler: AliasRule[] | null = null;
  const bundlers: AliasRule[][] = [];
  let compilerDone = false;
  let bundlerDone = false;
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    const aliases = at(dir);
    if (!compilerDone && aliases.compiler) [compiler, compilerDone] = [aliases.compiler, true];
    // The build that bundles the file: a package without its own build (a workspace package of a
    // single-build monorepo) takes an enclosing app's aliases (review 2026-10-31). A Laravel module
    // (`Modules/<Name>`) with its own bundler config also sees the enclosing app's aliases its own
    // config does not declare, as its build extends the root's (M0-17-R6).
    if (!bundlerDone && aliases.root === 'app') {
      bundlers.push(aliases.bundler ?? []);
      const app = LARAVEL_MODULE.test(dir) ? dirOf(dirOf(dir)) : null;
      bundlerDone = app === null || ctx.readText(app ? `${app}/artisan` : 'artisan') === null;
    }
    if (aliases.root === 'app') compilerDone = true;
    if ((compilerDone && bundlerDone) || !dir) break;
  }
  const hit = (compiler && match(compiler, target)) ?? bundlers.reduce<string[] | null>((found, rules) => found ?? match(rules, target), null);
  if (hit) return hit;
  if (!target.startsWith('@/')) return [];
  const rest = target.slice(2);
  const out: string[] = [];
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    if (at(dir).root !== 'none') {
      const p = join(dir, `src/${rest}`);
      if (p) out.push(p);
      break;
    }
    if (!dir) break;
  }
  // The src/ folder the importing file sits in (`app/src/views/x.vue`), as the HTTP pass and the
  // vue-router detector used to guess (M3-12), then the workspace root's.
  const parts = sourcePath.split('/');
  const src = parts.lastIndexOf('src', parts.length - 2);
  if (src >= 0) out.push(posix.join(...parts.slice(0, src + 1), rest));
  out.push(`src/${rest}`);
  return [...new Set(out)];
}

/** A Laravel module folder (nwidart/laravel-modules): `Modules/Blog`, under an app holding `artisan`. */
const LARAVEL_MODULE = /(?:^|\/)Modules\/[^/]+$/;

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

function dirAliases(dir: string, ctx: AliasContext): DirAliases {
  let compiler: AliasRule[] | null = null;
  for (const name of TS_CONFIGS) {
    const path = posix.join(dir, name);
    if (ctx.readText(path) === null) continue;
    compiler = tsConfigRules(path, ctx);
    if (compiler.length) break;
  }
  const manifest = parseJsonc(ctx.readText(posix.join(dir, 'package.json')));
  const deps = manifest && typeof manifest === 'object'
    ? { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }
    : null;
  let root: DirAliases['root'] = deps && (manifest.name || Object.keys(deps).length) ? 'package' : 'none';
  if (root === 'package' && BUILD_TOOLS.some(t => t in deps!)) root = 'app';
  let bundler: AliasRule[] | null = root === 'none' ? null : [];
  for (const name of BUNDLER_CONFIGS) {
    const text = ctx.readText(posix.join(dir, name));
    if (text === null) continue;
    (bundler ??= []).push(...bundlerRules(text, dir));
    root = 'app';
  }
  return { compiler, bundler, root };
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
    // `.set('@', a).set('x', b)`: every call of the chain.
    for (let open = m.index! + m[0].length - 1; ;) {
      const close = matchBracket(masked, open);
      if (close < 0) break;
      const [key, value] = splitTopLevel(masked, open + 1, close);
      if (key && value) add(literal(text.slice(key.start, key.end)), text.slice(value.start, value.end));
      const next = /^\s*\.\s*set\s*\(/.exec(masked.slice(close + 1));
      if (!next) break;
      open = close + next[0].length;
    }
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
  // Backslash separators (`'resources\\js'` in the source) are Windows paths.
  return join(dir, path.replace(/\\+/g, '/'));
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
