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
interface DirAliases { compiler: AliasRule[] | null; bundler: AliasRule[] | null; root: 'none' | 'package' | 'app'; baseUrl: string | null }

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
  const at = aliasesAt(ctx);
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

/** One directory's config files, cached per file set. */
function aliasesAt(ctx: AliasContext): (dir: string) => DirAliases {
  let cache = caches.get(ctx.files);
  if (!cache) caches.set(ctx.files, (cache = new Map()));
  return (dir) => {
    let aliases = cache!.get(dir);
    if (aliases === undefined) cache!.set(dir, (aliases = dirAliases(dir, ctx)));
    return aliases;
  };
}

/**
 * The module path a bare import names under the `baseUrl` of the nearest tsconfig/jsconfig, as tsc
 * tries it after `paths` (`components/Button` → `src/components/Button` with `"baseUrl": "src"`, a
 * create-react-app jsconfig); null without one. Not an alias: a package import probes it too, and
 * stays a package when no file is there (M2-08-R3 review).
 */
export function jsBaseUrlTarget(target: string, sourcePath: string, ctx: AliasContext): string | null {
  if (target.startsWith('.') || target.startsWith('/')) return null;
  const at = aliasesAt(ctx);
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    const aliases = at(dir);
    if (aliases.compiler) return aliases.baseUrl === null ? null : join(aliases.baseUrl, target);
    if (aliases.root === 'app' || !dir) return null;
  }
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

/**
 * What a package.json makes of its folder for alias lookup (before any bundler config): 'app' when a
 * build tool is among its dependencies, 'package' for any other manifest naming a package or listing
 * dependencies, 'none' otherwise. Exported for the scanner's sync tracking (M0-02-R13).
 */
export function manifestRootKind(manifest: any): DirAliases['root'] {
  const deps = manifest && typeof manifest === 'object'
    ? { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }
    : null;
  const root: DirAliases['root'] = deps && (manifest.name || Object.keys(deps).length) ? 'package' : 'none';
  return root === 'package' && BUILD_TOOLS.some(t => t in deps!) ? 'app' : root;
}

function dirAliases(dir: string, ctx: AliasContext): DirAliases {
  let compiler: AliasRule[] | null = null;
  let baseUrl: string | null = null;
  for (const name of TS_CONFIGS) {
    const path = posix.join(dir, name);
    if (ctx.readText(path) === null) continue;
    if (compiler === null) baseUrl = tsBaseUrl(path, ctx);
    compiler = tsConfigRules(path, ctx);
    if (compiler.length) break;
  }
  let root = manifestRootKind(parseJsonc(ctx.readText(posix.join(dir, 'package.json'))));
  let bundler: AliasRule[] | null = root === 'none' ? null : [];
  for (const name of BUNDLER_CONFIGS) {
    const text = ctx.readText(posix.join(dir, name));
    if (text === null) continue;
    (bundler ??= []).push(...bundlerRules(text, dir));
    root = 'app';
  }
  return { compiler, bundler, root, baseUrl };
}

// ── tsconfig / jsconfig ─────────────────────────────────────────────────────────────────────────

/**
 * JSON with comments and trailing commas (tsconfig's dialect) as plain JSON: comments become
 * spaces and trailing commas are dropped, outside strings only, so positions and line numbers stay
 * where they were (M5-02 reports JSON.parse errors at them).
 */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
      if (i < text.length) out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else if (c === ',') {
      // A trailing comma: only whitespace and comments before the closing bracket.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j]!)) j++;
        if (text[j] === '/' && text[j + 1] === '/') { while (j < text.length && text[j] !== '\n') j++; continue; }
        if (text[j] === '/' && text[j + 1] === '*') { const e = text.indexOf('*/', j + 2); j = e < 0 ? text.length : e + 2; continue; }
        break;
      }
      out += text[j] === '}' || text[j] === ']' ? ' ' : ',';
    } else out += c;
  }
  return out;
}

/** JSON with comments and trailing commas (tsconfig's dialect); null when unreadable. */
export function parseJsonc(text: string | null): any {
  if (text === null) return null;
  try {
    return JSON.parse(stripJsonc(text));
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

/**
 * The `baseUrl` of a config, after its `extends` chain, else of the configs it `references` (a Vite
 * solution-style tsconfig.json holding `references` to a tsconfig.app.json with the `baseUrl`), the
 * way `paths` follow them (M2-08-R6).
 */
function tsBaseUrl(path: string, ctx: AliasContext, depth = 0): string | null {
  const config = tsPaths(path, ctx);
  if (!config) return null;
  if (config.paths.baseUrl !== undefined) return config.paths.baseUrl;
  if (depth > 0 || !Array.isArray(config.json.references)) return null;
  for (const ref of config.json.references) {
    if (typeof ref?.path !== 'string') continue;
    const target = join(dirOf(path), ref.path.endsWith('.json') ? ref.path : `${ref.path}/tsconfig.json`);
    const found = target === null ? null : tsBaseUrl(target, ctx, depth + 1);
    if (found !== null) return found;
  }
  return null;
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

// ── Module roots (M2-08-R11) ────────────────────────────────────────────────────────────────────

/**
 * Configs that can declare webpack's `resolve.modules`: webpack, Vue CLI (`configureWebpack`), Laravel
 * Mix, CRACO and Next.js (`webpack(config)` hook) configs. A literal list is read; nothing is run.
 */
const WEBPACK_CONFIGS = [
  'webpack.config.js', 'webpack.config.cjs', 'webpack.config.mjs', 'webpack.config.ts', 'webpack.config.mts', 'webpack.config.cts',
  'webpack.common.js', 'webpack.dev.js', 'webpack.prod.js', 'vue.config.js', 'vue.config.cjs', 'webpack.mix.js',
  'craco.config.js', 'craco.config.cjs', 'craco.config.ts',
  'next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts',
];
const JEST_CONFIGS = ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.mts', 'jest.config.cts', 'jest.config.json'];

/** Every file name a module root is read from besides package.json; a change to one re-parses the files it governs. */
export const MODULE_ROOT_CONFIGS = [...WEBPACK_CONFIGS, ...JEST_CONFIGS];

/**
 * A folder a bare import is looked up in: `dir` is workspace-relative. With `walk` it is a folder NAME
 * (`src`, jest's `moduleDirectories: ['src']`, webpack's `modules: ['src']`) searched under every
 * ancestor of the importing file, as `node_modules` is; otherwise one fixed folder.
 */
interface ModuleRoot { dir: string; walk: boolean }

/**
 * The roots one config declares for the files under `scope`. `early` ones are searched before
 * `node_modules` (webpack lists them first), `late` ones after it (NODE_PATH, jest's `modulePaths`,
 * the entries after `'node_modules'`).
 */
export interface RootDecl { scope: string; early: ModuleRoot[]; late: ModuleRoot[] }
interface DirRoots { webpack: RootDecl | null; jest: RootDecl | null; nodePath: RootDecl | null }

interface RootCache {
  dirs: Map<string, DirRoots>;
  /** Per folder, the nearest declaration of each kind (webpack, jest, NODE_PATH) at or above it. */
  nearest: Map<string, Array<RootDecl | null>>;
  targets: Map<string, { early: string[]; late: string[] }>;
}
const rootCaches = new WeakMap<Set<string>, RootCache>();
const NO_ROOTS: { early: string[]; late: string[] } = { early: [], late: [] };
const inside = (dir: string, scope: string) => !scope || dir === scope || dir.startsWith(`${scope}/`);

/**
 * The module paths (without extension probing) a bare import may name under the module roots the
 * project configures, in search order (M2-08-R11). Three sources of positive evidence, each for the
 * files under the folder that declares it:
 * - webpack `resolve.modules` of a webpack-family config in an ancestor folder;
 * - jest `moduleDirectories` and `modulePaths` of the package.json `jest` key or jest.config.* (jest
 *   `roots` only say where tests are found);
 * - `NODE_PATH=` in a package.json script, relative to that package.
 * The nearest webpack config and the nearest jest config decide, even when they declare no root (a
 * package with its own jest config does not get an enclosing one's roots); NODE_PATH comes from the
 * nearest script that sets it. `early` roots come before a workspace package, `late` ones after it, and
 * the caller leaves them out for a name `node_modules` would supply (a listed package, a built-in).
 * Empty for relative imports. The result is shared: callers must not change it.
 */
export function jsModuleRootTargets(target: string, sourcePath: string, ctx: AliasContext): { early: string[]; late: string[] } {
  if (target.startsWith('.') || target.startsWith('/')) return NO_ROOTS;
  let cache = rootCaches.get(ctx.files);
  if (!cache) rootCaches.set(ctx.files, (cache = { dirs: new Map(), nearest: new Map(), targets: new Map() }));
  const caches = cache;
  const dirRoots = (dir: string) => {
    let roots = caches.dirs.get(dir);
    if (roots === undefined) caches.dirs.set(dir, (roots = readDirRoots(dir, ctx)));
    return roots;
  };
  const nearest = (dir: string): Array<RootDecl | null> => {
    let found = caches.nearest.get(dir);
    if (found === undefined) {
      const own = dirRoots(dir);
      const above = dir ? nearest(dirOf(dir)) : [null, null, null];
      found = [own.webpack ?? above[0]!, own.jest ?? above[1]!, own.nodePath ?? above[2]!];
      caches.nearest.set(dir, found);
    }
    return found;
  };
  const dir = dirOf(sourcePath);
  const key = `${dir}\0${target}`;
  const known = caches.targets.get(key);
  if (known) return known;
  const decls = nearest(dir).filter((d): d is RootDecl => !!d && (d.early.length > 0 || d.late.length > 0) && inside(dir, d.scope));
  if (!decls.length) {
    caches.targets.set(key, NO_ROOTS);
    return NO_ROOTS;
  }
  const out = { early: [] as string[], late: [] as string[] };
  const ancestors: string[] = [];
  for (let d = dir; ; d = dirOf(d)) {
    ancestors.push(d);
    if (!d) break;
  }
  for (const decl of decls) {
    for (const when of ['early', 'late'] as const) {
      for (const root of decl[when]) {
        // A folder name is searched in the ancestors that are inside the declaring folder.
        const bases = root.walk ? ancestors.filter((a) => inside(a, decl.scope)).map((a) => join(a, root.dir)) : [root.dir];
        for (const base of bases) {
          const path = base === null ? null : join(base, target);
          if (path !== null && !out[when].includes(path)) out[when].push(path);
        }
      }
    }
  }
  caches.targets.set(key, out);
  return out;
}

const emptyDecl = (scope: string): RootDecl => ({ scope, early: [], late: [] });

function readDirRoots(dir: string, ctx: AliasContext): DirRoots {
  const roots: DirRoots = { webpack: null, jest: null, nodePath: null };
  for (const name of WEBPACK_CONFIGS) {
    const text = ctx.readText(posix.join(dir, name));
    if (text === null) continue;
    const decl = webpackModuleRoots(text, dir);
    roots.webpack = roots.webpack ? { ...roots.webpack, early: [...roots.webpack.early, ...decl.early], late: [...roots.webpack.late, ...decl.late] } : decl;
  }
  for (const name of JEST_CONFIGS) {
    const text = ctx.readText(posix.join(dir, name));
    if (text !== null) { roots.jest ??= jestModuleRoots(name.endsWith('.json') ? parseJsonc(text) : text, dir); }
  }
  const fromManifest = packageModuleRoots(parseJsonc(ctx.readText(posix.join(dir, 'package.json'))), dir);
  roots.jest ??= fromManifest.jest;
  roots.nodePath = fromManifest.nodePath;
  return roots;
}

/**
 * The module roots a package.json declares for its folder: its `jest` key (jest's `moduleDirectories`
 * and `modulePaths`) and a `NODE_PATH=` set in a script. Exported for the scanner's sync tracking, so
 * a package.json edit that changes neither re-parses nothing (M0-02-R13).
 */
export function packageModuleRoots(manifest: any, dir: string): { jest: RootDecl | null; nodePath: RootDecl | null } {
  if (!manifest || typeof manifest !== 'object') return { jest: null, nodePath: null };
  return {
    jest: manifest.jest && typeof manifest.jest === 'object' ? jestModuleRoots(manifest.jest, dir) : null,
    nodePath: nodePathRoots(manifest.scripts, dir),
  };
}

/** The entry of a roots list that stands for `node_modules`: what comes before it is searched first. */
const NODE_MODULES = Symbol('node_modules');
type RootEntry = ModuleRoot | typeof NODE_MODULES;

function splitEntries(entries: RootEntry[]): { early: ModuleRoot[]; late: ModuleRoot[] } {
  const at = entries.indexOf(NODE_MODULES);
  const roots = (list: RootEntry[]) => list.filter((e): e is ModuleRoot => e !== NODE_MODULES);
  return at < 0 ? { early: roots(entries), late: [] } : { early: roots(entries.slice(0, at)), late: roots(entries.slice(at + 1)) };
}

/** A folder name in a modules list: a path under the config's folder is a fixed root, a bare name is searched in every ancestor. */
function nameRoot(name: string): RootEntry | null {
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name) || name.includes('\\')) return null;
  const n = norm(name);
  if (n === null) return null;
  return n === 'node_modules' ? NODE_MODULES : { dir: n, walk: true };
}

/** `__dirname` (and its relatives) alone, or a `path.resolve` / `path.join` of literals, as a workspace-relative folder. */
function folderExpression(value: string, dir: string): RootEntry | null {
  const v = value.trim();
  const base = /^(?:__dirname|process\s*\.\s*cwd\s*\(\s*\)|import\s*\.\s*meta\s*\.\s*dirname)$/.test(v) ? dir : aliasPath(v, dir);
  if (base === null) return null;
  return /(?:^|\/)node_modules$/.test(base) ? NODE_MODULES : { dir: base, walk: false };
}

/**
 * The key an object literal at `index` is the value of (`externals` in `externals: { resolve: … }`),
 * or null when the object stands alone (`module.exports = {`, an array element, a returned object).
 * Works on masked code.
 */
function enclosingKey(masked: string, index: number): string | null {
  const open: number[] = [];
  for (let i = 0; i < index; i++) {
    if (masked[i] === '{') open.push(i);
    else if (masked[i] === '}') open.pop();
  }
  const start = open[open.length - 1];
  if (start === undefined) return null;
  return /([\w$]+)\s*:\s*$/.exec(masked.slice(Math.max(0, start - 80), start))?.[1] ?? null;
}

/** Whether the bracket closing at `close` ends the whole value: no `.concat(…)`, `+ […]` or `[0]` follows. */
function listEndsHere(masked: string, close: number): boolean {
  const next = /^\s*(.)/.exec(masked.slice(close + 1))?.[1];
  return next === undefined || next === ',' || next === '}' || next === ';' || next === ')' || next === ']';
}

/**
 * The `resolve.modules` entries of a webpack-family config: literals, `path.resolve(__dirname, …)`,
 * `__dirname`. An element that is not readable (a variable, a call, a spread) stands for what it may
 * hold, `node_modules` among it: roots after it are searched after `node_modules`. A `resolve` object
 * that is the value of another key (`externals: { resolve: … }`) is not webpack's.
 */
function webpackModuleRoots(text: string, dir: string): RootDecl {
  if (!/\bmodules\b/.test(text)) return emptyDecl(dir);
  const masked = maskCode(text);
  const elements = (open: number, close: number): RootEntry[] => {
    const out: RootEntry[] = [];
    for (const part of splitTopLevel(masked, open + 1, close)) {
      const source = text.slice(part.start, part.end);
      const name = literal(source);
      out.push((name !== null ? nameRoot(name) : folderExpression(source, dir)) ?? NODE_MODULES);
    }
    return out;
  };
  let base: RootEntry[] | null = null;
  const front: RootEntry[] = [];
  const back: RootEntry[] = [];
  // resolve: { modules: [ … ] }
  for (const m of masked.matchAll(/\bresolve\s*:\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(masked, open);
    const key = enclosingKey(masked, m.index!);
    if (close < 0 || (key !== null && key !== 'configureWebpack' && key !== 'configure')) continue;
    for (const part of splitTopLevel(masked, open + 1, close)) {
      const field = /^\s*modules\s*:\s*\[/.exec(masked.slice(part.start, part.end));
      if (!field) continue;
      const bracket = part.start + field[0].length - 1;
      const end = matchBracket(masked, bracket);
      if (end > 0 && listEndsHere(masked, end)) base = [...(base ?? []), ...elements(bracket, end)];
    }
  }
  // config.resolve.modules = [ … ]
  for (const m of masked.matchAll(/\bresolve\s*\.\s*modules\s*=\s*\[/g)) {
    const bracket = m.index! + m[0].length - 1;
    const end = matchBracket(masked, bracket);
    if (end > 0 && listEndsHere(masked, end)) base = [...(base ?? []), ...elements(bracket, end)];
  }
  // config.resolve.modules.push(…) / .unshift(…): around webpack's default ['node_modules'].
  for (const m of masked.matchAll(/\bresolve\s*\.\s*modules\s*\.\s*(push|unshift)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    (m[1] === 'push' ? back : front).push(...elements(open, close));
  }
  if (base === null && !front.length && !back.length) return emptyDecl(dir);
  return { scope: dir, ...splitEntries([...front, ...(base ?? [NODE_MODULES]), ...back]) };
}

/**
 * Jest's module resolution roots: `moduleDirectories` (names searched in every ancestor, like
 * `node_modules`; an entry with `<rootDir>` is one fixed folder) and `modulePaths` (fixed folders,
 * searched after them). `config` is a parsed object (package.json `jest`, jest.config.json) or the
 * source text of a jest.config.{js,ts,…}, where the literal top-level values are read (not those of
 * `globals`, say). An element that is not a literal (a spread of the defaults, a variable) stands for
 * what it may hold, `node_modules` among it. A config with `projects` declares its options per
 * project, which are not followed, and one MapX cannot read declares none. The roots apply to the
 * files under `rootDir`.
 */
function jestModuleRoots(config: unknown, dir: string): RootDecl {
  let directories: Array<string | null> | undefined;
  let paths: Array<string | null> | undefined;
  let rootDirValue: string | RootEntry | null = '';
  if (typeof config === 'string') {
    if (!/\bmoduleDirectories\b|\bmodulePaths\b/.test(config) || /\bprojects\s*:/.test(config)) return emptyDecl(dir);
    const masked = maskCode(config);
    // The one top-level occurrence of the key (not `globals: { moduleDirectories: … }`, and not a file that
    // sets it in two objects: which one is exported is not known).
    const find = (key: string) => {
      const found = [...masked.matchAll(new RegExp(`\\b${key}\\s*:`, 'g'))].filter((m) => enclosingKey(masked, m.index!) === null);
      return found.length === 1 ? found[0] : undefined;
    };
    const list = (key: string): Array<string | null> | undefined => {
      const m = find(key);
      if (!m) return undefined;
      const open = masked.indexOf('[', m.index! + m[0].length);
      if (open < 0 || masked.slice(m.index! + m[0].length, open).trim() !== '') return undefined;
      const close = matchBracket(masked, open);
      if (close < 0 || !listEndsHere(masked, close)) return undefined;
      return splitTopLevel(masked, open + 1, close).map((p) => literal(config.slice(p.start, p.end)));
    };
    directories = list('moduleDirectories');
    paths = list('modulePaths');
    const rd = find('rootDir');
    if (rd) {
      const start = rd.index! + rd[0].length;
      const end = splitTopLevel(masked, start, masked.length)[0]?.end ?? start;
      const value = config.slice(start, end).trim();
      const name = literal(value);
      rootDirValue = name !== null ? name : folderExpression(value, dir);
      if (rootDirValue === null) return emptyDecl(dir);
    }
  } else if (config && typeof config === 'object') {
    const c = config as Record<string, unknown>;
    if (c['projects'] !== undefined) return emptyDecl(dir);
    const strings = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : null)) : undefined);
    directories = strings(c['moduleDirectories']);
    paths = strings(c['modulePaths']);
    if (typeof c['rootDir'] === 'string') rootDirValue = c['rootDir'];
    else if (c['rootDir'] !== undefined) return emptyDecl(dir);
  } else return emptyDecl(dir);
  // The folder <rootDir> stands for, relative to the config's folder unless absolute.
  const rootDir = typeof rootDirValue === 'string' ? (rootDirValue.startsWith('/') ? null : join(dir, rootDirValue)) : rootDirValue && rootDirValue !== NODE_MODULES ? rootDirValue.dir : null;
  if (rootDir === null) return emptyDecl(dir);
  const fixed = (entry: string): ModuleRoot | null => {
    const path = entry.startsWith('<rootDir>') ? entry.slice('<rootDir>'.length) : entry;
    if (!entry.startsWith('<rootDir>') && entry.startsWith('/')) return null;
    if (path.includes('<') || path.includes('\\')) return null;
    const folder = join(rootDir, path);
    return folder === null ? null : { dir: folder, walk: false };
  };
  const entries: RootEntry[] = [];
  for (const name of directories ?? []) {
    if (name === null || name === 'node_modules') entries.push(NODE_MODULES);
    else if (name.startsWith('<rootDir>')) { const root = fixed(name); if (root) entries.push(root); }
    else { const root = nameRoot(name); if (root) entries.push(root); }
  }
  // Without 'node_modules' among them, jest does not search it at all: those roots come first.
  const { early, late } = splitEntries(entries);
  for (const name of paths ?? []) { const root = name === null ? null : fixed(name); if (root) late.push(root); }
  // The roots are searched below the rootDir only; a folder name is walked within it.
  return { scope: rootDir, early, late };
}

/**
 * `NODE_PATH=src:lib` set in a package.json script (`NODE_PATH=. node main.js`, `cross-env
 * NODE_PATH=src jest`, `export NODE_PATH=…`): folders relative to the package, searched after
 * `node_modules`. Entries with a variable or absolute path are skipped. The whole package is
 * governed, though a `cd sub && NODE_PATH=. …` script means `sub`.
 */
function nodePathRoots(scripts: unknown, dir: string): RootDecl | null {
  if (!scripts || typeof scripts !== 'object') return null;
  const late: ModuleRoot[] = [];
  for (const script of Object.values(scripts as Record<string, unknown>)) {
    if (typeof script !== 'string') continue;
    for (const m of script.matchAll(/(?:^|[\s;&|(])NODE_PATH=(?:"([^"]*)"|'([^']*)'|([^\s;&|]*))/g)) {
      const parts = (m[1] ?? m[2] ?? m[3] ?? '').split(':');
      for (let i = 0; i < parts.length; i++) {
        // A Windows drive (`C:\lib`) is not two entries.
        if (/^[A-Za-z]$/.test(parts[i]!) && /^[\\/]/.test(parts[i + 1] ?? '')) { i++; continue; }
        const entry = parts[i]!.replace(/^(?:\$PWD|\$\{PWD\}|\$\(pwd\))\/?/, './');
        if (!entry || /[$`~\\]/.test(entry) || entry.startsWith('/')) continue;
        const folder = join(dir, entry);
        if (folder !== null && !late.some((r) => r.dir === folder)) late.push({ dir: folder, walk: false });
      }
    }
  }
  return late.length ? { scope: dir, early: [], late } : null;
}
