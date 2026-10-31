import { describe, it, expect } from 'vitest';
import { getParserForFile } from '../src/parsers/parser-registry.js';

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
