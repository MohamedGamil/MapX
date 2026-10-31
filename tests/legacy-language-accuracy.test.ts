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
