import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { declaredGlobalNames } from '../src/core/js-source.js';
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
