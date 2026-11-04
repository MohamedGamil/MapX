import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { declaredGlobalNames } from '../src/core/js-source.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';
import { Scanner } from '../src/core/scanner.js';
import { Store } from '../src/core/store.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-08-R3: a name bound by an import from a package or builtin module is that module's, never a
// same-named project symbol; a bare name an ES module neither imports nor declares is a global, never
// another project module's declaration (found by M5-18: `join` from node:path → a project `join`).
// TS parameter types are extracted for constructors (DI), so the type cases use constructors.
type Edge = { source_symbol: string | null; edge_type: string; target_file: string; target_symbol: string };

function edgesFrom(root: string, file: string): string[] {
  return query<Edge>(root, `SELECT source_symbol, edge_type, target_file, target_symbol FROM edges
    WHERE source_file = ? AND target_file != source_file AND edge_type NOT IN ('import', 'require') ORDER BY 1, 2, 3, 4`, file)
    .map((e) => `${e.source_symbol} ${e.edge_type} ${e.target_file}#${e.target_symbol}`);
}

describe('names imported from outside the project (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }),
      // Name lookup would pick these: every imported name below is declared here too.
      'src/b.ts': `export function join(a: string, b: string) { return a + b; }
export function resolve(a: string) { return a; }
export function debounce(f: unknown) { return f; }
export function readFileSync(p: string) { return p; }
export class Node {}
export class Parser {}
`,
      // A script's names are globals any file may see by name, unless an import binds the name.
      'src/vendor/legacy.js': 'function join(a, b) { return a + b; }\nfunction resolve(a) { return a; }\nfunction debounce(f) { return f; }\nfunction readFileSync(p) { return p; }\nclass Parser {}\n',
      'src/a.ts': `import { join, resolve } from 'node:path';

export function run(p: string) {
  return join(resolve(p), 'x');
}
`,
      'src/c.ts': `import { join, resolve, debounce } from 'lodash';

export function run(p: string) {
  debounce(() => join([resolve(p)], ','));
}
`,
      // A bare builtin, a default and a namespace binding, a type-only import.
      'src/d.ts': `import path from 'path';
import * as fs from 'fs';
import { readFileSync } from 'fs';
import type { Node } from 'web-tree-sitter';
import { Parser } from 'web-tree-sitter';

export class Loader {
  constructor(private node: Node) {}
  load(): string {
    const p = new Parser();
    fs.readFileSync(path.join('a', 'b'));
    return readFileSync(path.resolve(String(this.node), String(p)));
  }
}
`,
      // The same names imported from the project still link.
      'src/e.ts': `import { join, Node } from './b';

export class Holder {
  constructor(private node: Node) {}
  local() { return join('a', String(this.node)); }
}
`,
      // One function declares a local `join`, another calls the imported one (MapX's
      // src/arch/elements.ts): neither is b.ts's.
      'src/f.ts': `import { join } from 'node:path';

export function view(root: string) {
  return join(root, 'view');
}

export function label(input: { name?: string; path: string }): string {
  const { path, name } = input;
  const join = (prefix: string | null, sep: string, scopeSep = sep) =>
    name === undefined ? (prefix ?? path) : [prefix, name].filter(Boolean).join(sep + scopeSep);
  switch (path) {
    case 'a':
      return join(path, '.');
    default:
      return join(null, '::');
  }
}
`,
      // An SFC: the same rule for its script.
      'src/Page.vue': `<script setup lang="ts">
import { join } from 'node:path';
function full(a: string) { return join(a, 'b'); }
</script>
<template><div>{{ full('a') }}</div></template>
`,
      // Destructuring a dynamic import binds like an import.
      'src/g.ts': `export async function lazy() {
  const { resolve } = await import('./b');
  return resolve('x');
}
export function later() {
  return import('./b')
    .then(({ debounce }) => debounce(1));
}
`,
      // A project barrel passing on names from outside the project.
      'src/barrel.ts': "export { join } from 'node:path';\nexport * from 'lodash';\n",
      'src/barrel2.ts': "import { resolve } from 'node:path';\nexport { resolve };\n",
      'src/h.ts': `import { join, debounce } from './barrel';
import { resolve } from './barrel2';

export function viaBarrel() {
  debounce(() => join('a', resolve('b')));
}
`,
      // A dynamic import from outside the project.
      'src/i.ts': `export async function dyn() {
  const { join } = await import('node:path');
  return join('a', 'b');
}
export function dynThen() {
  return import('node:path').then(({ resolve }) => resolve('a'));
}
`,
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('a name a project barrel re-exports from outside the project links no project symbol', () => {
    expect(edgesFrom(root, 'src/h.ts')).toEqual([]);
  });

  it('a name destructured from a dynamic import of a builtin links no project symbol', () => {
    expect(edgesFrom(root, 'src/i.ts')).toEqual([]);
  });

  it('a name imported from a node: builtin links no project symbol', () => {
    expect(edgesFrom(root, 'src/a.ts')).toEqual([]);
  });

  it('a name imported from an npm package links no project symbol', () => {
    expect(edgesFrom(root, 'src/c.ts')).toEqual([]);
  });

  it('bare builtins, default and namespace receivers and type-only imports link no project symbol', () => {
    expect(edgesFrom(root, 'src/d.ts')).toEqual([]);
  });

  it('a Vue SFC\'s name imported from a builtin links no project symbol', () => {
    expect(edgesFrom(root, 'src/Page.vue')).toEqual([]);
  });

  it('the imported calls are recorded as external references instead (M5-19)', () => {
    const rows = query<{ specifier: string; symbol: string }>(root,
      `SELECT DISTINCT specifier, symbol FROM external_ref_candidates WHERE file_path = 'src/a.ts' AND kind = 'call' ORDER BY 2`);
    expect(rows.map((r) => `${r.specifier}#${r.symbol}`)).toEqual(['node:path#join', 'node:path#resolve']);
  });

  it('the same names imported from a project module still link it', () => {
    expect(edgesFrom(root, 'src/e.ts')).toEqual([
      'Holder::constructor param_type src/b.ts#Node',
      'Holder::local call src/b.ts#join',
    ]);
  });

  it('an imported builtin the file also declares as a local links no other module', () => {
    expect(edgesFrom(root, 'src/f.ts')).toEqual([]);
  });

  it('a name destructured from a dynamic import of a project module keeps name lookup', () => {
    expect(edgesFrom(root, 'src/g.ts')).toEqual(['later call src/b.ts#debounce', 'lazy call src/b.ts#resolve']);
  });
});

describe('globals an ES module neither imports nor declares (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'src/dom.ts': 'export class Node {}\nexport class Element {}\nexport class Request {}\nexport function helper() { return 1; }\n',
      // DOM globals, and a function only another module declares.
      'src/view.ts': `export class View {
  constructor(private node: Node, private el: Element) {}
  render() {
    helper();
    return new Request();
  }
}
`,
      'src/imported.ts': `import { Node, Element, Request, helper } from './dom';

export class View {
  constructor(private node: Node, private el: Element) {}
  render() {
    helper();
    return new Request();
  }
}
`,
      // A script (no import or export) puts its declarations in the global scope.
      'src/legacy/globals.js': 'function legacyHelper() { return 1; }\n',
      'src/legacy/page.js': 'function page() { return legacyHelper(); }\n',
      'src/uses-legacy.ts': 'export function viaScript() { return legacyHelper(); }\n',
      // `declare global` in a module: the names it declares are global, the module's others are not.
      'src/types/bus.ts': 'export {};\ndeclare global {\n  class EventBus {}\n}\nexport class NotGlobal {}\n',
      'src/uses-bus.ts': 'export class Bus {\n  constructor(private bus: EventBus, private other: NotGlobal) {}\n}\n',
      // A global .d.ts (no import or export).
      'src/types/env.d.ts': 'declare class AppEnv {}\n',
      'src/uses-env.ts': 'export class Env {\n  constructor(private env: AppEnv) {}\n}\n',
      // A global .d.ts whose namespace and ambient module bodies export: still a script.
      'src/types/widgets.d.ts': `declare namespace API {
  export interface Options { id: string }
}
declare module 'widget-lib' {
  export function create(): void;
}
declare class WidgetD {}
`,
      'src/uses-widget.ts': 'export function makeWidget() { return new WidgetD(); }\n',
      // TS namespace scripts: `export` inside a namespace body makes no module.
      'src/ns/models.ts': 'namespace App {\n  export function makeOrder() { return 1; }\n}\n',
      'src/ns/app.ts': 'namespace App {\n  export function start() { return makeOrder(); }\n}\n',
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('Node, Element and Request link no project class of another module; an unimported helper links nothing', () => {
    expect(edgesFrom(root, 'src/view.ts')).toEqual([]);
  });

  it('the same names imported from that module still link', () => {
    expect(edgesFrom(root, 'src/imported.ts')).toEqual([
      'View::constructor param_type src/dom.ts#Element',
      'View::constructor param_type src/dom.ts#Node',
      'View::render call src/dom.ts#helper',
      'View::render instantiation src/dom.ts#Request',
    ]);
  });

  it('a script\'s declarations stay reachable by name, from a script and from a module', () => {
    expect(edgesFrom(root, 'src/legacy/page.js')).toEqual(['page call src/legacy/globals.js#legacyHelper']);
    expect(edgesFrom(root, 'src/uses-legacy.ts')).toEqual(['viaScript call src/legacy/globals.js#legacyHelper']);
  });

  it('a name declared in `declare global` links; the module\'s other declarations do not', () => {
    expect(edgesFrom(root, 'src/uses-bus.ts')).toEqual(['Bus::constructor param_type src/types/bus.ts#EventBus']);
  });

  it('a global .d.ts declaration links', () => {
    expect(edgesFrom(root, 'src/uses-env.ts')).toEqual(['Env::constructor param_type src/types/env.d.ts#AppEnv']);
  });

  it('an `export` inside a namespace or `declare module` body makes no module', () => {
    expect(edgesFrom(root, 'src/uses-widget.ts')).toEqual(['makeWidget instantiation src/types/widgets.d.ts#WidgetD']);
    expect(edgesFrom(root, 'src/ns/app.ts')).toEqual(['start call src/ns/models.ts#makeOrder']);
  });
});

describe('imports the alias resolver cannot place (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { react: '^18.0.0' } }),
      // create-react-app: only `baseUrl`.
      'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
      'src/components/Button.jsx': 'export function Button() { return null; }\n',
      'src/a11y/Button.jsx': 'export function Button() { return null; }\n',
      'src/App.jsx': "import React from 'react';\nimport { Button } from 'components/Button';\nexport function App() { return Button(); }\n",
      // A webpack app (its own root, outside the jsconfig's `baseUrl`) with an alias whose value is no literal.
      'web/package.json': JSON.stringify({ name: 'web', version: '1.0.0', devDependencies: { webpack: '^5.0.0' } }),
      'web/webpack.config.js': "const path = require('path');\nconst SRC = path.resolve(__dirname, 'src');\nmodule.exports = { resolve: { alias: { shared: SRC + '/shared' } } };\n",
      'web/src/shared/money.js': 'export function formatMoney(n) { return String(n); }\n',
      'web/src/app/wp.js': "import { formatMoney } from 'shared/money';\nexport function viaWp() { return formatMoney(1); }\n",
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('resolves a bare import under the jsconfig `baseUrl`', () => {
    expect(edgesFrom(root, 'src/App.jsx')).toEqual(['App call src/components/Button.jsx#Button']);
  });

  it('keeps name lookup for an import that names a project folder', () => {
    expect(edgesFrom(root, 'web/src/app/wp.js')).toEqual(['viaWp call web/src/shared/money.js#formatMoney']);
  });
});

describe('sync when a file switches between script and module (hash sync)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'legacy/plain.ts': 'function plainGlobal() { return 1; }\n',
      'legacy/use.ts': 'export function usePlain() { return plainGlobal(); }\n',
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('drops the edge into a script that became a module, as scan --force does', () => {
    expect(edgesFrom(root, 'legacy/use.ts')).toEqual(['usePlain call legacy/plain.ts#plainGlobal']);
    writeFileSync(join(root, 'legacy/plain.ts'), 'function plainGlobal() { return 1; }\nexport {};\n');
    mapx(root, 'sync', '.');
    expect(edgesFrom(root, 'legacy/use.ts')).toEqual([]);
    mapx(root, 'scan', '.', '--force');
    expect(edgesFrom(root, 'legacy/use.ts')).toEqual([]);
  }, 120000);
});

// M2-08-R4 review: every declarator of a `declare global` list is global.
describe('names a `declare global` block declares', () => {
  const names = (code: string) => declaredGlobalNames({ code, masked: code, balanced: true });
  it('includes every declarator of a variable list and a spaced generator', () => {
    expect(names('declare global {\n  var a: number, b: string;\n  let { c } = x, d;\n  function *gen(): void;\n  const m: Map<string, number>, n: number;\n}\n'))
      .toEqual(['a', 'b', 'd', 'gen', 'm', 'n']);
  });
});

// M2-08-R4: the other direction. A module edited into a script, or gaining `declare global` names,
// makes names global that files already referenced by name and found nowhere. Those files have no
// edge into it to follow, so sync finds them by the names each parse recorded (`globalNameRefs`).
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });

describe.each([['git', true], ['hash', false]])('%s sync when a file gains global names', (_mode, useGit) => {
  let root: string;
  beforeEach(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      // A module: its function is not global. `use.ts` calls it without an import.
      'legacy/plain.ts': 'export function plainGlobal() { return 1; }\n',
      'legacy/use.ts': 'export function usePlain() { return plainGlobal(); }\n',
      // Names another file declares, but no changed file makes global: never re-parsed.
      'legacy/bystander.ts': 'export function other() { return missingName(); }\n',
      'legacy/other.ts': 'export function missingNameElsewhere() { return 2; }\n',
      // A module whose `declare global` block gains a class `uses-bus.ts` names.
      'types/bus.ts': 'export {};\ndeclare global {\n  class EventBus {}\n}\n',
      'types/uses-bus.ts': 'export class Bus {\n  constructor(private bus: LateBus) {}\n}\n',
      // Several declarators in one statement, and a class member: both reachable by bare name in a script.
      'lib/g.ts': 'export var helperA = function () {}, helperB = function () {};\n',
      'use/b.ts': 'export function w() { helperB(); }\n',
      'lib/m.ts': 'export class Shape {\n  area() { return 1; }\n}\n',
      'use/m.ts': 'export function measure() { return area(); }\n',
      // A script that becomes a module gaining `declare global` names.
      'old/script.ts': 'function sGlobal() { return 1; }\n',
      'old/use-s.ts': 'export function useS() { return sGlobal(); }\n',
      'old/wants.ts': 'export class Wants {\n  constructor(private x: LateGlobal) {}\n}\n',
    });
    if (useGit) {
      git(root, 'init', '-q');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
    }
    init(root);
    mapx(root, 'scan', '.');
  }, 120_000);
  afterEach(() => cleanup(root));

  const all = () => query<Edge>(root, `SELECT source_file, source_symbol, edge_type, target_file, target_symbol FROM edges
    WHERE edge_type NOT IN ('import', 'require') ORDER BY 1, 2, 3, 4, 5`);
  const updated = (output: string) => /Updated (\d+) files/.exec(output)?.[1];

  it('a module edited into a script gives its now-global function the edge scan --force gives', () => {
    expect(edgesFrom(root, 'legacy/use.ts')).toEqual([]);
    writeFileSync(join(root, 'legacy/plain.ts'), 'function plainGlobal() { return 1; }\n');
    // The edited file and `use.ts` only: the bystander names no gained name.
    expect(updated(mapx(root, 'sync', '.'))).toBe('2');
    expect(edgesFrom(root, 'legacy/use.ts')).toEqual(['usePlain call legacy/plain.ts#plainGlobal']);
    const synced = all();
    mapx(root, 'scan', '.', '--force');
    expect(all()).toEqual(synced);
  }, 120_000);

  it('a `declare global` block gaining a class links the file that names it, as scan --force does', () => {
    expect(edgesFrom(root, 'types/uses-bus.ts')).toEqual([]);
    writeFileSync(join(root, 'types/bus.ts'), 'export {};\ndeclare global {\n  class EventBus {}\n  class LateBus {}\n}\n');
    expect(updated(mapx(root, 'sync', '.'))).toBe('2');
    expect(edgesFrom(root, 'types/uses-bus.ts')).toEqual(['Bus::constructor param_type types/bus.ts#LateBus']);
    const synced = all();
    mapx(root, 'scan', '.', '--force');
    expect(all()).toEqual(synced);
  }, 120_000);

  it('a script\'s second declarator is global too, as scan --force has it', () => {
    expect(edgesFrom(root, 'use/b.ts')).toEqual([]);
    writeFileSync(join(root, 'lib/g.ts'), 'var helperA = function () {}, helperB = function () {};\n');
    expect(updated(mapx(root, 'sync', '.'))).toBe('2');
    expect(edgesFrom(root, 'use/b.ts')).toEqual(['w call lib/g.ts#helperB']);
    const synced = all();
    mapx(root, 'scan', '.', '--force');
    expect(all()).toEqual(synced);
  }, 120_000);

  it('a script\'s class member is reachable by bare name, as scan --force has it', () => {
    expect(edgesFrom(root, 'use/m.ts')).toEqual([]);
    writeFileSync(join(root, 'lib/m.ts'), 'class Shape {\n  area() { return 1; }\n}\n');
    expect(updated(mapx(root, 'sync', '.'))).toBe('2');
    const synced = all();
    expect(edgesFrom(root, 'use/m.ts')).toEqual(['measure call lib/m.ts#area']);
    mapx(root, 'scan', '.', '--force');
    expect(all()).toEqual(synced);
  }, 120_000);

  it('a script edited into a module with `declare global` names links the file that names one, as scan --force does', () => {
    expect(edgesFrom(root, 'old/wants.ts')).toEqual([]);
    writeFileSync(join(root, 'old/script.ts'), 'export {};\ndeclare global {\n  class LateGlobal {}\n}\nfunction sGlobal() { return 1; }\n');
    // The edited file, its former referrer (an edge into it) and the file naming the new class.
    expect(updated(mapx(root, 'sync', '.'))).toBe('3');
    expect(edgesFrom(root, 'old/wants.ts')).toEqual(['Wants::constructor param_type old/script.ts#LateGlobal']);
    const synced = all();
    mapx(root, 'scan', '.', '--force');
    expect(all()).toEqual(synced);
  }, 120_000);

  it('a module edit that gains no global name re-parses nobody else', () => {
    writeFileSync(join(root, 'legacy/plain.ts'), 'export function plainGlobal() { return 2; }\nexport function more() { return 3; }\n');
    expect(updated(mapx(root, 'sync', '.'))).toBe('1');
  }, 120_000);

  it('a file that no longer names the gained name is not re-parsed for it', () => {
    writeFileSync(join(root, 'legacy/use.ts'), 'export function usePlain() { return 1; }\n');
    mapx(root, 'sync', '.');
    writeFileSync(join(root, 'legacy/plain.ts'), 'function plainGlobal() { return 1; }\n');
    expect(updated(mapx(root, 'sync', '.'))).toBe('1');
  }, 120_000);

  it('a script that stays a script keeps its referrers\' edges', () => {
    writeFileSync(join(root, 'legacy/plain.ts'), 'function plainGlobal() { return 1; }\n');
    mapx(root, 'sync', '.');
    writeFileSync(join(root, 'legacy/plain.ts'), 'function plainGlobal() { return 2; }\n');
    expect(updated(mapx(root, 'sync', '.'))).toBe('1');
    expect(edgesFrom(root, 'legacy/use.ts')).toEqual(['usePlain call legacy/plain.ts#plainGlobal']);
  }, 120_000);
});

describe('auto-imported names (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      // Nuxt auto-imports composables: `useB()` needs no import.
      'web/package.json': JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { nuxt: '^3.0.0' } }),
      'web/composables/useA.ts': 'export function useA() { return useB(); }\n',
      'web/composables/useB.ts': 'export function useB() { return 1; }\n',
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('an un-imported name under an auto-import tool keeps name lookup', () => {
    expect(edgesFrom(root, 'web/composables/useA.ts')).toEqual(['useA call web/composables/useB.ts#useB']);
  });
});

// M2-08-R5: M2-08-R3's rule for Python and Java. A name an import from a package binds is that
// package's, never a same-named project symbol; an import that may be the project's keeps name lookup.
function allEdgesFrom(root: string, file: string): string[] {
  return query<Edge>(root, `SELECT source_symbol, edge_type, target_file, target_symbol FROM edges
    WHERE source_file = ? AND edge_type NOT IN ('import', 'require') ORDER BY 1, 2, 3, 4`, file)
    .map((e) => `${e.source_symbol} ${e.edge_type} ${e.target_file}#${e.target_symbol}`);
}
/** Cross-file edges, each once (a name used twice in a function gives two rows). */
const distinctEdgesFrom = (root: string, file: string) => [...new Set(edgesFrom(root, file))];

describe('Python names imported from a package (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      // Name lookup would pick these.
      'app/order.py': 'class Order:\n    def total(self):\n        return 1\n',
      'app/util.py': 'def join(a, b):\n    return a + b\n',
      'app/use_pkg.py': `from stripe import Order
import stripe
import os.path as osp


def charge():
    Order().total()
    stripe.Order().total()
    o = Order()
    return osp.join('a', 'b')


def twice():
    # Two calls of total on one line: the line cannot say which is which; the class decides.
    return Order().total() + Order().total()


class Sub(Order):
    pass
`,
      'app/use_proj.py': `from app.order import Order


def run():
    Order().total()
    return Order()
`,
      // `lib` is a project package: `lib.missing` may be the project's (generated, not indexed).
      'lib/__init__.py': '',
      'lib/real.py': 'X = 1\n',
      'app/use_unknown.py': 'from lib.missing import Order\n\n\ndef maybe():\n    return Order()\n',
      // Review of M2-08-R5. A src/ layout seen from tests/: mypkg is on no root the import searches.
      'src/mypkg/__init__.py': '',
      'src/mypkg/models.py': 'class Model:\n    def save(self):\n        return 1\n\n\ndef build():\n    return Model()\n',
      'tests/test_models.py': 'from mypkg.models import Model, build\n\n\ndef test_save():\n    Model().save()\n    build()\n',
      // A package import with a project fallback.
      'app/cond.py': 'try:\n    from stripe import Order\nexcept ImportError:\n    from app.order import Order\n\n\ndef pay():\n    return Order().total()\n',
      // One name called on two receivers on one line: the line cannot say which is which.
      'app/two.py': "import os.path as osp\nfrom app import util\n\n\ndef both():\n    return osp.join('a', 'b') + util.join('a', 'b')\n",
      // The file binds Order from a package, then declares its own: the declaration wins.
      'app/own.py': `from stripe import Order


class Order:
    def total(self):
        return 2


def mine():
    return Order().total()
`,
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('Python: names imported from a package link no project symbol', () => {
    expect(distinctEdgesFrom(root, 'app/use_pkg.py')).toEqual([]);
  });

  it('Python: the package uses are recorded as external references instead', () => {
    const rows = query<{ specifier: string; symbol: string }>(root,
      `SELECT DISTINCT specifier, symbol FROM external_ref_candidates WHERE file_path = 'app/use_pkg.py' AND kind != 'import' ORDER BY 1, 2`);
    expect(rows.map((r) => `${r.specifier}#${r.symbol}`)).toEqual(expect.arrayContaining(['os.path#join', 'stripe#Order']));
  });

  it('Python: the same names imported from the project still link', () => {
    expect(distinctEdgesFrom(root, 'app/use_proj.py')).toEqual([
      'run call app/order.py#total',
      'run instantiation app/order.py#Order',
    ]);
  });

  it('Python: an import from a project package folder keeps name lookup', () => {
    expect(distinctEdgesFrom(root, 'app/use_unknown.py')).toContain('maybe instantiation app/order.py#Order');
  });

  it('Python: a src/ layout package imported from tests/ still links (review)', () => {
    expect(distinctEdgesFrom(root, 'tests/test_models.py')).toEqual([
      'test_save call src/mypkg/models.py#build',
      'test_save call src/mypkg/models.py#save',
      'test_save instantiation src/mypkg/models.py#Model',
    ]);
  });

  it('Python: a name also imported from the project is not taken for the package\'s (review)', () => {
    expect(distinctEdgesFrom(root, 'app/cond.py')).toEqual(['pay call app/order.py#total', 'pay instantiation app/order.py#Order']);
  });

  it('Python: a name called on two receivers on one line keeps the project call (review)', () => {
    expect(distinctEdgesFrom(root, 'app/two.py')).toContain('both call app/util.py#join');
  });

  it('Python: a name the file declares after importing it from a package is the file\'s own', () => {
    expect(allEdgesFrom(root, 'app/own.py')).toEqual(expect.arrayContaining(['mine call app/own.py#total']));
  });
});

// M2-08-R7: a bare Python name the module neither defines nor imports is a builtin (or an error), never
// another module's function: name lookup reaches only the module itself, the modules it imports the
// name from, and the modules it star-imports. A receiver call (`obj.open()`) is not decided here.
describe('Python names a module neither defines nor imports (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      // Name lookup would pick these for a bare `open`, `Model` or `helper`.
      'db/__init__.py': '',
      'db/database.py': 'def open(path):\n    return path\n\n\ndef helper():\n    return 1\n\n\nclass Model:\n    def save(self):\n        return 1\n',
      'db/other.py': 'def open(path):\n    return path\n\n\ndef reader():\n    return 2\n\n\ndef later():\n    return 4\n\n\ndef spare():\n    return 5\n',
      // A builtin called, never imported.
      'app/__init__.py': '',
      'app/script.py': `import sys


@helper
def load(path, cb):
    with open(path) as f:
        print(len(f.read()), sys.argv)
    cb()
    return open(path)


def typed(m: Model) -> Model:
    return Model()


def saved():
    return Model().save()


class Child(Model):
    pass
`,
      // The same names imported: they link.
      'app/imported.py': `from db.database import open, helper
from db.database import Model as M


def load(path):
    return open(path), helper()


def build():
    return M()
`,
      // Imports the scan must still see: TYPE_CHECKING, inside a function, try/except, a parenthesised
      // list over lines, a semicolon after another statement, a relative import.
      'app/forms.py': `from typing import TYPE_CHECKING
import os; from db.other import reader
from db.database import (
    helper,
    Model,
)

if TYPE_CHECKING:
    from db.other import open as other_open


def fn(path):
    from db.database import open
    return open(path), helper(), Model(), reader(), os.sep


def guarded(path):
    try:
        from db.other import open as maybe
    except ImportError:
        maybe = None
    return maybe(path), other_open(path)
`,
      'app/rel/__init__.py': '',
      'app/rel/sibling.py': 'def sibling_fn():\n    return 1\n\n\ndef open(path):\n    return path\n',
      'app/rel/user.py': 'from .sibling import (\n    sibling_fn,\n    open,\n)\n\n\ndef go():\n    return sibling_fn(), open("p")\n',
      'app/rel/package_user.py': 'from . import sibling\nfrom .sibling import sibling_fn as sf\n\n\ndef go():\n    sf()\n    return sibling.open("p")\n',
      // A star import of a project module makes its public names visible, and so do the names that
      // module's package passes on.
      'app/star.py': 'from db.database import *\n\n\ndef go():\n    helper()\n    return open("p"), Model(), reader()\n',
      'app/chain/__init__.py': 'from .impl import *\n',
      'app/chain/impl.py': 'def build():\n    return 1\n\n\nclass Widget:\n    pass\n',
      'app/use_chain.py': 'from app.chain import *\n\n\ndef go():\n    Widget()\n    return build()\n',
      // A star import of a package whose __init__ passes a name on by a named import.
      'app/chain2/__init__.py': 'from .impl2 import passed_on\n',
      'app/chain2/impl2.py': 'def passed_on():\n    return 1\n',
      'app/use_chain2.py': 'from app.chain2 import *\n\n\ndef go():\n    return passed_on()\n',
      // An import of a module no file satisfies (generated, not indexed), over lines: name lookup stays.
      'db/generated_names.py': 'def gen_fn():\n    return 1\n',
      'app/gen_user.py': 'from .gen import (\n    gen_fn,\n    other_fn,\n)\n\n\ndef go():\n    return gen_fn()\n',
      // Names a starred module imports, through a chain of re-exports (`from pkg import name` in a module).
      'app/re/__init__.py': 'from .impl3 import deep_fn\n',
      'app/re/impl3.py': 'def deep_fn():\n    return 1\n',
      'app/re/mod.py': 'from app.re import deep_fn\n',
      'app/use_re.py': 'from app.re.mod import *\n\n\ndef go():\n    return deep_fn()\n',
      'app/re2/__init__.py': 'from .mid import deep2\n',
      'app/re2/mid.py': 'from .leaf import deep2\n',
      'app/re2/leaf.py': 'def deep2():\n    return 2\n',
      'app/use_re2.py': 'from app.re2 import *\n\n\ndef go():\n    return deep2()\n',
      // Whitespace after the dots of a relative import.
      'app/sp/__init__.py': '',
      'app/sp/impl.py': 'def spaced_fn():\n    return 1\n\n\ndef spaced_named():\n    return 2\n',
      'app/sp/star_user.py': 'from . impl import *\n\n\ndef go():\n    return spaced_fn()\n',
      'app/sp/named_user.py': 'from . impl import spaced_named\n\n\ndef go():\n    return spaced_named()\n',
      // An import in a comment or a docstring binds nothing.
      'app/commented.py': '# from db.database import *\n# import helper\n"""\nfrom db.database import *\n"""\n\n\ndef go():\n    return helper()\n',
      // A star import of a package outside the project binds nothing of the project's.
      'app/star_pkg.py': 'from os.path import *\n\n\ndef go():\n    return join("a", "b"), open("p")\n',
      // One that may be the project's (generated, not indexed) keeps name lookup.
      'app/star_unknown.py': 'from .generated import *\n\n\ndef go():\n    return open("p")\n',
      // A star import of a module named like a project package, with no such file: may be the project's.
      'lib/__init__.py': '',
      'app/star_lib.py': 'from lib.missing import *\n\n\ndef go():\n    return open("p")\n',
      // The module declares the name itself, after calling it; a local def in a function.
      'app/own.py': 'def first():\n    return later()\n\n\ndef later():\n    return 3\n\n\ndef outer():\n    def spare():\n        return 2\n    return spare()\n',
      // A receiver call is not decided by this rule: name lookup stays.
      'app/receiver.py': 'def go(conn):\n    return conn.open("p")\n',
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('Python: a builtin the module neither defines nor imports links no project function', () => {
    expect(distinctEdgesFrom(root, 'app/script.py').filter((e) => !e.includes('Model'))).toEqual([]);
  });

  it('Python: an unimported class instantiated, annotated, extended or called on links no project class or method', () => {
    expect(allEdgesFrom(root, 'app/script.py')).toEqual([]);
  });

  it('Python: the same names imported from a project module still link', () => {
    expect(distinctEdgesFrom(root, 'app/imported.py')).toEqual([
      'build instantiation db/database.py#Model',
      'load call db/database.py#helper',
      'load call db/database.py#open',
    ]);
  });

  it('Python: an import under TYPE_CHECKING, in a function, in try/except, over lines or after a semicolon is an import', () => {
    expect(distinctEdgesFrom(root, 'app/forms.py')).toEqual(expect.arrayContaining([
      'fn call db/database.py#helper',
      'fn call db/database.py#open',
      'fn call db/other.py#reader',
      'fn instantiation db/database.py#Model',
      'guarded call db/other.py#open',
    ]));
  });

  it('Python: a relative import, over lines too, still links', () => {
    expect(distinctEdgesFrom(root, 'app/rel/user.py')).toEqual(['go call app/rel/sibling.py#open', 'go call app/rel/sibling.py#sibling_fn']);
    expect(distinctEdgesFrom(root, 'app/rel/package_user.py')).toEqual(['go call app/rel/sibling.py#open', 'go call app/rel/sibling.py#sibling_fn']);
  });

  it('Python: a star import of a project module makes its names visible', () => {
    expect(distinctEdgesFrom(root, 'app/star.py')).toEqual([
      'go call db/database.py#helper',
      'go call db/database.py#open',
      'go instantiation db/database.py#Model',
    ]);
  });

  it('Python: a star import of a package, through its __init__, reaches the module that declares the name', () => {
    expect(distinctEdgesFrom(root, 'app/use_chain.py')).toEqual(['go call app/chain/impl.py#build', 'go instantiation app/chain/impl.py#Widget']);
  });

  it('Python: a star import of a package reaches a name its __init__ imports by name', () => {
    expect(distinctEdgesFrom(root, 'app/use_chain2.py')).toEqual(['go call app/chain2/impl2.py#passed_on']);
  });

  it('Python: a name imported over lines from a module no file satisfies keeps name lookup', () => {
    expect(distinctEdgesFrom(root, 'app/gen_user.py')).toEqual(['go call db/generated_names.py#gen_fn']);
  });

  it('Python: a star import reaches a name its module imports through a chain of re-exports', () => {
    expect(distinctEdgesFrom(root, 'app/use_re.py')).toEqual(['go call app/re/impl3.py#deep_fn']);
    expect(distinctEdgesFrom(root, 'app/use_re2.py')).toEqual(['go call app/re2/leaf.py#deep2']);
  });

  it('Python: whitespace after the dots of a relative import changes nothing', () => {
    expect(distinctEdgesFrom(root, 'app/sp/star_user.py')).toEqual(['go call app/sp/impl.py#spaced_fn']);
    expect(distinctEdgesFrom(root, 'app/sp/named_user.py')).toEqual(['go call app/sp/impl.py#spaced_named']);
  });

  it('Python: an import in a comment or a docstring makes no name visible', () => {
    expect(distinctEdgesFrom(root, 'app/commented.py')).toEqual([]);
  });

  it('Python: a star import of a module outside the project makes no project function visible', () => {
    expect(distinctEdgesFrom(root, 'app/star_pkg.py')).toEqual([]);
  });

  it('Python: a star import that may be the project\'s keeps name lookup', () => {
    expect(distinctEdgesFrom(root, 'app/star_unknown.py')).not.toEqual([]);
  });

  it('Python: a star import of a project-named module no file satisfies keeps name lookup', () => {
    expect(distinctEdgesFrom(root, 'app/star_lib.py')).not.toEqual([]);
  });

  it('Python: the module\'s own definition, later or nested, is not another module\'s', () => {
    expect(allEdgesFrom(root, 'app/own.py')).toEqual(['first call app/own.py#later', 'outer call app/own.py#spare']);
  });

  it('Python: a call on a receiver keeps name lookup (not this rule)', () => {
    expect(distinctEdgesFrom(root, 'app/receiver.py').length).toBeGreaterThan(0);
  });
});

describe('sync agrees with scan --force for a star import (M2-08-R7)', () => {
  let root: string;
  beforeEach(() => {
    root = workspace({
      'pkg/__init__.py': '',
      'pkg/core.py': 'def alpha():\n    return 1\n',
      'pkg/more.py': 'def gamma():\n    return 2\n',
      'pkg/user.py': 'from .core import *\n\n\ndef go():\n    return alpha(), beta(), gamma()\n',
      'pkg/elsewhere.py': 'def gamma():\n    return 3\n\n\ndef beta():\n    return 4\n',
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const edges = () => distinctEdgesFrom(root, 'pkg/user.py');

  it('the starred module gains a name, then the importer gains a star import', () => {
    // Only what pkg.core brings is visible: elsewhere.py's beta and gamma are not.
    expect(edges()).toEqual(['go call pkg/core.py#alpha']);
    writeFileSync(join(root, 'pkg/core.py'), 'def alpha():\n    return 1\n\n\ndef beta():\n    return 6\n');
    mapx(root, 'sync', '.');
    expect(edges()).toEqual(['go call pkg/core.py#alpha', 'go call pkg/core.py#beta']);
    writeFileSync(join(root, 'pkg/user.py'), 'from .core import *\nfrom .more import *\n\n\ndef go():\n    return alpha(), beta(), gamma()\n');
    mapx(root, 'sync', '.');
    const synced = edges();
    expect(synced).toEqual(['go call pkg/core.py#alpha', 'go call pkg/core.py#beta', 'go call pkg/more.py#gamma']);
    mapx(root, 'scan', '.', '--force');
    expect(edges()).toEqual(synced);
  }, 120000);
});

// One long-lived scanner (watch, MCP) syncs twice: what the first sync learned of a file's imports must
// not outlive its edit (the per-phase scope cache is cleared with the others).
describe('a long-lived scanner re-reads the imports of an edited Python file (M2-08-R7)', () => {
  let root: string;
  afterEach(() => cleanup(root));

  it('a star import added between two syncs of one scanner', async () => {
    root = workspace({
      'pkg/__init__.py': '',
      'pkg/core.py': 'def alpha():\n    return 1\n',
      'pkg/more.py': 'def gamma():\n    return 2\n',
      'pkg/user.py': 'from .core import *\n\n\ndef go():\n    return alpha(), gamma()\n',
    });
    const config = await Config.load(root);
    const store = new Store(':memory:');
    const scanner = new Scanner(store, config, new MapxGraph(config.repos[0]!.name));
    const calls = () => store.getAllEdges().filter((e) => e.source_file === 'pkg/user.py' && e.edge_type === 'call')
      .map((e) => `${e.target_file}#${e.target_symbol}`).sort();
    await scanner.scanFull();
    expect(calls()).toEqual(['pkg/core.py#alpha']);
    writeFileSync(join(root, 'pkg/core.py'), 'def alpha():\n    return 1\n\n\ndef beta():\n    return 3\n');
    await scanner.scanIncremental();
    expect(calls()).toEqual(['pkg/core.py#alpha']);
    writeFileSync(join(root, 'pkg/user.py'), 'from .core import *\nfrom .more import *\n\n\ndef go():\n    return alpha(), gamma()\n');
    await scanner.scanIncremental();
    expect(calls()).toEqual(['pkg/core.py#alpha', 'pkg/more.py#gamma']);
  }, 120000);
});

describe('Java names imported from a package (real scan)', () => {
  let root: string;
  const src = 'src/main/java/com';
  beforeAll(() => {
    root = workspace({
      // Name lookup would pick these.
      [`${src}/acme/Invoice.java`]: `package com.acme;

public class Invoice {
    public int total() { return 1; }
    public static int helper() { return 2; }
}
`,
      [`${src}/other/Missing.java`]: 'package com.other;\n\npublic class Missing {\n    public int go() { return 1; }\n}\n',
      [`${src}/acme2/UsePkg.java`]: `package com.acme2;

import com.vendor.Invoice;
import static com.vendor.Util.helper;
import java.util.List;

public class UsePkg extends Invoice {
    public int run(Invoice i) {
        Invoice x = new Invoice();
        helper();
        Invoice.helper();
        int a = new Invoice().total();
        return a + i.total();
    }
}
`,
      [`${src}/acme2/UseProj.java`]: `package com.acme2;

import com.acme.Invoice;

public class UseProj {
    public int run() {
        Invoice x = new Invoice();
        return new Invoice().total();
    }
}
`,
      // Java ties a package to no folder: misc/Ledger.java declares com.books.Ledger (found by the
      // arch-visibility fixture's core/Registry.java in package acme.core).
      'misc/Ledger.java': 'package com.books;\n\npublic class Ledger {\n    public void post() {}\n}\n',
      [`${src}/acme2/UseLedger.java`]: `package com.acme2;

import com.books.Ledger;

public class UseLedger {
    public void run() {
        new Ledger().post();
    }
}
`,
      // Review of M2-08-R5: doubly nested project classes, imported by type and by static member.
      [`${src}/acme/Outer.java`]: `package com.acme;

public class Outer {
    public static class Inner {
        public static int nestedHelper() { return 1; }
        public static class Deep {
            public int deepGo() { return 2; }
        }
    }
}
`,
      [`${src}/acme2/UseNested.java`]: `package com.acme2;

import static com.acme.Outer.Inner.nestedHelper;
import com.acme.Outer.Inner.Deep;

public class UseNested {
    public int run() {
        return nestedHelper() + new Deep().deepGo();
    }
}
`,
      // A static call on a class imported from a package: the receiver is bound, not the name.
      [`${src}/acme2/UseStatic.java`]: `package com.acme2;

import com.vendor.Invoice;

public class UseStatic {
    public int run() {
        return Invoice.helper();
    }
}
`,
      // com/acme is a project package: com.acme.Missing may be the project's (generated, not indexed).
      [`${src}/acme2/UseUnknown.java`]: `package com.acme2;

import com.acme.Missing;

public class UseUnknown {
    public int maybe() {
        return new Missing().go();
    }
}
`,
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('Java: names imported from a package link no project symbol', () => {
    // `i.total()` is a call on a parameter: its type is not tracked, so name lookup stays (limitation).
    // Not deduplicated: `new Invoice().total()` must not add a second row.
    expect(edgesFrom(root, `${src}/acme2/UsePkg.java`)).toEqual([`UsePkg::run call ${src}/acme/Invoice.java#total`]);
  });

  it('Java: a static call on a class imported from a package links no project symbol', () => {
    expect(distinctEdgesFrom(root, `${src}/acme2/UseStatic.java`)).toEqual([]);
  });

  it('Java: the same names imported from the project still link', () => {
    expect(distinctEdgesFrom(root, `${src}/acme2/UseProj.java`)).toEqual([
      `UseProj::run call ${src}/acme/Invoice.java#total`,
      `UseProj::run instantiation ${src}/acme/Invoice.java#Invoice`,
    ]);
  });

  it('Java: an import of a project class whose folder is not its package still links', () => {
    expect(distinctEdgesFrom(root, `${src}/acme2/UseLedger.java`)).toEqual([
      'UseLedger::run call misc/Ledger.java#post',
      'UseLedger::run instantiation misc/Ledger.java#Ledger',
    ]);
  });

  it('Java: doubly nested project classes imported by type or static member still link (review)', () => {
    expect(distinctEdgesFrom(root, `${src}/acme2/UseNested.java`)).toEqual(expect.arrayContaining([
      `UseNested::run call ${src}/acme/Outer.java#deepGo`,
      `UseNested::run call ${src}/acme/Outer.java#nestedHelper`,
    ]));
  });

  it('Java: an import naming a project package folder keeps name lookup', () => {
    expect(distinctEdgesFrom(root, `${src}/acme2/UseUnknown.java`)).toEqual([
      `UseUnknown::maybe call ${src}/other/Missing.java#go`,
      `UseUnknown::maybe instantiation ${src}/other/Missing.java#Missing`,
    ]);
  });
});

// M2-08-R6: Node never resolves a bare specifier to a relative file. `import 'express'` and
// `require('express')` beside a project express.js are the package's, not the file's; a bare specifier
// resolves only through a tsconfig/jsconfig `paths` or `baseUrl`, or a bundler alias.
function importTargets(root: string, file: string): string[] {
  return query<{ target_file: string }>(root, `SELECT DISTINCT target_file FROM edges
    WHERE source_file = ? AND edge_type IN ('import', 'require') AND target_file != source_file ORDER BY 1`, file).map((e) => e.target_file);
}

describe('a bare specifier never resolves to a relative project file (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { express: '^4.18.0' } }),
      // Project files a bare specifier would reach if it were read as a path from the repo root.
      'express.js': 'function Router() { return {}; }\nmodule.exports = function express() { return {}; };\nmodule.exports.Router = Router;\n',
      'lib/thing.js': 'export function thing() { return 1; }\n',
      'server.js': "import express from 'express';\nimport { thing } from 'lib/thing';\nexport function a() { express(); thing(); }\n",
      'legacy.js': "const express = require('express');\nconst t = require('lib/thing');\nfunction b() { return express(); }\nmodule.exports = { b, t };\n",
      'Page.vue': "<script>\nimport express from 'express';\nexport default { methods: { go() { return express(); } } };\n</script>\n<template><div /></template>\n",
      'Widget.svelte': "<script>\n  import express from 'express';\n  const app = express();\n</script>\n<div>{app}</div>\n",
      // A relative specifier to the same file still links.
      'rel.js': "import express from './express';\nconst r = require('./lib/thing');\nexport function c() { return express(); }\n",
      // Another language's bare path is no package: C includes and shell `source` keep resolving it.
      'main.c': '#include "util.h"\nint main(void) { return helper(); }\n',
      'util.h': 'int helper(void);\n',
      // A root-relative URL (Vite serves `/lib/thing.js` from the project root) is a path, not a package.
      'abs.js': "import { thing } from '/lib/thing.js';\nexport function d() { return thing(); }\n",
      // create-react-app: only `baseUrl`. `utils` is one segment, like a package name.
      'cra/jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
      'cra/src/components/Button.jsx': 'export function Button() { return null; }\n',
      'cra/src/utils.js': 'export function helper() { return 1; }\n',
      'cra/src/express.js': 'export default function express() { return 0; }\n',
      'cra/src/App.jsx': "import { Button } from 'components/Button';\nimport { helper } from 'utils';\nimport express from 'express';\nconst legacy = require('components/Button');\nexport function App() { helper(); express(); return Button(); }\n",
      // tsconfig `paths`, with a `*` pattern and a prefix pattern.
      'ts/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['./src/lib/*'], '*': ['./shims/*'] } } }),
      'ts/src/lib/fmt.ts': 'export function fmt() { return 1; }\n',
      'ts/shims/shimmed.ts': 'export function shimmed() { return 2; }\n',
      'ts/src/use.ts': "import { fmt } from '@lib/fmt';\nimport { shimmed } from 'shimmed';\nexport function go() { return fmt() + shimmed(); }\n",
      // A vite alias.
      'vite/package.json': JSON.stringify({ name: 'v', version: '1.0.0', devDependencies: { vite: '^5.0.0' } }),
      'vite/vite.config.js': "import path from 'path';\nexport default { resolve: { alias: { shared: path.resolve(__dirname, 'src/shared') } } };\n",
      'vite/src/shared/money.js': 'export function formatMoney(n) { return String(n); }\n',
      'vite/src/main.js': "import { formatMoney } from 'shared/money';\nexport function m() { return formatMoney(1); }\n",
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('an import of express gives no project edge, beside a local express.js', () => {
    expect(importTargets(root, 'server.js')).toEqual([]);
    // express() is the package's. `thing()` from 'lib/thing', which names a project folder, keeps the
    // by-name lookup M2-08-R3 gives an import it cannot place; the import itself resolves to nothing.
    expect(edgesFrom(root, 'server.js')).toEqual(['a call lib/thing.js#thing']);
  });

  it('a require of express gives no project edge, beside a local express.js', () => {
    expect(importTargets(root, 'legacy.js')).toEqual([]);
    expect(edgesFrom(root, 'legacy.js')).toEqual([]);
  });

  it('a Vue SFC and a Svelte component importing express link no project file', () => {
    expect(importTargets(root, 'Page.vue')).toEqual([]);
    expect(edgesFrom(root, 'Page.vue')).toEqual([]);
    expect(importTargets(root, 'Widget.svelte')).toEqual([]);
    expect(edgesFrom(root, 'Widget.svelte')).toEqual([]);
  });

  it('a relative import of the same files still links', () => {
    expect(importTargets(root, 'rel.js')).toEqual(['express.js', 'lib/thing.js']);
    expect(edgesFrom(root, 'rel.js')).toEqual(['c call express.js#express']);
  });

  it('a C include of a bare file name still links the file (the rule is JS/TS/Vue/Svelte only)', () => {
    expect(importTargets(root, 'main.c')).toEqual(['util.h']);
  });

  it('a root-relative URL import still resolves to the file', () => {
    expect(importTargets(root, 'abs.js')).toEqual(['lib/thing.js']);
  });

  it('a baseUrl import resolves, one segment (`utils`, `express`) as well as a folder (`components/Button`)', () => {
    expect(importTargets(root, 'cra/src/App.jsx')).toEqual(['cra/src/components/Button.jsx', 'cra/src/express.js', 'cra/src/utils.js']);
    expect(edgesFrom(root, 'cra/src/App.jsx')).toEqual([
      'App call cra/src/components/Button.jsx#Button',
      'App call cra/src/express.js#express',
      'App call cra/src/utils.js#helper',
    ]);
  });

  it('tsconfig `paths`, a `*` pattern included, still resolve', () => {
    expect(importTargets(root, 'ts/src/use.ts')).toEqual(['ts/shims/shimmed.ts', 'ts/src/lib/fmt.ts']);
    expect(edgesFrom(root, 'ts/src/use.ts')).toEqual(['go call ts/shims/shimmed.ts#shimmed', 'go call ts/src/lib/fmt.ts#fmt']);
  });

  it('a bundler alias still resolves', () => {
    expect(importTargets(root, 'vite/src/main.js')).toEqual(['vite/src/shared/money.js']);
    expect(edgesFrom(root, 'vite/src/main.js')).toEqual(['m call vite/src/shared/money.js#formatMoney']);
  });
});

describe('sync agrees with scan --force on a bare specifier beside a new project file (M2-08-R6)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { express: '^4.18.0' } }),
      'app.js': "import express from 'express';\nexport function run() { return express(); }\n",
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('a project express.js added later is not the package, by sync or by scan --force', () => {
    expect(importTargets(root, 'app.js')).toEqual([]);
    writeFileSync(join(root, 'express.js'), 'module.exports = function express() { return {}; };\n');
    mapx(root, 'sync', '.');
    expect(importTargets(root, 'app.js')).toEqual([]);
    mapx(root, 'scan', '.', '--force');
    expect(importTargets(root, 'app.js')).toEqual([]);
    expect(edgesFrom(root, 'app.js')).toEqual([]);
  }, 120000);
});

// M2-08-R6 review: a bare specifier resolves through a workspace package, and a `baseUrl` follows a
// solution-style tsconfig's `references`.
describe('workspace packages and referenced baseUrl (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['client', 'common', 'packages/*'] }),
      // A project file a bare `common` or `kernel` must not reach by path.
      'kernel.js': 'export function kernelDecoy() { return 0; }\n',
      // A package in a root folder, named like its folder: entry `index`, and a subpath.
      'common/package.json': JSON.stringify({ name: 'common', version: '1.0.0' }),
      'common/index.ts': 'export function commonEntry() { return 1; }\n',
      'common/src/fmt.ts': 'export function commonFmt() { return 2; }\n',
      // A scoped package in a nested folder with another name; `main` names a build output that is
      // not indexed, so the source entry `src/index` is the file.
      'packages/core/package.json': JSON.stringify({ name: '@acme/kernel', version: '1.0.0', main: 'dist/index.js' }),
      'packages/core/src/index.ts': 'export function kernelEntry() { return 3; }\n',
      'packages/core/src/deep/thing.ts': 'export function kernelDeep() { return 4; }\n',
      // `exports`: the `import` condition for the entry, a pattern for subpaths.
      'packages/ui/package.json': JSON.stringify({
        name: '@acme/ui', version: '1.0.0',
        exports: { '.': { import: './src/entry.ts', default: './dist/entry.js' }, './utils/*': './src/helpers/*.ts' },
      }),
      'packages/ui/src/entry.ts': 'export function uiEntry() { return 5; }\n',
      'packages/ui/src/helpers/color.ts': 'export function uiColor() { return 6; }\n',
      // `module` before `main`; the build output `main` names is not indexed.
      'packages/legacy/package.json': JSON.stringify({ name: '@acme/legacy', version: '1.0.0', module: './esm/index.ts', main: './cjs/index.js' }),
      'packages/legacy/esm/index.ts': 'export function legacyEntry() { return 7; }\n',
      'client/package.json': JSON.stringify({ name: 'client', version: '1.0.0', dependencies: { common: 'workspace:*' } }),
      'client/src/a.ts': `import { commonEntry } from 'common';
import { commonFmt } from 'common/src/fmt';
import { kernelEntry } from '@acme/kernel';
import { kernelDeep } from '@acme/kernel/src/deep/thing';
import { uiEntry } from '@acme/ui';
import { uiColor } from '@acme/ui/utils/color';
import { legacyEntry } from '@acme/legacy';
export function go() { return commonEntry() + commonFmt() + kernelEntry() + kernelDeep() + uiEntry() + uiColor() + legacyEntry(); }
`,
      // A name that is no workspace package is still no file.
      'client/src/b.ts': "import { kernelDecoy } from 'kernel';\nexport function b() { return kernelDecoy(); }\n",
      // Vite's solution-style tsconfig: the `baseUrl` lives in the referenced config.
      'vite/tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'vite/tsconfig.app.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
      'vite/src/components/Panel.tsx': 'export function Panel() { return null; }\n',
      'vite/src/main.tsx': "import { Panel } from 'src/components/Panel';\nexport function main() { return Panel(); }\n",
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('a workspace package name and subpath import link its files: root folder, nested scoped, exports', () => {
    expect(importTargets(root, 'client/src/a.ts')).toEqual([
      'common/index.ts',
      'common/src/fmt.ts',
      'packages/core/src/deep/thing.ts',
      'packages/core/src/index.ts',
      'packages/legacy/esm/index.ts',
      'packages/ui/src/entry.ts',
      'packages/ui/src/helpers/color.ts',
    ]);
    expect(edgesFrom(root, 'client/src/a.ts')).toEqual([
      'go call common/index.ts#commonEntry',
      'go call common/src/fmt.ts#commonFmt',
      'go call packages/core/src/deep/thing.ts#kernelDeep',
      'go call packages/core/src/index.ts#kernelEntry',
      'go call packages/legacy/esm/index.ts#legacyEntry',
      'go call packages/ui/src/entry.ts#uiEntry',
      'go call packages/ui/src/helpers/color.ts#uiColor',
    ]);
  });

  it('a name that is no workspace package still links no file', () => {
    expect(importTargets(root, 'client/src/b.ts')).toEqual([]);
  });

  it('a baseUrl in a referenced tsconfig resolves a bare import', () => {
    expect(importTargets(root, 'vite/src/main.tsx')).toEqual(['vite/src/components/Panel.tsx']);
    expect(edgesFrom(root, 'vite/src/main.tsx')).toEqual(['main call vite/src/components/Panel.tsx#Panel']);
  });
});

// M2-08-R11: M2-08-R6 stopped reading a bare specifier as a path from the repo root. A project that
// configures module roots, with evidence MapX reads, gets those imports back: webpack
// `resolve.modules`, jest `moduleDirectories` / `modulePaths` (package.json `jest` or jest.config.*)
// and `NODE_PATH=` in a package.json script. The roots belong to the folder that declares them.
function externalSpecifiers(root: string, prefix: string): string[] {
  return query<{ file_path: string; specifier: string }>(root, `SELECT DISTINCT file_path, specifier FROM external_ref_candidates
    WHERE ecosystem = 'npm' AND external = 1 AND file_path LIKE ? AND file_path NOT LIKE '%.config.%' ORDER BY 1, 2`, `${prefix}%`).map((e) => `${e.file_path} ${e.specifier}`);
}

const USER_MODULE = 'exports.save = function save() {};\nexports.find = function find() {};\n';
const MAIN_TSX = `import type { User } from 'models/user';
import { Account, LIMIT } from 'models/user';
import { Btn } from 'components/Btn';
import settings from 'config/settings';
import 'config/settings';
export function f(u: User) { const a = new Account(); return [LIMIT, settings.a, a, <Btn />]; }
`;
const JSTS_APP = {
  'models/user.ts': 'export interface User { id: number }\nexport class Account {}\nexport const LIMIT = 5;\n',
  'components/Btn.tsx': 'export function Btn() { return null; }\n',
  'config/settings.ts': 'export default { a: 1 };\n',
  'app/main.tsx': MAIN_TSX,
};
const prefixed = (dir: string, files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([p, c]) => [`${dir}/${p}`, c]));

describe('a bare import resolves under a module root the project configures (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'mono', private: true }),
      // jest `moduleDirectories` with <rootDir> in the package.json `jest` key (review cases G and J).
      'jestkey/package.json': JSON.stringify({ name: 'jestkey', jest: { moduleDirectories: ['node_modules', '<rootDir>'] } }),
      'jestkey/services/api.js': 'export function api() { return 1; }\n',
      'jestkey/test/api.test.js': "import { api } from 'services/api';\ntest('x', () => { api(); });\n",
      ...prefixed('jestkey', JSTS_APP),
      // jest.config.js: a directory NAME is searched in every ancestor of the importing file.
      'jestcfg/package.json': JSON.stringify({ name: 'jestcfg' }),
      'jestcfg/jest.config.js': "/** @type {import('jest').Config} */\nmodule.exports = {\n  moduleDirectories: ['node_modules', 'src'],\n};\n",
      'jestcfg/src/utils/fmt.js': 'export function fmt() { return 1; }\n',
      'jestcfg/src/deep/a/use.js': "import { fmt } from 'utils/fmt';\nexport function go() { return fmt(); }\n",
      'jestcfg/test/use.test.js': "import { fmt } from 'utils/fmt';\ntest('x', () => { fmt(); });\n",
      // jest.config.json: `modulePaths` with <rootDir>.
      'jestpaths/package.json': JSON.stringify({ name: 'jestpaths' }),
      'jestpaths/jest.config.json': JSON.stringify({ rootDir: 'pkg', modulePaths: ['<rootDir>/lib'] }),
      'jestpaths/pkg/lib/helpers.js': 'export function helper() { return 1; }\n',
      'jestpaths/pkg/test/h.test.js': "import { helper } from 'helpers';\ntest('x', () => { helper(); });\n",
      // jest.config.ts, with a custom rootDir: <rootDir> is `src`.
      'jestts/package.json': JSON.stringify({ name: 'jestts' }),
      'jestts/jest.config.ts': "import type { Config } from 'jest';\nconst config: Config = {\n  rootDir: 'src',\n  moduleDirectories: ['node_modules', '<rootDir>'],\n};\nexport default config;\n",
      'jestts/src/core/engine.ts': 'export function engine() { return 1; }\n',
      'jestts/src/run.ts': "import { engine } from 'core/engine';\ntest('x', () => { engine(); });\n",
      'jestts/outside.ts': "import { engine } from 'core/engine';\nexport function o() { return engine(); }\n",
      // jest `roots` are where tests are searched for, not where modules resolve from.
      'jestroots/package.json': JSON.stringify({ name: 'jestroots', jest: { roots: ['<rootDir>/src'] } }),
      'jestroots/src/mod.js': 'export function mod() { return 1; }\n',
      'jestroots/test/x.test.js': "import { mod } from 'mod';\ntest('x', () => { mod(); });\n",
      // jest with only the default `moduleDirectories` sets no root.
      'jestdefault/package.json': JSON.stringify({ name: 'jestdefault', jest: { moduleDirectories: ['node_modules'] } }),
      'jestdefault/services/api.js': 'export function api() { return 1; }\n',
      'jestdefault/test/api.test.js': "import { api } from 'services/api';\ntest('x', () => { api(); });\n",
      // webpack `resolve.modules`: path.resolve(__dirname, 'src') (a fixed folder).
      'wp/package.json': JSON.stringify({ name: 'wp', devDependencies: { webpack: '^5.0.0' } }),
      'wp/webpack.config.js': "const path = require('path');\nmodule.exports = {\n  resolve: {\n    modules: [path.resolve(__dirname, 'src'), 'node_modules'],\n  },\n};\n",
      'wp/src/models/user.js': USER_MODULE,
      'wp/src/app/main.js': "import { save } from 'models/user';\nexport function go() { return save(); }\n",
      // `[__dirname, 'node_modules']`: the folder of the config.
      'wp2/package.json': JSON.stringify({ name: 'wp2', devDependencies: { webpack: '^5.0.0' } }),
      'wp2/webpack.config.js': "module.exports = { resolve: { modules: [__dirname, 'node_modules'] } };\n",
      'wp2/lib/util.js': 'export function util() { return 1; }\n',
      'wp2/app.js': "import { util } from 'lib/util';\nexport function go() { return util(); }\n",
      // A relative NAME ('src') is searched in every ancestor, like node_modules.
      'wp3/package.json': JSON.stringify({ name: 'wp3', devDependencies: { webpack: '^5.0.0' } }),
      'wp3/webpack.config.js': "module.exports = { resolve: { modules: ['src', 'node_modules'] } };\n",
      'wp3/src/shared/money.js': 'export function money() { return 1; }\n',
      'wp3/src/features/x/y.js': "import { money } from 'shared/money';\nexport function go() { return money(); }\n",
      'wp3/pages/p.js': "import { money } from 'shared/money';\nexport function page() { return money(); }\n",
      // path.join and the `.push` form of a webpack hook (Next.js, CRACO).
      'wp4/package.json': JSON.stringify({ name: 'wp4', dependencies: { next: '^14.0.0' } }),
      'wp4/next.config.js': "const path = require('path');\nmodule.exports = {\n  webpack(config) {\n    config.resolve.modules.push(path.join(__dirname, 'shared'));\n    return config;\n  },\n};\n",
      'wp4/shared/ui/Card.js': 'export function Card() { return null; }\n',
      'wp4/pages/index.js': "import { Card } from 'ui/Card';\nexport default function Home() { return Card(); }\n",
      // `resolveLoader.modules` is where loaders are looked up; `modules: ['node_modules']` adds no root.
      'wpl/package.json': JSON.stringify({ name: 'wpl', devDependencies: { webpack: '^5.0.0' } }),
      'wpl/webpack.config.js': "const path = require('path');\nmodule.exports = {\n  resolveLoader: { modules: [path.resolve(__dirname, 'loaders'), 'node_modules'] },\n};\n",
      'wpl/loaders/tool.js': 'module.exports = function tool() {};\n',
      'wpl/app.js': "import tool from 'tool';\nexport function go() { return tool(); }\n",
      'wpn/package.json': JSON.stringify({ name: 'wpn', devDependencies: { webpack: '^5.0.0' } }),
      'wpn/webpack.config.js': "module.exports = { resolve: { modules: ['node_modules'] } };\n",
      'wpn/lib/thing.js': 'export function thing() { return 1; }\n',
      'wpn/app.js': "import { thing } from 'lib/thing';\nexport function go() { return thing(); }\n",
      // NODE_PATH=. in a script (review case K): colliding member names, so only the edge names the file.
      'np/package.json': JSON.stringify({ name: 'np', scripts: { start: 'NODE_PATH=. node main.js' } }),
      'np/main.js': "const a = require('lib/a');\nconst user = require('models/user');\nconst { find } = require('models/post');\nfunction go() { a.run(); a.only(); user.save(); find(); }\nmodule.exports = go;\n",
      'np/esm.js': "import { run } from 'lib/a';\nimport * as post from 'models/post';\nimport user from 'models/user';\nexport function go2() { run(); post.save(); user.save(); }\n",
      'np/lib/a.js': 'module.exports = { run() { return 1; }, only() { return 1; } };\n',
      'np/lib/b.js': 'module.exports = { run() { return 2; } };\n',
      'np/models/user.js': USER_MODULE,
      'np/models/post.js': USER_MODULE,
      // `:`-separated, relative to the package, behind cross-env.
      'np2/package.json': JSON.stringify({ name: 'np2', scripts: { test: 'cross-env NODE_PATH=src:./shared jest', build: 'tsc' } }),
      'np2/src/a/x.js': 'export function x() { return 1; }\n',
      'np2/shared/y.js': 'export function y() { return 1; }\n',
      'np2/main.js': "import { x } from 'a/x';\nimport { y } from 'y';\nexport function go() { return x() + y(); }\n",
      // Nothing configures a module root here.
      'nocfg/package.json': JSON.stringify({ name: 'nocfg', dependencies: { express: '^4.18.0' } }),
      'nocfg/express.js': 'module.exports = function express() {};\n',
      'nocfg/models/user.js': USER_MODULE,
      'nocfg/main.js': "const express = require('express');\nconst user = require('models/user');\nfunction go() { express(); return user.save(); }\nmodule.exports = go;\n",
      // Order. A listed package, a built-in and a workspace package beat a root searched after node_modules
      // (NODE_PATH, jest, webpack after 'node_modules'); a root listed before node_modules beats the package.
      'prec/package.json': JSON.stringify({ name: 'prec', dependencies: { express: '^4.18.0' }, scripts: { start: 'NODE_PATH=. node app.js' } }),
      'prec/express.js': 'module.exports = function express() {};\n',
      'prec/path.js': 'module.exports = {};\n',
      'prec/models/user.js': USER_MODULE,
      'prec/app.js': "const express = require('express');\nconst path = require('path');\nconst user = require('models/user');\nconst missing = require('missing/thing');\nfunction go() { express(); path.join('a'); return user.save() + missing; }\nmodule.exports = go;\n",
      'precw/package.json': JSON.stringify({ name: 'precw', dependencies: { express: '^4.18.0' }, devDependencies: { webpack: '^5.0.0' } }),
      'precw/webpack.config.js': "module.exports = { resolve: { modules: [__dirname, 'node_modules'] } };\n",
      'precw/express.js': 'module.exports = function express() {};\n',
      'precw/app.js': "import express from 'express';\nexport function go() { return express(); }\n",
      'precl/package.json': JSON.stringify({ name: 'precl', dependencies: { express: '^4.18.0' }, devDependencies: { webpack: '^5.0.0' } }),
      'precl/webpack.config.js': "module.exports = { resolve: { modules: ['node_modules', __dirname] } };\n",
      'precl/express.js': 'module.exports = function express() {};\n',
      'precl/app.js': "import express from 'express';\nexport function go() { return express(); }\n",
      'wsp/package.json': JSON.stringify({ name: 'wsp', private: true, scripts: { start: 'NODE_PATH=. node app.js' } }),
      'wsp/packages/kernel/package.json': JSON.stringify({ name: 'kernel', main: 'index.js' }),
      'wsp/packages/kernel/index.js': 'exports.kernel = function kernel() {};\n',
      'wsp/kernel.js': 'exports.decoy = function decoy() {};\n',
      'wsp/app.js': "const { kernel } = require('kernel');\nfunction go() { return kernel(); }\nmodule.exports = go;\n",
      // A spread of the defaults before the root puts the root after node_modules.
      'precs/package.json': JSON.stringify({ name: 'precs', dependencies: { express: '^4.18.0' }, devDependencies: { webpack: '^5.0.0' } }),
      'precs/webpack.config.js': "const defaults = ['node_modules'];\nmodule.exports = { resolve: { modules: [...defaults, __dirname] } };\n",
      'precs/express.js': 'module.exports = function express() {};\n',
      'precs/app.js': "import express from 'express';\nexport function go() { return express(); }\n",
      // A root listed before node_modules also beats a workspace package.
      'wspw/package.json': JSON.stringify({ name: 'wspw', private: true, devDependencies: { webpack: '^5.0.0' } }),
      'wspw/webpack.config.js': "module.exports = { resolve: { modules: [__dirname, 'node_modules'] } };\n",
      'wspw/packages/kernel2/package.json': JSON.stringify({ name: 'kernel2', main: 'index.js' }),
      'wspw/packages/kernel2/index.js': 'exports.pkg = function pkg() {};\n',
      'wspw/kernel2.js': 'exports.root = function root() {};\n',
      'wspw/app.js': "const { root } = require('kernel2');\nfunction go() { return root(); }\nmodule.exports = go;\n",
      // A root belongs to the folder that declares it: wp5's config says nothing about the workspace root's shared/.
      'shared/zed.js': 'export function zed() { return 1; }\n',
      'wp5/package.json': JSON.stringify({ name: 'wp5', devDependencies: { webpack: '^5.0.0' } }),
      'wp5/webpack.config.js': "module.exports = { resolve: { modules: ['shared', 'node_modules'] } };\n",
      'wp5/app.js': "import { zed } from 'zed';\nexport function go() { return zed(); }\n",
      // A jest config with `projects` declares its roots per project, which MapX does not follow.
      'jestprojkey/package.json': JSON.stringify({ name: 'jestprojkey', jest: { projects: [{ displayName: 'a', moduleDirectories: ['node_modules', '<rootDir>'] }] } }),
      'jestprojkey/services/api.js': 'export function api() { return 1; }\n',
      'jestprojkey/test/api.test.js': "import { api } from 'services/api';\ntest('x', () => { api(); });\n",
      'jestproj/package.json': JSON.stringify({ name: 'jestproj' }),
      'jestproj/jest.config.js': "module.exports = {\n  projects: [{ displayName: 'a', moduleDirectories: ['node_modules', '<rootDir>'] }],\n};\n",
      'jestproj/services/api.js': 'export function api() { return 1; }\n',
      'jestproj/test/api.test.js': "import { api } from 'services/api';\ntest('x', () => { api(); });\n",
      // A list the reader cannot see through (a spread of the defaults, a call, a variable, a concat) stands for
      // node_modules too: roots around it never beat a listed package, and a list it cannot read gives none.
      'jestspread/package.json': JSON.stringify({ name: 'jestspread', dependencies: { react: '^18.0.0' } }),
      'jestspread/jest.config.js': "const { defaults } = require('jest-config');\nmodule.exports = { moduleDirectories: [...defaults.moduleDirectories, 'src'] };\n",
      'jestspread/src/react.js': 'export function createElement() { return null; }\n',
      'jestspread/src/helpers.js': 'export function help() { return 1; }\n',
      'jestspread/src/app.js': "import { createElement } from 'react';\nimport { help } from 'helpers';\nexport function go() { return [createElement(), help()]; }\n",
      'jestconcat/package.json': JSON.stringify({ name: 'jestconcat', dependencies: { react: '^18.0.0' } }),
      'jestconcat/jest.config.js': "module.exports = { moduleDirectories: ['src'].concat(['node_modules']) };\n",
      'jestconcat/src/react.js': 'export function createElement() { return null; }\n',
      'jestconcat/src/app.js': "import { createElement } from 'react';\nexport function go() { return createElement(); }\n",
      'jestvar/package.json': JSON.stringify({ name: 'jestvar', dependencies: { react: '^18.0.0' } }),
      'jestvar/jest.config.js': "const dirs = ['src'];\nmodule.exports = { moduleDirectories: dirs };\n",
      'jestvar/src/react.js': 'export function createElement() { return null; }\n',
      'jestvar/src/app.js': "import { createElement } from 'react';\nexport function go() { return createElement(); }\n",
      'wpcall/package.json': JSON.stringify({ name: 'wpcall', dependencies: { react: '^18.0.0' }, devDependencies: { webpack: '^5.0.0' } }),
      'wpcall/webpack.config.js': "module.exports = { resolve: { modules: [lookup(), 'src'] } };\n",
      'wpcall/src/react.js': 'export function createElement() { return null; }\n',
      'wpcall/src/app.js': "import { createElement } from 'react';\nexport function go() { return createElement(); }\n",
      'wpconcat/package.json': JSON.stringify({ name: 'wpconcat', dependencies: { react: '^18.0.0' }, devDependencies: { webpack: '^5.0.0' } }),
      'wpconcat/webpack.config.js': "module.exports = { resolve: { modules: ['src'].concat(['node_modules']) } };\n",
      'wpconcat/src/react.js': 'export function createElement() { return null; }\n',
      'wpconcat/src/app.js': "import { createElement } from 'react';\nexport function go() { return createElement(); }\n",
      'jesttwo/package.json': JSON.stringify({ name: 'jesttwo' }),
      'jesttwo/jest.config.js': "const base = { moduleDirectories: ['node_modules', '<rootDir>'] };\nmodule.exports = { ...other, moduleDirectories: ['node_modules'] };\n",
      'jesttwo/services/api.js': 'export function api() { return 1; }\n',
      'jesttwo/test/api.test.js': "import { api } from 'services/api';\ntest('x', () => { api(); });\n",
      // The nearest config of a kind decides, even when it declares no root.
      'nest/package.json': JSON.stringify({ name: 'nest', private: true, jest: { moduleDirectories: ['node_modules', '<rootDir>/shared'] } }),
      'nest/shared/models/user.js': USER_MODULE,
      'nest/t0.js': "const user = require('models/user');\nfunction go() { return user.save(); }\nmodule.exports = go;\n",
      'nest/packages/a/package.json': JSON.stringify({ name: 'a', jest: { preset: 'ts-jest' } }),
      'nest/packages/a/t.js': "const user = require('models/user');\nfunction go() { return user.save(); }\nmodule.exports = go;\n",
      'nestw/package.json': JSON.stringify({ name: 'nestw', devDependencies: { webpack: '^5.0.0' } }),
      'nestw/webpack.config.js': "module.exports = { resolve: { modules: [__dirname, 'node_modules'] } };\n",
      'nestw/lib/x.js': 'export function x() { return 1; }\n',
      'nestw/b.js': "import { x } from 'lib/x';\nexport function go() { return x(); }\n",
      'nestw/sub/webpack.config.js': 'module.exports = {};\n',
      'nestw/sub/a.js': "import { x } from 'lib/x';\nexport function go() { return x(); }\n",
      // Only the top-level keys are read, and a jest `projects` object declares its options per project.
      'jestprojobj/package.json': JSON.stringify({ name: 'jestprojobj', jest: { projects: ['<rootDir>/a'], moduleDirectories: ['node_modules', '<rootDir>'] } }),
      'jestprojobj/services/api.js': 'export function api() { return 1; }\n',
      'jestprojobj/test/api.test.js': "import { api } from 'services/api';\ntest('x', () => { api(); });\n",
      'jestglobals/package.json': JSON.stringify({ name: 'jestglobals' }),
      'jestglobals/jest.config.js': "module.exports = { globals: { moduleDirectories: ['node_modules', '<rootDir>'] } };\n",
      'jestglobals/services/api.js': 'export function api() { return 1; }\n',
      'jestglobals/test/api.test.js': "import { api } from 'services/api';\ntest('x', () => { api(); });\n",
      'wpext/package.json': JSON.stringify({ name: 'wpext', devDependencies: { webpack: '^5.0.0' } }),
      'wpext/webpack.config.js': "module.exports = { externals: { resolve: { modules: [__dirname, 'node_modules'] } } };\n",
      'wpext/lib/x.js': 'export function x() { return 1; }\n',
      'wpext/app.js': "import { x } from 'lib/x';\nexport function go() { return x(); }\n",
      // tsconfig `baseUrl` is tried before a module root.
      'bu/package.json': JSON.stringify({ name: 'bu', scripts: { start: 'NODE_PATH=. node app.js' } }),
      'bu/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
      'bu/src/models/user.ts': 'export function viaBaseUrl() { return 1; }\n',
      'bu/models/user.ts': 'export function viaRoot() { return 2; }\n',
      'bu/app.ts': "import { viaBaseUrl } from 'models/user';\nexport function go() { return viaBaseUrl(); }\n",
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('jest moduleDirectories ["<rootDir>"]: the import, the type-only, constant and side-effect imports link (cases G, J)', () => {
    expect(importTargets(root, 'jestkey/test/api.test.js')).toEqual(['jestkey/services/api.js']);
    expect(edgesFrom(root, 'jestkey/test/api.test.js')).toEqual(['null call jestkey/services/api.js#api']);
    expect(importTargets(root, 'jestkey/app/main.tsx')).toEqual(['jestkey/components/Btn.tsx', 'jestkey/config/settings.ts', 'jestkey/models/user.ts']);
    expect(edgesFrom(root, 'jestkey/app/main.tsx')).toEqual([
      'f instantiation jestkey/models/user.ts#Account',
      'f render jestkey/components/Btn.tsx#Btn',
    ]);
  });

  it('jest moduleDirectories names are searched in every ancestor of the importing file', () => {
    expect(importTargets(root, 'jestcfg/src/deep/a/use.js')).toEqual(['jestcfg/src/utils/fmt.js']);
    expect(importTargets(root, 'jestcfg/test/use.test.js')).toEqual(['jestcfg/src/utils/fmt.js']);
  });

  it('jest modulePaths and a custom rootDir are read from jest.config.json and jest.config.ts', () => {
    expect(importTargets(root, 'jestpaths/pkg/test/h.test.js')).toEqual(['jestpaths/pkg/lib/helpers.js']);
    expect(importTargets(root, 'jestts/src/run.ts')).toEqual(['jestts/src/core/engine.ts']);
    // The config governs the files under its rootDir only.
    expect(importTargets(root, 'jestts/outside.ts')).toEqual([]);
  });

  it('jest `roots` and the default moduleDirectories are no module root', () => {
    expect(importTargets(root, 'jestroots/test/x.test.js')).toEqual([]);
    expect(importTargets(root, 'jestdefault/test/api.test.js')).toEqual([]);
  });

  it('webpack resolve.modules: path.resolve(__dirname, "src"), __dirname, a relative name, .push(path.join(…))', () => {
    expect(importTargets(root, 'wp/src/app/main.js')).toEqual(['wp/src/models/user.js']);
    expect(edgesFrom(root, 'wp/src/app/main.js')).toEqual(['go call wp/src/models/user.js#save']);
    expect(importTargets(root, 'wp2/app.js')).toEqual(['wp2/lib/util.js']);
    expect(importTargets(root, 'wp3/src/features/x/y.js')).toEqual(['wp3/src/shared/money.js']);
    expect(importTargets(root, 'wp3/pages/p.js')).toEqual(['wp3/src/shared/money.js']);
    expect(importTargets(root, 'wp4/pages/index.js')).toEqual(['wp4/shared/ui/Card.js']);
  });

  it('resolveLoader.modules and modules: ["node_modules"] are no module root', () => {
    expect(importTargets(root, 'wpl/app.js')).toEqual([]);
    expect(importTargets(root, 'wpn/app.js')).toEqual([]);
  });

  it('NODE_PATH=. in a script: require and import link the files, and colliding names keep their own call edges (case K)', () => {
    expect(importTargets(root, 'np/main.js')).toEqual(['np/lib/a.js', 'np/models/post.js', 'np/models/user.js']);
    expect(edgesFrom(root, 'np/main.js')).toEqual([
      'go call np/lib/a.js#only',
      'go call np/lib/a.js#run',
      'go call np/models/post.js#find',
      'go call np/models/user.js#save',
    ]);
    expect(importTargets(root, 'np/esm.js')).toEqual(['np/lib/a.js', 'np/models/post.js', 'np/models/user.js']);
    expect(edgesFrom(root, 'np/esm.js')).toEqual(['go2 call np/lib/a.js#run', 'go2 call np/models/post.js#save']);
  });

  it('NODE_PATH with several entries, behind cross-env, relative to the package', () => {
    expect(importTargets(root, 'np2/main.js')).toEqual(['np2/shared/y.js', 'np2/src/a/x.js']);
  });

  it('a bare package import with no such configuration still links no project file', () => {
    expect(importTargets(root, 'nocfg/main.js')).toEqual([]);
    expect(edgesFrom(root, 'nocfg/main.js').filter((e) => e.includes('express.js'))).toEqual([]);
  });

  it('a package, a built-in and a workspace package beat a root searched after node_modules', () => {
    // prec: NODE_PATH=. beside express (listed) and a root path.js (a built-in): only models/user links.
    expect(importTargets(root, 'prec/app.js')).toEqual(['prec/models/user.js']);
    // precl: webpack lists node_modules first.
    expect(importTargets(root, 'precl/app.js')).toEqual([]);
    expect(importTargets(root, 'precs/app.js')).toEqual([]);
    // wsp: the workspace package is in node_modules, so it beats the NODE_PATH root's kernel.js.
    expect(importTargets(root, 'wsp/app.js')).toEqual(['wsp/packages/kernel/index.js']);
  });

  it('a list the reader cannot see through stands for node_modules; one it cannot read gives no root', () => {
    // [...defaults, 'src']: src is searched after node_modules, so the listed react wins; a plain file still links.
    expect(importTargets(root, 'jestspread/src/app.js')).toEqual(['jestspread/src/helpers.js']);
    expect(importTargets(root, 'jestconcat/src/app.js')).toEqual([]);
    expect(importTargets(root, 'jestvar/src/app.js')).toEqual([]);
    expect(importTargets(root, 'wpcall/src/app.js')).toEqual([]);
    expect(importTargets(root, 'wpconcat/src/app.js')).toEqual([]);
    // Two top-level objects set the key: which one is exported is not known.
    expect(importTargets(root, 'jesttwo/test/api.test.js')).toEqual([]);
  });

  it('the nearest jest or webpack config decides, even when it declares no root', () => {
    expect(importTargets(root, 'nest/t0.js')).toEqual(['nest/shared/models/user.js']);
    expect(importTargets(root, 'nest/packages/a/t.js')).toEqual([]);
    expect(importTargets(root, 'nestw/b.js')).toEqual(['nestw/lib/x.js']);
    expect(importTargets(root, 'nestw/sub/a.js')).toEqual([]);
  });

  it('only top-level keys are read: jest globals and projects, webpack externals', () => {
    expect(importTargets(root, 'jestprojobj/test/api.test.js')).toEqual([]);
    expect(importTargets(root, 'jestglobals/test/api.test.js')).toEqual([]);
    expect(importTargets(root, 'wpext/app.js')).toEqual([]);
  });

  it('a name node_modules supplies is not recorded as unresolved under a late root', () => {
    const recorded = (file: string) => String(query<{ metadata: string }>(root, 'SELECT metadata FROM files WHERE path = ?', file)[0]?.metadata);
    // prec: express (listed) and path (built-in) are gated; the missing module is recorded under the root.
    expect(recorded('prec/app.js')).toContain('prec/missing/thing');
    expect(recorded('prec/app.js')).not.toMatch(/prec\/(express|path)/);
  });

  it('a root listed before node_modules beats the package of that name, and a workspace package', () => {
    expect(importTargets(root, 'precw/app.js')).toEqual(['precw/express.js']);
    expect(importTargets(root, 'wspw/app.js')).toEqual(['wspw/kernel2.js']);
  });

  it('a root belongs to the folder that declares it, and a jest `projects` config is not followed', () => {
    expect(importTargets(root, 'wp5/app.js')).toEqual([]);
    expect(importTargets(root, 'jestproj/test/api.test.js')).toEqual([]);
    expect(importTargets(root, 'jestprojkey/test/api.test.js')).toEqual([]);
  });

  it('tsconfig baseUrl is tried before a module root', () => {
    expect(importTargets(root, 'bu/app.ts')).toEqual(['bu/src/models/user.ts']);
  });

  it('a specifier a module root resolves is no npm external candidate', () => {
    for (const dir of ['jestkey', 'jestcfg', 'jestpaths', 'wp', 'wp2', 'wp3', 'wp4', 'precw']) expect(externalSpecifiers(root, `${dir}/`)).toEqual([]);
    expect(externalSpecifiers(root, 'np/')).toEqual([]);
    expect(externalSpecifiers(root, 'np2/')).toEqual([]);
    // Where nothing configures a root the specifiers stay candidates, as before.
    expect(externalSpecifiers(root, 'nocfg/')).toEqual(['nocfg/main.js express', 'nocfg/main.js models/user']);
  });
});

describe('sync agrees with scan --force when a module root is configured later (M2-08-R11)', () => {
  let root: string;
  const mainJs = "const user = require('models/user');\nconst late = require('late/thing');\nfunction go() { late.run(); return user.save(); }\nmodule.exports = go;\n";
  beforeEach(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'main.js': mainJs,
      'models/user.js': USER_MODULE,
      'models/post.js': USER_MODULE,
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const targets = () => importTargets(root, 'main.js');

  it('a NODE_PATH script, edited into package.json and out again', () => {
    expect(targets()).toEqual([]);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { start: 'NODE_PATH=. node main.js' } }));
    mapx(root, 'sync', '.');
    expect(targets()).toEqual(['models/user.js']);
    expect(edgesFrom(root, 'main.js')).toEqual(['go call models/user.js#save']);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    mapx(root, 'sync', '.');
    expect(targets()).toEqual([]);
  }, 120000);

  it('a jest.config.js and a webpack.config.js added, edited and removed', () => {
    writeFileSync(join(root, 'jest.config.js'), "module.exports = { moduleDirectories: ['node_modules', '<rootDir>'] };\n");
    mapx(root, 'sync', '.');
    expect(targets()).toEqual(['models/user.js']);
    writeFileSync(join(root, 'jest.config.js'), "module.exports = { moduleDirectories: ['node_modules'] };\n");
    mapx(root, 'sync', '.');
    expect(targets()).toEqual([]);
    writeFileSync(join(root, 'webpack.config.js'), "module.exports = { resolve: { modules: [__dirname, 'node_modules'] } };\n");
    mapx(root, 'sync', '.');
    expect(targets()).toEqual(['models/user.js']);
    rmSync(join(root, 'webpack.config.js'));
    mapx(root, 'sync', '.');
    expect(targets()).toEqual([]);
  }, 120000);

  it('a module added under the root later re-links the call of the importer that named it', () => {
    writeFileSync(join(root, 'main2.js'), "import { run } from 'models/other';\nexport function go3() { return run(); }\n");
    writeFileSync(join(root, 'models/run.js'), 'export function run() { return 0; }\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { start: 'NODE_PATH=. node main.js' } }));
    mapx(root, 'sync', '.');
    expect(edgesFrom(root, 'main2.js')).toEqual(['go3 call models/run.js#run']);
    writeFileSync(join(root, 'models/other.js'), 'export function run() { return 1; }\n');
    mapx(root, 'sync', '.');
    expect(edgesFrom(root, 'main2.js')).toEqual(['go3 call models/other.js#run']);
    const synced = edgesFrom(root, 'main2.js');
    mapx(root, 'scan', '.', '--force');
    expect(edgesFrom(root, 'main2.js')).toEqual(synced);
  }, 120000);

  it('a module with no symbol, added under the root later, links the importer that required it', () => {
    writeFileSync(join(root, 'side.js'), "require('models/side');\n");
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { start: 'NODE_PATH=. node side.js' } }));
    mapx(root, 'sync', '.');
    expect(importTargets(root, 'side.js')).toEqual([]);
    writeFileSync(join(root, 'models/side.js'), 'console.log(1);\n');
    mapx(root, 'sync', '.');
    expect(importTargets(root, 'side.js')).toEqual(['models/side.js']);
    mapx(root, 'scan', '.', '--force');
    expect(importTargets(root, 'side.js')).toEqual(['models/side.js']);
  }, 120000);

  it('a module added under the root later links the importer that named it', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { start: 'NODE_PATH=. node main.js' } }));
    mapx(root, 'sync', '.');
    expect(targets()).toEqual(['models/user.js']);
    mkdirSync(join(root, 'late'));
    writeFileSync(join(root, 'late/thing.js'), 'exports.run = function run() {};\n');
    mapx(root, 'sync', '.');
    expect(targets()).toEqual(['late/thing.js', 'models/user.js']);
    const synced = edgesFrom(root, 'main.js');
    mapx(root, 'scan', '.', '--force');
    expect(targets()).toEqual(['late/thing.js', 'models/user.js']);
    expect(edgesFrom(root, 'main.js')).toEqual(synced);
  }, 120000);
});
