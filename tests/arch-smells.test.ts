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
const SLOW = { timeout: 180_000 };

let tmp = '';
let app = ''; // the fixture as it is
let noconf = ''; // without an architecture configuration
let also = ''; // with policy.alsoInferred, and a file in no layer
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
  for (const root of [app, noconf, also]) cpSync(FIXTURE, root, { recursive: true });
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
  for (const root of [app, noconf, also]) {
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
