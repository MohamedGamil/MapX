import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getParserForFile } from '../src/parsers/parser-registry.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-17-R1: per-language extraction defects reproduced by the M0-41 audit (I17).
async function parse(file: string, src: string) {
  const r = await getParserForFile(file).parse(file, src, {});
  return {
    symbols: r.symbols.map((s) => `${s.kind}:${s.scope ? `${s.scope}::` : ''}${s.name}`),
    kinds: new Set(r.symbols.map((s) => s.kind)),
    refs: r.references.map((x) => `${x.referenceType}:${x.targetName}`),
  };
}

describe('language extraction accuracy', () => {
  it('Ruby: `< Base` extends Base, `include` implements, no call to include', async () => {
    const r = await parse('a.rb', 'module Greet\nend\nclass Base; end\nclass Foo < Base\n  include Greet\n  def run; end\nend\n');
    expect(r.refs).toEqual(expect.arrayContaining(['extends:Base', 'implements:Greet']));
    expect(r.refs).not.toContain('extends:< Base');
    expect(r.refs).not.toContain('call:include');
  });

  it('C++: in-class and out-of-line methods are scoped methods; templates are named by identifier', async () => {
    const r = await parse('a.cpp', [
      'class Foo {',
      'public:',
      '  void inside() {}',
      '  void run();',
      '};',
      'void Foo::run() { inside(); }',
      'template <typename T>',
      'T maxOf(T a, T b) { return a > b ? a : b; }',
    ].join('\n'));
    expect(r.symbols).toEqual(['class:Foo', 'method:Foo::inside', 'method:Foo::run', 'function:maxOf']);
  });

  it('C#: `class A : Base, IRun` extends Base and implements IRun', async () => {
    const r = await parse('a.cs', 'namespace N {\ninterface IRun {}\ninterface IAll : IRun {}\nclass Base {}\nclass A : Base, IRun {}\nclass B : IRun {}\nstruct S : IComparable {}\n}\n');
    expect(r.refs.sort()).toEqual(['extends:Base', 'extends:IRun', 'implements:IComparable', 'implements:IRun', 'implements:IRun'].sort());
  });

  it('Dart: function and method calls are call references', async () => {
    const r = await parse('a.dart', 'void helper() {}\nclass W {\n  void build() { helper(); obj.run(1); }\n}\n');
    expect(r.refs).toEqual(expect.arrayContaining(['call:helper', 'call:run']));
  });

  it('Python: Bar() is an instantiation, @property a property, and a module yields ≥ 6 kinds', async () => {
    const r = await parse('a.py', [
      'class Bar:',
      '    @property',
      '    def size(self):',
      '        return 1',
      '    def grow(self):',
      '        local = 2',
      '        return local',
      '',
      'LIMIT = 1',
      'items = []',
      '',
      'def make():',
      '    return Bar()',
    ].join('\n'));
    expect(r.refs).toContain('instantiation:Bar');
    expect(r.refs).not.toContain('call:Bar');
    expect(r.symbols).toEqual(expect.arrayContaining(['property:Bar::size', 'method:Bar::grow', 'constant:LIMIT', 'variable:items']));
    expect(r.symbols).not.toContain('variable:local');
    expect(r.kinds.size).toBeGreaterThanOrEqual(6);
  });

  it('Go: interface and struct embedding are extends; constraint unions are not', async () => {
    const r = await parse('a.go', 'package a\nimport "io"\ntype RC interface {\n  Reader\n  io.Writer\n  Close()\n}\ntype Num interface { int | float64 }\ntype S struct { Base; x int }\n');
    expect(r.refs.filter((x) => x.startsWith('extends:')).sort()).toEqual(['extends:Base', 'extends:Reader', 'extends:Writer']);
  });

  it('Kotlin: interface and enum class have their kinds', async () => {
    const r = await parse('a.kt', 'interface Shape { fun area(): Double }\nenum class Color { RED }\nclass Sq : Shape { override fun area() = 1.0 }\n');
    expect(r.symbols).toEqual(expect.arrayContaining(['interface:Shape', 'enum:Color', 'class:Sq']));
  });

  it('JavaScript: a reference file yields ≥ 6 kinds (constant, variable, property)', async () => {
    const r = await parse('a.js', [
      'const LIMIT = 10;',
      'let counter = 0;',
      'var legacy = 1;',
      'export const API = "/api";',
      'class Foo {',
      '  bar = 1;',
      '  static baz = 2;',
      '  run() { const local = 1; return local; }',
      '}',
      'function f() {}',
      'const g = () => 1;',
    ].join('\n'));
    expect(r.symbols).toEqual(expect.arrayContaining([
      'constant:LIMIT', 'constant:API', 'variable:counter', 'variable:legacy', 'property:Foo::bar', 'property:Foo::baz', 'function:g', 'function:f',
    ]));
    expect(r.symbols.filter((s) => s.endsWith(':g') || s.endsWith('::g'))).toEqual(['function:g']);
    expect(r.symbols.some((s) => s.includes('local'))).toBe(false);
    expect(r.kinds.size).toBeGreaterThanOrEqual(6);
  });

  it('Rust: one symbol per struct, whatever the number of impl blocks', async () => {
    const r = await parse('a.rs', 'struct Point { x: i32 }\nimpl Point { fn new() -> Self { Point { x: 0 } } }\nimpl Clone for Point { fn clone(&self) -> Self { Point { x: self.x } } }\nstruct W<T> { t: T }\nimpl<T> W<T> { fn get(&self) {} }\n');
    expect(r.symbols.filter((s) => s.endsWith(':Point'))).toEqual(['struct:Point']);
    expect(r.symbols).toEqual(expect.arrayContaining(['method:Point::new', 'method:Point::clone', 'method:W::get']));
  });

  // M0-17-R2: qualified names and base lists the review found mis-extracted.
  it('C++: template and nested qualifiers scope out-of-line methods by their class', async () => {
    const r = await parse('a.cpp', [
      'template <class T> class Box { public: void f(); };',
      'template <class T> void Box<T>::f() {}',
      'namespace ns { class K { void a(); }; }',
      'void ns::K::a() {}',
      'class Outer { class In { void z(); }; };',
      'void Outer::In::z() {}',
      'void free_fn() {}',
    ].join('\n'));
    expect(r.symbols).toEqual(expect.arrayContaining(['method:Box::f', 'method:K::a', 'method:In::z', 'function:free_fn']));
    expect(r.symbols.filter((s) => s.startsWith('method:'))).toEqual(['method:Box::f', 'method:K::a', 'method:In::z']);
  });

  it('C#: `: IOException` extends it; generic bases drop their type arguments', async () => {
    const r = await parse('a.cs', [
      'namespace N {',
      'class E : IOException {}',
      'class L : List<int>, IFoo<int> {}',
      'class Q : System.Collections.Generic.Dictionary<string, List<int>>, IDisposable {}',
      'class U : IPhoneHandler {}',
      '}',
    ].join('\n'));
    expect(r.refs.filter((x) => /^(extends|implements):/.test(x))).toEqual([
      'extends:IOException', 'extends:List', 'implements:IFoo', 'extends:System.Collections.Generic.Dictionary', 'implements:IDisposable', 'implements:IPhoneHandler',
    ]);
  });

  it('Go: a qualified embedded struct field is extends', async () => {
    const r = await parse('a.go', 'package a\nimport "sync"\ntype S struct {\n  *Base\n  sync.Mutex\n  x int\n  m sync.Mutex\n}\n');
    expect(r.refs.filter((x) => x.startsWith('extends:')).sort()).toEqual(['extends:Base', 'extends:Mutex']);
  });

  it('Swift: init is named init; Scala: import targets are clean paths', async () => {
    expect((await parse('a.swift', 'class Box {\n  init(size: Int) {}\n}\n')).symbols).toContain('method:Box::init');
    const scala = await parse('a.scala', 'import scala.collection.mutable.ListBuffer\nimport com.ex.lib.{Bar, Baz => Q}\nimport com.ex._\nobject M\n');
    expect(scala.refs).toEqual(['import:scala.collection.mutable.ListBuffer', 'import:com.ex.lib.Bar', 'import:com.ex.lib.Baz', 'import:com.ex._']);
  });
});

// M0-17-R3: generic bases, exported let/var and local arrows (limitations of M0-17-R2).
describe('language extraction accuracy: generic bases and JS bindings', () => {
  const bases = (refs: string[]) => refs.filter((x) => /^(extends|implements):/.test(x)).sort();

  it('Java: generic and qualified bases name their type', async () => {
    const r = await parse('A.java', [
      'class A extends Base<String> implements Run<T>, Other {}',
      'interface I extends J<T>, K {}',
      'class B extends java.util.ArrayList<String> {}',
      'class C extends Plain {}',
    ].join('\n'));
    expect(bases(r.refs)).toEqual(['extends:Base', 'extends:J', 'extends:K', 'extends:Plain', 'extends:java.util.ArrayList', 'implements:Other', 'implements:Run']);
  });

  it('Kotlin: a generic superclass and interface name their type', async () => {
    const r = await parse('a.kt', 'class A : Base<String>(), Run<T>, Other {}\n');
    expect(bases(r.refs)).toEqual(['extends:Base', 'implements:Other', 'implements:Run']);
  });

  it('TypeScript and TSX: generic extends and implements name their type', async () => {
    const src = 'class A extends Base<T> implements Run<T>, Other {}\n';
    expect(bases((await parse('a.ts', src)).refs)).toEqual(['extends:Base', 'implements:Other', 'implements:Run']);
    expect(bases((await parse('a.tsx', src)).refs)).toEqual(['extends:Base', 'implements:Other', 'implements:Run']);
  });

  it('JavaScript and TypeScript: exported let/var are variables; TS top-level bindings are symbols', async () => {
    const js = await parse('a.js', 'export let x = 1;\nexport var y = 2;\nexport let f = () => 1;\nfunction g() { let z = 1; return z; }\n');
    expect(js.symbols.sort()).toEqual(['function:f', 'function:g', 'variable:x', 'variable:y']);
    const ts = await parse('a.ts', [
      'export let x: number = 1;',
      'export var y = 2;',
      'export const e = 5;',
      'const c = 3;',
      'let d = 4;',
      'var v = 6;',
      'type T = number;',
      'const a = () => 1, b = 2;',
      'function g() { let z = 1; return z; }',
    ].join('\n'));
    expect(ts.symbols.sort()).toEqual(['constant:T', 'constant:b', 'constant:c', 'constant:e', 'function:a', 'function:g', 'variable:d', 'variable:v', 'variable:x', 'variable:y']);
  });

  it('JavaScript and TypeScript: an arrow declared inside a function is not a symbol', async () => {
    const src = [
      'function outer() { const f = () => 1; var h = function () {}; return f() + h(); }',
      'class Foo { run() { const cb = () => 2; return cb(); } }',
      'const top = () => { const inner = () => 3; return inner(); };',
      'export const exp = () => 4;',
    ].join('\n');
    for (const file of ['a.js', 'a.ts']) {
      expect((await parse(file, src)).symbols.sort()).toEqual(['class:Foo', 'function:exp', 'function:outer', 'function:top', 'method:Foo::run']);
    }
  });
});

// M0-17-R3: generic bases resolve to their class; C# base kinds follow the indexed target.
describe('generic bases and C# base kinds end to end', () => {
  let root: string;
  type Edge = { source_symbol: string | null; edge_type: string; target_symbol: string; target_file: string };
  const bases = (file: string) => query<Edge>(root,
    "SELECT source_symbol, edge_type, target_symbol, target_file FROM edges WHERE source_file = ? AND edge_type IN ('extends', 'implements') ORDER BY source_symbol, target_symbol", file);

  beforeAll(() => {
    root = workspace({
      'java/JBase.java': 'public class JBase<T> {}\n',
      'java/JA.java': 'public class JA extends JBase<String> {}\n',
      'kt/KBase.kt': 'open class KBase<T>\n',
      'kt/KA.kt': 'class KA : KBase<String>()\n',
      'ts/tbase.ts': 'export class TBase<T> {}\nexport interface TRun<T> {}\n',
      'ts/ta.ts': "import { TBase, TRun } from './tbase';\nexport class TA extends TBase<number> implements TRun<number> {}\n",
      // Shape is an interface without the I prefix; IPhone is a class with it.
      'cs/Types.cs': 'namespace N {\npublic interface Shape {}\npublic class Item {}\npublic class IPhone {}\n}\n',
      'cs/Use.cs': [
        'namespace N {',
        'class Box : Shape {}',
        'class Phone : IPhone {}',
        'class Pair : Item, Shape {}',
        'interface IAll : Shape {}',
        'struct S : Shape {}',
        '}',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('Java, Kotlin and TypeScript generic bases are extends edges to the base class', () => {
    expect(bases('java/JA.java')).toEqual([{ source_symbol: 'JA', edge_type: 'extends', target_symbol: 'JBase', target_file: 'java/JBase.java' }]);
    expect(bases('kt/KA.kt')).toEqual([{ source_symbol: 'KA', edge_type: 'extends', target_symbol: 'KBase', target_file: 'kt/KBase.kt' }]);
    expect(bases('ts/ta.ts')).toEqual([
      { source_symbol: 'TA', edge_type: 'extends', target_symbol: 'TBase', target_file: 'ts/tbase.ts' },
      { source_symbol: 'TA', edge_type: 'implements', target_symbol: 'TRun', target_file: 'ts/tbase.ts' },
    ]);
  });

  it('C#: an indexed interface is implemented and an indexed class extended, whatever the name', () => {
    expect(bases('cs/Use.cs')).toEqual([
      { source_symbol: 'Box', edge_type: 'implements', target_symbol: 'Shape', target_file: 'cs/Types.cs' },
      { source_symbol: 'IAll', edge_type: 'extends', target_symbol: 'Shape', target_file: 'cs/Types.cs' },
      { source_symbol: 'Pair', edge_type: 'extends', target_symbol: 'Item', target_file: 'cs/Types.cs' },
      { source_symbol: 'Pair', edge_type: 'implements', target_symbol: 'Shape', target_file: 'cs/Types.cs' },
      { source_symbol: 'Phone', edge_type: 'extends', target_symbol: 'IPhone', target_file: 'cs/Types.cs' },
      { source_symbol: 'S', edge_type: 'implements', target_symbol: 'Shape', target_file: 'cs/Types.cs' },
    ]);
  });
});

// M3-10: name lookup follows the target language's case rules. `Cart` is not `cart` in
// case-sensitive languages; PHP class and function names ignore case.
describe('symbol name lookup is case-sensitive except where the language is not', () => {
  let root: string;
  type Edge = { source_file: string; edge_type: string; target_symbol: string; target_file: string };
  const from = (file: string) => query<Edge>(root,
    "SELECT source_file, edge_type, target_symbol, target_file FROM edges WHERE source_file = ? AND edge_type NOT IN ('import', 'require') ORDER BY edge_type, target_symbol, target_file", file);

  beforeAll(() => {
    // Each `*/use.*` names `Cart`; only a lowercase `cart` is declared elsewhere in its language.
    root = workspace({
      'js/cart.js': 'export function cart() { return 1; }\n',
      'js/use.js': 'export function run() { return new Cart(); }\n',
      'ts/cart.ts': 'export function cart(): number { return 1; }\n',
      'ts/use.ts': 'export function run() { return Cart(); }\n',
      'vue/CartView.vue': '<template><div>{{ cart }}</div></template>\n<script setup>\nimport { ref } from "vue";\nconst cart = ref([]);\n</script>\n',
      'vue/use.ts': 'export class Big extends Cart {}\n',
      'py/cart.py': 'def cart():\n    return 1\n',
      'py/use.py': 'def run():\n    return Cart()\n',
      'go/cart.go': 'package shop\n\nfunc cart() int { return 1 }\n',
      'go/use.go': 'package shop\n\nfunc Run() int { return Cart() }\n',
      'rs/cart.rs': 'pub fn cart() -> i32 { 1 }\n',
      'rs/use.rs': 'pub fn run() -> i32 { Cart() }\n',
      'java/Store.java': 'public class Store { static int cart() { return 1; } }\n',
      'java/Use.java': 'public class Use { Object run() { return new Cart(); } }\n',
      'kt/Store.kt': 'fun cart() = 1\n',
      'kt/Use.kt': 'fun run() = Cart()\n',
      'swift/Store.swift': 'func cart() -> Int { return 1 }\n',
      'swift/Use.swift': 'func run() -> Int { return Cart() }\n',
      'rb/store.rb': 'def cart\n  1\nend\n',
      'rb/use.rb': 'def run\n  Cart.new\nend\n',
      'cs/Store.cs': 'public class Store { public static int cart() { return 1; } }\n',
      'cs/Use.cs': 'public class Use { object Run() { return new Cart(); } }\n',
      // PHP: classes and functions match whatever the case.
      'php/User.php': '<?php\nclass User { public function save() {} }\nfunction helper() { return 1; }\n',
      'php/use.php': '<?php\nfunction run() { $u = new user(); return HELPER(); }\n',
      'php/app/Models/Role.php': '<?php\nnamespace App\\Models;\nclass Role {}\n',
      'php/app/use.php': '<?php\nnamespace App;\nfunction go() { return new \\App\\Models\\ROLE(); }\n',
      // and methods (review 2026-10-31: only the mocked unit test covered methods).
      'php/Basket.php': '<?php\nclass Basket { public function addItem() {} }\n',
      'php/method.php': '<?php\nfunction fill($b) { $b->ADDITEM(); }\n',
      // Pascal identifiers ignore case.
      'pas/Store.pas': 'unit Store;\ninterface\nfunction Total: Integer;\nimplementation\nfunction Total: Integer;\nbegin\n  Result := 1;\nend;\nend.\n',
      'pas/Use.pas': 'unit Use;\ninterface\nimplementation\nuses Store;\nprocedure Run;\nvar x: Integer;\nbegin\n  x := TOTAL();\nend;\nend.\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it.each([
    'js/use.js', 'ts/use.ts', 'vue/use.ts', 'py/use.py', 'go/use.go', 'rs/use.rs',
    'java/Use.java', 'kt/Use.kt', 'swift/Use.swift', 'rb/use.rb', 'cs/Use.cs',
  ])('%s: `Cart` does not resolve to a lowercase `cart`', (file) => {
    expect(from(file)).toEqual([]);
  });

  it('PHP: `new user()` and `HELPER()` reach `User` and `helper`; `\\App\\Models\\ROLE` reaches Role', () => {
    expect(from('php/use.php')).toEqual([
      { source_file: 'php/use.php', edge_type: 'call', target_symbol: 'HELPER', target_file: 'php/User.php' },
      { source_file: 'php/use.php', edge_type: 'instantiation', target_symbol: 'user', target_file: 'php/User.php' },
    ]);
    expect(from('php/app/use.php')).toEqual([
      { source_file: 'php/app/use.php', edge_type: 'instantiation', target_symbol: 'App\\Models\\ROLE', target_file: 'php/app/Models/Role.php' },
    ]);
  });

  it('PHP: `$b->ADDITEM()` reaches the method `addItem`', () => {
    expect(from('php/method.php')).toEqual([
      { source_file: 'php/method.php', edge_type: 'call', target_symbol: 'ADDITEM', target_file: 'php/Basket.php' },
    ]);
  });

  it('Pascal: `TOTAL()` reaches `Total`', () => {
    expect(from('pas/Use.pas')).toEqual([
      { source_file: 'pas/Use.pas', edge_type: 'call', target_symbol: 'TOTAL', target_file: 'pas/Store.pas' },
    ]);
  });
});

// M0-17-R4: calls on library objects and global functions are not project symbols of the same name.
describe('calls on library and DOM receivers', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'src/lib.ts': 'export class Repo { save() { return 1; } }\nexport function create() { return 1; }\nexport function remove() { return 2; }\nexport function get() { return 3; }\nexport function fetch() { return 4; }\n',
      'src/api.ts': 'export function fetch() { return 5; }\n',
      'src/use.ts': [
        "import axios from 'axios';",
        "import _ from 'lodash';",
        "import * as lo from 'lodash-es';",
        "const qs = require('qs');",
        "import { Repo } from './lib';",
        'export function run(el: HTMLElement, r: Repo) {',
        '  axios.create();',
        "  el.classList.remove('x');",
        "  fetch('/x');",
        "  _.get({}, 'a');",
        "  lo.get({}, 'a');",
        "  qs.remove('a');",
        '  r.save();',
        '  const repo = new Repo();',
        '  repo.save();',
        '}',
        '',
      ].join('\n'),
      'src/own.ts': "import { fetch } from './api';\nexport const own = () => fetch();\n",
      'src/declared.ts': 'function fetch() { return 6; }\nexport const local = () => fetch();\n',
      'src/App.vue': "<script setup>\nimport axios from 'axios';\nfunction go() { return axios.create(); }\n</script>\n<template><div /></template>\n",
      // Review 2026-10-31: receivers that are not imports, and specifiers that are not npm packages.
      'package.json': JSON.stringify({ name: 'app', dependencies: { axios: '^1.0.0', lodash: '^4.0.0', 'lodash-es': '^4.0.0', qs: '^6.0.0', 'node-fetch': '^3.0.0', 'api-sdk': '^1.0.0', '@acme/lib': 'workspace:*' } }),
      'src/base.ts': 'export class Base { alert() { return 1; } confirm() { return 2; } }\n',
      'src/child.ts': "import { Base } from './base';\nexport class Child extends Base { go() { this.alert(); return this.confirm(); } }\n",
      'packages/lib/package.json': JSON.stringify({ name: '@acme/lib', main: 'src/index.ts' }),
      'packages/lib/src/index.ts': 'export function helperOne() { return 1; }\n',
      'src/workspace.ts': "import * as lib from '@acme/lib';\nexport const w = () => lib.helperOne();\n",
      'utils/format.ts': 'export function parseThing() { return 1; }\n',
      'src/nuxt.ts': "import * as t from '~/utils/format';\nexport const n = () => t.parseThing();\n",
      'src/shadow.ts': "import api from 'api-sdk';\nimport { Repo } from './lib';\nexport function f() { const api = new Repo(); return api.save(); }\n",
      'src/npmfetch.ts': "import fetch from 'node-fetch';\nexport const g = () => fetch('/x');\n",
      'src/client.ts': "export class Client { fetch() { return 1; } }\nexport const h = () => fetch('/x');\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));
  const calls = (file: string) =>
    query<{ t: string }>(root, "SELECT target_file || '#' || target_symbol AS t FROM edges WHERE edge_type = 'call' AND source_file = ? ORDER BY t", file).map((r) => r.t);

  it('gives no call edge for npm-package receivers, DOM properties or global functions', () => {
    expect(calls('src/use.ts')).toEqual(['src/lib.ts#save', 'src/lib.ts#save']);
    expect(calls('src/App.vue')).toEqual([]);
  });

  it('still resolves a call on a project receiver, and a global name the file imports or declares itself', () => {
    expect(calls('src/own.ts')).toEqual(['src/api.ts#fetch']);
    expect(calls('src/declared.ts')).toEqual(['src/declared.ts#fetch']);
  });

  it('resolves this.x() named like a global, workspace packages and unresolved ~/ imports as before', () => {
    expect(calls('src/child.ts')).toEqual(['src/base.ts#alert', 'src/base.ts#confirm']);
    expect(calls('src/workspace.ts')).toEqual(['packages/lib/src/index.ts#helperOne']);
    expect(calls('src/nuxt.ts')).toEqual(['utils/format.ts#parseThing']);
    // A local `api` shadows the imported package of that name.
    expect(calls('src/shadow.ts')).toEqual(['src/lib.ts#save']);
  });

  it('gives no edge for a global name imported from an npm package, nor for a global call beside a same-named method', () => {
    expect(calls('src/npmfetch.ts')).toEqual([]);
    expect(calls('src/client.ts')).toEqual([]);
  });

  it('keeps the receiver out of the stored edge metadata', () => {
    const meta = query<{ metadata: string }>(root, "SELECT metadata FROM edges WHERE edge_type = 'call'").map((r) => JSON.parse(r.metadata));
    expect(meta.some((m) => 'receiver' in m)).toBe(false);
  });
});

// M0-17-R5: factory-made callables, deep C++ qualifiers, block-scoped arrows and class expressions
// (review 2026-10-31 of M0-17-R2 and M0-17-R3).
describe('language extraction accuracy: callable bindings, deep qualifiers, block arrows', () => {
  it('JavaScript, TypeScript and Python: a binding to a call, a name or a member is a function; a literal stays a value', async () => {
    const src = [
      "import { useSelector } from 'react-redux';",
      'export const useAppSelector = useSelector;',
      "export const fetchUser = createAsyncThunk('user/fetch', async () => 1);",
      'export const dispatch = store.dispatch;',
      'const typed = (useSelector as any);',
      'let later = make();',
      'export const options = { retry: 1 };',
      'export const list = [1, 2];',
      "const name = 'x', size = 2 * 3;",
      'const inst = new Map();',
      'let flag = true;',
      'function f() { const inner = make(); return inner; }',
    ].join('\n');
    const expected = ['constant:inst', 'constant:list', 'constant:name', 'constant:options', 'constant:size',
      'function:dispatch', 'function:f', 'function:fetchUser', 'function:later', 'function:typed', 'function:useAppSelector', 'variable:flag'];
    expect((await parse('a.ts', src)).symbols.sort()).toEqual(expected);
    expect((await parse('a.js', src.replace(' as any', ''))).symbols.sort()).toEqual(expected);
    const py = await parse('a.py', [
      'import functools',
      'def _base(x):',
      '    return x',
      'handler = functools.partial(_base, 1)',
      'alias = _base',
      'method = obj.run',
      'square = lambda x: x * x',
      'DEFAULT = functools.partial(_base, 2)',
      'LIMIT = 10',
      'handlers = []',
      'names = {"a": 1}',
      'class C:',
      '    m = functools.partial(_base, 3)',
      'def g():',
      '    local = functools.partial(_base, 4)',
      '    return local',
    ].join('\n'));
    expect(py.symbols.sort()).toEqual(['class:C', 'constant:LIMIT', 'function:DEFAULT', 'function:_base', 'function:alias',
      'function:g', 'function:handler', 'function:method', 'function:square', 'variable:handlers', 'variable:names']);
  });

  it('C++: any depth of qualifiers and qualified destructors give scoped methods', async () => {
    const r = await parse('a.cpp', [
      'namespace a { namespace b { namespace c { struct D { void g(); }; } } }',
      'void a::b::c::D::g() {}',
      'void a::b::c::d::E::h() {}',
      'namespace ns { struct K { K(); ~K(); void a(); }; }',
      'ns::K::K() {}',
      'ns::K::~K() {}',
      'K2::~K2() {}',
      'void ns::K::a() {}',
      'void free_fn() {}',
    ].join('\n'));
    expect(r.symbols.filter((s) => /^(method|function):/.test(s))).toEqual([
      'method:D::g', 'method:E::h', 'method:K::K', 'method:K::~K', 'method:K2::~K2', 'method:K::a', 'function:free_fn',
    ]);
  });

  it('JavaScript and TypeScript: a block-scoped arrow is no symbol; a class expression is a class', async () => {
    const src = [
      'if (ready) { const blockArrow = () => 1; }',
      '{ const inBlock = function () {}; }',
      'for (;;) { var looped = () => 2; break; }',
      'try { const tried = () => 3; } catch (e) {}',
      'export const Klass = class { run() { return 1; } };',
      'const Named = class Inner {};',
      'export const top = () => 4;',
    ].join('\n');
    for (const file of ['a.js', 'a.ts']) {
      expect((await parse(file, src)).symbols.sort()).toEqual(['class:Klass', 'class:Named', 'function:top', 'method:Klass::run']);
    }
    // A TypeScript namespace body is module level, not a block.
    expect((await parse('n.ts', 'namespace NS { export const nsf = () => 1; }\n')).symbols).toContain('function:nsf');
  });
});

// M0-17-R5: an embedded `pkg.Type` belongs to the imported package; `new Klass()` reaches a class expression.
describe('qualified Go embedding and class expressions end to end', () => {
  let root: string;
  type Edge = { source_file: string; source_symbol: string | null; target_symbol: string; target_file: string };
  const edges = (type: string, like: string) => query<Edge>(root,
    'SELECT source_file, source_symbol, target_symbol, target_file FROM edges WHERE edge_type = ? AND source_file LIKE ? ORDER BY source_file, source_symbol', type, like);

  beforeAll(() => {
    root = workspace({
      'go/go.mod': 'module example.com/g\n\ngo 1.21\n',
      'go/internal/mylog/logger.go': 'package mylog\n\ntype Logger struct{}\n',
      'go/other/logger.go': 'package other\n\ntype Logger struct{}\n',
      // The standard library and a third-party module are not project packages.
      'go/svc/std.go': 'package svc\n\nimport "log"\n\ntype Std struct {\n\tlog.Logger\n}\n',
      'go/svc/ext.go': 'package svc\n\nimport "github.com/sirupsen/logrus"\n\ntype Ext struct {\n\t*logrus.Logger\n}\n',
      'go/svc/own.go': 'package svc\n\nimport "example.com/g/internal/mylog"\n\ntype Own struct {\n\t*mylog.Logger\n}\n',
      'go/svc/alias.go': 'package svc\n\nimport (\n\t"fmt"\n\tml "example.com/g/internal/mylog"\n)\n\ntype Aliased struct {\n\tml.Logger\n}\n\nvar _ = fmt.Sprint\n',
      'go/svc/base.go': 'package svc\n\ntype Base struct{}\n\ntype WithBase struct {\n\tBase\n}\n',
      'ts/klass.ts': 'export const Klass = class { run() { return 1; } };\n',
      'ts/make.ts': "import { Klass } from './klass';\nexport function make() { return new Klass(); }\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('Go: `log.Logger` and a third-party Logger give no extends edge; a project package does', () => {
    expect(edges('extends', 'go/%')).toEqual([
      { source_file: 'go/svc/alias.go', source_symbol: 'Aliased', target_symbol: 'Logger', target_file: 'go/internal/mylog/logger.go' },
      { source_file: 'go/svc/base.go', source_symbol: 'WithBase', target_symbol: 'Base', target_file: 'go/svc/base.go' },
      { source_file: 'go/svc/own.go', source_symbol: 'Own', target_symbol: 'Logger', target_file: 'go/internal/mylog/logger.go' },
    ]);
  });

  it('TypeScript: `new Klass()` reaches `export const Klass = class {}`', () => {
    expect(query<{ kind: string }>(root, "SELECT kind FROM symbols WHERE file_path = 'ts/klass.ts' AND name = 'Klass'")).toEqual([{ kind: 'class' }]);
    expect(edges('instantiation', 'ts/%')).toEqual([
      { source_file: 'ts/make.ts', source_symbol: 'make', target_symbol: 'Klass', target_file: 'ts/klass.ts' },
    ]);
  });
});
