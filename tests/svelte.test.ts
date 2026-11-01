import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-12-R8: a .svelte file's <script> blocks go through the JS/TS parsers, as a .vue file's do,
// so its symbols and references are those of a .ts module holding the same code.
const MODULE_SCRIPT = `  import { loadUser } from '$lib/api';
  export const PAGE_SIZE = 20;
  export function preload(id: number) {
    return loadUser(id);
  }
`;
const INSTANCE_SCRIPT = `  import { formatName } from './lib/format';
  import Child from './Child.svelte';
  export let title: string;
  export let count = 0;
  const MAX = 5;
  class Ticker {
    tick() { return new Date(); }
  }
  function label() {
    fetch('/api/user');
    return formatName(title);
  }
`;

// Both parse paths: worker threads (the default for more than 10 files) and the main thread.
describe.each([['workers', []], ['main thread', ['--no-parallel']]])('Svelte script blocks (M0-12-R8), %s', (label, flags) => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'svelte-app', devDependencies: { svelte: '^4.0.0', vite: '^5.0.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '$lib/*': ['./src/lib/*'] } } }),
      'src/lib/api.ts': 'export function loadUser(id: number) {\n  return id;\n}\n',
      'src/lib/format.ts': 'export function formatName(name: string) {\n  return name.trim();\n}\n',
      'src/lib/widget.ts': 'export class Widget {}\n',
      // Project symbols named like JS globals: `new Date()` and `fetch()` must not link to them.
      'src/Date.ts': 'export class Date {}\n',
      'src/fetch.ts': 'export function fetch(url: string) {\n  return url;\n}\n',
      'src/Counter.svelte':
        `<script context="module" lang="ts">\n${MODULE_SCRIPT}</script>\n\n<script lang="ts">\n${INSTANCE_SCRIPT}</script>\n\n<h1>{label()}</h1>\n<Child />\n`,
      // A commented-out <script> is not read.
      'src/Child.svelte': "<!-- <script>import { loadUser } from './lib/api';</script> -->\n<script>\n  export let x = 1;\n</script>\n<p>{x}</p>\n",
      // `lang="typescript"`, and a prop whose default is a function (a function symbol in a .ts module).
      'src/Badge.svelte': "<script lang=\"typescript\">\n  import { formatName } from '$lib/format';\n  export let onPick = (n: string) => formatName(n);\n</script>\n",
      // Plain JS (no lang) and Svelte 5's `<script module>`.
      'src/Plain.svelte': "<script module>\n  import { Widget } from './lib/widget';\n  export const shared = new Widget();\n</script>\n<p>plain</p>\n",
      // Unimported calls named like value bindings of Counter.svelte and twin.ts.
      'src/caller.ts': 'export function use() {\n  MAX();\n  title();\n}\n',
      // The same code as Counter.svelte's scripts in a .ts module, the reference behaviour.
      'src/twin.ts': MODULE_SCRIPT + INSTANCE_SCRIPT,
    }, ['.']);
    init(root);
    mapx(root, 'scan', root, ...(flags as string[]));
  }, 120000);
  afterAll(() => cleanup(root));

  const symbols = (file: string) =>
    query<{ name: string; kind: string; start_line: number; end_line: number }>(
      root, 'SELECT name, kind, start_line, end_line FROM symbols WHERE file_path = ? ORDER BY start_line, name', file);
  const edges = (file: string) =>
    query<{ target_file: string; target_symbol: string | null; edge_type: string; source_symbol: string | null }>(
      root, 'SELECT DISTINCT target_file, target_symbol, edge_type, source_symbol FROM edges WHERE source_file = ? ORDER BY target_file, edge_type, target_symbol', file);

  it('gives the functions, classes, constants and export-let props of both script blocks, at their .svelte lines', () => {
    // The scanner uses workers for more than 10 files.
    if (label === 'workers') expect(query<{ n: number }>(root, 'SELECT count(*) AS n FROM files')[0]!.n).toBeGreaterThan(10);
    expect(symbols('src/Counter.svelte')).toEqual([
      { name: 'Counter', kind: 'class', start_line: 1, end_line: 25 },
      { name: 'PAGE_SIZE', kind: 'constant', start_line: 3, end_line: 3 },
      { name: 'preload', kind: 'function', start_line: 4, end_line: 6 },
      { name: 'title', kind: 'variable', start_line: 12, end_line: 12 },
      { name: 'count', kind: 'variable', start_line: 13, end_line: 13 },
      { name: 'MAX', kind: 'constant', start_line: 14, end_line: 14 },
      { name: 'Ticker', kind: 'class', start_line: 15, end_line: 17 },
      { name: 'tick', kind: 'method', start_line: 16, end_line: 16 },
      { name: 'label', kind: 'function', start_line: 18, end_line: 21 },
    ]);
    // Props keep the kind of a .ts binding and are flagged; the component lists them, as a .vue one does.
    const meta = (file: string, name: string) => JSON.parse(query<{ metadata: string }>(
      root, 'SELECT metadata FROM symbols WHERE file_path = ? AND name = ?', file, name)[0]!.metadata);
    expect(meta('src/Counter.svelte', 'Counter').props).toEqual(['title', 'count']);
    expect(meta('src/Counter.svelte', 'title').prop).toBe(true);
    expect(meta('src/Counter.svelte', 'MAX').prop).toBeUndefined();
    expect(symbols('src/Child.svelte').map((s) => `${s.kind} ${s.name} ${s.start_line}`)).toEqual(['class Child 1', 'variable x 3']);
    expect(edges('src/Child.svelte')).toEqual([]);
    expect(meta('src/Child.svelte', 'Child').props).toEqual(['x']);
    expect(symbols('src/Badge.svelte').map((s) => `${s.kind} ${s.name} ${s.start_line}`)).toEqual(['class Badge 1', 'function onPick 3']);
    expect(meta('src/Badge.svelte', 'onPick').prop).toBe(true);
  });

  it('links relative and aliased imports and calls, owned by the enclosing function, else the component', () => {
    expect(edges('src/Counter.svelte')).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_file: 'src/lib/api.ts', edge_type: 'import', source_symbol: 'Counter' }),
      expect.objectContaining({ target_file: 'src/lib/api.ts', target_symbol: 'loadUser', edge_type: 'call', source_symbol: 'preload' }),
      expect.objectContaining({ target_file: 'src/lib/format.ts', edge_type: 'import' }),
      expect.objectContaining({ target_file: 'src/lib/format.ts', target_symbol: 'formatName', edge_type: 'call', source_symbol: 'label' }),
      expect.objectContaining({ target_file: 'src/Child.svelte', edge_type: 'import' }),
    ]));
  });

  it('links an instantiation from a plain-JS <script module> block', () => {
    expect(edges('src/Plain.svelte')).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_file: 'src/lib/widget.ts', target_symbol: 'Widget', edge_type: 'instantiation' }),
    ]));
  });

  it('gives new Date() and fetch() no edge to the same-named project symbols, while the project call links', () => {
    const targets = edges('src/Counter.svelte').map((e) => e.target_file);
    expect(targets).toContain('src/lib/format.ts');
    expect(targets).not.toContain('src/Date.ts');
    expect(targets).not.toContain('src/fetch.ts');
  });

  it('gives an unimported call elsewhere no edge to a Svelte value binding, as to a .ts one', () => {
    expect(edges('src/caller.ts')).toEqual([]);
  });

  it('gives the same edge targets as a .ts module holding the same code', () => {
    // The scripts' edges; the template's render edges are M0-12-R10's.
    const targets = (file: string) =>
      [...new Set(edges(file).filter((e) => e.target_file !== file && e.edge_type !== 'render').map((e) => `${e.edge_type} ${e.target_file} ${e.target_symbol ?? ''}`))].sort();
    expect(targets('src/twin.ts').length).toBeGreaterThan(0);
    expect(targets('src/Counter.svelte')).toEqual(targets('src/twin.ts'));
    expect(edges('src/Counter.svelte').filter((e) => e.edge_type === 'render').map((e) => e.target_file)).toEqual(['src/Child.svelte']);
  });
});

// SvelteKit's `$lib` is a tsconfig `paths` entry of the generated `.svelte-kit/tsconfig.json`,
// which the app's tsconfig extends; it resolves while that file is on disk (gitignored or not).
describe('SvelteKit $lib through the generated tsconfig (M0-12-R8)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'kit-app', devDependencies: { '@sveltejs/kit': '^2.0.0', vite: '^5.0.0' } }),
      '.gitignore': '.svelte-kit\n',
      'tsconfig.json': JSON.stringify({ extends: './.svelte-kit/tsconfig.json' }),
      '.svelte-kit/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { $lib: ['../src/lib'], '$lib/*': ['../src/lib/*'] } } }),
      'src/lib/util.ts': 'export function hello() {\n  return 1;\n}\n',
      'src/routes/+page.svelte': "<script lang=\"ts\">\n  import { hello } from '$lib/util';\n  const x = hello();\n</script>\n",
    }, ['.']);
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('links a $lib import and call from a route component', () => {
    expect(query(root, "SELECT DISTINCT target_file, target_symbol, edge_type FROM edges WHERE source_file = 'src/routes/+page.svelte' AND target_file = 'src/lib/util.ts' ORDER BY edge_type"))
      .toEqual([
        { target_file: 'src/lib/util.ts', target_symbol: 'hello', edge_type: 'call' },
        { target_file: 'src/lib/util.ts', target_symbol: '$lib/util', edge_type: 'import' },
      ]);
  });
});

// Review 2026-11-01 (M0-12-R8): script discovery and Svelte-specific bindings.
describe('Svelte script discovery and bindings (review)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'svelte-app', devDependencies: { svelte: '^5.0.0', vite: '^5.0.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '$lib/*': ['./src/lib/*'] } } }),
      'src/lib/api.ts': 'export function loadUser(id: number) {\n  return id;\n}\n',
      // A generics attribute holding `>`: still the TS parser, so the typed import resolves.
      'src/List.svelte': '<script generics="T extends Array<string>" lang="ts">\n  import { loadUser } from \'$lib/api\';\n  export function first(items: T): number { return loadUser(items.length); }\n</script>\n',
      // <script> text inside a template expression is text, not a script.
      'src/Html.svelte': '<script>\n  export let show = true;\n</script>\n{#if show}\n  {@html "<script>function injected() { loadUser(1) }</script>"}\n{/if}\n',
      // A "<!--" string inside a script does not start an HTML comment.
      'src/Editor.svelte': "<script>\n  import { loadUser } from './lib/api';\n  const open = '<!--';\n  export function load() { return loadUser(open.length); }\n</script>\n<p>x</p> <!-- note -->\n",
      // A module script's export let is no prop; runes are values, never call targets.
      'src/Mod.svelte': '<script context="module">\n  export let shared = 1;\n</script>\n<script>\n  export let own = 2;\n  let count = $state(0);\n  const total = $derived(count * 2);\n</script>\n',
      'src/stats.ts': 'export function use() {\n  return total() + count();\n}\n',
      // A stylesheet with a lone quote and a template regex before the script, and a head script.
      'src/Styled.svelte': "<style>\n  /* don't */\n  p { color: red; }\n</style>\n<p>{text.replace(/'/g, '')}</p>\n<svelte:head>\n  <script>function gtag() {}</script>\n</svelte:head>\n<script>\n  export let text = '';\n  export function shout() { return text; }\n</script>\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));
  const symbols = (file: string) => query<{ name: string; kind: string }>(root, 'SELECT name, kind FROM symbols WHERE file_path = ? ORDER BY start_line, name', file);
  const edges = (file: string) => query<{ e: string }>(root, "SELECT edge_type || ' ' || target_file AS e FROM edges WHERE source_file = ? ORDER BY e", file).map((r) => r.e);

  it('reads a script whose generics attribute holds `>` with the TS parser', () => {
    expect(edges('src/List.svelte')).toEqual(['call src/lib/api.ts', 'import src/lib/api.ts']);
  });

  it('ignores <script> text inside a template expression', () => {
    expect(symbols('src/Html.svelte').map((s) => s.name)).toEqual(['Html', 'show']);
    expect(edges('src/Html.svelte')).toEqual([]);
  });

  it('reads a script holding a "<!--" string', () => {
    expect(symbols('src/Editor.svelte').map((s) => s.name)).toEqual(['Editor', 'open', 'load']);
    expect(edges('src/Editor.svelte')).toEqual(['call src/lib/api.ts', 'import src/lib/api.ts']);
  });

  it('finds the script after a stylesheet and a template regex holding a lone quote, and not a head script', () => {
    expect(symbols('src/Styled.svelte').map((s) => s.name)).toEqual(['Styled', 'text', 'shout']);
  });

  it('lists only instance-script export lets as props, and keeps runes out of call targets', () => {
    const component = query<{ metadata: string }>(root, "SELECT metadata FROM symbols WHERE file_path = 'src/Mod.svelte' AND name = 'Mod'")[0]!;
    expect(JSON.parse(component.metadata).props).toEqual(['own']);
    // Values, never call targets (a const rune stays a constant since M0-17-R6 narrowed the promotion).
    for (const s of symbols('src/Mod.svelte').filter((s) => ['count', 'total'].includes(s.name))) expect(['variable', 'constant']).toContain(s.kind);
    expect(edges('src/stats.ts')).toEqual([]);
  });
});

describe('Svelte templates: calls, event handlers and child components (M0-12-R10)', () => {
  let root: string;
  type E = { source_symbol: string | null; target_file: string; target_symbol: string; edge_type: string };
  let edges: E[];
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', devDependencies: { svelte: '^4.2.0' } }),
      'src/lib/format.ts': 'export function format(x: number) { return String(x); }\nexport function save() { return 0; }\n',
      'src/lib/ui/index.js': "export { default as Button } from './Button.svelte';\n",
      'src/lib/ui/Button.svelte': '<button><slot /></button>\n',
      'src/routes/Child.svelte': '<p>child</p>\n',
      // Decoys a name lookup would find.
      'src/routes/Other.svelte': '<script>\n  function remove() {}\n  function helper() {}\n</script>\n',
      'src/routes/Page.svelte': `<script>
  import { format } from '../lib/format';
  import Child from './Child.svelte';
  import * as ui from '../lib/ui/index.js';
  let items = [];
  function save() {}
  function remove(id) {}
  function item() {}
  // Declared here: a read {@html helper()} would link it.
  function helper() {}
</script>

<!-- {remove()} in a comment -->
<p>{format(1)}</p>
<button on:click={save}>s</button>
<button onclick={() => remove(1)}>r</button>
{#each items as item}{item.name}{item()}{/each}
<Child />
<ui.Button />
{@html helper()}

<style>.a { color: red; } /* {remove()} */</style>
`,
    });
    init(root);
    mapx(root, 'scan', '.');
    edges = query<E>(root, `SELECT source_symbol, target_file, target_symbol, edge_type FROM edges
      WHERE source_file = 'src/routes/Page.svelte' AND edge_type IN ('call', 'render') ORDER BY 4, 2, 3`);
  }, 120000);
  afterAll(() => cleanup(root));

  const calls = () => edges.filter((e) => e.edge_type === 'call').map((e) => `${e.source_symbol} -> ${e.target_file}#${e.target_symbol}`);

  it('gives template calls and handlers edges to the component\'s own or imported functions, owned by the component', () => {
    expect(calls()).toEqual([
      'Page -> src/lib/format.ts#format',
      'Page -> src/routes/Page.svelte#remove',
      'Page -> src/routes/Page.svelte#save',
    ]);
  });

  it('never resolves an each-block alias, and ignores {@html}, comments and <style>', () => {
    expect(calls().some((c) => c.endsWith('#item') || c.endsWith('#helper'))).toBe(false);
    expect(edges.some((e) => e.target_file === 'src/routes/Other.svelte')).toBe(false);
  });

  it('gives render edges to imported components, also through a namespace import and a barrel', () => {
    expect(edges.filter((e) => e.edge_type === 'render').map((e) => `${e.target_file}#${e.target_symbol}`)).toEqual([
      'src/lib/ui/Button.svelte#Button',
      'src/routes/Child.svelte#Child',
    ]);
  });
});

describe('Svelte templates: review cases (M0-12-R10, review 2026-11-01)', () => {
  let root: string;
  type E = { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string; edge_type: string };
  let edges: E[];
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', devDependencies: { svelte: '^5.0.0', vue: '^3.4.0' } }),
      'src/lib/render.ts': 'export function render(x: number) { return x; }\nexport function key(x: number) { return x; }\nexport function fade() { return {}; }\n',
      'src/lib/ui/index.js': "export { default as PrimaryButton } from './Button.svelte';\n",
      'src/lib/ui/Button.svelte': '<button><slot /></button>\n',
      'src/routes/Card.svelte': '<div />\n',
      'src/routes/Page.svelte': `<script>
  import { render, key, fade } from '../lib/render';
  import { PrimaryButton } from '../lib/ui/index.js';
  import Card from './Card.svelte';
  let rows = [];
  let isOnline = true;
  function item() {}
  function helper() {}
  function isOnlineCheck() {}
</script>

<p>{'it\\'s'}</p>
{#each rows as item}{item()}{/each}
{@html helper()}
<p>Don't stop</p>
<p>{render(1)} {key(2)}</p>
<Status online={isOnline} />
<div transition:fade>x</div>
<svelte:component this={Card} />
<PrimaryButton />
`,
      // Vue: a component imported from a non-.vue barrel (the render branch follows the barrel).
      'src/vue/components/Foo.vue': '<template><i /></template>\n',
      'src/vue/components/index.ts': "export { default as Foo } from './Foo.vue';\n",
      'src/vue/App.vue': "<script setup>\nimport { Foo } from './components';\n</script>\n<template><Foo /></template>\n",
    });
    init(root);
    mapx(root, 'scan', '.');
    edges = query<E>(root, `SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges
      WHERE source_file IN ('src/routes/Page.svelte', 'src/vue/App.vue') AND edge_type IN ('call', 'render') ORDER BY 1, 5, 3, 4`);
  }, 120000);
  afterAll(() => cleanup(root));

  const from = (file: string, type: string) => edges.filter((e) => e.source_file === file && e.edge_type === type).map((e) => `${e.target_file}#${e.target_symbol}`);

  it('keeps reading the template after an escaped quote inside {…}', () => {
    const calls = from('src/routes/Page.svelte', 'call');
    expect(calls).not.toContain('src/routes/Page.svelte#item');
    expect(calls).not.toContain('src/routes/Page.svelte#helper');
    expect(from('src/routes/Page.svelte', 'render')).toEqual(expect.arrayContaining(['src/routes/Card.svelte#Card']));
  });

  it('links calls named like Svelte block words, and transition directives; a prop named on… is no handler', () => {
    expect(from('src/routes/Page.svelte', 'call')).toEqual(['src/lib/render.ts#fade', 'src/lib/render.ts#key', 'src/lib/render.ts#render']);
  });

  it('renders <svelte:component this={X}> and a component a barrel re-exports under a new name', () => {
    expect(from('src/routes/Page.svelte', 'render')).toEqual(['src/lib/ui/Button.svelte#Button', 'src/routes/Card.svelte#Card']);
  });

  it('renders a Vue component imported from a non-.vue barrel', () => {
    expect(from('src/vue/App.vue', 'render')).toEqual(['src/vue/components/Foo.vue#Foo']);
  });
});
