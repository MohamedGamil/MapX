import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveGoImport, resolveJvmImport, resolvePhpImport, resolvePythonImport, resolveRustImport, type ImportContext } from '../src/core/import-resolvers.js';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { jsAliasTargets } from '../src/core/js-aliases.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-12-R1: import edges for languages whose imports name modules, packages or namespaces.
const ctx = (files: string[], texts: Record<string, string> = {}): ImportContext => ({
  files: new Set(files),
  readText: (p) => texts[p] ?? null,
});

describe('import resolvers', () => {
  it('Python: absolute, relative, submodule vs package, src layout, stdlib', () => {
    const c = ctx(['pkg/__init__.py', 'pkg/mod.py', 'pkg/other.py', 'pkg/sub/__init__.py', 'pkg/sub/thing.py', 'src/app/core.py']);
    expect(resolvePythonImport('from pkg import mod', 'main.py', c)).toBe('pkg/mod.py');
    expect(resolvePythonImport('from pkg import name_in_init', 'main.py', c)).toBe('pkg/__init__.py');
    expect(resolvePythonImport('pkg.other', 'main.py', c)).toBe('pkg/other.py');
    expect(resolvePythonImport('from .sub import thing', 'pkg/mod.py', c)).toBe('pkg/sub/thing.py');
    expect(resolvePythonImport('from .. import other', 'pkg/sub/thing.py', c)).toBe('pkg/other.py');
    expect(resolvePythonImport('app.core', 'src/app/main.py', c)).toBe('src/app/core.py');
    expect(resolvePythonImport('os.path', 'main.py', c)).toBeNull();
  });

  it('Rust: crate, self and super paths; std is external', () => {
    const c = ctx(['src/main.rs', 'src/bar.rs', 'src/net/mod.rs', 'src/net/client.rs', 'src/util.rs']);
    expect(resolveRustImport('crate::bar::Bar', 'src/main.rs', c)).toBe('src/bar.rs');
    expect(resolveRustImport('crate::net::client::Client', 'src/main.rs', c)).toBe('src/net/client.rs');
    expect(resolveRustImport('self::client::Client', 'src/net/mod.rs', c)).toBe('src/net/client.rs');
    // In src/net/client.rs (net::client), `super` is `net`; reaching src/util.rs takes super::super.
    expect(resolveRustImport('super::super::util', 'src/net/client.rs', c)).toBe('src/util.rs');
    expect(resolveRustImport('super::client::Client', 'src/net/mod.rs', c)).toBeNull();
    expect(resolveRustImport('std::collections::HashMap', 'src/main.rs', c)).toBeNull();
  });
});

// M0-12-R3: resolution was quadratic, since every Java/Go/PHP import scanned the whole file set.
// A Set that counts full iterations shows the resolvers index it once, however many imports follow.
class CountingSet extends Set<string> {
  iterations = 0;
  [Symbol.iterator]() {
    this.iterations++;
    return super[Symbol.iterator]();
  }
}

describe('import resolution indexes (M0-12-R3)', () => {
  const files = [
    'a/src/main/java/com/ex/lib/Bar.java',
    'b/src/main/java/com/ex/lib/Bar.java',
    'a/src/main/java/com/ex/app/Main.java',
    'go/internal/lib/z.go',
    'go/internal/lib/a.go',
    'go/internal/lib/a_test.go',
    'app/Services/UserService.php',
    'vendor/acme/src/Services/UserService.php',
  ];
  for (let i = 0; i < 2000; i++) files.push(`gen/src/main/java/com/gen/p${i % 40}/C${i}.java`);
  const texts = {
    'go/go.mod': 'module example.com/proj\n',
    // PSR-4 maps the vendor prefix Acme\ to src/ (M0-04-R2: a dropped-segment suffix no longer does).
    'vendor/acme/composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Acme\\': 'src/' } } }),
  };

  it('index each file set once, not once per import', () => {
    const set = new CountingSet(files);
    const c: ImportContext = { files: set, readText: (p) => (texts as Record<string, string>)[p] ?? null };
    for (let i = 0; i < 2000; i++) {
      expect(resolveJvmImport(`com.gen.p${i % 40}.C${i}`, 'gen/src/main/java/com/gen/p0/C0.java', c, ['.java'])).toBe(`gen/src/main/java/com/gen/p${i % 40}/C${i}.java`);
      expect(resolveJvmImport('java.util.List', 'gen/src/main/java/com/gen/p0/C0.java', c, ['.java', '.kt'])).toBeNull();
    }
    expect(resolveGoImport('"example.com/proj/internal/lib"', 'go/cmd/main.go', c)).toBe('go/internal/lib/a.go');
    expect(resolvePhpImport('App\\Services\\UserService', 'app/Http/Kernel.php', c)).toBe('app/Services/UserService.php');
    expect(set.iterations).toBe(1);
  });

  it('keep the same answers: shortest path, same top directory, case-insensitive PHP, non-test Go file', () => {
    const c: ImportContext = { files: new Set(files), readText: (p) => (texts as Record<string, string>)[p] ?? null };
    expect(resolveJvmImport('com.ex.lib.Bar', 'a/src/main/java/com/ex/app/Main.java', c, ['.java'])).toBe('a/src/main/java/com/ex/lib/Bar.java');
    expect(resolveJvmImport('com.ex.lib.Bar', 'b/x/Other.java', c, ['.java'])).toBe('b/src/main/java/com/ex/lib/Bar.java');
    // A static member falls back one segment to its class.
    expect(resolveJvmImport('com.ex.lib.Bar.CONST', 'a/src/main/java/com/ex/app/Main.java', c, ['.java'])).toBe('a/src/main/java/com/ex/lib/Bar.java');
    expect(resolveJvmImport('ex.lib.Bar', 'a/X.java', c, ['.java'])).toBe('a/src/main/java/com/ex/lib/Bar.java');
    expect(resolveJvmImport('lib.Bar', 'z/X.java', c, ['.java'])).toBe('a/src/main/java/com/ex/lib/Bar.java');
    expect(resolveJvmImport('x.Bar', 'a/X.java', c, ['.java'])).toBeNull();
    expect(resolveGoImport('"example.com/proj/internal/lib"', 'go/cmd/main.go', c)).toBe('go/internal/lib/a.go');
    expect(resolveGoImport('"example.com/proj/internal/none"', 'go/cmd/main.go', c)).toBeNull();
    expect(resolvePhpImport('app\\services\\userservice', 'app/X.php', c)).toBe('app/Services/UserService.php');
    expect(resolvePhpImport('Acme\\Services\\UserService', 'vendor/acme/src/X.php', c)).toBe('vendor/acme/src/Services/UserService.php');
    // No mapping and no file at the whole name's path: nothing, not the …/Services/UserService.php homonyms.
    expect(resolvePhpImport('Acme\\Services\\UserService', 'app/X.php', c)).toBeNull();
    expect(resolvePhpImport('Illuminate\\Services\\UserService', 'app/X.php', c)).toBeNull();
    expect(resolvePhpImport('App\\Services\\UserService', 'app/Services/UserService.php', c)).toBeNull();
  });
});

describe('import edges through the scanner', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'java/src/main/java/com/ex/app/Main.java': 'package com.ex.app;\nimport com.ex.lib.Bar;\nimport java.util.List;\npublic class Main { Bar b; }\n',
      'java/src/main/java/com/ex/lib/Bar.java': 'package com.ex.lib;\npublic class Bar {}\n',
      'rust/src/main.rs': 'mod bar;\nuse crate::bar::Bar;\nuse std::collections::HashMap;\nfn main() {}\n',
      'rust/src/bar.rs': 'pub struct Bar;\n',
      'go/go.mod': 'module example.com/proj\n\ngo 1.22\n',
      'go/cmd/app/main.go': 'package main\nimport (\n  "example.com/proj/internal/lib"\n  "fmt"\n)\nfunc main() { lib.Do(); fmt.Println() }\n',
      'go/internal/lib/lib.go': 'package lib\nfunc Do() {}\n',
      'go/internal/lib/lib_test.go': 'package lib\n',
      'py/pkg/__init__.py': '',
      'py/pkg/mod.py': 'def f():\n    return 1\n',
      'py/app.py': 'from pkg import mod\nimport json\n',
      'rb/lib/base.rb': 'class Base; end\n',
      'rb/lib/foo.rb': "require_relative 'base'\nrequire 'json'\nclass Foo < Base; end\n",
      'cs/Lib/Models.cs': 'namespace Lib.Models { public class User {} }\n',
      'cs/Data/Repo.cs': 'namespace Data;\npublic class Repo {}\n',
      'cs/App.cs': 'using Lib.Models;\nusing Data;\nusing System;\nnamespace App { class A { User u; } }\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  const imports = (source: string) =>
    query<{ target_file: string }>(root, "SELECT DISTINCT target_file FROM edges WHERE source_file = ? AND edge_type IN ('import','require') ORDER BY target_file", source)
      .map((e) => e.target_file);

  it.each([
    ['java/src/main/java/com/ex/app/Main.java', ['java/src/main/java/com/ex/lib/Bar.java']],
    ['rust/src/main.rs', ['rust/src/bar.rs']],
    ['go/cmd/app/main.go', ['go/internal/lib/lib.go']],
    ['py/app.py', ['py/pkg/mod.py']],
    ['rb/lib/foo.rb', ['rb/lib/base.rb']],
    ['cs/App.cs', ['cs/Data/Repo.cs', 'cs/Lib/Models.cs']],
  ])('%s has exactly its internal import edge', (source, expected) => {
    expect(imports(source)).toEqual(expected);
  });
});

// M0-12-R4: per-language precision (review 2026-10-31). Each source lists exactly its import edges
// as `target [target_symbol]`; an absent case has no edge.
describe('import precision (M0-12-R4)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      // Ruby: require_relative is relative only; plain require searches load paths, not the file's own directory.
      'missing.rb': 'X = 1\n',
      'lib/mygem.rb': "require 'mygem/version'\nrequire_relative 'missing'\nrequire 'json'\n",
      'lib/mygem/version.rb': "VERSION = '1'\n",
      'lib/mygem/json.rb': 'module FakeJson; end\n',
      'lib/mygem/cli.rb': "require 'json'\nrequire 'mygem/version'\n",
      'spec/spec_helper.rb': 'RSPEC = 1\n',
      'spec/cli_spec.rb': "require 'spec_helper'\nrequire_relative '../lib/mygem'\n",
      'app/models/concern.rb': 'module Concern; end\n',
      'app/models/user.rb': "require_relative 'concern'\nrequire 'concern'\n",
      // Java multi-module: the module sharing the longest directory prefix wins.
      'jv/services/billing/src/main/java/com/acme/model/Account.java': 'package com.acme.model;\npublic class Account {}\n',
      'jv/services/orders/src/main/java/com/acme/model/Account.java': 'package com.acme.model;\npublic class Account {}\n',
      'jv/services/orders/src/main/java/com/acme/app/OrderApp.java': 'package com.acme.app;\nimport com.acme.model.Account;\npublic class OrderApp {}\n',
      'jv/services/billing/src/main/java/com/acme/app/BillApp.java': 'package com.acme.app;\nimport com.acme.model.Account;\npublic class BillApp {}\n',
      // Python: aliases, several names, siblings; target_symbol is the module, not the statement.
      'py/pkg/__init__.py': 'def helper():\n    return 0\n',
      'py/pkg/a.py': 'A = 1\n',
      'py/pkg/b.py': 'B = 1\n',
      'py/main.py': 'import pkg.a as pa\nfrom pkg import a, b as bee\nfrom pkg import helper\n',
      'py/pkg/sub/__init__.py': '',
      'py/pkg/sub/d.py': 'D = 1\n',
      'py/pkg/sub/c.py': 'from . import d\nfrom ..a import A\n',
      'py/src/shared/util.py': 'U = 1\n',
      'py/src/app/main.py': 'import shared.util\n',
      // C#: using static, alias, global::, nested namespaces, and the file whose types are used.
      'cs/Lib/Helpers.cs': 'namespace Lib { public static class Helpers { public static int Twice(int x) => x * 2; } }\n',
      'cs/Lib/Other.cs': 'namespace Lib { public class Other {} }\n',
      'cs/Nested.cs': 'namespace Outer { namespace Inner { public class Deep {} } }\n',
      'cs/Models/User.cs': 'namespace Lib.Models { public class User {} }\n',
      'cs/Models/Order.cs': 'namespace Lib.Models { public class Order {} }\n',
      'cs/App.cs': [
        'using static Lib.Helpers;',
        'using M = Lib.Models;',
        'using global::Outer.Inner;',
        'using Lib;',
        'namespace App { class A { void Run() { var o = new Other(); var u = new M.User(); var d = new Deep(); } } }',
      ].join('\n'),
      // Rust: `mod foo;` and uniform paths; external crates have no edge.
      'rs/src/main.rs': 'mod net;\nmod util;\nuse net::Client;\nuse serde::Deserialize;\nfn main() {}\n',
      'rs/src/net/mod.rs': 'pub mod client;\n',
      'rs/src/net/client.rs': 'pub struct Client;\n',
      'rs/src/util.rs': 'pub fn u() {}\n',
      // Go: a nested module importing its parent module's package.
      'go/go.mod': 'module example.com/proj\n\ngo 1.22\n',
      'go/internal/lib/lib.go': 'package lib\nfunc Do() {}\n',
      'go/tools/go.mod': 'module example.com/proj/tools\n\ngo 1.22\n',
      'go/tools/internal/fmtx/fmtx.go': 'package fmtx\nfunc F() {}\n',
      'go/tools/cmd/gen/main.go': 'package main\nimport (\n  "example.com/proj/internal/lib"\n  "example.com/proj/tools/internal/fmtx"\n)\nfunc main() { lib.Do(); fmtx.F() }\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  const edges = (source: string) =>
    query<{ target_file: string; target_symbol: string }>(
      root, "SELECT target_file, target_symbol FROM edges WHERE source_file = ? AND edge_type IN ('import','require') ORDER BY target_file, target_symbol", source,
    ).map((e) => `${e.target_file} [${e.target_symbol}]`);

  it.each([
    // Ruby
    ['lib/mygem.rb', ['lib/mygem/version.rb [mygem/version]']],
    ['lib/mygem/cli.rb', ['lib/mygem/version.rb [mygem/version]']],
    ['spec/cli_spec.rb', ['lib/mygem.rb [../lib/mygem]', 'spec/spec_helper.rb [spec_helper]']],
    // require_relative finds its sibling; the plain require of the same name does not (app/models is no load path).
    ['app/models/user.rb', ['app/models/concern.rb [concern]']],
    // Java
    ['jv/services/orders/src/main/java/com/acme/app/OrderApp.java', ['jv/services/orders/src/main/java/com/acme/model/Account.java [com.acme.model.Account]']],
    ['jv/services/billing/src/main/java/com/acme/app/BillApp.java', ['jv/services/billing/src/main/java/com/acme/model/Account.java [com.acme.model.Account]']],
    // Python
    ['py/main.py', ['py/pkg/__init__.py [pkg]', 'py/pkg/a.py [pkg.a]', 'py/pkg/a.py [pkg.a]', 'py/pkg/b.py [pkg.b]']],
    ['py/pkg/sub/c.py', ['py/pkg/a.py [..a]', 'py/pkg/sub/d.py [.d]']],
    ['py/src/app/main.py', ['py/src/shared/util.py [shared.util]']],
    // C#
    ['cs/App.cs', ['cs/Lib/Helpers.cs [Lib.Helpers]', 'cs/Lib/Other.cs [Lib]', 'cs/Models/User.cs [Lib.Models]', 'cs/Nested.cs [Outer.Inner]']],
    // Rust
    ['rs/src/main.rs', ['rs/src/net/mod.rs [net]', 'rs/src/net/mod.rs [net::Client]', 'rs/src/util.rs [util]']],
    ['rs/src/net/mod.rs', ['rs/src/net/client.rs [client]']],
    // Go
    ['go/tools/cmd/gen/main.go', ['go/internal/lib/lib.go [example.com/proj/internal/lib]', 'go/tools/internal/fmtx/fmtx.go [example.com/proj/tools/internal/fmtx]']],
  ])('%s', (source, expected) => {
    expect(edges(source)).toEqual(expected);
  });

  // The C# resolver reads namespaces from the symbol index, which also holds the symbols of files
  // a sync does not re-parse (formerly a separate store query that no test exercised).
  it('C#: after a sync that re-parses only App.cs, namespaces declared in stored files still resolve', () => {
    const before = edges('cs/App.cs');
    expect(before).toHaveLength(4);
    writeFileSync(join(root, 'cs/App.cs'), readFileSync(join(root, 'cs/App.cs'), 'utf8') + '\n// touched\n');
    mapx(root, 'sync', root);
    expect(edges('cs/App.cs')).toEqual(before);
  });
});

// M0-12-R7: follow-ups from review 2026-10-31 (2db08bd). Each source lists exactly its import edges.
describe('import precision (M0-12-R7)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      // Python 3 has no implicit relative imports: inside a package, `import json` is the stdlib,
      // not the sibling pkg/json.py. A script directory without __init__.py is on sys.path.
      'py/pkg/__init__.py': '',
      'py/pkg/json.py': 'X = 1\n',
      'py/pkg/a.py': 'A = 1\n',
      'py/pkg/b.py': 'B = 1\n',
      'py/pkg/uses_json.py': 'import json\nimport pkg.a\n',
      'py/pkg/rel.py': 'from . import json\n',
      'py/scripts/helpers.py': 'H = 1\n',
      'py/scripts/run.py': 'import helpers\n',
      // M0-12-R9: a namespace folder inside a package is no root either.
      'py/pkg/data/json.py': 'X = 1\n',
      'py/pkg/data/reader.py': 'import json\nimport pkg.a\n',
      // ...but a project config higher up does not hide a project's own top-level packages (review).
      'dj/pyproject.toml': '[tool.black]\n',
      'dj/backend/polls/__init__.py': '',
      'dj/backend/polls/models.py': 'Q = 1\n',
      'dj/backend/polls/views.py': 'from polls.models import Q\n',
      'dj/tests/helpers.py': 'H = 1\n',
      'dj/tests/test_x.py': 'from helpers import H\n',
      // A comment inside a parenthesised from-import.
      'py/main.py': 'from pkg import (a,  # first\n    b)\n',
      // Rust: src/bin/*.rs is a crate root, so `mod helper;` is src/bin/helper.rs and `crate::` starts at src/bin.
      'rs/src/main.rs': 'mod helper;\nfn main() {}\n',
      'rs/src/helper.rs': 'pub fn h() {}\n',
      'rs/src/bin/tool.rs': 'mod helper;\nuse crate::helper::h;\nfn main() { h() }\n',
      'rs/src/bin/helper.rs': 'pub fn h() {}\n',
      // Go: go.mod may quote the module path.
      'go/go.mod': '// comment\nmodule "example.com/q"\n\ngo 1.22\n',
      'go/lib/lib.go': 'package lib\nfunc Do() {}\n',
      'go/cmd/main.go': 'package main\nimport l "example.com/q/lib"\nfunc main() { l.Do() }\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  const edges = (source: string) =>
    query<{ target_file: string; target_symbol: string }>(
      root, "SELECT target_file, target_symbol FROM edges WHERE source_file = ? AND edge_type IN ('import','require') ORDER BY target_file, target_symbol", source,
    ).map((e) => `${e.target_file} [${e.target_symbol}]`);

  it.each([
    ['py/pkg/uses_json.py', ['py/pkg/a.py [pkg.a]']],
    ['py/pkg/rel.py', ['py/pkg/json.py [.json]']],
    ['py/scripts/run.py', ['py/scripts/helpers.py [helpers]']],
    ['py/pkg/data/reader.py', ['py/pkg/a.py [pkg.a]']],
    ['dj/backend/polls/views.py', ['dj/backend/polls/models.py [polls.models]']],
    ['dj/tests/test_x.py', ['dj/tests/helpers.py [helpers]']],
    ['py/main.py', ['py/pkg/a.py [pkg.a]', 'py/pkg/b.py [pkg.b]']],
    ['rs/src/bin/tool.rs', ['rs/src/bin/helper.rs [crate::helper::h]', 'rs/src/bin/helper.rs [helper]']],
    ['rs/src/main.rs', ['rs/src/helper.rs [helper]']],
    ['go/cmd/main.go', ['go/lib/lib.go [example.com/q/lib]']],
  ])('%s', (source, expected) => {
    expect(edges(source)).toEqual(expected);
  });

  it('keeps the workspace root a search root despite a stray __init__.py (M0-12-R9 review)', () => {
    const stray = workspace({ '__init__.py': '', 'app/__init__.py': '', 'app/models.py': 'M = 1\n', 'app/views.py': 'import app.models\n' });
    try {
      init(stray);
      mapx(stray, 'scan', stray);
      expect(query<{ t: string }>(stray, "SELECT target_file AS t FROM edges WHERE source_file = 'app/views.py' AND edge_type = 'import'")).toEqual([{ t: 'app/models.py' }]);
    } finally {
      cleanup(stray);
    }
  }, 60000);
});

// M3-09: JS/TS path aliases from the nearest tsconfig/jsconfig `paths`, else the nearest vite /
// vue-cli / webpack / Laravel Mix alias, else `@/` → src/. Configs are read, never executed.
describe('JS/TS import aliases (M3-09)', () => {
  const aliases = (texts: Record<string, string>) => {
    const c = ctx(Object.keys(texts), texts);
    return (target: string, source: string) => jsAliasTargets(target, source, c);
  };

  it('tsconfig paths: baseUrl and paths through a relative extends, comments and trailing commas', () => {
    const at = aliases({
      // baseUrl comes from the extended config: the paths below are relative to src/.
      'apps/web/tsconfig.base.json': '{ "compilerOptions": { "baseUrl": "./src" } }',
      'apps/web/tsconfig.json': `{
  // the app's aliases
  "extends": "./tsconfig.base",
  "compilerOptions": {
    "paths": { "@/*": ["*"], "@components/*": ["ui/*", "legacy/*"], "#config": ["../config/index.ts"], },
  },
}`,
    });
    expect(at('@/utils/format', 'apps/web/src/pages/a.ts')).toEqual(['apps/web/src/utils/format']);
    expect(at('@components/Button', 'apps/web/src/pages/a.ts')).toEqual(['apps/web/src/ui/Button', 'apps/web/src/legacy/Button']);
    expect(at('#config', 'apps/web/src/a.ts')).toEqual(['apps/web/config/index.ts']);
    // Scoped packages and relative imports are never aliased.
    expect(at('@vue/runtime-core', 'apps/web/src/a.ts')).toEqual([]);
    expect(at('./b', 'apps/web/src/a.ts')).toEqual([]);
  });

  it('tsconfig without baseUrl resolves paths from its own folder; the longest prefix wins; references are read', () => {
    const at = aliases({
      'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.app.json" }] }',
      'tsconfig.node.json': '{ "compilerOptions": { "types": ["node"] } }',
      'tsconfig.app.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"], "@/components/*": ["./src/shared/components/*"] } } }',
    });
    expect(at('@/stores/cart', 'src/views/Cart.vue')).toEqual(['src/stores/cart']);
    expect(at('@/components/Card.vue', 'src/views/Cart.vue')).toEqual(['src/shared/components/Card.vue']);
  });

  it('vite.config: object and array forms, fileURLToPath, path.resolve and Laravel\'s root-relative string', () => {
    expect(aliases({
      'shop/vite.config.ts': "import { fileURLToPath, URL } from 'node:url';\nexport default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } } });\n",
    })('@/App.vue', 'shop/src/main.ts')).toEqual(['shop/src/App.vue']);
    expect(aliases({
      'vite.config.js': "export default { resolve: { alias: [{ find: '~', replacement: path.resolve(__dirname, 'client') }, { find: /^#/, replacement: 'x' }] } };\n",
    })('~/api/http', 'client/main.js')).toEqual(['client/api/http']);
    expect(aliases({
      'vite.config.js': "export default defineConfig({\n  plugins: [laravel({ input: 'resources/js/app.js' })],\n  resolve: { alias: { '@': '/resources/js', ziggy: path.resolve('vendor/tightenco/ziggy') } },\n});\n",
    })('@/Pages/Home.vue', 'resources/js/app.js')).toEqual(['resources/js/Pages/Home.vue']);
  });

  it('vue.config.js (chainWebpack, configureWebpack), webpack.config.js ($ exact) and webpack.mix.js', () => {
    expect(aliases({
      'vue.config.js': "module.exports = { chainWebpack: (config) => { config.resolve.alias.set('@', path.resolve(__dirname, 'app')); } };\n",
    })('@/router', 'app/main.js')).toEqual(['app/router']);
    expect(aliases({
      'vue.config.js': "module.exports = { configureWebpack: { resolve: { alias: { '@': path.join(__dirname, 'frontend', 'src') } } } };\n",
    })('@/router', 'frontend/src/main.js')).toEqual(['frontend/src/router']);
    const webpack = aliases({ 'webpack.config.js': "module.exports = { resolve: { alias: { vue$: 'vue/dist/vue.esm.js', Utils: path.resolve(__dirname, 'src/utilities/') } } };\n" });
    expect(webpack('Utils/date', 'src/a.js')).toEqual(['src/utilities/date']);
    expect(webpack('vue', 'src/a.js')).toEqual(['vue/dist/vue.esm.js']);
    expect(webpack('vue/other', 'src/a.js')).toEqual([]);
    expect(aliases({
      'webpack.mix.js': "mix.js('resources/js/app.js', 'public/js').vue().alias({ '@': path.join(__dirname, 'resources/js') });\n",
    })('@/store', 'resources/js/app.js')).toEqual(['resources/js/store']);
  });

  it('skips non-literal aliases; tsconfig paths come before a bundler alias; the nearest config decides', () => {
    expect(aliases({ 'vite.config.js': "const dir = compute();\nexport default { resolve: { alias: { '~': dir } } };\n" })('~/x', 'a.js')).toEqual([]);
    const at = aliases({
      'web/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./ts/*"] } } }',
      'web/vite.config.js': "export default { resolve: { alias: { '@': '/vite' } } };\n",
      'vite.config.js': "export default { resolve: { alias: { '@': '/root', '~': '/root-tilde' } } };\n",
    });
    expect(at('@/x', 'web/ts/a.ts')).toEqual(['web/ts/x']);
    // web/ has its own vite.config.js, so web/ is its own app: the root config's `~` is another
    // project's alias and does not apply (M3-09-R1; M3-09 expected 'root-tilde/x' here).
    expect(at('~/x', 'web/ts/a.ts')).toEqual([]);
    expect(at('@/x', 'other/a.ts')).toEqual(['root/x']);
  });

  it('paths come from the nearest tsconfig/jsconfig, bundler aliases from the nearest package.json or bundler config folder (M3-09-R1)', () => {
    // A Laravel root (jsconfig and vite `@` → resources/js) with a nested Vue CLI app (own
    // package.json, no alias config): the app keeps `@` → its own src/.
    const laravel = aliases({
      'package.json': '{}',
      'vite.config.js': "export default { resolve: { alias: { '@': '/resources/js' } } };\n",
      'jsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./resources/js/*"], "#shared": ["./shared/index.js"] } } }',
      'frontend/package.json': '{ "name": "frontend", "devDependencies": { "@vue/cli-service": "^5.0.0" } }',
    });
    expect(laravel('@/views/Home.vue', 'frontend/src/App.vue')).toEqual(['frontend/src/views/Home.vue', 'src/views/Home.vue']);
    expect(laravel('#shared', 'frontend/src/App.vue')).toEqual([]);
    expect(laravel('@/views/Home.vue', 'resources/js/app.js')).toEqual(['resources/js/views/Home.vue']);
    // A tsconfig alone (tests/) is not an app root: its `extends` chain gives `paths`, the root's
    // vite.config.js gives the bundler aliases. The nearest tsconfig decides, even without `paths`.
    const vitest = aliases({
      'package.json': '{}',
      'vite.config.ts': "export default { resolve: { alias: { '@': '/app' } } };\n",
      'tsconfig.json': '{ "compilerOptions": { "paths": { "#lib/*": ["./lib/*"] } } }',
      'tests/tsconfig.json': '{ "extends": "../tsconfig.json", "compilerOptions": { "types": ["vitest"] } }',
      'e2e/tsconfig.json': '{ "compilerOptions": { "types": ["playwright"] } }',
    });
    expect(vitest('#lib/x', 'tests/unit/a.spec.ts')).toEqual(['lib/x']);
    expect(vitest('@/x', 'tests/unit/a.spec.ts')).toEqual(['app/x']);
    expect(vitest('#lib/x', 'e2e/a.spec.ts')).toEqual([]);
    expect(vitest('@/x', 'e2e/a.spec.ts')).toEqual(['app/x']);
    // Review 2026-10-31 (M3-09-R1): a monorepo package (package.json, no tsconfig, no bundler) uses the
    // root tsconfig's paths, as tsc does; a `{"type": "module"}` marker is not a package root, so the
    // app's vite alias still applies below it.
    const mono = aliases({
      'package.json': '{ "name": "mono", "private": true }',
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@shared/*": ["./packages/shared/src/*"] } } }',
      'packages/web/package.json': '{ "name": "web", "dependencies": { "lodash": "^4.0.0" } }',
      'app/package.json': '{ "name": "app", "devDependencies": { "vite": "^5.0.0" } }',
      'app/vite.config.js': "export default { resolve: { alias: { '~': '/src' } } };\n",
      'app/src/workers/package.json': '{ "type": "module" }',
    });
    expect(mono('@shared/util', 'packages/web/src/index.ts')).toEqual(['packages/shared/src/util']);
    expect(mono('~/lib/fmt', 'app/src/workers/w.js')).toEqual(['app/src/lib/fmt']);
    // A separately built app (vite) does not take the root's paths.
    expect(mono('@shared/util', 'app/src/main.ts')).toEqual([]);
    // Final review 2026-10-31: in a single-build monorepo the root webpack config bundles every
    // package, so its aliases reach packages that have a package.json but no build of their own.
    const single = aliases({
      'package.json': '{ "name": "mono", "private": true, "devDependencies": { "webpack": "^5.0.0" } }',
      'webpack.config.js': "module.exports = { resolve: { alias: { '@components': path.resolve(__dirname, 'packages/components/src') } } };\n",
      'packages/app/package.json': '{ "name": "@mono/app" }',
    });
    expect(single('@components/Button', 'packages/app/src/index.js')).toEqual(['packages/components/src/Button']);
  });

  it('reads every alias of a chained .set() and backslash path segments (M3-09-R1)', () => {
    const at = aliases({
      'vue.config.js': "module.exports = { chainWebpack: (config) => {\n  config.resolve.alias\n    .set('@', resolve('src'))\n    .set('assets', resolve('src/assets'));\n} };\n",
      'webpack.mix.js': "mix.webpackConfig({ resolve: { alias: { '~': path.resolve(__dirname, 'resources\\\\js') } } });\n",
    });
    expect(at('@/router', 'src/main.js')).toEqual(['src/router']);
    expect(at('assets/logo.png', 'src/main.js')).toEqual(['src/assets/logo.png']);
    expect(at('~/store', 'src/main.js')).toEqual(['resources/js/store']);
  });

  it('without an alias, @/ is src/ under the nearest package.json folder, the enclosing src/, then the workspace root', () => {
    const at = aliases({ 'apps/legacy/package.json': '{}', 'apps/legacy/src/main.js': '' });
    expect(at('@/utils/format', 'apps/legacy/src/main.js')).toEqual(['apps/legacy/src/utils/format', 'src/utils/format']);
    expect(at('~/utils/format', 'apps/legacy/src/main.js')).toEqual([]);
    // No package.json (the HTTP pass's unit inputs, M3-12): the src/ folder the file sits in.
    expect(at('@/views/Home.vue', 'frontend/src/router/index.js')).toEqual(['frontend/src/views/Home.vue', 'src/views/Home.vue']);
    expect(at('@/views/Home.vue', 'lib/router.js')).toEqual(['src/views/Home.vue']);
  });
});

describe('JS/TS alias import edges through the scanner (M3-09)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      // Laravel-style app: `@` is resources/js (vite.config.js).
      'apps/admin/package.json': '{ "name": "admin" }',
      'apps/admin/vite.config.js': "import path from 'path';\nexport default { resolve: { alias: { '@': path.resolve(__dirname, 'resources/js') } } };\n",
      'apps/admin/resources/js/app.js': "import { format } from '@/utils/format';\nformat(1);\n",
      'apps/admin/resources/js/utils/format.js': 'export function format(v) { return String(v); }\n',
      // tsconfig paths relative to the baseUrl of the extended config: `@` is app/.
      'apps/shop/package.json': '{ "name": "shop" }',
      'apps/shop/tsconfig.base.json': '{ "compilerOptions": { "baseUrl": "./app" } }',
      'apps/shop/tsconfig.json': '{ "extends": "./tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["*"] } } }',
      'apps/shop/app/main.ts': "import { format } from '@/utils/format';\nformat(2);\n",
      'apps/shop/app/utils/format.ts': 'export function format(v: number) { return `${v}`; }\n',
      // vue.config.js: `@` is client/.
      'apps/old/package.json': '{ "name": "old" }',
      'apps/old/vue.config.js': "module.exports = { chainWebpack: (config) => config.resolve.alias.set('@', path.resolve(__dirname, 'client')) };\n",
      'apps/old/client/main.js': "import { format } from '@/utils/format';\nformat(3);\n",
      'apps/old/client/utils/format.js': 'export function format(v) { return v; }\n',
      // No alias config: `@` is src/ of the app.
      'apps/legacy/package.json': '{ "name": "legacy" }',
      'apps/legacy/src/main.js': "import { format } from '@/utils/format';\nformat(4);\n",
      'apps/legacy/src/utils/format.js': 'export function format(v) { return v; }\n',
      // src/utils/format files the aliases do not point at (traps for a fixed `@/` → src/).
      'apps/admin/src/utils/format.js': 'export function format() { return 0; }\n',
      'apps/shop/src/utils/format.ts': 'export function format() { return 0; }\n',
      'src/utils/format.js': 'export function format() { return 0; }\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  const imports = (source: string) =>
    query<{ target_file: string }>(root, "SELECT DISTINCT target_file FROM edges WHERE source_file = ? AND edge_type IN ('import','require') ORDER BY target_file", source)
      .map((e) => e.target_file);

  it.each([
    ['apps/admin/resources/js/app.js', ['apps/admin/resources/js/utils/format.js']],
    ['apps/shop/app/main.ts', ['apps/shop/app/utils/format.ts']],
    ['apps/old/client/main.js', ['apps/old/client/utils/format.js']],
    ['apps/legacy/src/main.js', ['apps/legacy/src/utils/format.js']],
  ])('%s imports through its own app\'s alias', (source, expected) => {
    expect(imports(source)).toEqual(expected);
  });
});

// M0-12-R9 review: an __init__.py added or removed changes Python import roots; sync follows it.
describe('Python import roots on sync', () => {
  it('re-resolves when a folder becomes a package, as scan --force', () => {
    const root = workspace({ '.gitignore': '.mapx/\n', 'pkg/data/json.py': 'X = 1\n', 'pkg/data/reader.py': 'import json\n' }, ['.']);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
    const imports = () => query<{ t: string }>(root, "SELECT target_file AS t FROM edges WHERE source_file = 'pkg/data/reader.py' AND edge_type = 'import'").map((r) => r.t);
    try {
      git('add', '-A');
      git('commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      // No package yet: pkg/data is a script folder, so json.py shadows the stdlib (as python would).
      expect(imports()).toEqual(['pkg/data/json.py']);
      writeFileSync(join(root, 'pkg/__init__.py'), '');
      mapx(root, 'sync', root);
      expect(imports()).toEqual([]);
      rmSync(join(root, 'pkg/__init__.py'));
      mapx(root, 'sync', root);
      expect(imports()).toEqual(['pkg/data/json.py']);
    } finally {
      cleanup(root);
    }
  }, 120000);
});
