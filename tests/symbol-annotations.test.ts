import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cli } from '../scripts/ui/workspace.js';
import { Store } from '../src/core/store.js';
import { buildElementView, type Element, type ElementView } from '../src/arch/elements.js';
import { matchSelector, unsupportedKeys } from '../src/arch/selectors/index.js';
import { computeMembership } from '../src/arch/membership.js';
import { validateArchitectureText } from '../src/arch/config.js';
import type { Selector } from '../src/arch/schema.js';
import type { SymbolDecorator, SymbolDocTag } from '../src/types.js';
import { getParserForFile } from '../src/parsers/parser-registry.js';
import { ANNOTATION_TEXT_LIMIT } from '../src/parsers/annotations.js';

// M5-10: decorators, attributes and annotations, and doc tags, in symbol metadata (PHP, TS, JS,
// Python, Java, Kotlin, C#), and the `decorator` and `docTag` selectors over them. One real scan of
// tests/fixtures/symbol-annotations (synthetic, one file per language).
const FIXTURE = resolve(__dirname, 'fixtures/symbol-annotations');
let root: string;
let store: Store;
let view: ElementView;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mapx-annotations-'));
  cpSync(FIXTURE, root, { recursive: true });
  cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
  cli(root, 'scan');
  store = new Store(join(root, '.mapx/mapx.db'));
  view = buildElementView(store, root);
}, 300_000);
afterAll(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Annotations { decorators?: SymbolDecorator[]; docTags?: SymbolDocTag[] }
/** The stored decorators and doc tags of symbol `scope.name` (or `name`) in `file`. */
function stored(file: string, qualified: string): Annotations {
  const [scope, name] = qualified.includes('.') ? qualified.split('.') : [null, qualified];
  const rows = store.raw.prepare('SELECT scope, metadata FROM symbols WHERE file_path = ? AND name = ?').all(file, name) as Array<{ scope: string | null; metadata: string }>;
  const row = rows.find((r) => (r.scope ?? null) === scope);
  if (!row) throw new Error(`no symbol ${qualified} in ${file}`);
  const m = JSON.parse(row.metadata) as Annotations;
  return { ...(m.decorators ? { decorators: m.decorators } : {}), ...(m.docTags ? { docTags: m.docTags } : {}) };
}

const dec = (name: string, args: string | null = null, written?: string): SymbolDecorator => ({ name, args, ...(written ? { written } : {}) });
const tag = (t: string, value = ''): SymbolDocTag => ({ tag: t, value });

describe('symbol metadata: decorators and doc tags per language', () => {
  it('PHP: attributes resolved through use and the namespace; PHPDoc block tags', () => {
    const f = 'php/src/Entity/Order.php';
    expect(stored(f, 'Order')).toEqual({
      decorators: [
        dec('Doctrine\\ORM\\Mapping\\Entity', 'repositoryClass: OrderRepository::class', 'ORM\\Entity'),
        dec('Doctrine\\ORM\\Mapping\\Table', "name: 'orders',\n    schema: 'shop'", 'ORM\\Table'),
      ],
      docTags: [tag('@internal'), tag('@deprecated', 'since 2.0, use OrderV2 instead')],
    });
    // Two attributes in one group; `\Deprecated` is global. `{@link}` is inline, not a tag.
    expect(stored(f, 'Order.run')).toEqual({
      decorators: [dec('Symfony\\Component\\Routing\\Attribute\\Route', "'/orders/{id}', methods: ['GET']", 'Route'), dec('Deprecated')],
      docTags: [tag('@Route', '("/legacy")'), tag('@return', 'void')],
    });
    expect(stored(f, 'Order.$id')).toEqual({ decorators: [dec('Doctrine\\ORM\\Mapping\\Column', null, 'ORM\\Column')] });
    expect(stored(f, 'Order.plain')).toEqual({});
  });

  it('TypeScript: decorators before and after export, on methods and fields; TSDoc block tags', () => {
    const f = 'ts/src/users.controller.ts';
    expect(stored(f, 'UsersController')).toEqual({
      decorators: [dec('Controller', "'users'")],
      docTags: [tag('@internal'), tag('@deprecated', 'use UsersV2Controller')],
    });
    // Multi-line arguments kept as written; the parameter decorator @Param is not the method's.
    expect(stored(f, 'UsersController.find')).toEqual({
      decorators: [dec('Get', "':id'"), dec('UseGuards', 'AuthGuard,\n    RolesGuard,')],
      docTags: [tag('@param', 'id the user id'), tag('@since', '1.2')],
    });
    // `@see` mid-line is not a block tag.
    expect(stored(f, 'UsersController.pageSize')).toEqual({ decorators: [dec('Input', '')] });
    expect(stored(f, 'UsersController.plain')).toEqual({});
    expect(stored(f, 'UsersService')).toEqual({ decorators: [dec('Injectable', '')] });
    expect(stored(f, 'helper')).toEqual({ docTags: [tag('@internal')] });
  });

  it('JavaScript: member-expression and call decorators; JSDoc block tags', () => {
    const f = 'js/src/legacy.js';
    expect(stored(f, 'Store')).toEqual({ decorators: [dec('observable')], docTags: [tag('@deprecated')] });
    expect(stored(f, 'Store.load')).toEqual({
      decorators: [dec('action.bound'), dec('retry', '{\n    times: 3,\n  }')],
      docTags: [tag('@param', '{string} url where from'), tag('@returns', '{Promise<void>}')],
    });
    expect(stored(f, 'format')).toEqual({ docTags: [tag('@internal')] });
  });

  it('Python: decorators on class and def; docstring directives and @tags', () => {
    const f = 'python/app/orders.py';
    expect(stored(f, 'Order')).toEqual({
      decorators: [dec('dataclass', 'frozen=True')],
      docTags: [tag('@deprecated', '2.0 Use OrderV2.'), tag('@internal')],
    });
    expect(stored(f, 'Order.run')).toEqual({
      decorators: [dec('app.route', '"/orders/<id>",\n               methods=["GET"]'), dec('staticmethod')],
      docTags: [tag('@versionadded', '1.5')],
    });
    expect(stored(f, 'Order.plain')).toEqual({});
    expect(stored(f, 'run_legacy')).toEqual({ decorators: [dec('typing_extensions.deprecated', '"use run_v2"')] });
  });

  it('Java: marker, qualified and argument annotations; Javadoc block tags', () => {
    const f = 'java/src/main/java/com/acme/Order.java';
    expect(stored(f, 'Order')).toEqual({
      decorators: [dec('Entity'), dec('Table', 'name = "orders",\n       schema = "shop"')],
      docTags: [tag('@deprecated', 'use OrderV2'), tag('@author', 'shop')],
    });
    expect(stored(f, 'Order.run')).toEqual({
      decorators: [dec('Override'), dec('javax.annotation.Nullable'), dec('RequestMapping', 'value = "/orders/{id}", method = RequestMethod.GET')],
      docTags: [tag('@param', 'id the id')],
    });
    expect(stored(f, 'Order.clock')).toEqual({ decorators: [dec('Inject')] });
    expect(stored(f, 'Order.plain')).toEqual({});
  });

  it('an overload is stored with its own annotations; its element carries those of every overload', () => {
    const f = 'java/src/main/java/com/acme/Order.java';
    const rows = store.raw.prepare("SELECT metadata FROM symbols WHERE file_path = ? AND name = 'run' ORDER BY start_line").all(f) as Array<{ metadata: string }>;
    expect(rows.map((r) => (JSON.parse(r.metadata).decorators as SymbolDecorator[]).map((d) => d.name))).toEqual([
      ['Override', 'javax.annotation.Nullable', 'RequestMapping'], ['Deprecated'],
    ]);
    const run = view.ofFile(f).find((e) => e.name === 'run')!;
    expect(run.decorators!.map((d) => d.name)).toEqual(['Override', 'javax.annotation.Nullable', 'RequestMapping', 'Deprecated']);
    expect(run.docTags).toEqual([tag('@param', 'id the id')]); // `@param` mid-line in the overload's doc is not a tag
  });

  it('Kotlin: annotations in modifiers; KDoc block tags (after a package line without a terminator)', () => {
    const f = 'kotlin/src/main/kotlin/com/acme/Order.kt';
    expect(stored(f, 'Order')).toEqual({
      decorators: [dec('Entity'), dec('Table', 'name = "orders",\n  schema = "shop"')],
      docTags: [tag('@deprecated', 'use OrderV2'), tag('@property', 'id the id')],
    });
    expect(stored(f, 'Order.run')).toEqual({
      decorators: [dec('Deprecated', '"use runV2"'), dec('kotlin.jvm.JvmStatic')],
      docTags: [tag('@param', 'x the x')],
    });
    expect(stored(f, 'Order.plain')).toEqual({});
  });

  it('C#: attribute lists (several per list, multi-line); XML doc elements as tags, summary excluded', () => {
    const f = 'csharp/src/Order.cs';
    expect(stored(f, 'Order')).toEqual({
      decorators: [dec('Serializable'), dec('Table', '"orders",\n        Schema = "shop"'), dec('Obsolete', '"use OrderV2"')],
      docTags: [tag('@remarks', 'Kept for compatibility.')],
    });
    expect(stored(f, 'Order.Run')).toEqual({
      decorators: [dec('HttpGet', '"{id}"'), dec('System.ObsoleteAttribute')],
      docTags: [tag('@param', 'id the id'), tag('@exception', 'System.InvalidOperationException when closed')],
    });
    expect(stored(f, 'Order.Plain')).toEqual({});
  });
});

describe('stored text limits', () => {
  it('cuts decorator arguments and tag values at 500 characters', async () => {
    const long = 'x'.repeat(800);
    const source = `/**\n * @deprecated ${long}\n */\n@Component(\`${long}\`)\nexport class Big {}\n`;
    const { symbols } = await getParserForFile('big.ts').parse('big.ts', source);
    const big = symbols.find((s) => s.name === 'Big')!;
    const [d] = big.metadata['decorators'] as SymbolDecorator[];
    const [t] = big.metadata['docTags'] as SymbolDocTag[];
    expect([d!.args!.length, d!.args!.endsWith('…'), t!.value.length, t!.value.endsWith('…')]).toEqual([ANNOTATION_TEXT_LIMIT, true, ANNOTATION_TEXT_LIMIT, true]);
  });
});

// ─── Selectors ───────────────────────────────────────────────────────────────────────────────

const sym = (file: string, name: string): Element => {
  const found = view.ofFile(file).find((e) => e.kind === 'symbol' && (e.scope ? `${e.scope}.${e.name}` : e.name) === name);
  if (!found) throw new Error(`no element ${name} in ${file}`);
  return found;
};
const fileEl = (file: string) => view.byId.get(`file:${file}`)!;
const ctx = () => ({ view, inLayer: () => false });
const matches = (sel: Selector, e: Element) => matchSelector(sel, e, ctx()).matched;
const PHP = 'php/src/Entity/Order.php';
const TS = 'ts/src/users.controller.ts';
const PY = 'python/app/orders.py';
const CS = 'csharp/src/Order.cs';
const JAVA = 'java/src/main/java/com/acme/Order.java';

describe('decorator selector', () => {
  it('matches a name or its trailing segments, case-insensitively; a leading sigil is ignored', () => {
    expect(matches({ decorator: 'Controller' }, sym(TS, 'UsersController'))).toBe(true);
    expect(matches({ decorator: '@controller' }, sym(TS, 'UsersController'))).toBe(true);
    expect(matches({ decorator: 'Controller' }, sym(TS, 'UsersService'))).toBe(false);
    expect(matches({ decorator: 'Doctrine\\ORM\\Mapping\\Entity' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ decorator: '#[\\Doctrine\\ORM\\Mapping\\Entity]' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ decorator: 'Mapping\\Entity' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ decorator: 'Entity' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ decorator: 'tity' }, sym(PHP, 'Order'))).toBe(false); // a segment, not a substring
    expect(matches({ decorator: 'Other\\Entity' }, sym(PHP, 'Order'))).toBe(false);
    expect(matches({ decorator: 'route' }, sym(PY, 'Order.run'))).toBe(true);
    expect(matches({ decorator: 'app.route' }, sym(PY, 'Order.run'))).toBe(true);
    expect(matches({ decorator: 'Nullable' }, sym(JAVA, 'Order.run'))).toBe(true);
    expect(matches({ decorator: 'Override' }, sym(JAVA, 'Order.plain'))).toBe(false);
  });

  it('in C# the Attribute suffix is optional on both sides', () => {
    expect(matches({ decorator: 'Obsolete' }, sym(CS, 'Order.Run'))).toBe(true); // [System.ObsoleteAttribute]
    expect(matches({ decorator: 'ObsoleteAttribute' }, sym(CS, 'Order'))).toBe(true); // [Obsolete(…)]
    expect(matches({ decorator: 'System.Obsolete' }, sym(CS, 'Order.Run'))).toBe(true);
    expect(matches({ decorator: 'Obsolete' }, sym(CS, 'Order.Plain'))).toBe(false);
  });

  it('/regex/flags is a regex on the stored name', () => {
    expect(matches({ decorator: '/^(Get|Post)$/' }, sym(TS, 'UsersController.find'))).toBe(true);
    expect(matches({ decorator: '/^get$/' }, sym(TS, 'UsersController.find'))).toBe(false);
    expect(matches({ decorator: '/^get$/i' }, sym(TS, 'UsersController.find'))).toBe(true);
    expect(matches({ decorator: '/^Doctrine\\\\ORM\\\\/' }, sym(PHP, 'Order.$id'))).toBe(true);
  });

  it('is symbol-level: inapplicable on a file, and so is its negation', () => {
    expect(matchSelector({ decorator: 'Controller' }, fileEl(TS), ctx())).toEqual({ matched: false, inapplicable: true });
    expect(matchSelector({ not: { decorator: 'Controller' } }, fileEl(TS), ctx())).toEqual({ matched: false, inapplicable: true });
    expect(matchSelector({ not: { decorator: 'Controller' } }, sym(TS, 'UsersController.plain'), ctx()).matched).toBe(true);
  });
});

describe('docTag selector', () => {
  it('matches a tag (the @ optional, case ignored), with an optional value regex', () => {
    expect(matches({ docTag: '@deprecated' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ docTag: 'Deprecated' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ docTag: '@deprecated' }, sym(PHP, 'Order.run'))).toBe(false);
    expect(matches({ docTag: '@deprecated', value: 'OrderV2' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ docTag: '@deprecated', value: 'orderv2' }, sym(PHP, 'Order'))).toBe(true); // case-insensitive
    expect(matches({ docTag: '@deprecated', value: '/orderv2/' }, sym(PHP, 'Order'))).toBe(false);
    expect(matches({ docTag: '@deprecated', value: '^1\\.' }, sym(PHP, 'Order'))).toBe(false);
    expect(matches({ docTag: '@internal' }, sym(TS, 'helper'))).toBe(true);
    expect(matches({ docTag: '@see' }, sym(TS, 'UsersController.pageSize'))).toBe(false);
    expect(matches({ docTag: '@remarks', value: 'compatibility' }, sym(CS, 'Order'))).toBe(true);
    expect(matches({ docTag: '@param', value: '^id ' }, sym(JAVA, 'Order.run'))).toBe(true);
  });

  it('in Python a @deprecated decorator counts as the @deprecated tag, with its arguments as the value', () => {
    expect(matches({ docTag: '@deprecated' }, sym(PY, 'run_legacy'))).toBe(true);
    expect(matches({ docTag: '@deprecated', value: 'run_v2' }, sym(PY, 'run_legacy'))).toBe(true);
    expect(matches({ docTag: '@deprecated', value: '^2\\.0' }, sym(PY, 'Order'))).toBe(true); // the docstring directive
    expect(matches({ docTag: '@deprecated' }, sym(PY, 'Order.plain'))).toBe(false);
  });

  it('is symbol-level: inapplicable on a file', () => {
    expect(matchSelector({ docTag: '@internal' }, fileEl(TS), ctx())).toEqual({ matched: false, inapplicable: true });
  });
});

describe('membership and configuration', () => {
  it('layers by decorator and doc tag put the symbols and, through top-level ones, their files in the layer', () => {
    const m = computeMembership(view, { layers: [
      { name: 'Entities', selectors: [{ decorator: 'Doctrine\\ORM\\Mapping\\Entity' }, { decorator: 'Entity' }] },
      { name: 'Deprecated', overlay: true, selectors: [{ docTag: '@deprecated' }] },
    ] });
    expect(m.unsupported).toEqual([]);
    const KT = 'kotlin/src/main/kotlin/com/acme/Order.kt';
    // The review/ files have their own tests below.
    const members = (layer: string) => m.members(layer).filter((e) => !e.file.path.startsWith('review/'));
    expect(members('Entities').map((e) => e.id).sort()).toEqual([
      `file:${JAVA}`, `file:${KT}`, `file:${PHP}`, sym(JAVA, 'Order').id, sym(KT, 'Order').id, sym(PHP, 'Order').id,
    ].sort());
    const why = (e: Element) => m.explain(e).filter((t) => t.layer === 'Entities');
    expect(why(sym(PHP, 'Order'))).toEqual([{ layer: 'Entities', selector: 'selectors[0].decorator', via: 'self' }]);
    // Java stores `@Entity` as written, so the qualified value matches it too.
    expect(why(sym(JAVA, 'Order'))).toEqual([{ layer: 'Entities', selector: 'selectors[0].decorator', via: 'self' }]);
    expect(why(fileEl(PHP))).toEqual([{ layer: 'Entities', selector: 'selectors[0].decorator', via: 'App\\Entity\\Order' }]);
    const deprecated = members('Deprecated').filter((e) => e.kind === 'symbol').map((e) => `${e.file.path}:${e.scope ? `${e.scope}.` : ''}${e.name}`).sort();
    expect(deprecated).toEqual([
      `${JAVA}:Order`, 'js/src/legacy.js:Store', 'kotlin/src/main/kotlin/com/acme/Order.kt:Order', `${PHP}:Order`, `${PY}:Order`, `${PY}:run_legacy`, `${TS}:UsersController`,
    ].sort());
  });

  it('decorator and docTag are no longer unsupported', () => {
    expect(unsupportedKeys({ any: [{ decorator: 'X' }, { docTag: '@x', value: 'y' }] })).toEqual([]);
  });

  it('the loader accepts decorator and docTag selectors, and rejects a decorator /regex/ that does not compile', () => {
    const text = (decorator: string) => JSON.stringify({ layers: [{ name: 'A', selectors: [{ decorator }, { docTag: '@internal', value: '^x' }] }], rules: {} });
    expect(validateArchitectureText(text('Controller'))).toEqual([]);
    expect(validateArchitectureText(text('Doctrine\\ORM\\Mapping\\Entity'))).toEqual([]);
    expect(validateArchitectureText(text('/^(Get|Post)$/'))).toEqual([]);
    const issues = validateArchitectureText(text('/(/'));
    expect(issues.map((i) => [i.pointer, /not a valid regular expression/.test(i.message)])).toEqual([['/layers/0/selectors/0/decorator', true]]);
  });
});

// ─── Review of M5-10 (tests/fixtures/symbol-annotations/review) ─────────────────────────────

describe('review: code in doc comments is never a tag', () => {
  it('Javadoc <pre> blocks and multi-line {@code} are text; a tag after them still counts', () => {
    const f = 'review/java/src/main/java/com/acme/Review.java';
    expect(stored(f, 'Review')).toEqual({ docTags: [tag('@since', '2')] });
    expect(matches({ docTag: '@deprecated' }, sym(f, 'Review'))).toBe(false);
    expect(matches({ docTag: '@internal' }, sym(f, 'Review'))).toBe(false);
  });

  it('KDoc <pre> blocks are text', () => {
    expect(stored('review/kotlin/src/main/kotlin/com/acme/Review.kt', 'Review').docTags).toEqual([tag('@since', '2')]);
  });

  it('a JSDoc @example runs to the end of the comment: tags inside it are its value', () => {
    const f = 'review/ts/src/review.ts';
    expect(stored(f, 'Ctl.ex')).toEqual({ docTags: [tag('@example', '@internal class Foo {}')] });
    expect(matches({ docTag: '@internal' }, sym(f, 'Ctl.ex'))).toBe(false);
  });

  it('C# XML <code> is not a tag, nor is markup inside it', () => {
    expect(stored('review/csharp/src/Review.cs', 'Review').docTags).toEqual([tag('@example', '@internal')]);
  });

  it('Python literal blocks (after "::") and doctest examples are not tags', () => {
    expect(stored('review/python/review.py', 'handler').docTags).toEqual([tag('@deprecated', '2.0 Use other.')]);
  });
});

describe('review: comments between decorators, docs and declarations', () => {
  it('a comment between decorators keeps the earlier ones (TS, Java, Python)', () => {
    expect(stored('review/ts/src/review.ts', 'Ctl.find').decorators).toEqual([dec('Get', "':id'"), dec('UseGuards', 'AuthGuard')]);
    expect(stored('review/java/src/main/java/com/acme/Review.java', 'Review.f').decorators).toEqual([dec('Get'), dec('Put')]);
    expect(stored('review/python/review.py', 'handler').decorators).toEqual([dec('app.route', '"/x"'), dec('functools.lru_cache', 'maxsize=None')]);
  });

  it('a line comment between a doc and its declaration is passed over; code is not', () => {
    const f = 'review/ts/src/review.ts';
    expect(stored(f, 'lostDoc')).toEqual({ docTags: [tag('@deprecated', 'old doc')] });
    expect(stored(f, 'LIMIT')).toEqual({ docTags: [tag('@internal', "a constant's doc")] });
    expect(stored(f, 'notDocumented')).toEqual({});
  });

  it('a C# plain comment between the XML doc and the declaration is passed over', () => {
    expect(matches({ docTag: '@example' }, sym('review/csharp/src/Review.cs', 'Review'))).toBe(true);
  });

  it('TS overload signatures give their doc tags to the implementation', () => {
    expect(stored('review/ts/src/review.ts', 'over')).toEqual({ docTags: [tag('@deprecated', 'overload doc'), tag('@since', '2')] });
  });
});

describe('review: decorator forms and qualified selectors', () => {
  it('C# [return:] and other foreign targets are not the declaration\'s; [method:] is', () => {
    expect(stored('review/csharp/src/Review.cs', 'Review.M')).toEqual({ decorators: [dec('Pure')] });
  });

  it('Kotlin @[A B(1)] stores each annotation', () => {
    expect(stored('review/kotlin/src/main/kotlin/com/acme/Review.kt', 'Review').decorators).toEqual([dec('JvmField'), dec('A'), dec('B', '1')]);
  });

  it('PHP keeps the name as written when resolution changed it; a selector matches either', () => {
    const f = 'review/php/src/Review.php';
    expect(stored(f, 'Aliased').decorators).toEqual([dec('Foo\\Bar', null, 'Baz')]);
    expect(stored(f, 'GlobalEntity').decorators).toEqual([dec('Entity')]);
    expect(matches({ decorator: 'Baz' }, sym(f, 'Aliased'))).toBe(true);
    expect(matches({ decorator: 'Foo\\Bar' }, sym(f, 'Aliased'))).toBe(true);
    expect(matches({ decorator: 'ORM\\Entity' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ decorator: '@ORM\\Entity' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ decorator: '/^ORM\\\\Entity$/' }, sym(PHP, 'Order'))).toBe(true);
    expect(matches({ decorator: 'Other\\Entity' }, sym(PHP, 'Order'))).toBe(false);
  });

  it('a qualified value matches a name stored as written, except in PHP, where names are resolved', () => {
    expect(matches({ decorator: 'System.Obsolete' }, sym('review/csharp/src/Review.cs', 'Review'))).toBe(true); // [Obsolete]
    expect(matches({ decorator: 'System.ObsoleteAttribute' }, sym('review/csharp/src/Review.cs', 'Review'))).toBe(true);
    expect(matches({ decorator: 'javax.persistence.Entity' }, sym(JAVA, 'Order'))).toBe(true); // @Entity
    expect(matches({ decorator: 'org.Other' }, sym(JAVA, 'Order'))).toBe(false);
    // PHP `#[\Entity]` is the global class Entity, not Doctrine's.
    expect(matches({ decorator: 'Doctrine\\ORM\\Mapping\\Entity' }, sym('review/php/src/Review.php', 'GlobalEntity'))).toBe(false);
    expect(matches({ decorator: 'Entity' }, sym('review/php/src/Review.php', 'GlobalEntity'))).toBe(true);
  });
});
