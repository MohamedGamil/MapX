import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.resolve('./baton-scan.mjs'));
const task = (id, status, deps = [], patch = {}) => ({
  id,
  title: id,
  status,
  priority: 'P0',
  owner: 'dev',
  estimate: { expected: 8 },
  dependencies: deps.map((d) => ({ id: d, type: 'hard' })),
  acceptanceCriteria: ['Specific measurable result'],
  verificationCommands: ['node --test feature.test.mjs'],
  affectedFiles: [`src/${id}`],
  ...patch,
});
// Every temp folder is removed when the file's tests are done (M4-09-R5).
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function scan(plan) {
  const dir = mkdtempSync(join(tmpdir(), 'baton-scan-'));
  made.push(dir);
  mkdirSync(join(dir, 'iterations'));
  for (const t of plan.tasks) writeFileSync(join(dir, 'iterations', `${t.id}.md`), '# spec\n');
  writeFileSync(join(dir, 'TASKS.json'), JSON.stringify(plan));
  return JSON.parse(
    execFileSync('node', [script, join(dir, 'TASKS.json'), '--json'], { encoding: 'utf8' }),
  );
}

test('classifies active, ready, promotable, next wave, blocked and later work', () => {
  const r = scan({
    gates: [{ id: 'G1', status: 'PENDING' }],
    tasks: [
      task('DONE1', 'DONE'),
      task('ACT', 'IN_PROGRESS', ['DONE1'], { affectedFiles: ['src/shared'] }),
      task('RDY', 'READY', ['DONE1']),
      task('PRO', 'BACKLOG', ['DONE1'], { affectedFiles: ['src/shared/x.ts'] }),
      task('WAVE', 'BACKLOG', ['ACT', 'PRO'], { blockingConditions: ['device access'] }),
      task('GATED', 'BACKLOG', ['DONE1'], { approvalGate: 'G1' }),
      task('EPIC', 'BACKLOG', [], { kind: 'epic', estimate: { expected: 60 } }),
      task('LATER', 'BACKLOG', ['WAVE']),
    ],
  });
  assert.deepEqual(
    r.active.map((t) => t.id),
    ['ACT'],
  );
  assert.deepEqual(
    r.ready.map((t) => t.id),
    ['RDY'],
  );
  assert.deepEqual(
    r.promotable.map((t) => t.id),
    ['PRO'],
  );
  assert.deepEqual(
    r.nextWave.map((t) => t.id),
    ['WAVE'],
  );
  assert.deepEqual(r.nextWave[0].alsoNeeds, ['external: device access']);
  assert.deepEqual(r.blocked.map((t) => t.id).sort(), ['EPIC', 'GATED']);
  assert.equal(r.laterCount, 1);
  assert.match(r.promotable[0].overlaps[0], /overlaps ACT/);
  assert.deepEqual(r.ready[0].overlaps, [], 'src/RDY does not overlap src/shared');
  assert.deepEqual(r.pendingGates, ['G1']);
});

test('reports planning gaps and owner WIP violations', () => {
  const r = scan({
    tasks: [
      task('A', 'IN_PROGRESS', [], { owner: 'solo' }),
      task('B', 'VERIFYING', [], { owner: 'solo' }),
      task('R', 'REVIEW_REQUIRED', [], { owner: 'solo' }),
      task('PRE', 'BACKLOG', [], { affectedFiles: ['src/A-other'] }),
      task('C', 'BACKLOG', [], {
        owner: 'unassigned',
        verificationCommands: ['pnpm check'],
        acceptanceCriteria: ['Works well'],
        estimate: { expected: 30 },
        affectedFiles: [],
      }),
    ],
  });
  assert.deepEqual(r.wipViolations, [{ owner: 'solo', ids: ['A', 'B'] }]);
  const pre = r.promotable.find((t) => t.id === 'PRE');
  assert.deepEqual(pre.overlaps, [], 'src/A-other is not inside src/A');
  const gaps = r.promotable[0].gaps.join(' | ');
  for (const expected of ['no owner', 'only generic', 'vague', '30h', 'no affected files'])
    assert.match(gaps, new RegExp(expected));
});
