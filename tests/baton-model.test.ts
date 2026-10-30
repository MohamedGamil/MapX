import { describe, it, expect } from 'vitest';
import {
  criticalPath,
  handoff,
  ready,
  topological,
  transition,
  validate,
  type Plan,
  type Task,
} from '../scripts/baton/model.ts';

const task = (id: string, h: number, deps: string[] = [], patch: Partial<Task> = {}): Task => ({
  id,
  milestone: id.split('-')[0]!,
  title: id,
  objective: `Deliver ${id}`,
  description: `Deliver ${id}`,
  priority: 'P1',
  estimate: { min: h, expected: h, max: h },
  risk: 'low',
  area: ['core'],
  dependencies: deps.map((d) => ({ id: d, type: 'hard' })),
  optionalDependencies: [],
  blockingConditions: [],
  sources: ['report'],
  outputs: ['out'],
  affectedFiles: [`src/${id}`],
  acceptanceCriteria: ['Input X yields Y'],
  verificationCommands: ['npx vitest run tests/x.test.ts'],
  verificationPlan: 'run it',
  status: 'BACKLOG',
  owner: 'dev',
  actualHours: null,
  startedAt: null,
  completedAt: null,
  commits: [],
  artifacts: [],
  evidence: [],
  criticalPath: false,
  approvalGate: null,
  kind: 'iteration',
  rollback: 'revert',
  ...patch,
});

function fixture(): Plan {
  return {
    schemaVersion: 1,
    project: 'MapX',
    baselineRevision: 'test',
    capacity: { engineers: 1, productiveHoursPerWeek: 20, forecastStart: '2026-11-02' },
    milestones: [
      { id: 'M0', title: 'Base', goal: 'g' },
      { id: 'M1', title: 'Next', goal: 'g', release: '0.4.0' },
    ],
    gates: [{ id: 'G1', status: 'PENDING', approvedBy: null, approvedAt: null, revision: null, artifact: null }],
    tasks: [task('M1-01', 2), task('M1-02', 5, ['M1-01']), task('M1-03', 3, ['M1-01']), task('M1-04', 1, ['M1-02', 'M1-03'])],
  };
}
const evidence = [{ command: 'npx vitest run tests/x.test.ts', exitCode: 0, artifact: 'r.md' }];

describe('BATON plan model', () => {
  it('sorts a diamond topologically and computes the critical path', () => {
    const p = fixture();
    validate(p);
    expect(topological(p).map((t) => t.id)).toEqual(['M1-01', 'M1-02', 'M1-03', 'M1-04']);
    const cp = criticalPath(p);
    expect(cp.duration).toBe(8);
    expect(cp.path).toEqual(['M1-01', 'M1-02', 'M1-04']);
    expect(cp.times.find((t) => t.id === 'M1-03')!.slack).toBe(2);
  });

  it('rejects duplicates, cycles, unknown milestones and bad ids', () => {
    let p = fixture();
    p.tasks.push(p.tasks[0]!);
    expect(() => validate(p)).toThrow(/Duplicate/);
    p = fixture();
    p.tasks[0]!.dependencies = [{ id: 'M1-04', type: 'hard' }];
    expect(() => validate(p)).toThrow(/cycle/);
    p = fixture();
    p.tasks.push(task('M7-01', 1));
    expect(() => validate(p)).toThrow(/Invalid identity M7-01/);
    p = fixture();
    p.tasks.push(task('M1-1', 1));
    expect(() => validate(p)).toThrow(/Invalid identity/);
  });

  it('accepts remediation ids and the fixture dependency type', () => {
    const p = fixture();
    p.tasks.push(task('M1-02-R1', 2, [], { dependencies: [{ id: 'M1-01', type: 'fixture' }] }));
    expect(() => validate(p)).not.toThrow();
    p.tasks.at(-1)!.dependencies[0]!.type = 'asset';
    expect(() => validate(p)).toThrow(/Invalid dependency type/);
  });

  it('walks a task to DONE only with evidence for every registered command', () => {
    let p = fixture();
    p = transition(p, 'M1-01', 'READY');
    p = transition(p, 'M1-01', 'IN_PROGRESS', [], '2026-01-01T00:00:00Z', 'alice');
    expect(p.tasks[0]!.owner).toBe('alice');
    p = transition(p, 'M1-01', 'VERIFYING');
    expect(() => transition(p, 'M1-01', 'DONE', [])).toThrow(/evidence/);
    p = transition(p, 'M1-01', 'DONE', evidence);
    expect(p.tasks[0]!.status).toBe('DONE');
    expect(p.tasks[0]!.history!.map((h) => h.to)).toEqual(['READY', 'IN_PROGRESS', 'VERIFYING', 'DONE']);
    expect(() => transition(p, 'M1-01', 'READY')).toThrow(/Illegal/);
  });

  it('blocks promotion on unmet dependencies, gates and external conditions', () => {
    let p = fixture();
    expect(() => transition(p, 'M1-02', 'READY')).toThrow(/Blocked M1-02/);
    p.tasks[0]!.approvalGate = 'G1';
    expect(() => transition(p, 'M1-01', 'READY')).toThrow(/G1/);
    p = fixture();
    p.tasks[0]!.blockingConditions = ['Owner decision'];
    expect(ready(p).map((t) => t.id)).not.toContain('M1-01');
  });

  it('enforces one active iteration per owner', () => {
    let p = fixture();
    p.tasks.push(task('M0-01', 1));
    p = transition(p, 'M1-01', 'READY');
    p = transition(p, 'M0-01', 'READY');
    p = transition(p, 'M1-01', 'IN_PROGRESS');
    expect(() => transition(p, 'M0-01', 'IN_PROGRESS')).toThrow(/One active iteration per owner/);
  });

  it('names the next ready task and its spec in the handoff', () => {
    const text = handoff(fixture(), 'develop@abc');
    expect(text).toContain('Next READY: M1-01');
    expect(text).toContain('docs/baton/iterations/M1-01.md');
    expect(text).toContain('Current milestone: M1 — Next');
  });
});
