import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-08: a call of a name the file imports from a project module links that module's declaration
// (through re-exports), never another file's same-named symbol; unimported names keep name lookup.
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' });
type Edge = { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string };

function callsFrom(root: string, file: string) {
  const edges = query<Edge>(root, `SELECT source_file, source_symbol, target_file, target_symbol FROM edges
    WHERE edge_type IN ('call', 'instantiation') AND source_file = ? ORDER BY 1, 2, 3, 4`, file);
  return (symbol: string) => edges.filter((e) => e.source_symbol === symbol).map((e) => `${e.target_file}#${e.target_symbol}`);
}

describe('JS/TS calls through the file\'s imports (real scan)', () => {
  let root: string;
  let from: (symbol: string) => string[];
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      // Name lookup would pick these: same folder as the caller.
      'src/app/helpers.ts': 'export function create() { return 0; }\nexport function shout() { return 0; }\nexport function build() { return 0; }\nexport function local() { return 0; }\n',
      'src/lib/utils.ts': 'export function create(x?: number) { return x; }\n',
      'src/lib/build.ts': 'export default function build() { return 1; }\n',
      'src/lib/impl.ts': 'export function shout() { return 2; }\nexport function whisper() { return 3; }\n',
      'src/lib/more.ts': 'export function whisper() { return 4; }\n',
      'src/lib/index.ts': "export { shout } from './impl';\nexport * from './more';\n",
      'src/app/main.ts': `import { create } from '../lib/utils';
import { create as make } from '../lib/utils';
import * as u from '../lib/utils';
import build from '../lib/build';
import { shout, whisper } from '../lib';

export function viaNamed() { return create(1); }
export function viaAlias() { return make(); }
export function viaNamespace() { return u.create(); }
export function viaDefault() { return build(); }
export function viaReexport() { return shout(); }
export function viaStar() { return whisper(); }
export function unimported() { return local(); }
`,
      'src/app/legacy.js': "const { create: mk } = require('../lib/utils');\nfunction viaRequire() { return mk(); }\nmodule.exports = { viaRequire };\n",
    });
    init(root);
    mapx(root, 'scan', '.');
    from = callsFrom(root, 'src/app/main.ts');
  }, 120000);
  afterAll(() => cleanup(root));

  it('links a named import to the imported module, over a same-named function in the caller\'s folder', () => {
    expect(from('viaNamed')).toEqual(['src/lib/utils.ts#create']);
  });

  it('follows aliases, namespace imports and default imports', () => {
    expect(from('viaAlias')).toEqual(['src/lib/utils.ts#create']);
    expect(from('viaNamespace')).toEqual(['src/lib/utils.ts#create']);
    expect(from('viaDefault')).toEqual(['src/lib/build.ts#build']);
  });

  it('follows export { x } from and export * re-exports', () => {
    expect(from('viaReexport')).toEqual(['src/lib/impl.ts#shout']);
    expect(from('viaStar')).toEqual(['src/lib/more.ts#whisper']);
  });

  it('follows require destructuring with a rename', () => {
    expect(callsFrom(root, 'src/app/legacy.js')('viaRequire')).toEqual(['src/lib/utils.ts#create']);
  });

  it('keeps name lookup for a name the file does not import', () => {
    expect(from('unimported')).toEqual(['src/app/helpers.ts#local']);
  });
});

describe('Python calls through the file\'s imports (real scan)', () => {
  let root: string;
  let from: (symbol: string) => string[];
  beforeAll(() => {
    root = workspace({
      // Alphabetically first in the caller's folder: name lookup's pick.
      'app/aaa.py': 'def create():\n    return 0\n\ndef thing():\n    return 0\n\ndef helper():\n    return 0\n',
      'app/utils.py': 'def create():\n    return 1\n',
      'app/pkg/__init__.py': 'from .impl import helper\n',
      'app/pkg/impl.py': 'def helper():\n    return 2\n',
      'app/pkg/mod.py': 'def thing():\n    return 3\n',
      'app/main.py': `from utils import create
from utils import create as c
import utils
from pkg import mod
from pkg import helper


def via_named():
    return create()


def via_alias():
    return c()


def via_module():
    return utils.create()


def via_submodule():
    return mod.thing()


def via_package():
    return helper()
`,
    });
    init(root);
    mapx(root, 'scan', '.');
    from = callsFrom(root, 'app/main.py');
  }, 120000);
  afterAll(() => cleanup(root));

  it('links from-imports, aliases and module attribute calls to the imported module', () => {
    expect(from('via_named')).toEqual(['app/utils.py#create']);
    expect(from('via_alias')).toEqual(['app/utils.py#create']);
    expect(from('via_module')).toEqual(['app/utils.py#create']);
  });

  it('links a submodule import and a name re-exported by a package __init__', () => {
    expect(from('via_submodule')).toEqual(['app/pkg/mod.py#thing']);
    expect(from('via_package')).toEqual(['app/pkg/impl.py#helper']);
  });
});

describe('import-bound calls: shadowing, comments, values and other forms (review 2026-11-01)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'src/app/helpers.ts': 'export function ghost() { return 0; }\nexport function create() { return 0; }\n',
      'src/lib/utils.ts': 'export function create() { return 1; }\nexport const options = { retry: 1 };\n',
      'src/lib/old.ts': 'export function create() { return 2; }\n',
      'src/app/main.ts': `import { create, options, ghost } from '../lib/utils';
// Previously: import { create } from '../lib/old';
/* import { create } from '../lib/old'; */

export function viaImport() { return create(); }
export function literal() { return options(); }
export function missing() { return ghost(); }
export function shadowed() {
  function create() { return 3; }
  return create();
}
`,
      'src/app/ns.js': "const lib = require('../lib/utils');\nfunction viaNamespace() { return lib.create(); }\nmodule.exports = { viaNamespace };\n",
      'src/app/Widget.vue': "<script setup>\nimport { create } from '../lib/utils';\nfunction onSave() { return create(); }\n</script>\n<template><button @click=\"onSave\">x</button></template>\n",
      'src/app/Card.svelte': "<script>\nimport { create } from '../lib/utils';\nfunction save() { return create(); }\n</script>\n<button on:click={save}>x</button>\n",
      'app/aaa.py': 'def create():\n    return 0\n\ndef thing():\n    return 0\n',
      'app/utils.py': 'def create():\n    return 1\n',
      'app/other_mod.py': 'def create():\n    return 2\n',
      'app/pkg/__init__.py': '',
      'app/pkg/mod.py': 'def thing():\n    return 3\n',
      'app/pkg/rel.py': 'from .mod import (\n    thing,\n)\n\n\ndef via_relative():\n    return thing()\n',
      'app/main.py': `"""
from other_mod import create
"""
import utils
import pkg.mod
import pkg.mod as pm
from other_mod import create
from utils import create as run


def dotted():
    return pkg.mod.thing()


def aliased_module():
    return pm.thing()


def two_on_line():
    return utils.create(create())


def run():
    return 0


def caller():
    return run()
`,
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterAll(() => cleanup(root));

  it('ignores commented-out imports and gives an imported literal no edge (M0-17-R2)', () => {
    const from = callsFrom(root, 'src/app/main.ts');
    expect(from('viaImport')).toEqual(['src/lib/utils.ts#create']);
    expect(from('literal')).toEqual([]);
  });

  // M2-08-R1: a name imported from a project module that neither declares nor re-exports it links
  // nothing, never another file's same-named symbol (review 2026-11-02).
  it('gives no edge when the imported project module does not declare the name', () => {
    expect(callsFrom(root, 'src/app/main.ts')('missing')).toEqual([]);
  });

  it('lets a declaration in the file shadow the import', () => {
    expect(callsFrom(root, 'src/app/main.ts')('shadowed')).toEqual(['src/app/main.ts#create']);
    // A later top-level def rebinds the imported name.
    expect(callsFrom(root, 'app/main.py')('caller')).toEqual(['app/main.py#run']);
  });

  it('resolves a require namespace, and imports in .vue and .svelte scripts', () => {
    expect(callsFrom(root, 'src/app/ns.js')('viaNamespace')).toEqual(['src/lib/utils.ts#create']);
    expect(callsFrom(root, 'src/app/Widget.vue')('onSave')).toEqual(['src/lib/utils.ts#create']);
    expect(callsFrom(root, 'src/app/Card.svelte')('save')).toEqual(['src/lib/utils.ts#create']);
  });

  it('resolves dotted and aliased Python module calls, and relative parenthesised imports', () => {
    const from = callsFrom(root, 'app/main.py');
    expect(from('dotted')).toEqual(['app/pkg/mod.py#thing']);
    expect(from('aliased_module')).toEqual(['app/pkg/mod.py#thing']);
    expect(callsFrom(root, 'app/pkg/rel.py')('via_relative')).toEqual(['app/pkg/mod.py#thing']);
  });

  it('does not guess which of two same-named calls on one line is the module call', () => {
    // utils.create(create()): both fall back to name lookup, never both to utils.py.
    const targets = callsFrom(root, 'app/main.py')('two_on_line');
    expect(targets.filter((t) => t === 'app/utils.py#create').length).toBeLessThan(2);
  });
});

describe('sync follows changes to imported modules and barrels (review 2026-11-01)', () => {
  let root: string;
  beforeEach(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'src/app/helpers.ts': 'export function create() { return 0; }\nexport function run() { return 0; }\nexport function starred() { return 0; }\n',
      'src/lib/impl.ts': 'export function shout() { return 1; }\n',
      // M2-08-R1: modules behind an `export … from` and an `export *` barrel (review 2026-11-02).
      'src/lib/base.ts': 'export function other2() { return 0; }\n',
      'src/lib/star.ts': "export * from './starimpl';\n",
      'src/lib/starimpl.ts': 'export function other3() { return 0; }\n',
      'src/app/barrels.ts': "import { run } from '../lib';\nimport { starred } from '../lib/star';\nexport function runIt() { return run(); }\nexport function starIt() { return starred(); }\n",
      'src/lib/impl2.ts': 'export function shout() { return 2; }\n',
      'src/lib/index.ts': "export { shout } from './impl';\nexport { run } from './base';\n",
      'src/lib/utils.ts': 'export function other() { return 0; }\n',
      'src/app/main.ts': "import { shout } from '../lib';\nimport { create } from '../lib/utils';\nexport function go() { return shout(); }\nexport function make() { return create(); }\n",
    });
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const all = () => query<Edge>(root, `SELECT source_file, source_symbol, target_file, target_symbol FROM edges
    WHERE edge_type IN ('call', 'instantiation') ORDER BY 1, 2, 3, 4`);

  it.each([
    ['a barrel re-exporting from another module', (r: string) => writeFileSync(join(r, 'src/lib/index.ts'), "export { shout } from './impl2';\n"), 'src/lib/impl2.ts#shout', 'go'],
    ['an imported module gaining the imported name', (r: string) => writeFileSync(join(r, 'src/lib/utils.ts'), 'export function other() { return 0; }\nexport function create() { return 1; }\n'), 'src/lib/utils.ts#create', 'make'],
    ['the module behind an export-from barrel gaining the name', (r: string) => writeFileSync(join(r, 'src/lib/base.ts'), 'export function other2() { return 0; }\nexport function run() { return 1; }\n'), 'src/lib/base.ts#run', 'runIt', 'src/app/barrels.ts'],
    ['the module behind an export-star barrel gaining the name', (r: string) => writeFileSync(join(r, 'src/lib/starimpl.ts'), 'export function other3() { return 0; }\nexport function starred() { return 1; }\n'), 'src/lib/starimpl.ts#starred', 'starIt', 'src/app/barrels.ts'],
  ])('re-parses the importers after %s, so sync equals scan --force', (_name, change, expected, symbol, file = 'src/app/main.ts') => {
    // Before the change the imported name is declared nowhere behind the import: no edge (M2-08-R1).
    if (symbol === 'runIt' || symbol === 'starIt' || symbol === 'make') expect(callsFrom(root, file)(symbol)).toEqual([]);
    change(root);
    mapx(root, 'sync', '.');
    expect(callsFrom(root, file)(symbol)).toEqual([expected]);
    const synced = all();
    mapx(root, 'scan', '.', '--force');
    expect(synced).toEqual(all());
  }, 120000);
});

// M2-08-R1: the "absent" rule (no edge for a name the imported project module certainly lacks) and
// the comment stripper it reads through, on the shapes the 2026-11-02 review reproduced.
describe('names absent from the imported project module (M2-08-R1)', () => {
  let root: string;
  let from: (symbol: string) => string[];
  const FALLBACK = 'src/app/helpers.ts#run';
  const MODULES = ['str', 're', 'body', 'ext', 'cjs', 'star-compiled', 'assign', 'dynamic', 'two-star', 'no-star', 'pkg-star', 'alias', 'utils'];
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      // Name lookup would pick this one: same folder as every caller.
      'src/app/helpers.ts': 'export function run() { return 0; }\nexport function build() { return 0; }\n',
      'src/lib/impl.ts': 'export function run() { return 1; }\n',
      'src/lib/other.ts': 'export function other() { return 1; }\n',
      // Comment openers inside a string and a regex literal hide nothing.
      'src/lib/str.ts': "const accept = 'image/*';\nexport { run } from './impl';\n// */\n",
      'src/lib/re.ts': "const slash = /\\/*$/;\nexport { run } from './impl';\n// */\n",
      // A commented-out default export names nothing.
      'src/lib/build.ts': '// export default function legacyBuild() {}\nexport default function build() { return 1; }\n',
      // The name only inside a body: absent from the module's top level.
      'src/lib/body.ts': 'export function other() { const run = 1; return run; }\n',
      // The name at the top level, but not declared or re-exported: unknown, name lookup.
      'src/lib/ext.ts': "import { run } from 'some-pkg';\nexport function other() { return run(); }\n",
      // CommonJS and compiled exports: unknown.
      'src/lib/cjs.js': "module.exports = require('./impl');\n",
      'src/lib/star-compiled.js': '"use strict";\n__exportStar(require("./impl"), exports);\n',
      'src/lib/assign.js': "Object.assign(exports, require('./impl'));\n",
      'src/lib/dynamic.js': "const m = require('./impl');\nfor (const k of Object.keys(m)) exports[k] = m[k];\n",
      // Barrels: two stars, one resolving to the name; two stars, neither; a package star; a local alias.
      'src/lib/two-star.ts': "export * from './other';\nexport * from './impl';\n",
      'src/lib/no-star.ts': "export * from './other';\nexport * from './body';\n",
      'src/lib/pkg-star.ts': "export * from 'some-pkg';\nexport * from './other';\n",
      'src/lib/alias.ts': 'function a() { return 2; }\nexport { a as run };\n',
      // A file and a folder index of the same name: the file wins, as in Node and TypeScript.
      'src/lib/utils.ts': 'export function run() { return 3; }\n',
      'src/lib/utils/index.ts': 'export function other() { return 4; }\n',
      // One caller per module, each importing `run` unaliased, so name lookup would find helpers' run.
      ...Object.fromEntries(MODULES.map(m => [`src/app/use-${m}.ts`, `import { run } from '../lib/${m}';\nexport function call() { return run(); }\n`])),
      'src/app/use-build.ts': "import build from '../lib/build';\nexport function call() { return build(); }\n",
      // JSX and Vue template text is no code: an unterminated `/*` or an apostrophe in it hides nothing.
      // A later real comment closes the text's `/*`, and the `//` of a URL would end the line.
      'src/lib/help.tsx': "export function Help() {\n  return <p>Patterns like src/*.ts don't match.</p>;\n}\n/* re-exported */ export { run } from './impl';\n",
      'src/lib/note.tsx': "export function Note() { return <p>see https://example.com</p>; } export { run } from './impl';\n",
      'src/app/use-note.ts': "import { run } from '../lib/note';\nexport function call() { return run(); }\n",
      'src/app/use-help.ts': "import { run } from '../lib/help';\nexport function call() { return run(); }\n",
      'src/app/GlobHelp.vue': "<template>\n  <p>Patterns like src/*.ts don't match.</p>\n</template>\n<script setup lang=\"ts\">\nimport { run } from '../lib/impl';\n/* the run */\nconst out = run();\n</script>\n",

    });
    init(root);
    mapx(root, 'scan', '.');
    from = (m: string) => callsFrom(root, `src/app/use-${m}.ts`)('call');
  }, 120000);
  afterAll(() => cleanup(root));

  it('reads re-exports after a comment opener inside a string or a regex literal', () => {
    expect(from('str')).toEqual(['src/lib/impl.ts#run']);
    expect(from('re')).toEqual(['src/lib/impl.ts#run']);
  });

  it('reads past an unterminated /* and an apostrophe in JSX and Vue template text', () => {
    expect(from('help')).toEqual(['src/lib/impl.ts#run']);
    expect(from('note')).toEqual(['src/lib/impl.ts#run']);
    const vue = query<Edge>(root, "SELECT source_file, source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call' AND source_file = 'src/app/GlobHelp.vue' AND target_symbol = 'run'");
    expect(vue.map(e => `${e.target_file}#${e.target_symbol}`)).toEqual(['src/lib/impl.ts#run']);
  });

  it('ignores a commented-out default export', () => {
    expect(from('build')).toEqual(['src/lib/build.ts#build']);
  });

  it('gives no edge when the name is absent from the module and every export-star target', () => {
    expect(from('body')).toEqual([]);
    expect(from('no-star')).toEqual([]);
  });

  it('follows the export-star target that declares the name', () => {
    expect(from('two-star')).toEqual(['src/lib/impl.ts#run']);
  });

  it.each([
    ['the name occurs at the top level', 'ext'],
    ['module.exports = require(…)', 'cjs'],
    ['compiled __exportStar(require(…), exports)', 'star-compiled'],
    ['Object.assign(exports, …)', 'assign'],
    ['exports[k] = …', 'dynamic'],
    ['an export-star target outside the project', 'pkg-star'],
    ['a local export alias', 'alias'],
  ])('keeps name lookup when %s', (_name, symbol) => {
    expect(from(symbol)).toEqual([FALLBACK]);
  });

  it('resolves a module path to the file before the folder index', () => {
    expect(from('utils')).toEqual(['src/lib/utils.ts#run']);
  });
});

// D032 (M2-08-R1): sync re-parses the importers behind a barrel only when the module's exported
// names change; a body-only edit re-parses none. Both sync paths (git and content hashes).
describe.each([['git', true], ['hash', false]])('barrel importers in %s sync follow export changes only (D032)', (_mode, useGit) => {
  let root: string;
  const importers = ['a', 'b', 'c'];
  beforeEach(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'src/app/helpers.ts': 'export function added() { return 0; }\nexport function leafFn() { return 0; }\n',
      // A return type: the body is still a body (review 2026-11-02).
      'src/lib/leaf.ts': 'export function leafFn(): number { return 1; }\n',
      'src/lib/side.ts': 'export function sideFn() { return 1; }\n',
      'src/lib/index.ts': "export * from './leaf';\nexport * from './side';\n",
      // An import-then-export barrel (review 2026-11-02), and its importer.
      'src/lib/reexp.ts': "import { leafFn, added } from './leaf';\nexport { leafFn, added };\n",
      'src/app/d.ts': "import { added } from '../lib/reexp';\nexport function d2() { return added(); }\n",
      // JSX whose text and closing tags once cut the export skeleton short (review 2026-11-02).
      'src/lib/history.tsx': "export function History({ show, data }: { show: boolean; data: string }) {\n  return <div>{show && <pre data={data} />}</div>;\n}\nexport function Note() {\n  return <p>You don't have items, see https://example.com</p>;\n}\n",
      'src/app/e.ts': "import { History, useHistory } from '../lib/history';\nexport function e1() { return History; }\nexport function e2() { return useHistory(); }\n",
      ...Object.fromEntries(importers.map(n => [`src/app/${n}.ts`, `import { leafFn, added } from '../lib';\nexport function ${n}1() { return leafFn(); }\nexport function ${n}2() { return added(); }\n`])),
    });
    if (useGit) {
      git(root, 'init', '-q');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
    }
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const all = () => query<Edge>(root, `SELECT source_file, source_symbol, target_file, target_symbol FROM edges
    WHERE edge_type IN ('call', 'instantiation') ORDER BY 1, 2, 3, 4`);
  const sync = () => /Updated (\d+) files/.exec(mapx(root, 'sync', '.'))?.[1];
  const equalsForce = () => {
    const synced = all();
    mapx(root, 'scan', '.', '--force');
    expect(synced).toEqual(all());
  };

  it('re-parses no importer after an edit inside a body', () => {
    writeFileSync(join(root, 'src/lib/leaf.ts'), 'export function leafFn(): number {\n  const x = 2;\n  return x;\n}\n');
    writeFileSync(join(root, 'src/lib/side.ts'), 'export function sideFn() { return 2; }\n');
    // The two edited modules only.
    expect(sync()).toBe('2');
    expect(callsFrom(root, 'src/app/a.ts')('a1')).toEqual(['src/lib/leaf.ts#leafFn']);
    equalsForce();
  }, 120000);

  it('re-parses the importers through the barrel when the module gains an export', () => {
    expect(callsFrom(root, 'src/app/a.ts')('a2')).toEqual([]);
    expect(callsFrom(root, 'src/app/d.ts')('d2')).toEqual([]);
    writeFileSync(join(root, 'src/lib/leaf.ts'), 'export function leafFn() { return 1; }\nexport function added() { return 1; }\n');
    // The leaf, both barrels and their four importers.
    expect(sync()).toBe('7');
    for (const n of [...importers, 'd']) expect(callsFrom(root, `src/app/${n}.ts`)(`${n}2`)).toEqual(['src/lib/leaf.ts#added']);
    equalsForce();
  }, 120000);

  it('re-parses them when a body edit declares a nested function of the imported name', () => {
    // The index holds nested declarations without a scope, so findExport finds them: the signature
    // lists every declared name, not only the top level.
    writeFileSync(join(root, 'src/lib/leaf.ts'), 'export function leafFn(): number {\n  function added() { return 2; }\n  return added();\n}\n');
    mapx(root, 'sync', '.');
    equalsForce();
  }, 120000);

  it('re-parses them when the module loses or renames an export', () => {
    writeFileSync(join(root, 'src/lib/leaf.ts'), 'export function leafRenamed() { return 1; }\n');
    // The leaf, both barrels and their four importers.
    expect(sync()).toBe('7');
    expect(callsFrom(root, 'src/app/a.ts')('a1')).toEqual([]);
    equalsForce();
  }, 120000);

  it('re-parses them when the barrel changes in the same sync without changing its exports', () => {
    writeFileSync(join(root, 'src/lib/leaf.ts'), 'export function leafFn(): number { return 1; }\nexport function added() { return 1; }\n');
    writeFileSync(join(root, 'src/lib/index.ts'), "// barrel\nexport * from './leaf';\nexport * from './side';\n");
    mapx(root, 'sync', '.');
    expect(callsFrom(root, 'src/app/a.ts')('a2')).toEqual(['src/lib/leaf.ts#added']);
    equalsForce();
  }, 120000);

  it('re-parses the importers of a JSX module that gains an export', () => {
    expect(callsFrom(root, 'src/app/e.ts')('e2')).toEqual([]);
    writeFileSync(join(root, 'src/lib/history.tsx'), readFileSync(join(root, 'src/lib/history.tsx'), 'utf8') + 'export const useHistory = () => [];\n');
    mapx(root, 'sync', '.');
    expect(callsFrom(root, 'src/app/e.ts')('e2')).toEqual(['src/lib/history.tsx#useHistory']);
    equalsForce();
  }, 120000);

  it('re-parses them when the module behind the barrel is deleted', () => {
    rmSync(join(root, 'src/lib/leaf.ts'));
    if (useGit) git(root, 'rm', '-q', '--cached', 'src/lib/leaf.ts');
    mapx(root, 'sync', '.');
    // The barrel's star target is gone: unknown, so name lookup applies, as in scan --force.
    expect(callsFrom(root, 'src/app/a.ts')('a1')).toEqual(['src/app/helpers.ts#leafFn']);
    equalsForce();
  }, 120000);
});

// M2-08-R2: a module sync adds can change what an existing import resolves to: one the import named
// but nothing satisfied, or a file that takes precedence over a folder index of the same name.
describe.each([['git', true], ['hash', false]])('%s sync re-links imports a new module satisfies (M2-08-R2)', (_mode, useGit) => {
  let root: string;
  beforeEach(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      // Name lookup's pick while the import does not resolve.
      'src/app/helpers.ts': 'export function run() { return 0; }\n',
      'src/app/f.ts': "import { run } from '../lib/missing';\nexport function f1() { return run(); }\n",
      'src/app/g.ts': "import { run } from '../lib/utils';\nexport function g1() { return run(); }\n",
      'src/lib/utils/index.ts': 'export function run() { return 4; }\n',
      // Review 2026-11-02: through barrels, extension precedence, a folder index, an alias.
      'src/app/barrel.ts': "export { run } from '../lib/later';\nexport * from '../lib/utils';\n",
      'src/app/viaBarrel.ts': "import { run } from './barrel';\nexport function v1() { return run(); }\n",
      'src/lib/m.ts': 'export function run() { return 5; }\n',
      'src/app/ext.ts': "import { run } from '../lib/m.js';\nexport function e1() { return run(); }\n",
      'src/app/folder.ts': "import { run } from '../lib/pkg';\nexport function p1() { return run(); }\n",
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/app/alias.ts': "import { run } from '@/lib/aliased';\nexport function a1() { return run(); }\n",
    });
    if (useGit) {
      git(root, 'init', '-q');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
    }
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const all = () => query<Edge>(root, `SELECT source_file, source_symbol, target_file, target_symbol FROM edges
    WHERE edge_type IN ('call', 'instantiation') ORDER BY 1, 2, 3, 4`);
  const sync = () => /Updated (\d+) files/.exec(mapx(root, 'sync', '.'))?.[1];
  const equalsForce = () => {
    const synced = all();
    mapx(root, 'scan', '.', '--force');
    expect(synced).toEqual(all());
  };

  it('re-parses the importer of a module that did not exist', () => {
    expect(callsFrom(root, 'src/app/f.ts')('f1')).toEqual(['src/app/helpers.ts#run']);
    writeFileSync(join(root, 'src/lib/missing.ts'), 'export function run() { return 1; }\n');
    expect(sync()).toBe('2');
    expect(callsFrom(root, 'src/app/f.ts')('f1')).toEqual(['src/lib/missing.ts#run']);
    equalsForce();
  }, 120000);

  it('re-parses the importers of a folder index a new file of the same name takes precedence over', () => {
    expect(callsFrom(root, 'src/app/g.ts')('g1')).toEqual(['src/lib/utils/index.ts#run']);
    writeFileSync(join(root, 'src/lib/utils.ts'), 'export function run() { return 3; }\n');
    sync();
    expect(callsFrom(root, 'src/app/g.ts')('g1')).toEqual(['src/lib/utils.ts#run']);
    equalsForce();
  }, 120000);

  it.each([
    ['through an export-from barrel', 'src/lib/later.ts', 'src/app/viaBarrel.ts', 'v1', 'src/lib/later.ts#run'],
    ['for an extension earlier in the probe order', 'src/lib/m.js', 'src/app/ext.ts', 'e1', 'src/lib/m.js#run'],
    ['for a new folder index', 'src/lib/pkg/index.ts', 'src/app/folder.ts', 'p1', 'src/lib/pkg/index.ts#run'],
    ['for an alias import', 'src/lib/aliased.ts', 'src/app/alias.ts', 'a1', 'src/lib/aliased.ts#run'],
  ])('re-links %s', (_name, added, file, symbol, expected) => {
    mkdirSync(dirname(join(root, added)), { recursive: true });
    writeFileSync(join(root, added), 'export function run() { return 9; }\n');
    sync();
    expect(callsFrom(root, file)(symbol)).toEqual([expected]);
    equalsForce();
  }, 120000);

  it('re-links through a barrel when a file takes precedence over the folder index it re-exports', () => {
    expect(callsFrom(root, 'src/app/viaBarrel.ts')('v1')).not.toEqual(['src/lib/utils.ts#run']);
    writeFileSync(join(root, 'src/lib/utils.ts'), 'export function run() { return 3; }\nexport function other() { return 0; }\n');
    sync();
    equalsForce();
  }, 120000);

  it('re-links in a plain scan too', () => {
    writeFileSync(join(root, 'src/lib/missing.ts'), 'export function run() { return 1; }\n');
    mapx(root, 'scan', '.');
    expect(callsFrom(root, 'src/app/f.ts')('f1')).toEqual(['src/lib/missing.ts#run']);
    equalsForce();
  }, 120000);

  it('re-parses no other file for a new module no import names', () => {
    writeFileSync(join(root, 'src/lib/other.ts'), 'export function other() { return 1; }\n');
    expect(sync()).toBe('1');
  }, 120000);
});
