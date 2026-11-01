import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';
import { moduleNavigationReferences, navigationReferences } from '../src/parsers/languages/vue-navigation.js';
import { jsAliasTargets } from '../src/core/js-aliases.js';
import { getParserForFile } from '../src/parsers/parser-registry.js';

// M0-17-R6: heuristic follow-ups from the 2026-11-01 reviews (docs/baton/iterations/M0-17-R6.md).

describe('a rename whose old name survives as text (M0-02-R8 reviewer O P2-3)', () => {
  let root: string;
  beforeEach(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'src/a.ts': 'export function save() { return 1; }\n',
      // No import: name lookup links the call (an importer is re-parsed through M2-08 anyway).
      'src/b.js': 'function go() { return save(); }\nmodule.exports = { go };\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const calls = () => query<{ e: string }>(root, `SELECT source_file || '#' || COALESCE(source_symbol, '') || ' -> ' || target_file || '#' || target_symbol AS e
    FROM edges WHERE edge_type = 'call' ORDER BY 1`).map((r) => r.e);

  it('drops the callers\' edges on sync when the old name is only in a comment or a string', () => {
    expect(calls()).toEqual(['src/b.js#go -> src/a.ts#save']);
    writeFileSync(join(root, 'src/a.ts'), "// was save(); renamed\nexport function store() { return 'save'; }\n");
    mapx(root, 'sync', '.');
    const synced = calls();
    mapx(root, 'scan', '.', '--force');
    expect(synced).toEqual(calls());
    expect(synced).not.toContain('src/b.js#go -> src/a.ts#save');
  }, 120000);
});

describe('Vue Router shadowing and guard returns (M3-11-R1 reviewer O P2-5/P2-6)', () => {
  const targets = (refs: { metadata?: Record<string, unknown> }[]) =>
    refs.map((r) => JSON.stringify((r.metadata as { navigate: unknown }).navigate)).sort();

  it('reads no navigation from a next or push rebound by a parameter or a local', () => {
    const guards = `import router from './index';
router.beforeEach((to, from, next) => {
  const steps = [() => 1];
  steps.forEach((next) => next({ name: 'notARoute' }));
  function local() { const next = (x) => x; return next({ name: 'alsoNot' }); }
  next({ name: 'login' });
});
`;
    expect(targets(moduleNavigationReferences(guards, []))).toEqual(['{"name":"login"}']);
    const store = `import { useRouter } from 'vue-router';
const { push } = useRouter();
export function go() { push({ name: 'home' }); }
export function collect(push) { push({ name: 'notARoute' }); }
export function other() { const push = (x) => x; push('/nope'); }
`;
    expect(targets(moduleNavigationReferences(store, []))).toEqual(['{"name":"home"}']);
  });

  it('keeps navigation when the name is no parameter binding, and scopes a for-header declaration to the loop (review 2026-11-01)', () => {
    const store = `import { useRouter } from 'vue-router';
const { push } = useRouter();
export function a({ push: p }) { push('/a'); }
export function b(cb = push) { push('/b'); }
export function c(x: typeof push) { push('/c'); }
`;
    expect(targets(moduleNavigationReferences(store, []))).toEqual(['{"path":"/a"}', '{"path":"/b"}', '{"path":"/c"}']);
    const guards = `import router from './index';
router.beforeEach((to, from, next) => {
  for (const next of [1]) { next; }
  next({ name: 'login' });
});
`;
    expect(targets(moduleNavigationReferences(guards, []))).toEqual(['{"name":"login"}']);
  });

  it('keeps a guard\'s own return after a ternary in code without semicolons (review 2026-11-01)', () => {
    const guards = "import router from './index'\nrouter.beforeEach((to) => {\n  to.meta.ok ? a() : b(to)\n  try {\n    return { name: 'login' }\n  } catch (e) {}\n})\n";
    expect(targets(moduleNavigationReferences(guards, []))).toEqual(['{"name":"login"}']);
  });

  it('reads no navigation from a template push bound by v-for or v-slot', () => {
    const sfc = `<script setup>
import { useRouter } from 'vue-router';
const { push } = useRouter();
</script>
<template>
  <button @click="push({ name: 'home' })">home</button>
  <li v-for="push in handlers" @click="push({ name: 'notARoute' })" />
  <Comp v-slot="{ push }"><a @click="push('/nope')" /></Comp>
</template>
`;
    expect(targets(navigationReferences(sfc))).toEqual(['{"name":"home"}']);
  });

  it('never counts the return of a nested function with an object, literal-union or function return type as the guard\'s', () => {
    const guards = `import router from './index';
router.beforeEach((to) => {
  function crumb(): { name: string } { return { name: 'crumbs' }; }
  function kind(): 'a' | 'b' { return 'a'; }
  function make(): () => void { return () => {}; }
  const nested = (): Array<{ name: string }> => { return [{ name: 'list' }]; };
  if (!to.meta.ok) return { name: 'login' };
});
`;
    expect(targets(moduleNavigationReferences(guards, []))).toEqual(['{"name":"login"}']);
  });
});

describe('a Laravel module\'s own @/ (D017 limitation)', () => {
  it('takes the root Laravel app\'s @ when the module\'s bundler config declares none', () => {
    const files: Record<string, string> = {
      artisan: '#!/usr/bin/env php\n<?php\n',
      'package.json': JSON.stringify({ name: 'laravel', devDependencies: { vite: '^5.0.0', 'laravel-vite-plugin': '^1.0.0' } }),
      'vite.config.js': "import { defineConfig } from 'vite';\nexport default defineConfig({ resolve: { alias: { '@': '/resources/js' } } });\n",
      'resources/js/utils/money.js': 'export const x = 1;\n',
      'Modules/Blog/package.json': JSON.stringify({ name: 'blog', devDependencies: { vite: '^5.0.0' } }),
      'Modules/Blog/vite.config.js': "import { defineConfig } from 'vite';\nexport default defineConfig({ build: { outDir: '../../public/build-blog' } });\n",
      'Modules/Blog/resources/assets/js/app.js': "import { x } from '@/utils/money';\n",
    };
    const ctx = { files: new Set(Object.keys(files)), readText: (p: string) => files[p] ?? null };
    expect(jsAliasTargets('@/utils/money', 'Modules/Blog/resources/assets/js/app.js', ctx as never)).toContain('resources/js/utils/money');
    // A Modules/ folder of an app that is no Laravel app (no artisan) keeps its own resolution.
    const plain = { files: new Set(Object.keys(files).filter((f) => f !== 'artisan')), readText: (p: string) => (p === 'artisan' ? null : files[p] ?? null) };
    expect(jsAliasTargets('@/utils/money', 'Modules/Blog/resources/assets/js/app.js', plain as never)).not.toContain('resources/js/utils/money');
  });
});

describe('factory bindings are functions only when exported or called (M0-17-R5 reviewer L P2-11)', () => {
  const kinds = async (file: string, src: string) =>
    Object.fromEntries((await getParserForFile(file).parse(file, src)).symbols.filter((s) => !s.scope).map((s) => [s.name, s.kind]));

  it('keeps a local binding to a call a value, and an exported or called one a function', async () => {
    const k = await kinds('src/main.ts', `import { createApp } from 'vue';
import { createAsyncThunk } from '@reduxjs/toolkit';
import App from './App.vue';
const app = createApp(App);
app.mount('#app');
export const fetchUser = createAsyncThunk('user/fetch', async () => 1);
const handler = makeHandler();
handler();
const config = loadConfig();
module.exports = { config };
`);
    expect(['constant', 'variable']).toContain(k.app);
    expect(k.fetchUser).toBe('function');
    expect(k.handler).toBe('function');
    expect(k.config).toBe('function');
  });

  it('counts export default, export = and exports.default as exports (review 2026-11-01)', async () => {
    expect((await kinds('src/store.ts', "const useStore = create(() => ({}));\nexport default useStore;\n")).useStore).toBe('function');
    expect((await kinds('src/tool.ts', 'const tool = make();\nexport = tool;\n')).tool).toBe('function');
    expect((await kinds('src/cjs.js', 'const run = make();\nexports.default = run;\n')).run).toBe('function');
    expect((await kinds('src/opt.ts', 'const maybe = make();\nmaybe?.();\n')).maybe).toBe('function');
  });

  it('in Python, keeps a private binding a value unless the module calls it', async () => {
    const k = await kinds('pkg/mod.py', 'import functools\n_cache = make_cache()\n_run = functools.partial(print, 1)\n_run()\nhandler = functools.partial(print, 2)\n');
    expect(['constant', 'variable']).toContain(k._cache);
    expect(k._run).toBe('function');
    expect(k.handler).toBe('function');
  });
});
