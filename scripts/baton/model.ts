// BATON plan model for MapX: schema, invariants, transitions, critical path and handoff.
// docs/baton/TASKS.json is the source of truth; this module never touches the filesystem.
export const states = [
  'BACKLOG',
  'BLOCKED',
  'READY',
  'IN_PROGRESS',
  'VERIFYING',
  'REVIEW_REQUIRED',
  'DONE',
  'FAILED',
  'DEFERRED',
  'CANCELLED',
] as const;
export type Status = (typeof states)[number];
export const dependencyTypes = ['hard', 'interface', 'research', 'fixture', 'quality', 'approval'] as const;
export interface Evidence {
  command: string;
  exitCode: number;
  artifact: string;
  runAt?: string;
}
export interface Task {
  id: string;
  milestone: string;
  title: string;
  objective: string;
  description: string;
  priority: string;
  estimate: { min: number; expected: number; max: number };
  risk: string;
  area: string[];
  dependencies: { id: string; type: string }[];
  optionalDependencies: string[];
  blockingConditions: string[];
  sources: string[];
  outputs: string[];
  affectedFiles: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  verificationPlan: string;
  status: Status;
  owner: string;
  actualHours: number | null;
  startedAt: string | null;
  completedAt: string | null;
  commits: string[];
  artifacts: string[];
  evidence: Evidence[];
  history?: { at: string; from: Status; to: Status; evidence: Evidence[] }[];
  criticalPath: boolean;
  approvalGate: string | null;
  kind: 'iteration' | 'epic';
  rollback: string;
  /** Pre-BATON iteration id (I01–I22) for imported work. */
  legacyId?: string;
}
export interface Gate {
  id: string;
  title?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  approvedBy: string | null;
  approvedAt: string | null;
  revision: string | null;
  artifact: string | null;
}
export interface Milestone {
  id: string;
  title: string;
  goal: string;
  release?: string;
}
export interface Plan {
  schemaVersion: number;
  project: string;
  baselineRevision: string;
  capacity: { engineers: number; productiveHoursPerWeek: number; forecastStart: string };
  milestones: Milestone[];
  gates: Gate[];
  tasks: Task[];
}
export interface Requirement {
  id: string;
  priority: string;
  requirement: string;
  source: string;
  taskIds: string[];
  verificationTaskIds: string[];
}
const TASK_ID = /^(M\d+)-\d{2,}(-R\d+)?$/;
const STARTED: Status[] = ['IN_PROGRESS', 'VERIFYING', 'REVIEW_REQUIRED', 'DONE'];

export function blockers(plan: Plan, task: Task): string[] {
  const result = task.dependencies
    .filter((d) => plan.tasks.find((t) => t.id === d.id)?.status !== 'DONE')
    .map((d) => d.id);
  if (
    task.approvalGate &&
    plan.gates.find((g) => g.id === task.approvalGate)?.status !== 'APPROVED'
  )
    result.push(task.approvalGate);
  return result.concat(
    task.blockingConditions,
    task.kind === 'epic' ? ['Decompose epic into 4–16h iterations before execution'] : [],
  );
}
export function topological(plan: Plan): Task[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  if (byId.size !== plan.tasks.length) throw new Error('Duplicate task IDs');
  const done = new Set<string>();
  const visiting = new Set<string>();
  const order: Task[] = [];
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (done.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown dependency ${id}`);
    visiting.add(id);
    task.dependencies.forEach((d) => visit(d.id));
    visiting.delete(id);
    done.add(id);
    order.push(task);
  };
  plan.tasks.forEach((t) => visit(t.id));
  return order;
}
export function validate(plan: Plan, requirements: Requirement[] = []): void {
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.tasks) || !plan.tasks.length)
    throw new Error('Invalid schema or empty plan');
  if (
    !Number.isInteger(plan.capacity?.engineers) ||
    plan.capacity.engineers < 1 ||
    !Number.isFinite(plan.capacity.productiveHoursPerWeek) ||
    plan.capacity.productiveHoursPerWeek <= 0 ||
    !Number.isFinite(Date.parse(plan.capacity.forecastStart))
  )
    throw new Error('Invalid capacity');
  if (!Array.isArray(plan.milestones) || !plan.milestones.length)
    throw new Error('Missing milestones');
  const milestones = new Set(plan.milestones.map((m) => m.id));
  if (milestones.size !== plan.milestones.length) throw new Error('Duplicate milestones');
  const order = topological(plan);
  const ids = new Set(order.map((t) => t.id));
  const gates = new Set(plan.gates.map((g) => g.id));
  if (gates.size !== plan.gates.length) throw new Error('Duplicate gates');
  for (const gate of plan.gates) {
    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(gate.status))
      throw new Error(`Invalid gate ${gate.id}`);
    if (
      gate.status === 'APPROVED' &&
      (!gate.approvedBy ||
        !gate.approvedAt ||
        !gate.revision ||
        !gate.artifact ||
        !Number.isFinite(Date.parse(gate.approvedAt)))
    )
      throw new Error(`Approval lacks evidence: ${gate.id}`);
  }
  for (const task of order) {
    const match = TASK_ID.exec(task.id);
    if (!match || task.milestone !== match[1] || !milestones.has(task.milestone))
      throw new Error(`Invalid identity ${task.id}`);
    for (const key of [
      'title',
      'objective',
      'description',
      'priority',
      'risk',
      'owner',
      'verificationPlan',
      'rollback',
    ] as const)
      if (typeof task[key] !== 'string' || !task[key])
        throw new Error(`Missing ${key}: ${task.id}`);
    for (const key of [
      'area',
      'sources',
      'outputs',
      'affectedFiles',
      'acceptanceCriteria',
      'verificationCommands',
    ] as const)
      if (
        !Array.isArray(task[key]) ||
        !task[key].length ||
        task[key].some((x) => typeof x !== 'string' || !x)
      )
        throw new Error(`Missing ${key}: ${task.id}`);
    if (
      !['P0', 'P1', 'P2', 'P3'].includes(task.priority) ||
      !['low', 'medium', 'high', 'critical'].includes(task.risk) ||
      typeof task.criticalPath !== 'boolean'
    )
      throw new Error(`Invalid metadata ${task.id}`);
    for (const key of [
      'commits',
      'artifacts',
      'blockingConditions',
      'optionalDependencies',
    ] as const)
      if (!Array.isArray(task[key]) || task[key].some((x) => typeof x !== 'string'))
        throw new Error(`Invalid ${key}: ${task.id}`);
    if (!states.includes(task.status)) throw new Error(`Invalid status ${task.id}`);
    if (!['iteration', 'epic'].includes(task.kind)) throw new Error(`Invalid kind ${task.id}`);
    if (
      !['CANCELLED', 'DEFERRED'].includes(task.status) &&
      task.dependencies.some((d) =>
        ['CANCELLED', 'DEFERRED'].includes(plan.tasks.find((t) => t.id === d.id)!.status),
      )
    )
      throw new Error(`Unreachable dependency: ${task.id}; replan removed prerequisites`);
    if (
      task.startedAt &&
      task.completedAt &&
      Date.parse(task.completedAt) < Date.parse(task.startedAt)
    )
      throw new Error(`Completion precedes start ${task.id}`);
    const { min, expected, max } = task.estimate;
    if (
      ![min, expected, max].every((x) => Number.isFinite(x) && x >= 0) ||
      min > expected ||
      expected > max
    )
      throw new Error(`Invalid estimate ${task.id}`);
    if (task.actualHours !== null && (!Number.isFinite(task.actualHours) || task.actualHours < 0))
      throw new Error(`Invalid actual effort ${task.id}`);
    if (new Set(task.dependencies.map((d) => d.id)).size !== task.dependencies.length)
      throw new Error(`Duplicate dependency ${task.id}`);
    if (task.dependencies.some((d) => !(dependencyTypes as readonly string[]).includes(d.type)))
      throw new Error(`Invalid dependency type ${task.id}`);
    if (task.optionalDependencies.some((id) => !ids.has(id) || id === task.id))
      throw new Error(`Unknown optional dependency ${task.id}`);
    if (task.approvalGate && !gates.has(task.approvalGate))
      throw new Error(`Unknown gate ${task.id}`);
    if (
      ['READY', ...STARTED].includes(task.status) &&
      blockers(plan, task).length
    )
      throw new Error(`Unsatisfied dependencies/gates for ${task.id}`);
    if (
      STARTED.includes(task.status) &&
      (!task.startedAt || !Number.isFinite(Date.parse(task.startedAt)))
    )
      throw new Error(`Missing startedAt ${task.id}`);
    if (
      task.status === 'DONE' &&
      (!task.completedAt ||
        !Number.isFinite(Date.parse(task.completedAt)) ||
        !task.evidence.length ||
        task.evidence.some((e) => e.exitCode !== 0 || !e.command || !e.artifact))
    )
      throw new Error(`Missing passing completion evidence ${task.id}`);
    if (
      task.status === 'DONE' &&
      task.verificationCommands.some(
        (command) => !task.evidence.some((e) => e.command === command && e.exitCode === 0),
      )
    )
      throw new Error(`Missing required verification evidence ${task.id}`);
  }
  const owners = order
    .filter((t) => ['IN_PROGRESS', 'VERIFYING'].includes(t.status))
    .map((t) => t.owner);
  if (new Set(owners).size !== owners.length) throw new Error('One active iteration per owner');
  const reqIds = new Set(requirements.map((r) => r.id));
  if (reqIds.size !== requirements.length) throw new Error('Duplicate requirement IDs');
  for (const r of requirements) {
    if (r.taskIds.concat(r.verificationTaskIds).some((id) => !ids.has(id)))
      throw new Error(`Unknown requirement mapping ${r.id}`);
    if (r.priority === 'P0' && (!r.taskIds.length || !r.verificationTaskIds.length))
      throw new Error(`Unmapped P0 ${r.id}`);
    if (
      r.priority === 'P0' &&
      r.taskIds
        .concat(r.verificationTaskIds)
        .some((id) =>
          ['CANCELLED', 'DEFERRED'].includes(plan.tasks.find((t) => t.id === id)!.status),
        )
    )
      throw new Error(`Removed P0 requirement path ${r.id}`);
  }
}
export function ready(plan: Plan): Task[] {
  return plan.tasks
    .filter((t) => ['BACKLOG', 'BLOCKED', 'READY'].includes(t.status) && !blockers(plan, t).length)
    .sort(
      (a, b) =>
        Number(b.criticalPath) - Number(a.criticalPath) ||
        a.priority.localeCompare(b.priority) ||
        a.id.localeCompare(b.id),
    );
}
export interface Timing {
  id: string;
  duration: number;
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  slack: number;
}
export function criticalPath(plan: Plan, remaining = true) {
  const order = topological(plan);
  const times = new Map<string, Timing>();
  const previous = new Map<string, string>();
  for (const task of order) {
    let earliestStart = 0;
    let predecessor: string | undefined;
    for (const d of task.dependencies) {
      const finish = times.get(d.id)!.earliestFinish;
      if (finish >= earliestStart) {
        earliestStart = finish;
        predecessor = d.id;
      }
    }
    const duration =
      remaining && ['DONE', 'DEFERRED', 'CANCELLED'].includes(task.status)
        ? 0
        : task.estimate.expected;
    times.set(task.id, {
      id: task.id,
      duration,
      earliestStart,
      earliestFinish: earliestStart + duration,
      latestStart: 0,
      latestFinish: 0,
      slack: 0,
    });
    if (predecessor) previous.set(task.id, predecessor);
  }
  const duration = Math.max(0, ...[...times.values()].map((t) => t.earliestFinish));
  for (const task of [...order].reverse()) {
    const time = times.get(task.id)!;
    const children = order.filter((t) => t.dependencies.some((d) => d.id === task.id));
    time.latestFinish = children.length
      ? Math.min(...children.map((c) => times.get(c.id)!.latestStart))
      : duration;
    time.latestStart = time.latestFinish - time.duration;
    time.slack = time.latestStart - time.earliestStart;
  }
  const endpoint = [...times.values()].find((t) => t.earliestFinish === duration);
  const path: string[] = [];
  let id = endpoint?.id;
  while (id) {
    if (times.get(id)!.duration > 0) path.unshift(id);
    id = previous.get(id);
  }
  return {
    duration,
    path,
    times: [...times.values()],
    totalEffort: [...times.values()].reduce((s, t) => s + t.duration, 0),
  };
}
// Dependency-aware, non-preemptive list schedule. Gate waits and time off are excluded.
export function resourceSchedule(plan: Plan, asOf = new Date().toISOString().slice(0, 10)) {
  const cp = criticalPath(plan);
  const workers = Array<number>(plan.capacity.engineers).fill(0);
  const finish = new Map<string, number>();
  const assignments: { id: string; worker: number; start: number; finish: number }[] = [];
  for (const task of topological(plan)) {
    const duration = cp.times.find((t) => t.id === task.id)!.duration;
    const available = Math.max(0, ...task.dependencies.map((d) => finish.get(d.id)!));
    const worker = workers.indexOf(Math.min(...workers));
    const start = Math.max(workers[worker]!, available);
    const end = start + duration;
    finish.set(task.id, end);
    workers[worker] = end;
    assignments.push({ id: task.id, worker, start, finish: end });
  }
  const hours = Math.max(...workers);
  const weeks = hours / plan.capacity.productiveHoursPerWeek;
  const forecastAsOf = new Date(Math.max(Date.parse(asOf), Date.parse(plan.capacity.forecastStart)))
    .toISOString()
    .slice(0, 10);
  const conditionalDate = new Date(Date.parse(forecastAsOf) + weeks * 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  return { hours, weeks, forecastAsOf, conditionalDate, assignments };
}
const transitions: Record<Status, Status[]> = {
  BACKLOG: ['READY', 'BLOCKED', 'DEFERRED', 'CANCELLED'],
  BLOCKED: ['READY', 'DEFERRED', 'CANCELLED'],
  READY: ['IN_PROGRESS', 'BLOCKED', 'DEFERRED', 'CANCELLED'],
  IN_PROGRESS: ['VERIFYING', 'FAILED', 'BLOCKED'],
  VERIFYING: ['DONE', 'FAILED', 'REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['DONE', 'FAILED', 'BLOCKED'],
  FAILED: ['READY', 'BLOCKED', 'CANCELLED'],
  DONE: [],
  DEFERRED: ['BACKLOG'],
  CANCELLED: [],
};
export function transition(
  plan: Plan,
  id: string,
  status: Status,
  evidence: Evidence[] = [],
  now = new Date().toISOString(),
  owner?: string,
): Plan {
  const next = structuredClone(plan);
  const task = next.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Unknown task ${id}`);
  if (!states.includes(status)) throw new Error(`Unknown status ${status}`);
  if (!transitions[task.status].includes(status))
    throw new Error(`Illegal transition ${task.status} → ${status}`);
  if (['READY', ...STARTED].includes(status) && blockers(next, task).length)
    throw new Error(`Blocked ${id}: ${blockers(next, task).join('; ')}`);
  task.history = [
    ...(task.history ?? []),
    { at: now, from: task.status, to: status, evidence: structuredClone(evidence) },
  ];
  task.status = status;
  if (owner) task.owner = owner;
  if (status === 'IN_PROGRESS') task.startedAt = now;
  if (status === 'DONE') {
    task.evidence = evidence;
    task.completedAt = now;
    task.artifacts = [...new Set([...task.artifacts, ...evidence.map((e) => e.artifact)])];
  }
  validate(next);
  return next;
}
export function handoff(plan: Plan, revision: string): string {
  const cp = criticalPath(plan);
  const queue = ready(plan);
  const next = queue[0];
  const completed = plan.tasks
    .filter((t) => t.status === 'DONE')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const last = completed[0];
  const active = plan.tasks.filter((t) =>
    ['IN_PROGRESS', 'VERIFYING', 'REVIEW_REQUIRED'].includes(t.status),
  );
  const milestone = active[0]?.milestone ?? next?.milestone;
  const goal = plan.milestones.find((m) => m.id === milestone);
  return `# MapX BATON handoff

Revision: ${revision}; plan baseline: ${plan.baselineRevision}. Current milestone: ${goal ? `${goal.id} — ${goal.title}` : 'none eligible; review gates and blockers'}.

## Baseline
Last completed: ${last ? `${last.id} — ${last.title}` : 'none'}.
Evidence: ${last?.evidence.map((e) => `\`${e.command}\` (exit ${e.exitCode}) → ${e.artifact}`).join('; ') || 'none'}.
Actual engineering effort is unknown unless recorded in TASKS.json.

## Architect
Read docs/baton/PROJECT_STATE.md, docs/baton/DECISIONS.md and docs/baton/RISKS.md. Legacy design notes live in specs/features/ (referenced from each task's \`sources\`); TASKS.json and docs/baton/iterations/ supersede specs/ITERATIONS.md.

## Task
${next ? `Next READY: ${next.id} — ${next.title}. Prerequisites: ${next.dependencies.map((d) => d.id).join(', ') || 'none'}. Read docs/baton/iterations/${next.id}.md. Objective: ${next.objective} Expected outputs: ${next.outputs.join('; ')}. Verify: ${next.verificationCommands.map((c) => `\`${c}\``).join('; ')}.` : 'No READY task; inspect blockers and pending approvals.'}
Also eligible: ${queue.slice(1, 6).map((t) => t.id).join(', ') || 'none'}.
Active work: ${active.map((t) => `${t.id} (${t.owner})`).join(', ') || 'none'}. One active iteration per owner.

## Observe
Run \`npm run plan:validate\`, inspect \`git status\`, then \`npm run check\`. Never rely on this packet alone; read docs/baton/reports/ for executed evidence and limitations.

## Next
Remaining critical path: ${cp.path.join(' → ') || 'none'} (${cp.duration}h). Recompute with \`npm run plan:report\` after every completion.
Pending gates: ${plan.gates.filter((g) => g.status !== 'APPROVED').map((g) => g.id).join(', ') || 'none'}; request approval only with reviewable evidence.
External blockers: ${plan.tasks.flatMap((t) => t.blockingConditions.map((b) => `${t.id}: ${b}`)).join('; ') || 'none'}.
`;
}
