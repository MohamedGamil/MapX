import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-16: `self::m()`, `static::m()` and `parent::m()` link the method of the enclosing class, or of
// the first class of its chain that declares it (found by M2-13: no edge on any layout). The walk is
// M2-12's (`(new self())->m()`): the class, its traits, then its parent; a class the project does not
// declare, and a method the chain does not declare, link nothing.
type Edge = { source_symbol: string | null; edge_type: string; target_file: string; target_symbol: string };

function edges(root: string, file: string, type = 'call'): string[] {
  return query<Edge>(root, `SELECT source_symbol, edge_type, target_file, target_symbol FROM edges
    WHERE source_file = ? AND edge_type = ? ORDER BY 1, 3, 4`, file, type)
    .map((e) => `${e.source_symbol} -> ${e.target_file}#${e.target_symbol}`)
    .filter((edge, i, all) => all.indexOf(edge) === i);
}

const FILES: Record<string, string> = {
  // The acceptance case, over several lines and on one. Constants, static properties and `::class`
  // are not calls. Other.php declares the same method names: never linked.
  'php/User.php': [
    '<?php', 'class User {', '    const KIND = 1;', '    public static $count = 0;',
    '    public function name() {', '        $k = self::KIND . static::KIND . self::$count . self::class . static::class;',
    '        return self::id() . static::tag();', '    }', '    private static function id() { return 1; }',
    '    public static function tag() { return 2; }', '}', ''].join('\n'),
  'php/OneLine.php': '<?php class OneLine { public function name() { return self::id() . static::tag(); } private static function id() { return 1; } public static function tag() { return 2; } }\n',
  'php/Other.php': '<?php\nclass Other {\n    public static function id() { return 9; }\n    public static function tag() { return 9; }\n    public static function boot() { return 9; }\n    public static function query() { return 9; }\n    public static function from() { return 9; }\n}\n',
  // parent:: starts at the parent; self:: and static:: reach inherited methods; the parent may be several levels up.
  'php/Base.php': '<?php\nclass Base {\n    public static function boot() { return 1; }\n    public function base() { return 1; }\n    public function __construct() {}\n    public static function gp() { return 1; }\n}\n',
  'php/Mid.php': '<?php\nclass Mid extends Base {\n    public function midm() { return 1; }\n}\n',
  'php/Child.php': [
    '<?php', 'class Child extends Mid {', '    public static function boot() {', '        parent::boot();', '        self::base();',
    '        static::midm();', '        parent::gp();', '        self::boot();', '    }', '    public function __construct() {',
    '        parent::__construct();', '    }', '}', ''].join('\n'),
  'php/ChildOne.php': '<?php class ChildOne extends Base { public static function boot() { parent::boot(); self::base(); } }\n',
  // No parent, nothing declared, an own method that shadows: no edge or the own method.
  'php/Lone.php': '<?php\nclass Lone {\n    public function a() { parent::boot(); parent::b(); self::nothing(); static::from(); }\n    public function b() { return self::b(); }\n}\n',
  // A trait's method called through self::, from the class that uses it; the class's own wins over the trait's.
  'php/Loggable.php': '<?php\ntrait Loggable {\n    public static function log() { return 1; }\n    public static function both() { return 1; }\n}\n',
  'php/Svc.php': '<?php\nclass Svc {\n    use Loggable;\n    public static function both() { return 2; }\n    public function run() { self::log(); static::log(); self::both(); }\n}\n',
  // A trait calling its own method; one that no trait declares gives no edge (the using class may).
  'php/Helper.php': '<?php\ntrait Helper {\n    public function h() { return self::h2() . static::h3(); }\n    public static function h2() { return 1; }\n}\n',
  // Abstract classes and interfaces.
  'php/Shape.php': '<?php\nabstract class Shape {\n    abstract public function area();\n    public function describe() { return self::area() . static::area(); }\n}\n',
  'php/Cfg.php': '<?php\ninterface Cfg {\n    const MAX = 1;\n    public static function limit();\n}\nclass Conf implements Cfg {\n    public static function limit() { return self::MAX . static::MAX . Cfg::MAX; }\n    public function use() { return self::limit(); }\n}\n',
  // Closures and arrow functions in a method bind self to the class; a top-level one binds nothing.
  'php/Clo.php': '<?php\nclass Clo {\n    public static function h() { return 1; }\n    public function m() {\n        $f = function () { return self::h(); };\n        $g = fn() => static::h();\n        return [$f, $g];\n    }\n}\n$top = fn() => self::h();\nfunction plain() { return self::h(); }\n',
  // An anonymous class is not the class around it.
  'php/Anon.php': '<?php\nclass Outer {\n    public function g() { return 1; }\n    public function f() {\n        return new class {\n            public function a() { return self::g(); }\n            public function g() { return 2; }\n        };\n    }\n}\n',
  // ... nor does its parent:: reach the parent of the class around it.
  'php/Anon2.php': '<?php\nclass Outer2 extends Base {\n    public function f() {\n        return new class {\n            public function a() { return parent::boot(); }\n        };\n    }\n}\n',
  // Enums: self:: reaches the enum's methods; from()/cases() are built in.
  'php/Suit.php': '<?php\nenum Suit: string {\n    case H = \'h\';\n    public static function make() { return self::from(\'h\') ?? self::H; }\n    public static function def() { return self::make() . static::make() . self::cases(); }\n}\n',
  // Static binding: the enclosing class's chain; a subclass's override is not linked.
  'php/Late.php': '<?php\nclass P {\n    public function m() { return static::hook(); }\n    public function hook() { return 1; }\n}\nclass Q extends P {\n    public function hook() { return 2; }\n}\n',
  // Two classes in one file (one line), each reaching its own method.
  'php/Two.php': '<?php class A { public function x() { return 1; } public function f() { return self::x(); } } class B { public function y() { return 2; } public function g() { return self::x(); } public function h() { return self::y(); } }\n',
  // Namespaces: a class's own namespace decides, in statements and blocks, against a homonym.
  'php/Lib/Order.php': '<?php\nnamespace Lib;\nclass Order {\n    public static function calc() { return 2; }\n    public function t() { return self::calc(); }\n}\n',
  'php/App/Order.php': '<?php\nnamespace App;\nclass Order {\n    public static function calc() { return 1; }\n    public function t() { return self::calc() . static::calc(); }\n}\n',
  'php/Blocks.php': '<?php namespace Lib2 { class Order { public static function ca() { return 1; } public function t() { return self::ca(); } } } namespace App2 { class Order { public static function cb() { return 2; } public function t() { return static::cb(); } } }\n',
  // parent:: resolves its class as an `extends` does: through `use` and the namespace, and through the parent's traits.
  'php/Ns/Kid.php': '<?php\nnamespace App;\nuse Lib\\Order as LO;\nclass Kid1 extends LO {\n    public function k() { return parent::calc(); }\n}\nclass Kid2 extends Order {\n    public function k() { return parent::calc(); }\n}\n',
  'php/PTrait.php': '<?php\ntrait Hi { public function hi() { return 1; } }\nclass Pa { use Hi; }\nclass Ki extends Pa { public function k() { return parent::hi() . self::hi(); } }\n',
  // Two global classes of one name in different files: each reaches its own methods, not the first found by name.
  'php/dup/Dup1.php': '<?php\nclass Dup {\n    public function a() { return self::onlya() . static::onlya(); }\n    public function onlya() { return 1; }\n}\n',
  'php/dup/Dup2.php': '<?php\nclass Dup {\n    public function b() { return self::onlyb(); }\n    public function onlyb() { return 2; }\n}\n',
  // Trait adaptation: insteadof picks the winner, `as` names a trait method again; visibility-only `as` changes nothing.
  'php/Tc/A.php': '<?php\ntrait TA { public function x() {} public function y() {} public function w() {} }\n',
  'php/Tc/B.php': '<?php\ntrait TB { public function x() {} public function y() {} }\n',
  'php/Tc/C.php': '<?php\ntrait TC { public function y() {} public function z() {} }\n',
  'php/Tc/K.php': [
    '<?php', 'class K {', '    use TA, TB, TC {', '        TB::x insteadof TA;', '        TC::y insteadof TA, TB;', '        TA::x as ax;', '        TB::y as by;',
    '        z as protected;', '        w as private;', '    }',
    '    public function r() { return self::x() . self::ax() . self::y() . self::z() . self::w() . self::by() . static::ax(); }', '}', ''].join('\n'),
  // The class's own method beats an alias of the same name; an alias of a parent-less trait is the trait's; a name that
  // exists in no trait links nothing; the parent's method of the aliased name is overridden by the trait's alias.
  'php/Tc/L.php': '<?php\nclass Par { public function ax() {} public function other() {} }\nclass L extends Par {\n    use TA { x as ax; }\n    public function other() {}\n    public function r() { return self::ax() . parent::ax() . self::other(); }\n}\n',
  // Laravel: the parent is a vendor class; a same-named project class elsewhere is not it.
  'app/Support/Model.php': '<?php\nnamespace App\\Support;\nclass Model {\n    public static function boot() { return 1; }\n    public static function query() { return 1; }\n    public static function where() { return 1; }\n}\n',
  'app/Models/Post.php': [
    '<?php', 'namespace App\\Models;', '', 'use Illuminate\\Database\\Eloquent\\Model;', '',
    'class Post extends Model {', '    protected static function boot() {', '        parent::boot();', '    }',
    '    public static function recent() {', '        return static::query() . self::where();', '    }',
    '    public static function own() { return self::recent(); }', '}', ''].join('\n'),
  'app/Models/Comment.php': '<?php\nnamespace App\\Models;\nclass Comment extends \\App\\Support\\Model {\n    protected static function boot() { parent::boot(); static::query(); }\n}\n',
  'app/Models/Tag.php': '<?php\nnamespace App\\Models;\nclass Tag extends Missing {\n    public static function boot() { parent::boot(); self::query(); }\n}\n',
  // The class that calls through self:: must not link a same-named top-level function.
  'php/Fn.php': '<?php\nfunction helper() { return 1; }\nclass Fn1 {\n    public function f() { return self::helper() . static::helper(); }\n}\n',
  // Dynamic forms are not method calls by name.
  'php/Dyn.php': '<?php\nclass Dyn {\n    public static function f() { return 1; }\n    public function g($name, $cb) { return self::$cb() . static::$name() . self::{\'f\'}() . [self::class, \'f\']; }\n}\n',
};

describe('PHP self::, static:: and parent:: calls (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace(FILES);
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('self::id() in User::name links User::id, on several lines and on one', () => {
    expect(edges(root, 'php/User.php')).toEqual(['User::name -> php/User.php#id', 'User::name -> php/User.php#tag']);
    expect(edges(root, 'php/OneLine.php')).toEqual(['OneLine::name -> php/OneLine.php#id', 'OneLine::name -> php/OneLine.php#tag']);
  });

  it('constants, static properties and ::class give no edge; nothing links the homonyms of Other', () => {
    const all = query<Edge>(root, "SELECT source_symbol, edge_type, target_file, target_symbol FROM edges WHERE source_file = 'php/User.php' AND edge_type != 'import'");
    expect(all.map((e) => `${e.edge_type}:${e.target_symbol}`).sort()).toEqual(['call:id', 'call:tag']);
    expect(query<Edge>(root, "SELECT * FROM edges WHERE target_file = 'php/Other.php'")).toEqual([]);
  });

  it('parent::boot() links the parent class boot, multi-line and one-line', () => {
    expect(edges(root, 'php/Child.php')).toEqual([
      'Child::__construct -> php/Base.php#__construct',
      'Child::boot -> php/Base.php#base',
      'Child::boot -> php/Base.php#boot',
      'Child::boot -> php/Base.php#gp',
      'Child::boot -> php/Child.php#boot',
      'Child::boot -> php/Mid.php#midm',
    ]);
    expect(edges(root, 'php/ChildOne.php')).toEqual(['ChildOne::boot -> php/Base.php#base', 'ChildOne::boot -> php/Base.php#boot']);
  });

  it('with no parent, no declaration or a vendor-like name, nothing links; an own method links itself', () => {
    expect(edges(root, 'php/Lone.php')).toEqual(['Lone::b -> php/Lone.php#b']);
  });

  it('a trait method called through self:: links the trait; the class\'s own method wins', () => {
    expect(edges(root, 'php/Svc.php')).toEqual(['Svc::run -> php/Loggable.php#log', 'Svc::run -> php/Svc.php#both']);
    expect(edges(root, 'php/Helper.php')).toEqual(['Helper::h -> php/Helper.php#h2']);
  });

  it('abstract methods link their declaration; interface constants are no calls', () => {
    expect(edges(root, 'php/Shape.php')).toEqual(['Shape::describe -> php/Shape.php#area']);
    expect(edges(root, 'php/Cfg.php')).toEqual(['Conf::use -> php/Cfg.php#limit']);
  });

  it('a closure or arrow function in a method binds self to its class; outside a class nothing does', () => {
    expect(edges(root, 'php/Clo.php')).toEqual(['Clo::m -> php/Clo.php#h']);
  });

  it('an anonymous class\'s self:: links no method of the class around it', () => {
    expect(edges(root, 'php/Anon.php')).toEqual([]);
    expect(edges(root, 'php/Anon2.php')).toEqual([]);
  });

  it('enums: self:: links the enum\'s methods; from() and cases() are built in', () => {
    expect(edges(root, 'php/Suit.php')).toEqual(['Suit::def -> php/Suit.php#make']);
  });

  it('static:: links the enclosing class\'s chain; a subclass override is not linked', () => {
    expect(edges(root, 'php/Late.php')).toEqual(['P::m -> php/Late.php#hook']);
    expect(query<Edge>(root, "SELECT * FROM edges WHERE source_file = 'php/Late.php' AND edge_type = 'call' AND source_symbol = 'P::m'")).toHaveLength(1);
  });

  it('two classes on one line each reach their own methods only', () => {
    // B declares no x and does not extend A: its self::x() links nothing, not A's x.
    expect(edges(root, 'php/Two.php')).toEqual(['A::f -> php/Two.php#x', 'B::h -> php/Two.php#y']);
  });

  it('two classes of one name in different files each reach their own methods', () => {
    expect(edges(root, 'php/dup/Dup1.php')).toEqual(['Dup::a -> php/dup/Dup1.php#onlya']);
    expect(edges(root, 'php/dup/Dup2.php')).toEqual(['Dup::b -> php/dup/Dup2.php#onlyb']);
  });

  it('a class\'s own namespace decides against a homonym, in statements and in blocks', () => {
    expect(edges(root, 'php/Lib/Order.php')).toEqual(['Order::t -> php/Lib/Order.php#calc']);
    expect(edges(root, 'php/App/Order.php')).toEqual(['Order::t -> php/App/Order.php#calc']);
    // Each block's Order::t reaches its own class's method (the names differ, so a wrong class shows).
    expect(edges(root, 'php/Blocks.php')).toEqual(['Order::t -> php/Blocks.php#ca', 'Order::t -> php/Blocks.php#cb']);
  });

  it('parent:: resolves the parent through use and the namespace, and reaches the parent\'s traits', () => {
    expect(edges(root, 'php/Ns/Kid.php')).toEqual(['Kid1::k -> php/Lib/Order.php#calc', 'Kid2::k -> php/App/Order.php#calc']);
    expect(edges(root, 'php/PTrait.php')).toEqual(['Ki::k -> php/PTrait.php#hi']);
  });

  it('trait conflict resolution: insteadof picks the winner, as aliases a trait method', () => {
    // x: TB (insteadof TA); ax: TA::x; y: TC (insteadof TA, TB); z and w: `as protected` / `as private`
    // change visibility only, so z is TC's and w is TA's.
    expect(edges(root, 'php/Tc/K.php')).toEqual([
      'K::r -> php/Tc/A.php#w', 'K::r -> php/Tc/A.php#x', 'K::r -> php/Tc/B.php#x', 'K::r -> php/Tc/B.php#y', 'K::r -> php/Tc/C.php#y', 'K::r -> php/Tc/C.php#z',
    ]);
    // L: self::ax() is the trait alias of TA::x, not Par::ax; parent::ax() is Par's; the class's own method wins.
    expect(edges(root, 'php/Tc/L.php')).toEqual(['L::r -> php/Tc/A.php#x', 'L::r -> php/Tc/L.php#ax', 'L::r -> php/Tc/L.php#other']);
  });

  it('a vendor parent links nothing, never a same-named project class or function', () => {
    expect(edges(root, 'app/Models/Post.php')).toEqual(['Post::own -> app/Models/Post.php#recent']);
    expect(query<Edge>(root, "SELECT * FROM edges WHERE target_file = 'app/Support/Model.php' AND source_file = 'app/Models/Post.php'")).toEqual([]);
    // A project parent links its method; an unresolvable parent (Missing) links nothing.
    expect(edges(root, 'app/Models/Comment.php')).toEqual(['Comment::boot -> app/Support/Model.php#boot', 'Comment::boot -> app/Support/Model.php#query']);
    expect(edges(root, 'app/Models/Tag.php')).toEqual([]);
  });

  it('a vendor parent\'s method is no external reference: the extends is the package\'s only mark', () => {
    const rows = query<{ kind: string; symbol: string }>(root, "SELECT kind, symbol FROM external_ref_candidates WHERE file_path = 'app/Models/Post.php'");
    expect(rows.map((r) => `${r.kind}:${r.symbol}`).sort()).toEqual(['extends:Model', 'import:Model']);
  });

  it('self::helper() never links a top-level function; dynamic forms link nothing but the literal name', () => {
    expect(edges(root, 'php/Fn.php')).toEqual([]);
    expect(edges(root, 'php/Dyn.php')).toEqual([]);
  });

  it('the edges are verified and carry no resolution hint', () => {
    const rows = query<{ verifiability: string; metadata: string | null }>(root,
      "SELECT verifiability, metadata FROM edges WHERE source_file = 'php/Child.php' AND edge_type = 'call'");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.verifiability).toBe('verified');
      expect(r.metadata ?? '').not.toMatch(/newClass|selfCall/);
    }
  });
});

describe('PHP self:: and parent:: calls after a sync (real scan and sync)', () => {
  let root: string;
  const kid = () => edges(root, 'Kid.php');
  const KID = '<?php\nclass Kid extends Mid {\n  public function k() { self::newm(); parent::newm(); static::b(); }\n}\n';
  beforeAll(() => {
    root = workspace({
      'Base.php': '<?php\nclass Base { public function b() {} }\n',
      'Mid.php': '<?php\nclass Mid extends Base { public function newm() {} }\n',
      'Kid.php': KID,
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('drops the edge when the chain no longer declares the method, and links it when the caller changes, as scan --force does', () => {
    expect(kid()).toEqual(['Kid::k -> Base.php#b', 'Kid::k -> Mid.php#newm']);
    writeFileSync(join(root, 'Mid.php'), '<?php\nclass Mid extends Base { }\n');
    mapx(root, 'sync', root);
    expect(kid()).toEqual(['Kid::k -> Base.php#b']);
    // The method moves up to Base; Kid.php is edited, so sync parses and resolves it again.
    writeFileSync(join(root, 'Base.php'), '<?php\nclass Base { public function b() {} public function newm() {} }\n');
    writeFileSync(join(root, 'Kid.php'), `${KID}// edited\n`);
    mapx(root, 'sync', root);
    expect(kid()).toEqual(['Kid::k -> Base.php#b', 'Kid::k -> Base.php#newm']);
    mapx(root, 'scan', root, '--force');
    expect(kid()).toEqual(['Kid::k -> Base.php#b', 'Kid::k -> Base.php#newm']);
  });
});
