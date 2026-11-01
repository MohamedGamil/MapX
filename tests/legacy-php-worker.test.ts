import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapxWithStderr, query, workspace, useParseWorkers } from './helpers/e2e.js';

// These scans exercise the parse workers; test projects are below the automatic break-even (M4-13).
useParseWorkers(4);

// M0-06-R1: worker-thread scans (default for > 10 files) must apply PHP post-processing exactly
// like sequential scans: facades, dispatch/notify edges and Laravel roles.
const cls = (ns: string, name: string, body = '', extra = '') =>
  `<?php\nnamespace ${ns};\n${extra}\nclass ${name} ${body}{}\n`;

const files: Record<string, string> = {
  artisan: '#!/usr/bin/env php\n<?php\n',
  'app/Events/UserRegistered.php': cls('App\\Events', 'UserRegistered', '', 'use Illuminate\\Foundation\\Events\\Dispatchable;'),
  'app/Events/OrderShipped.php': cls('App\\Events', 'OrderShipped', '', 'use Illuminate\\Foundation\\Events\\Dispatchable;'),
  'app/Jobs/SendReport.php': cls('App\\Jobs', 'SendReport', 'implements \\Illuminate\\Contracts\\Queue\\ShouldQueue '),
  'app/Jobs/Cleanup.php': cls('App\\Jobs', 'Cleanup', 'implements \\Illuminate\\Contracts\\Queue\\ShouldQueue '),
  'app/Notifications/Welcome.php': cls('App\\Notifications', 'Welcome', 'extends \\Illuminate\\Notifications\\Notification '),
  'app/Listeners/SendWelcome.php': cls('App\\Listeners', 'SendWelcome'),
  'app/Listeners/LogOrder.php': cls('App\\Listeners', 'LogOrder'),
  'app/Models/User.php': cls('App\\Models', 'User', 'extends \\Illuminate\\Database\\Eloquent\\Model '),
  'app/Http/Controllers/UserController.php': [
    '<?php',
    'namespace App\\Http\\Controllers;',
    'use App\\Events\\UserRegistered;',
    'use App\\Events\\OrderShipped;',
    'use App\\Jobs\\SendReport;',
    'use App\\Jobs\\Cleanup;',
    'use App\\Notifications\\Welcome;',
    'use Illuminate\\Support\\Facades\\Event;',
    'use Illuminate\\Support\\Facades\\Cache;',
    'class UserController {',
    '  public function store($user) {',
    '    event(new UserRegistered($user));',
    '    Event::dispatch(new OrderShipped());',
    '    SendReport::dispatch();',
    '    dispatch(new Cleanup());',
    '    $user->notify(new Welcome());',
    "    Cache::put('k', 1);",
    '  }',
    '}',
  ].join('\n'),
  'app/Providers/EventServiceProvider.php': [
    '<?php',
    'namespace App\\Providers;',
    'use App\\Events\\UserRegistered;',
    'use App\\Events\\OrderShipped;',
    'use App\\Listeners\\SendWelcome;',
    'use App\\Listeners\\LogOrder;',
    'class EventServiceProvider extends \\Illuminate\\Foundation\\Support\\Providers\\EventServiceProvider {',
    // M0-04-R2: a docblock example came first and was the only $listen read; comments and
    // string keys are now read from the property declaration node.
    '  /**',
    '   * Example: protected $listen = [ Fake::class => [FakeListener::class] ];',
    '   */',
    '  protected $listen = [',
    '    UserRegistered::class => [',
    '      // LogOrder::class,',
    '      SendWelcome::class,',
    '    ],',
    '    OrderShipped::class => [LogOrder::class, SendWelcome::class],',
    "    'App\\Events\\Paid' => ['App\\Listeners\\LogOrder@handle'],",
    '    "App\\\\Events\\\\Refunded" => [ /* first */ \\App\\Listeners\\SendWelcome::class],',
    '  ];',
    '}',
  ].join('\n'),
  'app/Listeners/FakeListener.php': cls('App\\Listeners', 'FakeListener'),
  'app/Http/Controllers/ShipController.php': [
    '<?php',
    'namespace App\\Http\\Controllers;',
    'use App\\Events\\UserRegistered;',
    'class ShipController {',
    '  public function ship($user) {',
    '    event(new \\App\\Events\\OrderShipped());',
    '    \\Event::dispatch(new UserRegistered($user));',
    '  }',
    '}',
  ].join('\n'),
};
for (let i = 0; i < 6; i++) files[`app/Services/S${i}.php`] = cls('App\\Services', `S${i}`);

type Row = { source_file: string; source_symbol: string | null; edge_type: string; target_file: string; target_symbol: string; verifiability: string; metadata: string };
function scan(parallel: boolean) {
  const root = workspace(files);
  init(root);
  const { stderr } = mapxWithStderr(root, 'scan', root, ...(parallel ? [] : ['--no-parallel']));
  // Guard: a parallel scan must really use worker threads, not fall back silently.
  if (parallel) expect(stderr).not.toContain('Parallel parsing unavailable');
  // Every edge with its metadata and verifiability, and every file's metadata (M0-04-R2: the
  // parity check ignored both, so a worker dropping fileMetadata or binding metadata passed).
  const edges = query<Row>(root, 'SELECT source_file, source_symbol, edge_type, target_file, target_symbol, verifiability, metadata FROM edges')
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const fileRows = query<{ path: string; language: string; metadata: string; namespace: string | null }>(root, 'SELECT path, language, metadata, namespace FROM files ORDER BY path');
  const roles = query<{ name: string; metadata: string }>(root, 'SELECT name, metadata FROM symbols ORDER BY name')
    .map((s) => [s.name, JSON.parse(s.metadata || '{}').laravelRole])
    .filter(([, role]) => role);
  return { root, edges, files: fileRows, roles };
}

describe('PHP post-processing in worker scans', () => {
  let parallel: ReturnType<typeof scan>;
  let sequential: ReturnType<typeof scan>;
  beforeAll(() => {
    expect(Object.keys(files).length).toBeGreaterThan(10);
    parallel = scan(true);
    sequential = scan(false);
  }, 180000);
  afterAll(() => {
    cleanup(parallel.root);
    cleanup(sequential.root);
  });

  it('produces the same edges (metadata and verifiability included), file metadata and roles as a sequential scan', () => {
    const withMeta = (rows: Row[]) => rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata || '{}') }));
    expect(withMeta(parallel.edges)).toEqual(withMeta(sequential.edges));
    expect(parallel.files).toEqual(sequential.files);
    expect(parallel.roles).toEqual(sequential.roles);
    // The comparison is not vacuous: namespaces and binding metadata are present.
    expect(parallel.files.find((f) => f.path === 'app/Providers/EventServiceProvider.php')?.namespace).toBe('App\\Providers');
    expect(JSON.parse(parallel.files.find((f) => f.path === 'app/Jobs/Cleanup.php')!.metadata)).toMatchObject({ namespace: 'App\\Jobs' });
    expect(parallel.edges.filter((e) => e.edge_type === 'dispatch').length).toBeGreaterThanOrEqual(4);
    expect(parallel.edges.filter((e) => e.edge_type === 'notify').length).toBeGreaterThanOrEqual(1);
    expect(parallel.roles.length).toBeGreaterThanOrEqual(6);
  });

  it('targets the dispatched class for Event::dispatch(new X)', () => {
    const shipped = parallel.edges.find((e) => e.edge_type === 'dispatch' && e.target_symbol === 'App\\Events\\OrderShipped');
    expect(shipped?.target_file).toBe('app/Events/OrderShipped.php');
    expect(JSON.parse(shipped!.metadata)).toMatchObject({ dispatchedRole: 'event' });
    expect(parallel.edges.some((e) => e.edge_type === 'dispatch' && /Facades\\Event$/.test(e.target_symbol))).toBe(false);
  });

  it('dispatches through qualified names: event(new \\App\\X) and \\Event::dispatch(new X)', () => {
    const ship = parallel.edges.filter((e) => e.source_file === 'app/Http/Controllers/ShipController.php' && e.edge_type === 'dispatch')
      .map((e) => `${JSON.parse(e.metadata).dispatchMethod} → ${e.target_file} ${e.target_symbol}`).sort();
    expect(ship).toEqual([
      'Event::dispatch → app/Events/UserRegistered.php App\\Events\\UserRegistered',
      'event → app/Events/OrderShipped.php App\\Events\\OrderShipped',
    ]);
  });

  it('turns $listen into provider → listener bindings carrying the event', () => {
    const listens = parallel.edges
      .filter((e) => e.edge_type === 'binding' && JSON.parse(e.metadata).bindingType === 'listen')
      .map((e) => `${JSON.parse(e.metadata).event} → ${e.target_file} ${e.verifiability}`)
      .sort();
    // Not the docblock's Fake → FakeListener, not the commented-out UserRegistered → LogOrder;
    // string keys and listeners count, a listener string being inferred (M0-04-R2).
    expect(listens).toEqual([
      'App\\Events\\OrderShipped → app/Listeners/LogOrder.php verified',
      'App\\Events\\OrderShipped → app/Listeners/SendWelcome.php verified',
      'App\\Events\\Paid → app/Listeners/LogOrder.php inferred',
      'App\\Events\\Refunded → app/Listeners/SendWelcome.php verified',
      'App\\Events\\UserRegistered → app/Listeners/SendWelcome.php verified',
    ]);
  });
});
