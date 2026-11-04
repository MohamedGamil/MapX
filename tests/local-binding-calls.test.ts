import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-25: a call through a local binding (a for-of / for-in variable, a destructured local, a catch
// parameter) is that binding's, never a same-named function in another file: a Vue SFC's
// `<script setup>` function or a plain script's (found by M5-18-R1 on MapX's own tests/fixtures).
type Edge = { source_symbol: string | null; edge_type: string; target_file: string; target_symbol: string };

function edgesFrom(root: string, file: string): string[] {
  return query<Edge>(root, `SELECT source_symbol, edge_type, target_file, target_symbol FROM edges
    WHERE source_file = ? AND target_file != source_file AND edge_type NOT IN ('import', 'require') ORDER BY 1, 2, 3, 4`, file)
    .map((e) => `${e.source_symbol} ${e.edge_type} ${e.target_file}#${e.target_symbol}`);
}

/** Every edge out of a file with its verifiability, for the cases that keep a by-name link marked inferred. */
function linksFrom(root: string, file: string): string[] {
  return query<Edge & { verifiability: string }>(root, `SELECT source_symbol, edge_type, target_file, target_symbol, verifiability FROM edges
    WHERE source_file = ? AND target_file != source_file AND edge_type NOT IN ('import', 'require') ORDER BY 1, 2, 3, 4`, file)
    .map((e) => `${e.source_symbol} ${e.edge_type} ${e.target_file}#${e.target_symbol} ${e.verifiability}`);
}

describe('calls through local bindings (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      // Same-named functions elsewhere that name lookup would pick.
      'other/Widget.vue': '<script setup lang="ts">\nfunction step(d: number) { return d; }\n</script>\n<template><div>{{ step(1) }}</div></template>\n',
      'public/legacy.js': 'function cb(x) { return x; }\nfunction handler(x) { return x; }\nfunction extra() {}\nfunction hoisted() {}\n',
      // The M5-18-R1 repro: a for-of variable called.
      'src/steps.ts': `const STEPS = [(n: string) => n];
export function run(name: string) {
  for (const step of STEPS) {
    const t = step(name);
    if (t) return t;
  }
  return name;
}
`,
      'src/loops.ts': `export function each(callbacks: Array<() => void>, table: Record<string, () => void>) {
  for (const cb of callbacks) cb();
  for (const handler in table) handler();
  for (let step of callbacks) step();
  for (const [name, cb] of Object.entries(table)) cb();
}
export function all(fns: Array<() => void>) {
  for (const { cb } of fns.map((f) => ({ cb: f }))) cb();
}
`,
      // Destructured from a literal, from a package and from a builtin: never a project symbol.
      'src/destructured.ts': `import { join } from 'node:path';
import * as lodash from 'lodash';
export function pick() {
  const { cb, handler: h } = { cb: () => 1, handler: () => 2 };
  const [step] = [() => 3];
  const { extra } = lodash.pick({}, []);
  const { cb: fromLoad } = require('lodash');
  const { handler: fromImport } = join('a');
  cb();
  h();
  step();
  extra();
  fromLoad();
  fromImport();
}
export function once(c: boolean) {
  if (c) { var hoisted = () => 1; }
  return hoisted();
}
`,
      // A destructuring from a parameter may name a project symbol: by name, inferred only.
      'src/param.ts': `export function pick(opts: { cb: () => void }) {
  const { cb } = opts;
  cb();
}
`,
      'src/cstyle.ts': `export function spin() {
  for (let handler = () => 1; ; ) { handler(); break; }
}
`,
      'src/caught.ts': `export function guarded(run: () => void) {
  try {
    run();
  } catch (cb) {
    cb();
  }
}
`,
      // The same names called for real: from a script, and from an SFC.
      'public/other-script.js': 'function again() { return cb(1) + handler(2); }\n',
      'src/Caller.vue': '<script setup lang="ts">\nfunction go() { return step(2); }\n</script>\n<template><div>{{ go() }}</div></template>\n',
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('a for-of variable called links no same-named function (the M5-18-R1 repro)', () => {
    expect(edgesFrom(root, 'src/steps.ts')).toEqual([]);
  });

  it('for-in, for-of with a pattern, and let loop variables link nothing', () => {
    expect(edgesFrom(root, 'src/loops.ts')).toEqual([]);
  });

  it('locals destructured from a literal, a package or a builtin link nothing, nor a hoisted var', () => {
    expect(edgesFrom(root, 'src/destructured.ts')).toEqual([]);
  });

  it('a C-style loop variable links nothing', () => {
    expect(edgesFrom(root, 'src/cstyle.ts')).toEqual([]);
  });

  it('a local destructured from a parameter links no verified edge', () => {
    expect(linksFrom(root, 'src/param.ts').filter((l) => l.endsWith(' verified'))).toEqual([]);
  });

  it('a catch parameter called links nothing', () => {
    expect(edgesFrom(root, 'src/caught.ts')).toEqual([]);
  });

  it('a real call from a script still links the script function', () => {
    expect(edgesFrom(root, 'public/other-script.js')).toEqual([
      'again call public/legacy.js#cb',
      'again call public/legacy.js#handler',
    ]);
  });

  it('a real call from an SFC still links the SFC function', () => {
    expect(edgesFrom(root, 'src/Caller.vue')).toEqual(['go call other/Widget.vue#step']);
  });
});

// M2-26: a name destructured from a call result (`const { Database } = load('bun:sqlite')`) is a local,
// never a same-named class or function elsewhere; one bound by an import or a require of a project
// module is that module's and still links.
describe('names destructured from a call result (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'other/Database.ts': 'export class Database {}\n',
      'other/ui.ts': 'export function render() { return 1; }\n',
      'other/make.ts': 'export function make() {\n  function build() { return 1; }\n  return { build };\n}\n',
      // The M5-18-R1 repro, and a function and an array destructured from a call.
      'src/store.ts': `import { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
export class Store {
  db: unknown;
  constructor(p: string) {
    const { Database } = load('bun:sqlite');
    this.db = new Database(p);
  }
}
export function paint() {
  const { render } = load('bun:test');
  const [Database] = load('node:worker_threads');
  new Database();
  return render();
}
`,
      // A call result given no package specifier may be a project's: by name, inferred only.
      'src/noarg.ts': `import { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
export function again() {
  const { render } = load();
  return render();
}
`,
      // Sources that may hold a project symbol keep their by-name link, marked inferred.
      'other/svc.ts': `export class UserService { findAll() { return []; } }
export function useStore() { return { reset() {} }; }
export class Builder { fromInst() { return 1; } }
export function mk() { return { o() {} }; }
export function autoFn() {}
`,
      'src/ctl.ts': `import { UserService, useStore, Builder } from '../other/svc';
export class Ctl {
  constructor(private userService: UserService) {}
  list() { const { findAll } = this.userService; return findAll(); }
}
export function pin() { const s = useStore(); const { reset } = s; reset(); }
function localMake() { function inner() {} return { inner }; }
export function sameFile() { const { inner } = localMake(); inner(); }
export function auto() { const { autoFn } = useAuto(); autoFn(); }
export function inst() { const { fromInst } = new Builder(); fromInst(); }
const m = require('../other/svc').mk;
export function viaReq() { const { o } = m(); o(); }
`,
      // A module-level destructuring is a local binding of the whole file.
      'src/shared.ts': `declare function acquire(name: string): any;
const { render } = acquire('node:fs');
export function again() { return render(); }
`,
      // The same names bound by an import or a require of a project module: they link.
      'src/imported.ts': `import { Database } from '../other/Database';
import { render } from '../other/ui';
export function open() { new Database(); return render(); }
`,
      // A value reached through an imported name (a composable's inner function) keeps its by-name link.
      'src/composed.ts': `import { make } from '../other/make';
export function go() {
  const { build } = make();
  return build();
}
`,
      'src/required.js': `function open() {
  const { Database } = require('../other/Database');
  const { render } = require('../other/ui');
  new Database();
  return render();
}
module.exports = { open };
`,
      'src/dynamic.ts': `export async function open() {
  const { Database } = await import('../other/Database');
  const { render } = await import('../other/ui');
  new Database();
  return render();
}
`,
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('a class destructured from a call result links no same-named class', () => {
    expect(edgesFrom(root, 'src/store.ts')).toEqual([]);
  });

  it('sources that may hold a project symbol keep their by-name link', () => {
    expect(linksFrom(root, 'src/ctl.ts').filter((l) => / call /.test(l))).toEqual([
      'Ctl::list call other/svc.ts#findAll inferred', // const { findAll } = this.userService
      'auto call other/svc.ts#autoFn inferred', // a composable with no import (Nuxt auto-import)
      'inst call other/svc.ts#fromInst verified', // const { fromInst } = new Builder()
      'pin call other/svc.ts#reset inferred', // const { reset } = s, s = useStore()
      'pin call other/svc.ts#useStore verified',
      'viaReq call other/svc.ts#mk verified',
      'viaReq call other/svc.ts#o inferred', // const { o } = m(), m = require('…').mk
    ]);
    // const { inner } = localMake(), localMake declared in the same file
    expect(query<Edge>(root, `SELECT source_symbol, edge_type, target_file, target_symbol FROM edges
      WHERE source_file = 'src/ctl.ts' AND source_symbol = 'sameFile' AND edge_type = 'call'`)).toContainEqual(
      expect.objectContaining({ target_file: 'src/ctl.ts', target_symbol: 'inner' }));
  });

  it('a destructuring from a call given no package specifier links no verified edge', () => {
    expect(linksFrom(root, 'src/noarg.ts').filter((l) => l.endsWith(' verified'))).toEqual([]);
  });

  it('a module-level destructuring from a call links nothing', () => {
    expect(edgesFrom(root, 'src/shared.ts')).toEqual([]);
  });

  it('an imported class and function of that name still link', () => {
    expect(edgesFrom(root, 'src/imported.ts')).toEqual([
      'open call other/ui.ts#render',
      'open instantiation other/Database.ts#Database',
    ]);
  });

  it('a name destructured from the result of an imported function still links', () => {
    expect(edgesFrom(root, 'src/composed.ts')).toEqual(['go call other/make.ts#build', 'go call other/make.ts#make']);
  });

  it('names destructured from a require or a dynamic import of a project module still link', () => {
    const want = ['open call other/ui.ts#render', 'open instantiation other/Database.ts#Database'];
    expect(edgesFrom(root, 'src/required.js')).toEqual(want);
    expect(edgesFrom(root, 'src/dynamic.ts')).toEqual(want);
  });
});

// Review of M2-25: resolving a destructured name read the file's imports once per call (a cache keyed
// on a node wrapper that never hit): 500 imports and 9,000 destructured calls took 30 s against 2 s.
describe('scan time of destructured calls', () => {
  const IMPORTS = 1000;
  const CALLS = 1500;
  const build = (destructure: boolean) => {
    const imports = Array.from({ length: IMPORTS }, (_, i) => `import { use${i} } from './lib';`).join('\n');
    const fns = Array.from({ length: CALLS }, (_, i) => destructure
      ? `export function g${i}() { const { r${i} } = use${i % IMPORTS}(); r${i}(); }`
      : `export function g${i}() { const r${i} = use${i % IMPORTS}(); r${i}(); }`).join('\n');
    const lib = Array.from({ length: IMPORTS }, (_, i) => `export function use${i}() { return { r: 1 }; }`).join('\n');
    const root = workspace({ 'package.json': '{"name":"perf"}', 'src/lib.ts': lib, 'src/big.ts': `${imports}\n${fns}\n` });
    init(root);
    const start = Date.now();
    mapx(root, 'scan', '.');
    const took = Date.now() - start;
    cleanup(root);
    return took;
  };

  it('is within 3 times that of plain declarations', () => {
    build(false); // warm the grammar and the file cache
    const plain = build(false);
    const destructured = build(true);
    expect(destructured).toBeLessThan(plain * 3);
  }, 300000);
});
