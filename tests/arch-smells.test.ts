import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { buildCLI } from '../src/cli.js';
import { init, mapx, mapxResult } from './helpers/e2e.js';
import { Store } from '../src/core/store.js';
import { currentSmells, type SmellRow } from '../src/core/architecture-analyzer.js';

// Every evaluation of the edges, counted (M5-16 review: one per command).
const evaluations = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/arch/evaluate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/arch/evaluate.js')>();
  return { ...real, evaluateEdges: (...args: Parameters<typeof real.evaluateEdges>) => { evaluations.n++; return real.evaluateEdges(...args); } };
});

// M5-16 (AR-18; deptrac §3.3): with .mapx/architecture.jsonc, layer violations come from the rules,
// once, and the rule-derived smells join them; without one, nothing changes. On scanned temp copies
// of tests/fixtures/arch-smells/ts, a synthetic app whose configuration holds a positive and a
// negative case of every new smell. The goldens in tests/fixtures/arch-smells/legacy were printed
// by the code before this task (develop, without src/arch/smells.ts) on the same app without its
// configuration.
const FIXTURE = resolve(__dirname, 'fixtures/arch-smells/ts');
const LEGACY = resolve(__dirname, 'fixtures/arch-smells/legacy');
const EXTRA = resolve(__dirname, 'fixtures/arch-smells/extra'); // files laid over the app for orphan-element and baseline-debt (M5-16-R2)
const SLOW = { timeout: 180_000 };

let tmp = '';
let app = ''; // the fixture as it is
let noconf = ''; // without an architecture configuration
let also = ''; // with policy.alsoInferred, and a file in no layer
let extra = ''; // the fixture with the EXTRA files (M5-16-R2)
let client: Client;

const MONEY_ORDER = ['src/shared/Money.ts', 'src/domain/Order.ts'];
const REPO_ORDER = ['src/repository/SqlOrderRepository.ts', 'src/domain/Order.ts'];
const LEGACY_ORDER = ['src/legacy/LegacyOrderRepository.ts', 'src/domain/Order.ts'];

const smellsOf = (root: string): SmellRow[] => {
  const store = new Store(join(root, '.mapx', 'mapx.db'));
  try {
    const repo = root.split('/').pop()!;
    return currentSmells(store, root, [repo], { primary: repo });
  } finally {
    store.close();
  }
};
/** What a smell is about: its type with its layers, or its files. */
const id = (s: SmellRow) => [s.type, ...(s.involvedLayers?.length ? s.involvedLayers : s.involvedFiles)].join(' ');
const ruleIds = (root: string) => smellsOf(root).filter((s) => s.source === 'rules').map(id);
const mcpSmells = async (dir: string) => ((await client.callTool({ name: 'mapx_smells', arguments: { dir } })) as { content: Array<{ text: string }> }).content[0]!.text;
const golden = (name: string) => readFileSync(join(LEGACY, name), 'utf8');
/** The `[SEVERITY] type` headings of a CLI or MCP smell listing, in order. */
const headings = (text: string) => [...text.matchAll(/^ {2}\[[A-Z]+\] (\S+)$/gm)].map((m) => m[1]);

/** Runs `fn` with `root`'s configuration edited by `edit`, then restores it. */
function withConfig<T>(root: string, edit: (doc: string) => string, fn: () => T): T {
  const cfg = join(root, '.mapx/architecture.jsonc');
  const before = readFileSync(cfg, 'utf8');
  const edited = edit(before);
  expect(edited).not.toBe(before);
  writeFileSync(cfg, edited);
  try {
    return fn();
  } finally {
    writeFileSync(cfg, before);
  }
}
/** Runs `fn` with a baseline file of `content` (the one `mapx check --generate-baseline` writes, by default). */
function withBaseline<T>(root: string, content: string | null, fn: () => T): T {
  const file = join(root, '.mapx/architecture.baseline.json');
  if (content === null) expect(mapxResult(root, 'check', '--generate-baseline').status).toBe(0);
  else writeFileSync(file, content);
  try {
    return fn();
  } finally {
    rmSync(file, { force: true });
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mapx-arch-smells-'));
  app = join(tmp, 'app');
  noconf = join(tmp, 'noconf');
  also = join(tmp, 'also');
  extra = join(tmp, 'extra');
  for (const root of [app, noconf, also, extra]) cpSync(FIXTURE, root, { recursive: true });
  cpSync(EXTRA, extra, { recursive: true });
  rmSync(join(noconf, '.mapx/architecture.jsonc'));
  const cfg = join(also, '.mapx/architecture.jsonc');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('"layers": [', '"policy": { "alsoInferred": true },\n  "layers": ['));
  // Code no layer covers: the role order still finds a data → service violation in it.
  mkdirSync(join(also, 'src/legacy'));
  writeFileSync(join(also, 'src/legacy/LegacyOrderRepository.ts'), [
    '// Legacy: in no layer. The rules never decide its edges; the role order still does.',
    "import { Order } from '../domain/Order';",
    '',
    'export class LegacyOrderRepository {',
    '  load(id: string): Order {',
    '    return new Order(id);',
    '  }',
    '}',
    '',
  ].join('\n'));
  for (const root of [app, noconf, also, extra]) {
    init(root);
    mapx(root, 'scan');
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
}, 300_000);
afterAll(async () => {
  await client?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('without an architecture configuration nothing changes (criterion 2)', SLOW, () => {
  it('mapx_smells, `mapx arch`, --smells and --violations print exactly what they printed before M5-16', async () => {
    expect(await mcpSmells(noconf)).toBe(golden('mapx_smells.txt'));
    for (const [args, file] of [[[], 'arch.txt'], [['--smells'], 'arch-smells.txt'], [['--violations'], 'arch-violations.txt']] as const) {
      const r = mapxResult(noconf, 'arch', ...args);
      expect(r.status, args.join(' ')).toBe(0);
      expect(r.stdout, args.join(' ')).toBe(golden(file));
    }
  });

  it('the smells are the stored rows, unchanged and without a source, and nothing is evaluated', () => {
    const store = new Store(join(noconf, '.mapx', 'mapx.db'));
    try {
      const before = evaluations.n;
      expect(currentSmells(store, noconf, ['noconf'], { primary: 'noconf' })).toEqual(store.getArchSmells('noconf'));
      expect(evaluations.n).toBe(before);
    } finally {
      store.close();
    }
  });
});

describe('one source of layer violations (criterion 1)', SLOW, () => {
  it('with a configuration, layer violations come from the rules only, once per edge', () => {
    const violations = smellsOf(app).filter((s) => s.type === 'layer-violation');
    expect(violations.map((s) => [s.source, s.severity, s.involvedFiles])).toEqual([['rules', 'critical', MONEY_ORDER]]);
    expect(violations[0]!.description).toBe('Layer violation: src/shared/Money.ts#Money must not depend on src/domain/Order.ts#Order (Shared on Domain) [disallowed-layer: import]');
  });

  it('the CLI and MCP agree: one layer-violation, from the rules; --violations shows only it', async () => {
    const text = await mcpSmells(app);
    const cli = mapxResult(app, 'arch', '--smells');
    expect(cli.status).toBe(0);
    expect(headings(text)).toEqual(headings(cli.stdout));
    expect(headings(text).filter((t) => t === 'layer-violation')).toHaveLength(1);
    expect(text).toContain('    Files: src/shared/Money.ts, src/domain/Order.ts\n    Suggestion: Remove the dependency, or allow Shared → Domain');
    expect(text).not.toContain("'data' depends on 'service'");
    const violations = mapxResult(app, 'arch', '--violations').stdout;
    expect(headings(violations)).toEqual(['layer-violation']);
    expect(violations).toContain('    Source:      rules\n');
    // The health line counts the same smells.
    expect(mapxResult(app, 'arch').stdout).toContain(`Detected ${headings(cli.stdout).length} architectural smell(s)`);
  });

  it('policy.alsoInferred keeps role-order violations only on edges the rules decide in no way', () => {
    // The legacy file is in no layer: its violation is kept, marked. SqlOrderRepository → Order is
    // allowed by the rules, and Money → Order is theirs: neither is re-reported.
    const violations = smellsOf(also).filter((s) => s.type === 'layer-violation');
    expect(violations.map((s) => [s.source, s.involvedFiles])).toEqual([
      ['inferred-roles', LEGACY_ORDER],
      ['rules', MONEY_ORDER],
    ]);
  });

  it('policy.alsoInferred never brings a baselined violation back (review 1)', () => {
    withBaseline(also, null, () => {
      const violations = smellsOf(also).filter((s) => s.type === 'layer-violation');
      expect(violations.map((s) => [s.source, s.involvedFiles])).toEqual([['inferred-roles', LEGACY_ORDER]]);
    });
    // An edge the scope excludes is the rules' decision too.
    withConfig(also, (d) => d.replace('"layers": [', '"scope": { "exclude": ["src/legacy/**"] },\n  "layers": ['), () => {
      expect(smellsOf(also).filter((s) => s.source === 'inferred-roles')).toEqual([]);
    });
  });

  it('a configuration that cannot be loaded keeps the role-order violations and says so', () => {
    withConfig(app, () => '{ "layers": [{ "name": "A", "selectors": [{ "paht": "x" }] }], "rules": {} }', () => {
      const smells = smellsOf(app);
      expect(smells.filter((s) => s.type === 'layer-violation').map((s) => [s.source, s.involvedFiles])).toEqual([
        ['inferred-roles', REPO_ORDER], ['inferred-roles', MONEY_ORDER],
      ]);
      const config = smells.filter((s) => s.type === 'architecture-config');
      expect(config.map((s) => [s.severity, s.source])).toEqual([['critical', 'rules']]);
      expect(config[0]!.description).toMatch(/^The architecture configuration cannot be evaluated: \.mapx\/architecture\.jsonc#\/layers\/0\/selectors\/0/);
    });
  });

  it('a stale baseline entry, an exit-3 error of mapx check, is an architecture-config smell (review 4)', () => {
    const stale = JSON.stringify({ version: 1, entries: [{ rule: 'disallowed-layer', source: 'src/util/Clock.ts#Clock', target: 'src/domain/Order.ts#Order', edgeType: 'import' }] });
    withBaseline(app, stale, () => {
      expect(mapxResult(app, 'check').status).toBe(3);
      const config = smellsOf(app).filter((s) => s.type === 'architecture-config');
      expect(config.map((s) => [s.severity, s.source, s.involvedFiles])).toEqual([['critical', 'rules', ['.mapx/architecture.baseline.json']]]);
      expect(config[0]!.description).toMatch(/^Stale baseline entry: .*src\/util\/Clock\.ts#Clock → src\/domain\/Order\.ts#Order.*matches no violation/);
    });
    // A baseline whose every entry matches: no such smell, and its violation is skipped.
    withBaseline(app, null, () => {
      expect(smellsOf(app).filter((s) => s.type === 'architecture-config' || s.type === 'layer-violation')).toEqual([]);
    });
  });

  it('an edited configuration applies without a rescan', () => {
    withConfig(app, (d) => d.replace('"Shared": []', '"Shared": ["Domain"]'), () => {
      expect(smellsOf(app).filter((s) => s.type === 'layer-violation')).toEqual([]);
    });
  });
});

describe('rule-derived smells: a positive and a negative case each (criterion 3)', SLOW, () => {
  it('lists exactly the expected smells, from the rules, in a stable order', () => {
    expect(ruleIds(app)).toEqual([
      `layer-violation ${MONEY_ORDER.join(' ')}`,
      'layer-cycle Domain Shared',
      'layer-skip Controller Service Repository',
      'dead-allowance Controller Util',
      'weak-allowance Service Shared',
      'unstable-layer-dependency Domain Shared',
      'abstractness-distance Domain',
      'abstractness-distance Shared',
      'deprecated-usage src/service/OrderService.ts src/shared/format.ts',
    ]);
    // The scan's other smells stay: they are not about layers.
    expect(smellsOf(app).filter((s) => !s.source).map((s) => s.type)).toEqual(['cyclic-dependency', 'orphan-cluster']);
  });

  const smell = (type: string, root = app) => smellsOf(root).filter((s) => s.type === type);

  it('layer-cycle: Domain ↔ Shared is a cycle; the Controller → Service → Repository → Domain chain is not', () => {
    expect(smell('layer-cycle').map((s) => [s.description, s.severity])).toEqual([['Layer cycle: Domain -> Shared -> Domain', 'critical']]);
    for (const layer of ['Controller', 'Service', 'Repository']) expect(smell('layer-cycle').flatMap((s) => s.involvedLayers)).not.toContain(layer);
  });

  it('a baselined violation is acknowledged debt: it makes no cycle and no coupling (review 5)', () => {
    withBaseline(app, null, () => {
      const ids = ruleIds(app);
      expect(ids.filter((i) => /^(layer-cycle|unstable-layer-dependency|layer-violation)/.test(i))).toEqual([]);
      // Shared no longer depends on Domain: Ca(Domain) loses Money.ts, and Shared has no Ce.
      expect(smell('abstractness-distance').map((s) => s.description)).toEqual([
        'Distance from the main sequence: layer Domain has D = 0.75 (abstractness 0.00, instability 0.25), concrete and stable (zone of pain)',
        'Distance from the main sequence: layer Shared has D = 1.00 (abstractness 0.00, instability 0.00), concrete and stable (zone of pain)',
      ]);
    });
  });

  it('layer-skip: Controller → Repository is past Service on the "+" chain; its own Service, the Shared kernel and plain allowances are not', () => {
    expect(smell('layer-skip').map((s) => s.description)).toEqual([
      'Layer skip: src/controller/OrderController.ts (Controller) depends on src/repository/SqlOrderRepository.ts (Repository), bypassing Service',
    ]);
    const files = smell('layer-skip').flatMap((s) => s.involvedFiles);
    expect(files).not.toContain('src/service/OrderService.ts'); // Controller's own "+Service"
    expect(files).not.toContain('src/shared/format.ts'); // Shared, reached through "+": Service allows it plainly (review 3)
    expect(files).not.toContain('src/domain/Order.ts'); // Service → Domain: Repository allows Domain plainly, no strict order
  });

  it('layer-skip names every bypassed layer, and none past an empty one (review 3)', () => {
    // Controller → +Util → +Service → +Repository: Repository is three down, past Util and Service.
    const chain = (d: string) => d.replace('"Controller": ["+Service", "Util"]', '"Controller": ["+Util"]').replace('"Util": []', '"Util": ["+Service"]');
    withConfig(app, chain, () => {
      expect(smell('layer-skip').map((s) => [s.description, s.involvedLayers])).toEqual([
        ['Layer skip: src/controller/OrderController.ts (Controller) depends on src/repository/SqlOrderRepository.ts (Repository), bypassing Util, Service', ['Controller', 'Util', 'Service', 'Repository']],
        ['Layer skip: src/controller/OrderController.ts (Controller) depends on src/service/OrderService.ts (Service), bypassing Util', ['Controller', 'Util', 'Service']],
      ]);
    });
    // No skip past a layer with no elements ("when Service exists"): Service selects nothing here.
    withConfig(app, (d) => d.replace('"path": "src/service/**"', '"path": "src/no-such-dir/**"'), () => {
      expect(smell('layer-skip')).toEqual([]);
    });
    // A layer the source's own rules name is no skip.
    withConfig(app, (d) => d.replace('"Controller": ["+Service", "Util"]', '"Controller": ["+Service", "Util", "Repository"]'), () => {
      expect(smell('layer-skip')).toEqual([]);
    });
  });

  it('dead-allowance: Controller → Util is never used; the used Controller → Service and the inherited, unused Controller → Domain are not dead', () => {
    expect(smell('dead-allowance').map((s) => s.description)).toEqual(['Dead allowance: Controller → Util (explicit) is allowed, but no dependency in scope uses it']);
    const layers = smell('dead-allowance').map((s) => s.involvedLayers!.join(' → '));
    expect(layers).not.toContain('Controller → Service');
    expect(layers).not.toContain('Controller → Domain');
  });

  it('dead-allowance: a "*" default is dead only when no layer uses it, and reported once (review 2)', () => {
    // Nobody uses Util: one smell against "*" (Controller's own Util allowance is its own smell).
    withConfig(app, (d) => d.replace('"rules": {', '"rules": {\n    "*": ["Util"],'), () => {
      expect(smell('dead-allowance').map((s) => [s.description, s.involvedLayers])).toEqual([
        ['Dead allowance: * → Util (default for every layer) is allowed, but no dependency in scope uses it', ['*', 'Util']],
        ['Dead allowance: Controller → Util (explicit) is allowed, but no dependency in scope uses it', ['Controller', 'Util']],
      ]);
    });
    // Service and Shared use Domain: the default is alive, though Controller and Util never use it.
    withConfig(app, (d) => d.replace('"rules": {', '"rules": {\n    "*": ["Domain"],'), () => {
      expect(smell('dead-allowance').map((s) => s.involvedLayers!.join(' → '))).toEqual(['Controller → Util']);
      expect(smell('weak-allowance').map((s) => s.involvedLayers!.join(' → '))).toEqual(['Service → Shared']);
    });
  });

  it('weak-allowance: Service → Shared is used by 2 edges; Repository → Domain (3) and Domain → Shared (4) are not weak', () => {
    expect(smell('weak-allowance').map((s) => s.description)).toEqual(['Weak allowance: Service → Shared (explicit) is used by only 2 edges']);
    const layers = smell('weak-allowance').map((s) => s.involvedLayers!.join(' → '));
    expect(layers).not.toContain('Repository → Domain');
    expect(layers).not.toContain('Domain → Shared');
  });

  it('unstable-layer-dependency: Domain (I 0.20) on Shared (I 0.25); Controller (1.00) on Service (0.67) is not', () => {
    expect(smell('unstable-layer-dependency').map((s) => s.description)).toEqual([
      'Unstable layer dependency: Domain (instability 0.20) depends on Shared (instability 0.25), which is less stable',
    ]);
    expect(smell('unstable-layer-dependency').map((s) => s.involvedLayers!.join(' → '))).not.toContain('Controller → Service');
  });

  it('instability counts files, not elements: OrderService.ts (two top-level declarations and its imports) counts once (review 6)', () => {
    // Ca(Domain) = OrderService.ts, AuditService.ts, SqlOrderRepository.ts, Money.ts; Ce(Domain) = Order.ts.
    // Counted per element, OrderService.ts would count three times (its file, the class, quickOrder).
    expect(smell('abstractness-distance').map((s) => s.description)[0]).toBe(
      'Distance from the main sequence: layer Domain has D = 0.80 (abstractness 0.00, instability 0.20), concrete and stable (zone of pain)',
    );
  });

  it('abstractness-distance: concrete, stable Domain and Shared are far from the main sequence; Repository (A 0.50, I 0.25: D 0.25, but 0.75 if its interface were not abstract) and uncoupled Util are not', () => {
    expect(smell('abstractness-distance').map((s) => s.description)).toEqual([
      'Distance from the main sequence: layer Domain has D = 0.80 (abstractness 0.00, instability 0.20), concrete and stable (zone of pain)',
      'Distance from the main sequence: layer Shared has D = 0.75 (abstractness 0.00, instability 0.25), concrete and stable (zone of pain)',
    ]);
    const layers = smell('abstractness-distance').flatMap((s) => s.involvedLayers);
    expect(layers).not.toContain('Repository');
    expect(layers).not.toContain('Util');
  });

  it('deprecated-usage: OrderService calls the @deprecated legacyLabel; Order\'s call to label and the never-called @deprecated Money.legacyAmount are not reported', () => {
    expect(smell('deprecated-usage').map((s) => s.description)).toEqual([
      'Deprecated usage: src/service/OrderService.ts#OrderService uses src/shared/format.ts#legacyLabel, which is deprecated (use label())',
    ]);
    expect(smell('deprecated-usage').flatMap((s) => s.involvedFiles)).not.toContain('src/domain/Order.ts');
    expect(smell('deprecated-usage').flatMap((s) => s.involvedFiles)).not.toContain('src/shared/Money.ts');
    // The fixture does declare it, deprecated, so the negative case is real.
    expect(readFileSync(join(app, 'src/shared/Money.ts'), 'utf8')).toContain('/** @deprecated use forOrder() */\n  legacyAmount()');
  });
});

describe('orphan-element and baseline-debt (M5-16-R2, AR-18)', SLOW, () => {
  const smell = (type: string, root = extra) => smellsOf(root).filter((s) => s.type === type);
  const edgeTargets = (root: string) => {
    const store = new Store(join(root, '.mapx', 'mapx.db'));
    try {
      return new Set((store.raw.prepare('SELECT target_file FROM edges').all() as Array<{ target_file: string }>).map((r) => r.target_file));
    } finally {
      store.close();
    }
  };

  it('orphan-element: DeadHelper is in no layer and nothing depends on it; the rest of src/legacy and OrderController are not orphans', () => {
    expect(smell('orphan-element').map((s) => [s.description, s.involvedFiles, s.severity, s.source])).toEqual([
      ['Orphan element: go/legacy/dead.go is in no layer and nothing depends on it', ['go/legacy/dead.go'], 'info', 'rules'],
      ['Orphan element: java/x/DeadService.java is in no layer and nothing depends on it', ['java/x/DeadService.java'], 'info', 'rules'],
      ['Orphan element: php/DeadPhp.php is in no layer and nothing depends on it', ['php/DeadPhp.php'], 'info', 'rules'],
      ['Orphan element: py/dead.py is in no layer and nothing depends on it', ['py/dead.py'], 'info', 'rules'],
      ['Orphan element: src/legacy/DeadHelper.ts is in no layer and nothing depends on it', ['src/legacy/DeadHelper.ts'], 'info', 'rules'],
    ]);
    // Go: an import names a package, so main's import of go/shapes clears perimeter.go, which no call reaches
    // and no edge targets; main.go, which declares `func main`, is not an orphan either.
    const goTargets = edgeTargets(extra);
    expect(goTargets.has('go/shapes/area.go')).toBe(true);
    for (const f of ['go/shapes/perimeter.go', 'go/main.go', 'go/legacy/dead.go']) expect(goTargets.has(f), f).toBe(false);
    // The negatives are real, by the fixture's own edges: UsedHelper is imported (by DeadHelper, itself in no
    // layer); OrderController is in a layer (Controller) and imported by nothing; the entry point, the configuration
    // file and the file without a declaration are imported by nothing either.
    const targets = edgeTargets(extra);
    expect(targets.has('src/legacy/UsedHelper.ts')).toBe(true);
    for (const f of ['src/legacy/DeadHelper.ts', 'src/controller/OrderController.ts', 'src/main.ts', 'src/legacy/vite.config.ts', 'src/legacy/karma.conf.js', 'src/legacy/notes.ts']) expect(targets.has(f), f).toBe(false);
    expect(readFileSync(join(extra, 'src/legacy/notes.ts'), 'utf8')).not.toMatch(/\b(class|function|const|export)\b/);
    // Without the extra files the fixture has none; a layer for the folders of the positives takes them out of the smell.
    expect(smell('orphan-element', app)).toEqual([]);
    withConfig(extra, (doc) => doc.replace('"layers": [', '"layers": [\n    { "name": "Legacy", "selectors": [{ "path": "src/legacy/**" }, { "path": "go/legacy/**" }, { "path": "py/dead.py" }, { "path": "java/x/DeadService.java" }, { "path": "php/DeadPhp.php" }] },'), () => {
      expect(smell('orphan-element')).toEqual([]);
    });
  });

  // One negative case per class of exemption (review of M5-16-R2): files nothing imports by design. Each is in no
  // layer, is indexed with a top-level symbol and has no inbound edge, so only the exemption keeps it out.
  it('orphan-element: entry points, registered folders, runtime files, declarations, tests, `package main` and annotated applications are not orphans', () => {
    const store = new Store(join(extra, '.mapx', 'mapx.db'));
    const exempt: Record<string, string[]> = {
      'a registered folder': ['bin/serve.ts', 'src/routes/users.ts', 'src/controllers/UserController.ts', 'src/migrations/001_init.ts', 'src/plugins/auth.ts', 'scripts/build.ts'],
      'a runtime or declaration file': ['src/server.ts', 'src/shapes.d.ts', 'py/manage.py', 'py/wsgi.py', 'py/asgi.py', 'py/__main__.py', 'py/__init__.py'],
      'a test by the classifier\'s own definition': ['e2e/login.ts', 'src/testing/util.ts', 'src/test-utils.ts', 'vitest.setup.ts', 'py/test_helpers.py', 'java/x/OrderIT.java', 'php/OrderTest.php'],
      'a main method or an application annotation': ['java/x/Application.java', 'java/x/Boot.java'],
      'a file of a Go package main': ['go/tool/main.go', 'go/tool/util.go'],
      'an entry role': ['src/main.ts'],
    };
    try {
      const indexed = new Map((store.raw.prepare('SELECT f.path AS path, (SELECT COUNT(*) FROM symbols s WHERE s.file_path = f.path) AS symbols FROM files f').all() as Array<{ path: string; symbols: number }>).map((r) => [r.path, r.symbols]));
      const targets = edgeTargets(extra);
      for (const [why, files] of Object.entries(exempt)) {
        for (const f of files) {
          expect(indexed.get(f), `${f} (${why}) is indexed with a symbol`).toBeGreaterThan(0);
          expect(targets.has(f), `${f} (${why}) has no inbound edge`).toBe(false);
          expect(smell('orphan-element').flatMap((s) => s.involvedFiles), `${f} (${why})`).not.toContain(f);
        }
      }
    } finally {
      store.close();
    }
  });

  it('baseline-debt: the baselined violations of each source layer; none without a baseline, and none for a layer with no baselined violation', () => {
    expect(smell('baseline-debt')).toEqual([]);
    withBaseline(extra, null, () => {
      // The oracle: what `mapx check` skips by the baseline, by source layer.
      const r = mapxResult(extra, 'check', '--format', 'json', '--report-skipped');
      const skipped = (JSON.parse(r.stdout).findings as Array<{ kind: string; skippedBy?: string; source: { element: string; layers: string[] } }>).filter((f) => f.kind === 'skipped' && f.skippedBy === 'baseline');
      expect(skipped.map((f) => `${f.source.layers.join('+')} ${f.source.element}`).sort()).toEqual([
        'Repository src/repository/AuditTrail.ts#AuditTrail',
        'Repository src/repository/AuditTrail.ts#AuditTrail',
        'Shared src/shared/Money.ts#Money',
      ]);
      expect(smell('baseline-debt').map((s) => [s.description, s.involvedLayers, s.severity, s.source])).toEqual([
        ['Baseline debt: layer Repository has 2 baselined violations (disallowed-layer: 2)', ['Repository'], 'info', 'rules'],
        ['Baseline debt: layer Shared has 1 baselined violation (disallowed-layer: 1)', ['Shared'], 'info', 'rules'],
      ]);
      // A baseline of only Shared's entry: Repository has no debt (its violations are reported again).
      const file = join(extra, '.mapx/architecture.baseline.json');
      const baseline = JSON.parse(readFileSync(file, 'utf8')) as { entries: Array<{ source: string }> };
      writeFileSync(file, JSON.stringify({ ...baseline, entries: baseline.entries.filter((e) => e.source.startsWith('src/shared/')) }));
      expect(smell('baseline-debt').map((s) => s.involvedLayers)).toEqual([['Shared']]);
      expect(smellsOf(extra).filter((s) => s.type === 'layer-violation').flatMap((s) => s.involvedFiles)).toContain('src/repository/AuditTrail.ts');
    });
    expect(smell('baseline-debt')).toEqual([]);
  });
});

describe('the edges are evaluated once per command (review 7)', SLOW, () => {
  it('currentSmells evaluates once; `mapx arch`, which lists smells twice, evaluates once', async () => {
    const store = new Store(join(app, '.mapx', 'mapx.db'));
    try {
      const before = evaluations.n;
      currentSmells(store, app, ['app'], { primary: 'app' });
      expect(evaluations.n - before).toBe(1);
    } finally {
      store.close();
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const before = evaluations.n;
      await buildCLI().parseAsync(['node', 'mapx', 'arch', app]);
      expect(evaluations.n - before).toBe(1);
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Detected \d+ architectural smell\(s\)/);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    expect(existsSync(join(app, '.mapx/architecture.baseline.json'))).toBe(false);
  });
});
