import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-12: a method called on a new instance, `new Order().total()`, links the method the
// instantiated class declares (found by M4-28: JS/TS gave no call edge), never a same-named method
// of another class (Java, C#, PHP and Python linked one by name).
type Edge = { source_symbol: string | null; edge_type: string; target_file: string; target_symbol: string; verifiability: string };

function edgesFrom(root: string, file: string): string[] {
  return query<Edge>(root, `SELECT source_symbol, edge_type, target_file, target_symbol, verifiability FROM edges
    WHERE source_file = ? AND edge_type NOT IN ('import', 'require') ORDER BY 1, 2, 3, 4`, file)
    .map((e) => `${e.source_symbol} ${e.edge_type} ${e.target_file}#${e.target_symbol} ${e.verifiability}`);
}

/** The edges from `file` whose source symbol is `symbol`. */
function from(root: string, file: string, symbol: string): string[] {
  return edgesFrom(root, file).filter((e) => e.startsWith(`${symbol} `)).map((e) => e.slice(symbol.length + 1));
}

describe('a method called on a new-expression (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'some-pkg': '^1.0.0' } }),
      // A same-named method elsewhere: name lookup would pick it (Invoice sorts first).
      'src/invoice.ts': 'export class Invoice {\n  total(): number { return 2; }\n  c(): number { return 2; }\n  only(): number { return 3; }\n  base(): number { return 3; }\n}\n',
      'src/order.ts': 'export class Order<T = number> {\n  total(): number { return 1; }\n  next(): Order { return this; }\n}\nexport class Quote extends Order {}\n',
      'src/a.ts': `import { Order } from './order';
import * as orders from './order';
import { Order as Renamed, Quote } from './order';
import { Sub } from './sub';

export function viaNew() {
  return new Order().total();
}
export function viaVar() {
  const o = new Order();
  return o.total();
}
export function viaNs() { return new orders.Order().total(); }
export function viaGeneric() { return new Order<string>().total(); }
export function viaParens() { return (new Order()).total(); }
export function viaAlias() { return new Renamed().total(); }
export function chained() { return new Order().next().c(); }
export function inherited() { return new Quote().total(); }
export function noSuch() { return new Order().only(); }
export function viaSub() { return new Sub().base(); }
export function dyn() { return new (getClass())().total(); }
export function computed(reg: any[]) { return new reg[0]().total(); }
function getClass(): any { return Order; }
`,
      // A base imported from another file; a same-named method in an unrelated class beside it.
      'src/base.ts': 'export class Base {\n  base(): number { return 0; }\n}\n',
      'src/sub.ts': "import { Base } from './base';\nexport class Sub extends Base {}\nexport class Other {\n  base(): number { return 9; }\n}\n",
      // A class imported from a package is the package's (M2-08-R3), even when the project has one.
      'src/pkg.ts': `import { Order } from 'some-pkg';
import * as lib from 'some-pkg';

export function viaPkg() { return new Order().total(); }
export function viaPkgNs() { return new lib.Order().total(); }
`,
      'js/invoice.js': 'export class Invoice {\n  total() { return 2; }\n}\n',
      'js/order.js': 'export class Order {\n  total() { return 1; }\n}\n',
      'js/a.js': `import { Order } from './order.js';

export function viaNew() {
  return new Order().total();
}
`,
      'php/Invoice.php': '<?php\nnamespace App;\nclass Invoice {\n  public function total() { return 2; }\n}\n',
      'php/Order.php': '<?php\nnamespace App;\nclass Order {\n  public function total() { return 1; }\n}\n',
      'php/A.php': '<?php\nnamespace App;\nclass A {\n  public function run() {\n    return (new Order())->total();\n  }\n  public function lib() {\n    return (new \\Vendor\\Client())->total();\n  }\n}\n',
      // Several classes in one file: each method is its own class's (review of M2-12).
      'php/Base.php': '<?php\nnamespace App;\nclass Base {\n  public function base() { return 0; }\n}\n',
      'php/Sub.php': '<?php\nnamespace App;\nclass Other {\n  public function base() { return 9; }\n  public function helper() { return 9; }\n}\nclass Sub extends Base {}\n',
      'php/Traits.php': '<?php\nnamespace App;\ntrait T {\n  public function t() { return 1; }\n}\nclass UsesT {\n  use T;\n}\n',
      'php/B.php': '<?php\nnamespace App;\nclass B extends Base {\n  public function inh() {\n    return (new Sub())->base();\n  }\n  public function oth() {\n    return (new Other())->base();\n  }\n  public function tr() {\n    return (new UsesT())->t();\n  }\n  public function helper() { return 1; }\n  public function slf() {\n    return (new self())->helper();\n  }\n  public function stc() {\n    return (new static())->helper();\n  }\n  public function par() {\n    return (new parent())->base();\n  }\n}\n',
      'java/com/acme/Invoice.java': 'package com.acme;\npublic class Invoice {\n  public int total() { return 2; }\n}\n',
      'java/com/acme/Order.java': 'package com.acme;\npublic class Order<T> {\n  public int total() { return 1; }\n}\n',
      'java/com/acme/A.java': 'package com.acme;\npublic class A {\n  int run() {\n    return new Order().total();\n  }\n  int generic() {\n    return new Order<String>().total();\n  }\n  int lib() {\n    return new StringBuilder().total();\n  }\n}\n',
      'cs/Invoice.cs': 'namespace Acme {\n  public class Invoice {\n    public int Total() { return 2; }\n  }\n}\n',
      'cs/Order.cs': 'namespace Acme {\n  public class Order {\n    public int Total() { return 1; }\n  }\n}\n',
      'cs/A.cs': 'namespace Acme {\n  public class A {\n    int Run() {\n      return new Order().Total();\n    }\n  }\n}\n',
      'py/invoice.py': 'class Invoice:\n    def total(self):\n        return 2\n',
      'py/order.py': 'class Order:\n    def total(self):\n        return 1\n',
      'py/a.py': 'from order import Order\nfrom sub import Sub\n\ndef run():\n    return Order().total()\n\ndef inh():\n    return Sub().total()\n',
      'py/sub.py': 'from order import Order\n\nclass Sub(Order):\n    pass\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('TS: new Order().total() links order.ts#total, verified, and keeps the instantiation edge', () => {
    expect(from(root, 'src/a.ts', 'viaNew')).toEqual([
      'call src/order.ts#total verified',
      'instantiation src/order.ts#Order verified',
    ]);
  });

  it('TS: a namespace import, type arguments, parentheses and an import alias resolve the same class', () => {
    expect(from(root, 'src/a.ts', 'viaNs')).toContain('call src/order.ts#total verified');
    expect(from(root, 'src/a.ts', 'viaGeneric')).toEqual(['call src/order.ts#total verified', 'instantiation src/order.ts#Order verified']);
    expect(from(root, 'src/a.ts', 'viaParens')).toEqual(['call src/order.ts#total verified', 'instantiation src/order.ts#Order verified']);
    expect(from(root, 'src/a.ts', 'viaAlias')).toContain('call src/order.ts#total verified');
  });

  it('TS: a chain resolves only its first call; the next one has no known receiver type', () => {
    expect(from(root, 'src/a.ts', 'chained')).toEqual([
      'call src/order.ts#next verified',
      'instantiation src/order.ts#Order verified',
    ]);
  });

  it('TS: an inherited method is the base class\'s, in the same file or imported (review of M2-12)', () => {
    expect(from(root, 'src/a.ts', 'inherited').filter((e) => e.startsWith('call '))).toEqual(['call src/order.ts#total verified']);
    expect(from(root, 'src/a.ts', 'viaSub').filter((e) => e.startsWith('call '))).toEqual(['call src/base.ts#base verified']);
  });

  it('TS: a method no class of the chain declares, or a class the syntax does not name, links nothing', () => {
    expect(from(root, 'src/a.ts', 'noSuch').filter((e) => e.startsWith('call '))).toEqual([]);
    expect(from(root, 'src/a.ts', 'dyn').filter((e) => e.includes('#total'))).toEqual([]);
    expect(from(root, 'src/a.ts', 'computed').filter((e) => e.includes('#total'))).toEqual([]);
  });

  // `const o = new Order(); o.total()` (viaVar) still resolves by name, inferred: not this task.
  it('TS: no new-expression call reaches a same-named method of another class', () => {
    expect(edgesFrom(root, 'src/a.ts').filter((e) => (e.includes('src/invoice.ts') || e.includes('src/sub.ts#base')) && !e.startsWith('viaVar '))).toEqual([]);
  });

  it('TS: a class imported from a package links no project symbol (M2-08-R3)', () => {
    expect(edgesFrom(root, 'src/pkg.ts')).toEqual([]);
  });

  it('JS: new Order().total() links order.js#total', () => {
    expect(from(root, 'js/a.js', 'viaNew')).toEqual([
      'call js/order.js#total verified',
      'instantiation js/order.js#Order verified',
    ]);
  });

  it('PHP: (new Order())->total() links Order::total; a vendor class links nothing', () => {
    expect(from(root, 'php/A.php', 'A::run')).toEqual([
      'call php/Order.php#total verified',
      'instantiation php/Order.php#App\\Order verified',
    ]);
    expect(from(root, 'php/A.php', 'A::lib')).toEqual([]);
  });

  it('PHP: several classes in one file, a trait, and new self / static / parent (review of M2-12)', () => {
    expect(from(root, 'php/B.php', 'B::inh').filter((e) => e.startsWith('call '))).toEqual(['call php/Base.php#base verified']);
    expect(from(root, 'php/B.php', 'B::oth').filter((e) => e.startsWith('call '))).toEqual(['call php/Sub.php#base verified']);
    expect(from(root, 'php/B.php', 'B::tr').filter((e) => e.startsWith('call '))).toEqual(['call php/Traits.php#t verified']);
    expect(from(root, 'php/B.php', 'B::slf').filter((e) => e.startsWith('call '))).toEqual(['call php/B.php#helper verified']);
    expect(from(root, 'php/B.php', 'B::stc').filter((e) => e.startsWith('call '))).toEqual(['call php/B.php#helper verified']);
    expect(from(root, 'php/B.php', 'B::par').filter((e) => e.startsWith('call '))).toEqual(['call php/Base.php#base verified']);
    // The members of Sub.php are scoped to their own class.
    expect(query<{ name: string; scope: string }>(root, "SELECT name, scope FROM symbols WHERE file_path = 'php/Sub.php' AND kind = 'method' ORDER BY name"))
      .toEqual([{ name: 'base', scope: 'Other' }, { name: 'helper', scope: 'Other' }]);
  });

  it('Java: new Order().total() and new Order<String>().total() link Order#total; a library class links nothing', () => {
    expect(from(root, 'java/com/acme/A.java', 'A::run')).toEqual([
      'call java/com/acme/Order.java#total verified',
      'instantiation java/com/acme/Order.java#Order verified',
    ]);
    expect(from(root, 'java/com/acme/A.java', 'A::generic')).toContain('call java/com/acme/Order.java#total verified');
    expect(from(root, 'java/com/acme/A.java', 'A::lib').filter((e) => e.startsWith('call'))).toEqual([]);
  });

  it('C#: new Order().Total() links Order#Total', () => {
    expect(from(root, 'cs/A.cs', 'A::Run')).toEqual([
      'call cs/Order.cs#Total verified',
      'instantiation cs/Order.cs#Order verified',
    ]);
  });

  it('Python: Order().total() links Order#total, and Sub(Order) inherits it', () => {
    expect(from(root, 'py/a.py', 'run')).toEqual([
      'call py/order.py#total verified',
      'instantiation py/order.py#Order verified',
    ]);
    expect(from(root, 'py/a.py', 'inh').filter((e) => e.startsWith('call '))).toEqual(['call py/order.py#total verified']);
  });
});

// Re-review of M2-12: a chain lacking the method links nothing only when MapX knows the class's
// whole method set; otherwise name lookup, inferred, as before M2-12. C# extension methods and
// partial classes, Python bases through aliases and its method order, PHP trait precedence.
describe('a method called on a new-expression: closed and open chains (real scan)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'cs/Ext.cs': 'namespace Acme.Ext {\n  public static class WidgetExtensions {\n    public static int Spin(this Acme.App.Widget w) { return 1; }\n  }\n}\n',
      'cs/Widget.cs': 'namespace Acme.App {\n  public partial class Widget {\n    public int One() { return 1; }\n  }\n}\n',
      'cs/Widget.Designer.cs': 'namespace Acme.App {\n  public partial class Widget {\n    public int Two() { return 2; }\n  }\n}\n',
      'cs/Use.cs': 'using Acme.Ext;\nnamespace Acme.App {\n  public class Use {\n    public int Run() {\n      return new Widget().One() + new Widget().Two() + new Widget().Spin();\n    }\n  }\n}\n',
      'java/com/acme/Other.java': 'package com.acme;\npublic class Other {\n  public int add(int x) { return x; }\n  public int none() { return 0; }\n}\n',
      'java/com/acme/MyList.java': 'package com.acme;\nimport java.util.ArrayList;\npublic class MyList extends ArrayList<Integer> {}\n',
      'java/com/acme/Plain.java': 'package com.acme;\npublic class Plain {}\n',
      'java/com/acme/Shape.java': 'package com.acme;\npublic interface Shape {\n  default int area() { return 0; }\n}\n',
      'java/com/acme/Sq.java': 'package com.acme;\npublic class Sq implements Shape {}\n',
      'java/com/acme/Use.java': 'package com.acme;\npublic class Use {\n  int dflt() {\n    return new Sq().area();\n  }\n  int lib() {\n    return new MyList().add(1) ? 1 : 0;\n  }\n  int closed() {\n    return new Plain().none();\n  }\n}\n',
      'pkg/__init__.py': '',
      'pkg/core/__init__.py': 'from .base import Base\n',
      'pkg/core/base.py': 'class Base:\n    def base(self):\n        return 0\n',
      'pkg/models.py': 'from .core import Base\nfrom .core.base import Base as B2\n\nclass Kid(Base):\n    pass\n\nclass Kid2(B2):\n    pass\n',
      'pkg/use.py': 'from .models import Kid, Kid2\n\ndef run():\n    return Kid().base()\n\ndef run2():\n    return Kid2().base()\n',
      'py/x.py': 'class X:\n    def m(self):\n        return "X"\n\nclass A(X):\n    pass\n',
      'py/b.py': 'class B:\n    def m(self):\n        return "B"\n',
      'py/other.py': 'class Other:\n    def only(self):\n        return 1\n    def made(self):\n        return 2\n',
      'py/factory.py': 'def Maker():\n    return 1\n',
      'py/c.py': 'from x import A\nfrom b import B\nfrom factory import Maker\n\nclass C(A, B):\n    pass\n\ndef run():\n    return C().m()\n\ndef closed():\n    return B().only()\n\ndef factory():\n    return Maker().made()\n',
      'php/Greets.php': '<?php\nnamespace App;\ntrait Greets {\n  public function both() { return "t"; }\n}\n',
      'php/Kid.php': '<?php\nnamespace App;\nclass ParentC {\n  public function both() { return "p"; }\n}\nclass Kid extends ParentC {\n  use Greets;\n}\nclass Magic {\n  public function __call($n, $a) { return 1; }\n}\nclass Other {\n  public function anything() { return 2; }\n}\n',
      'php/Use.php': '<?php\nnamespace App;\nclass UseIt {\n  public function a() {\n    return (new Kid())->both();\n  }\n  public function b() {\n    return (new Magic())->anything();\n  }\n  public function c($cls) {\n    return (new $cls())->anything();\n  }\n  public function d() {\n    return (new class { public function x() { return 1; } })->anything();\n  }\n}\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));
  const calls = (file: string, symbol: string) => from(root, file, symbol).filter((e) => e.startsWith('call '));

  it('C#: an extension method and every declaration of a partial class', () => {
    expect(calls('cs/Use.cs', 'Use::Run')).toEqual(['call cs/Ext.cs#Spin verified', 'call cs/Widget.Designer.cs#Two verified', 'call cs/Widget.cs#One verified']);
  });

  it('Java: a library base leaves the chain open (name lookup, inferred); a closed one links nothing; an interface default method', () => {
    expect(calls('java/com/acme/Use.java', 'Use::lib')).toEqual(['call java/com/acme/Other.java#add inferred']);
    expect(calls('java/com/acme/Use.java', 'Use::closed')).toEqual([]);
    expect(calls('java/com/acme/Use.java', 'Use::dflt')).toEqual(['call java/com/acme/Shape.java#area verified']);
  });

  it('Python: bases through a package import and an aliased relative import; depth-first left order', () => {
    expect(calls('pkg/use.py', 'run')).toEqual(['call pkg/core/base.py#base verified']);
    expect(calls('pkg/use.py', 'run2')).toEqual(['call pkg/core/base.py#base verified']);
    expect(calls('py/c.py', 'run')).toEqual(['call py/x.py#m verified']);
  });

  it('Python: a closed class lacking the method links nothing; a factory function keeps name lookup', () => {
    expect(calls('py/c.py', 'closed')).toEqual([]);
    expect(calls('py/c.py', 'factory')).toEqual(['call py/other.py#made inferred']);
  });

  it('PHP: a trait method wins over the parent\'s; __call keeps name lookup; new $cls() and new class {} link nothing', () => {
    expect(calls('php/Use.php', 'UseIt::a')).toEqual(['call php/Greets.php#both verified']);
    expect(calls('php/Use.php', 'UseIt::b')).toEqual(['call php/Kid.php#anything inferred']);
    expect(calls('php/Use.php', 'UseIt::c')).toEqual([]);
    expect(calls('php/Use.php', 'UseIt::d')).toEqual([]);
  });
});

describe('a method called on a new-expression, after sync', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'src/invoice.ts': 'export class Invoice {\n  total(): number { return 2; }\n}\n',
      'src/order.ts': 'export class Order {\n  total(): number { return 1; }\n}\n',
      'src/a.ts': "import { Order } from './order';\n\nexport function viaNew() {\n  return new Order().total();\n}\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('drops the edge when the class no longer declares the method, as scan --force does', () => {
    expect(from(root, 'src/a.ts', 'viaNew')).toContain('call src/order.ts#total verified');
    writeFileSync(join(root, 'src/order.ts'), 'export class Order {\n  sum(): number { return 1; }\n}\n');
    mapx(root, 'sync', root);
    const synced = from(root, 'src/a.ts', 'viaNew');
    mapx(root, 'scan', root, '--force');
    expect(synced).toEqual(from(root, 'src/a.ts', 'viaNew'));
    expect(synced.filter((e) => e.includes('src/order.ts#total'))).toEqual([]);
  }, 120000);
});
