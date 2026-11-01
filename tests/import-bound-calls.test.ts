import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('falls back to name lookup when the imported module does not declare the name', () => {
    expect(callsFrom(root, 'src/app/main.ts')('missing')).toEqual(['src/app/helpers.ts#ghost']);
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
      'src/app/helpers.ts': 'export function create() { return 0; }\n',
      'src/lib/impl.ts': 'export function shout() { return 1; }\n',
      'src/lib/impl2.ts': 'export function shout() { return 2; }\n',
      'src/lib/index.ts': "export { shout } from './impl';\n",
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
  ])('re-parses the importers after %s, so sync equals scan --force', (_name, change, expected, symbol) => {
    change(root);
    mapx(root, 'sync', '.');
    expect(callsFrom(root, 'src/app/main.ts')(symbol)).toEqual([expected]);
    const synced = all();
    mapx(root, 'scan', '.', '--force');
    expect(synced).toEqual(all());
  }, 120000);
});
