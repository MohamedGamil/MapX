import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workspace, init, mapx, query, cleanup } from './helpers/e2e.js';

// M5-25: a package-qualified Go composite literal (`domain.Order{}`) is an instantiation edge to the
// type in the imported project package, never a homonym elsewhere and never a library type.
interface Row { id: string; app: string; edgeType?: string; from?: { file: string; symbol?: string }; to?: { file: string; symbol?: string } }
interface Edge { source_file: string; target_file: string; target_symbol: string; edge_type: string }

const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');
const rows = (JSON.parse(readFileSync(join(FIXTURE, 'expected-findings.json'), 'utf8')).rows as Row[])
  .filter((r) => r.app === 'go' && r.edgeType === 'instantiation' && r.from && r.to);

let app = '';
let ws = '';
let calls = '';
let shadow = '';
let work = '';
let replaced = '';
let noMod = '';

const scanned = (files: Record<string, string>) => {
  const root = workspace(files);
  init(root);
  mapx(root, 'scan');
  return root;
};

// The same names in every package (M5-25-R1).
const homonyms = (pkg: string) => [
  `package ${pkg}`,
  '',
  'type Order struct{}',
  '',
  'type Item struct{}',
  '',
  'type Box[T any] struct{ V T }',
  '',
  'func NewOrder() Order { return Order{} }',
  '',
  'func (o Order) Run() {}',
  '',
  'func Unix() int64 { return 0 }',
  '',
  'func NewReader() {}',
  '',
].join('\n');

beforeAll(() => {
  app = mkdtempSync(join(tmpdir(), 'mapx-go-qualified-'));
  cpSync(join(FIXTURE, 'go'), app, { recursive: true });
  init(app);
  mapx(app, 'scan');

  ws = workspace({
    'go.mod': 'module example.com/shop\n\nrequire github.com/acme/money v1.0.0\n',
    'domain/order.go': 'package domain\n\ntype Order struct{}\n',
    // A homonym in another package: an unrelated `Order` the qualified literal must not reach.
    'legacy/order.go': 'package legacy\n\ntype Order struct{}\n',
    // Third-party (not in the workspace) and standard-library types named like project ones.
    'billing/time.go': 'package billing\n\ntype Time struct{}\n\ntype Amount struct{}\n',
    'app/use.go': [
      'package app',
      '',
      'import (',
      '\td "example.com/shop/domain"',
      '\t"github.com/acme/money"',
      '\t"time"',
      ')',
      '',
      'func Use() {',
      '\t_ = d.Order{}',
      '\t_ = time.Time{}',
      '\t_ = money.Amount{}',
      '}',
      '',
    ].join('\n'),
  });
  init(ws);
  mapx(ws, 'scan');

  // M5-25-R1: the imported package `domain`, a homonym package `legacy` and the calling package `app`
  // all declare the same names, so a by-name match would reach the wrong declaration.
  calls = scanned({
    'go.mod': 'module example.com/shop\n\nrequire github.com/acme/money v1.0.0\n',
    // `Order` embeds `Logger` (another file of the package): `Log` is promoted.
    'domain/order.go': homonyms('domain').replace('type Order struct{}', 'type Order struct {\n\tLogger `json:"-"`\n\tname string\n}'),
    'domain/logger.go': 'package domain\n\ntype Logger struct{}\n\nfunc (l Logger) Log() {}\n',
    'legacy/order.go': homonyms('legacy'),
    'app/local.go': homonyms('app') + '\nfunc Log() {}\n',
    // `string` may be declared (it is predeclared, not reserved); `[]string{}` never names it.
    'other/types.go': 'package other\n\ntype string struct{}\n\ntype T struct{}\n\ntype E struct{}\n\ntype K struct{}\n',
    'app/use.go': [
      'package app',
      '',
      'import (',
      '\t"example.com/shop/domain"',
      '\t"github.com/acme/money"',
      '\t"strings"',
      '\t"time"',
      ')',
      '',
      'func Calls() {',
      '\t_ = domain.NewOrder()',
      '\tdomain.Order{}.Run()',
      '\t_ = strings.NewReader("")',
      '\t_ = money.NewOrder()',
      '\t_ = time.Time{}.Unix()',
      '}',
      '',
      'func Pointer() {',
      '\t(&domain.Order{}).Run()',
      '}',
      '',
      'func Promoted() {',
      '\tdomain.Order{}.Log()',
      '}',
      '',
      'func Generic() {',
      '\t_ = domain.Box[int]{}',
      '}',
      '',
      'func Slice() {',
      '\t_ = []domain.Item{{}}',
      '}',
      '',
      'func Map() {',
      '\t_ = map[string]domain.Item{}',
      '}',
      '',
      'func Arrays() {',
      '\t_ = [2]domain.Item{}',
      '\t_ = [...]*domain.Item{}',
      '}',
      '',
      'func Nested() {',
      '\t_ = map[string]*domain.Box[int]{}',
      '\t_ = map[string][]domain.Item{}',
      '}',
      '',
      'func Local() {',
      '\t_ = Box[int]{}',
      '\t_ = []*Item{}',
      '\t_ = []string{}',
      '}',
      '',
      'func Collect[T any, E comparable](xs ...T) []T {',
      '\t_ = map[string]E{}',
      '\treturn []T{}',
      '}',
      '',
    ].join('\n'),
    // A method of a generic type: `K` is its receiver's type parameter (the method itself is not
    // indexed as a symbol, so the file is asserted whole).
    'app/keys.go': 'package app\n\nfunc (b *Box[K]) Keys() []K { return []K{} }\n',
  });

  // A variable or parameter named like an import is not the package.
  shadow = scanned({
    'go.mod': 'module example.com/m\n',
    'user/user.go': 'package user\n\ntype User struct{}\n\nfunc New() *User { return &User{} }\n\nfunc (u *User) Save() {}\n',
    'domain/order.go': 'package domain\n\ntype Order struct{}\n\nfunc (o Order) Ship() {}\n',
    'app/app.go': [
      'package app',
      '',
      'import (',
      '\td "example.com/m/domain"',
      '\t"example.com/m/user"',
      ')',
      '',
      'func Shadow() {',
      '\tuser := user.New()',
      '\tuser.Save()',
      '}',
      '',
      'func Param(user *user.User) {',
      '\tuser.Save()',
      '}',
      '',
      'func Loop(orders []d.Order) {',
      '\tfor _, d := range orders {',
      '\t\td.Ship()',
      '\t}',
      '}',
      '',
    ].join('\n'),
  });

  // Several modules: a go.work joins them; a go.mod `replace` with a local path does too.
  const modules = (root: Record<string, string>) => ({
    ...root,
    'lib/go.mod': 'module example.com/lib\n\ngo 1.22\n',
    'lib/store/store.go': 'package store\n\ntype Store struct{}\n\nfunc Open(dsn string) *Store { return &Store{} }\n\nfunc (s Store) Save() {}\n',
    // A homonym in the importing module.
    'svc/store/store.go': 'package store\n\ntype Store struct{}\n\nfunc Open(dsn string) *Store { return &Store{} }\n\nfunc (s Store) Save() {}\n',
    'svc/cmd/main.go': 'package main\n\nimport "example.com/lib/store"\n\nfunc main() {\n\t_ = store.Open("x")\n\tstore.Store{}.Save()\n}\n',
  });
  work = scanned(modules({
    'go.work': 'go 1.22\n\nuse (\n\t./svc\n\t./lib\n)\n',
    'svc/go.mod': 'module example.com/svc\n\ngo 1.22\n\nrequire example.com/lib v0.0.0\n',
  }));
  replaced = scanned(modules({
    'svc/go.mod': 'module example.com/svc\n\ngo 1.22\n\nrequire example.com/lib v0.0.0\n\nreplace example.com/lib => ../lib\n',
  }));

  // No go.mod: a qualified name is found by name outside the calling package; a standard-library
  // qualifier still links nothing.
  noMod = scanned({
    // `Fields` is unique too, but `strings.Fields` is the standard library's.
    'domain/order.go': homonyms('domain') + '\nfunc Only() {}\n\nfunc Fields() {}\n',
    'legacy/order.go': homonyms('legacy'),
    'app/local.go': homonyms('app'),
    'app/use.go': 'package app\n\nimport (\n\t"example.com/shop/domain"\n\t"strings"\n)\n\nfunc Use() {\n\t_ = domain.NewOrder()\n\tdomain.Only()\n\tdomain.Order{}.Run()\n\t_ = strings.NewReader("")\n\t_ = strings.Fields("")\n}\n',
  });
}, 300_000);
afterAll(() => { for (const root of [app, ws, calls, shadow, work, replaced, noMod]) cleanup(root); });

describe('Go package-qualified composite literals (M5-25)', () => {
  it('the fixture app has an instantiation edge for every labelled cross-package literal', () => {
    const edges = query<Edge>(app, "SELECT source_file, target_file, target_symbol, edge_type FROM edges WHERE edge_type = 'instantiation'");
    const crossPackage = rows.filter((r) => r.from!.file.split('/').slice(0, -1).join('/') !== r.to!.file.split('/').slice(0, -1).join('/'));
    expect(crossPackage.map((r) => r.id)).toEqual(expect.arrayContaining(['go-05', 'go-06', 'go-07', 'go-08', 'go-16', 'go-17', 'go-22', 'go-23']));
    for (const r of crossPackage) {
      expect(edges.some((e) => e.source_file === r.from!.file && e.target_file === r.to!.file && e.target_symbol === r.to!.symbol), r.id).toBe(true);
    }
  });

  it('an aliased import resolves to its package; a homonym, the standard library and a third-party package do not', () => {
    const edges = query<Edge>(ws, "SELECT source_file, target_file, target_symbol, edge_type FROM edges WHERE source_file = 'app/use.go' AND edge_type = 'instantiation'");
    expect(edges.map((e) => `${e.target_file}#${e.target_symbol}`)).toEqual(['domain/order.go#Order']);
  });
});

// M5-25-R1: package-qualified calls, methods on a qualified literal, and generic, slice, array and
// map literals of an imported type reach the imported package's declaration only.
describe('Go package-qualified calls and wrapped literals (M5-25-R1)', () => {
  const from = (root: string, file: string, fn: string, type: string) => query<Edge>(root,
    'SELECT source_file, target_file, target_symbol, edge_type FROM edges WHERE source_file = ? AND source_symbol = ? AND edge_type = ? ORDER BY target_file, target_symbol',
    file, fn, type).map((e) => `${e.target_file}#${e.target_symbol}`);
  const use = (fn: string, type: string) => from(calls, 'app/use.go', fn, type);

  it('`domain.NewOrder()` links the imported package\'s function; library qualifiers link nothing', () => {
    // Not app/local.go (same package) nor legacy/order.go; `strings.NewReader`, `money.NewOrder` and
    // `time.Time{}.Unix()` name library packages, whatever the workspace declares.
    expect(use('Calls', 'call')).toEqual(['domain/order.go#NewOrder', 'domain/order.go#Run']);
  });

  it('a method called on a pointer to a qualified literal links that type\'s method', () => {
    expect(use('Pointer', 'call')).toEqual(['domain/order.go#Run']);
  });

  it('a method the literal\'s type promotes from a type it embeds links the embedded type\'s method', () => {
    expect(use('Promoted', 'call')).toEqual(['domain/logger.go#Log']);
  });

  it('`domain.Box[int]{}`, `[]domain.Item{{}}` and `map[string]domain.Item{}` each give one instantiation edge to the imported type', () => {
    expect(use('Generic', 'instantiation')).toEqual(['domain/order.go#Box']);
    expect(use('Slice', 'instantiation')).toEqual(['domain/order.go#Item']);
    expect(use('Map', 'instantiation')).toEqual(['domain/order.go#Item']);
  });

  it('array literals and nested map values (`*Box[int]`, `[]Item`) name their element type', () => {
    expect(use('Arrays', 'instantiation')).toEqual(['domain/order.go#Item', 'domain/order.go#Item']);
    expect(use('Nested', 'instantiation')).toEqual(['domain/order.go#Box', 'domain/order.go#Item']);
  });

  it('a literal of a local type links the calling package\'s type; a predeclared type or a type parameter links nothing', () => {
    // `[]string{}` never reaches other/types.go#string; `[]T`, `map[string]E` and `[]K` are type
    // parameters, not other/types.go's T, E and K.
    expect(use('Local', 'instantiation')).toEqual(['app/local.go#Box', 'app/local.go#Item']);
    expect(use('Collect', 'instantiation')).toEqual([]);
    expect(query(calls, "SELECT * FROM edges WHERE source_file = 'app/keys.go' AND edge_type = 'instantiation'")).toEqual([]);
  });

  it('a variable, parameter or range variable named like an import is not the package', () => {
    // `user := user.New()` still calls the package; then `user.Save()` is the variable's method,
    // resolved by name (the package has no function Save).
    expect(from(shadow, 'app/app.go', 'Shadow', 'call')).toEqual(['user/user.go#New', 'user/user.go#Save']);
    expect(from(shadow, 'app/app.go', 'Param', 'call')).toEqual(['user/user.go#Save']);
    expect(from(shadow, 'app/app.go', 'Loop', 'call')).toEqual(['domain/order.go#Ship']);
  });

  it('a go.work or a go.mod local replace reaches the other module\'s package', () => {
    for (const root of [work, replaced]) {
      expect(from(root, 'svc/cmd/main.go', 'main', 'call')).toEqual(['lib/store/store.go#Open', 'lib/store/store.go#Save']);
      expect(from(root, 'svc/cmd/main.go', 'main', 'instantiation')).toEqual(['lib/store/store.go#Store']);
    }
  });

  it('without a go.mod, a qualified name is found by name outside the calling package; the standard library links nothing', () => {
    // `domain.Only` is unique; `NewOrder` and `Order.Run` are declared in domain/ and legacy/ too, and
    // the folder that ends the import path decides. `strings.NewReader` and `strings.Fields` link nothing.
    expect(from(noMod, 'app/use.go', 'Use', 'call')).toEqual(['domain/order.go#NewOrder', 'domain/order.go#Only', 'domain/order.go#Run']);
  });
});
