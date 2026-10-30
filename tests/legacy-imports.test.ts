import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolvePythonImport, resolveRustImport, type ImportContext } from '../src/core/import-resolvers.js';
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
    query<{ target_file: string }>(root, "SELECT target_file FROM edges WHERE source_file = ? AND edge_type IN ('import','require') ORDER BY target_file", source)
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
