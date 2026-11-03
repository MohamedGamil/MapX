// M4-31: every full test run printed "MaxListenersExceededWarning: 11 SIGINT/exit/SIGTERM listeners
// added to [process]". With --trace-warnings each stack was loadContext (src/cli.ts): every call
// added an exit, a SIGINT and a SIGTERM listener to close its store, and never removed them, so a
// test file running eleven CLI commands in-process passed ten. One listener set now serves every
// open store, and is removed when the last store is closed.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildCLI, loadContext } from '../src/cli.js';
import type { Store } from '../src/core/store.js';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';

const EVENTS = ['exit', 'SIGINT', 'SIGTERM'] as const;
const counts = () => Object.fromEntries(EVENTS.map((e) => [e, process.listenerCount(e)]));

describe('loadContext adds at most one process listener per event, and removes it on close', () => {
  let root = '';
  const warnings: Error[] = [];
  const onWarning = (w: Error) => { if (w.name === 'MaxListenersExceededWarning') warnings.push(w); };

  beforeAll(() => {
    root = workspace({ 'src/a.ts': 'export function a() { return 1; }\n', 'src/b.ts': "import { a } from './a';\nexport const b = a();\n" });
    init(root);
    mapx(root, 'scan', root);
    process.on('warning', onWarning);
  }, 60_000);
  afterAll(() => {
    process.removeListener('warning', onWarning);
    if (root) cleanup(root);
  });

  it('twelve contexts share one listener per event; closing their stores restores the counts', async () => {
    const before = counts();
    const stores: Store[] = [];
    for (let i = 0; i < 12; i++) stores.push((await loadContext(root)).store);
    for (const e of EVENTS) expect(process.listenerCount(e), e).toBeLessThanOrEqual(before[e]! + 1);
    stores[0]!.close();
    for (const e of EVENTS) expect(process.listenerCount(e), `${e} with 11 stores open`).toBe(before[e]! + 1);
    for (const s of stores.slice(1)) s.close();
    expect(counts()).toEqual(before);
    // A store closed twice (as the exit listener may) changes nothing.
    stores[0]!.close();
    expect(counts()).toEqual(before);
    expect(warnings).toEqual([]);
  });

  it('twelve in-process CLI commands emit no MaxListenersExceededWarning', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const before = counts();
      for (let i = 0; i < 12; i++) await buildCLI().parseAsync(['node', 'mapx', 'status', root]);
      for (const e of EVENTS) expect(process.listenerCount(e), e).toBeLessThanOrEqual(before[e]! + 1);
      await new Promise((r) => setImmediate(r)); // warnings are emitted on the next tick
      expect(warnings).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});
