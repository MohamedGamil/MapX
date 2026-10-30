import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapxWithStderr, query, workspace } from './helpers/e2e.js';

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
    '  protected $listen = [',
    '    UserRegistered::class => [SendWelcome::class],',
    '    OrderShipped::class => [LogOrder::class, SendWelcome::class],',
    '  ];',
    '}',
  ].join('\n'),
};
for (let i = 0; i < 6; i++) files[`app/Services/S${i}.php`] = cls('App\\Services', `S${i}`);

type Row = { edge_type: string; target_file: string; target_symbol: string; metadata: string };
function scan(parallel: boolean) {
  const root = workspace(files);
  init(root);
  const { stderr } = mapxWithStderr(root, 'scan', root, ...(parallel ? [] : ['--no-parallel']));
  // Guard: a parallel scan must really use worker threads, not fall back silently.
  if (parallel) expect(stderr).not.toContain('Parallel parsing unavailable');
  const edges = query<Row>(root, "SELECT edge_type, target_file, target_symbol, metadata FROM edges WHERE edge_type IN ('dispatch','notify','binding','call') ORDER BY edge_type, target_symbol");
  const roles = query<{ name: string; metadata: string }>(root, 'SELECT name, metadata FROM symbols ORDER BY name')
    .map((s) => [s.name, JSON.parse(s.metadata || '{}').laravelRole])
    .filter(([, role]) => role);
  return { root, edges, roles };
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

  it('produces the same dispatch, notify, binding and role results as a sequential scan', () => {
    const strip = (rows: Row[]) => rows.map((r) => `${r.edge_type} ${r.target_symbol} ${r.target_file}`);
    expect(strip(parallel.edges)).toEqual(strip(sequential.edges));
    expect(parallel.roles).toEqual(sequential.roles);
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

  it('turns $listen into provider → listener bindings carrying the event', () => {
    const listens = parallel.edges
      .filter((e) => e.edge_type === 'binding' && JSON.parse(e.metadata).bindingType === 'listen')
      .map((e) => `${JSON.parse(e.metadata).event} → ${e.target_file}`)
      .sort();
    expect(listens).toEqual([
      'App\\Events\\OrderShipped → app/Listeners/LogOrder.php',
      'App\\Events\\OrderShipped → app/Listeners/SendWelcome.php',
      'App\\Events\\UserRegistered → app/Listeners/SendWelcome.php',
    ]);
  });
});
