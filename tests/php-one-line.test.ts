import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-13: calls inside a class written on one line come from their method, as over several lines
// (found smoke-testing v0.3.9: a one-line PHP class gave no callee for User::name). The scanner's
// line ranges cannot tell several symbols on one line apart, so the syntax tree decides, as for
// one-line C++ functions (M5-03-R2).
type Edge = { source_symbol: string | null; edge_type: string; target_file: string; target_symbol: string };

function calls(root: string, file: string): string[] {
  return query<Edge>(root, `SELECT source_symbol, edge_type, target_file, target_symbol FROM edges
    WHERE source_file = ? AND edge_type = 'call' ORDER BY 1, 3, 4`, file)
    .map((e) => `${e.source_symbol} -> ${e.target_file}#${e.target_symbol}`);
}

describe('calls inside a one-line class (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'php/User.php': '<?php class User { public function name() { return $this->id(); } private function id() { return 1; } }\n',
      'php/Multi.php': '<?php\nclass Multi {\n  public function name() {\n    return $this->id();\n  }\n  private function id() { return 1; }\n}\n',
      // A namespaced one-line file (`<?php namespace App;`): member and function calls between one-line
      // methods and functions.
      'php/Ns.php': '<?php namespace App; class Svc { public function run() { return $this->make() + (new Order())->total(); } public function make() { return helper(); } } function helper() { return 1; } function top() { return helper(); }\n',
      'php/Order.php': '<?php\nnamespace App;\nclass Order {\n  public function total() { return 1; }\n}\n',
      // Review of M2-13: two classes, a trait, extends and a template, each on one line; namespaces
      // in blocks or statements, on one line or several.
      'php/Two.php': '<?php class A { public function m() { return $this->x(); } public function x() { return 1; } } class B extends A { public function n() { return $this->y(); } public function y() { return (new A())->m(); } }\n',
      'php/Tr.php': '<?php trait T { public function t() { return $this->u(); } public function u() { return 1; } } class UsesT { use T; public function w() { return $this->t(); } }\n',
      'php/tpl.php': '<html><?php function tplf() { return tplg(); } ?><body><?php echo tplf(); ?></body><?php function tplg() { return 1; } ?></html>\n',
      'php/LibOrder.php': '<?php\nnamespace Lib;\nclass Order {\n  public function total() { return 2; }\n}\n',
      'php/NsBlocks.php': '<?php namespace Lib { class W { public function w() { return 1; } } } namespace App { class Q { public function q() { return (new Order())->total(); } } }\n',
      // Re-review: a class or function declared in the first of two blocks is that block's, not the file's last.
      'php/NsCross.php': '<?php namespace Lib { class Order { public function total() { return 2; } } function lf() { return 1; } } namespace App2 { class K { public function k() { return (new Order())->total() + \\Lib\\lf(); } } }\n',
      'php/NsStatements.php': '<?php namespace Lib;\nclass X { public function x() { return (new Order())->total(); } }\nnamespace App;\nclass Y { public function y() { return (new Order())->total() + helper(); } }\n',
      'js/user.js': 'export class User { name() { return this.id(); } id() { return 1; } }\n',
      'js/arrows.js': 'export const b = () => 1; export const a = () => b();\n',
      'ts/user.ts': 'export class User { name(): number { return this.id(); } id(): number { return 1; } }\n',
      'java/User.java': 'public class User { int name() { return id(); } int id() { return 1; } }\n',
      // Python cannot put two methods on one line; one-line defs and a module-level lambda.
      'py/user.py': 'def helper(): return 1\nclass User:\n    def name(self): return self.id()\n    def id(self): return helper()\nrun = lambda: helper()\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('PHP: the one-line class gives User::name -> User::id, as over several lines', () => {
    expect(calls(root, 'php/User.php')).toEqual(['User::name -> php/User.php#id']);
    expect(calls(root, 'php/Multi.php')).toEqual(['Multi::name -> php/Multi.php#id']);
  });

  it('PHP: in a one-line namespaced file, member and function calls come from their method or function', () => {
    expect(calls(root, 'php/Ns.php')).toEqual([
      'Svc::make -> php/Ns.php#App\\helper',
      'Svc::run -> php/Ns.php#make',
      'Svc::run -> php/Order.php#total',
      'top -> php/Ns.php#App\\helper',
    ]);
  });

  it('PHP: a class named in a one-line namespaced file resolves in its namespace', () => {
    expect(query<Edge>(root, `SELECT source_symbol, edge_type, target_file, target_symbol FROM edges
      WHERE source_file = 'php/Ns.php' AND edge_type = 'instantiation'`).map((e) => `${e.source_symbol} -> ${e.target_file}#${e.target_symbol}`))
      .toEqual(['Svc::run -> php/Order.php#App\\Order']);
  });

  it('Python: one-line methods and a module-level lambda come from themselves', () => {
    expect(calls(root, 'py/user.py')).toEqual(['User::id -> py/user.py#helper', 'User::name -> py/user.py#id', 'run -> py/user.py#helper']);
  });

  it('JS: one-line arrow functions on one line come from themselves', () => {
    expect(calls(root, 'js/arrows.js')).toEqual(['a -> js/arrows.js#b']);
  });

  it('PHP: two classes and a trait on one line; `class B extends A` beside A is B\'s (review of M2-13)', () => {
    expect(calls(root, 'php/Two.php')).toEqual(['A::m -> php/Two.php#x', 'B::n -> php/Two.php#y', 'B::y -> php/Two.php#m']);
    expect(query<Edge>(root, "SELECT source_symbol, edge_type, target_file, target_symbol FROM edges WHERE source_file = 'php/Two.php' AND edge_type = 'extends'")
      .map((e) => `${e.source_symbol} -> ${e.target_file}#${e.target_symbol}`)).toEqual(['B -> php/Two.php#A']);
    expect(calls(root, 'php/Tr.php')).toEqual(['T::t -> php/Tr.php#u', 'UsesT::w -> php/Tr.php#t']);
  });

  it('PHP: a template\'s top-level call is the file\'s, not the function on its line', () => {
    expect(calls(root, 'php/tpl.php')).toEqual(['null -> php/tpl.php#tplf', 'tplf -> php/tpl.php#tplg']);
  });

  it('PHP: each namespace block or statement resolves its own names, on one line or several', () => {
    expect(calls(root, 'php/NsBlocks.php')).toEqual(['Q::q -> php/Order.php#total']);
    // App2\Order is declared nowhere: no edge, never Lib\Order of the first block; \Lib\lf is that block's.
    expect(calls(root, 'php/NsCross.php')).toEqual(['K::k -> php/NsCross.php#Lib\\lf']);
    expect(calls(root, 'php/NsStatements.php')).toEqual(['X::x -> php/LibOrder.php#total', 'Y::y -> php/Ns.php#App\\helper', 'Y::y -> php/Order.php#total']);
  });

  it('JS, TS and Java: the one-line class gives User::name -> id', () => {
    expect(calls(root, 'js/user.js')).toEqual(['User::name -> js/user.js#id']);
    expect(calls(root, 'ts/user.ts')).toEqual(['User::name -> ts/user.ts#id']);
    expect(calls(root, 'java/User.java')).toEqual(['User::name -> java/User.java#id']);
  });
});
