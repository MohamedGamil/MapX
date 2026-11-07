#!/usr/bin/env node
// Read-only BATON queue scan: what is active, ready, promotable, coming next, blocked,
// and which of those items are not yet planned well enough to start. Zero dependencies.
// Usage: node baton-scan.mjs [path/to/TASKS.json] [--json]
import console from 'node:console';
import { existsSync, readFileSync, statSync } from 'node:fs';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const file = resolve(args.find((a) => !a.startsWith('--')) ?? 'docs/baton/TASKS.json');
let plan;
try {
  plan = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`Cannot read plan ${file}: ${error.message}`);
  process.exit(2);
}
const tasks = Array.isArray(plan) ? plan : (plan.tasks ?? []);
const gates = new Map((plan.gates ?? []).map((g) => [g.id, g]));
const byId = new Map(tasks.map((t) => [t.id, t]));
const batonDir = dirname(file);
const ACTIVE = ['IN_PROGRESS', 'VERIFYING', 'REVIEW_REQUIRED'];
const OPEN = ['BACKLOG', 'BLOCKED', 'READY'];
const MAX_ITERATION_HOURS = 16;
const GENERIC_COMMANDS = new Set(['npm run check', 'npm test', 'npx vitest run', 'npm run typecheck', 'pnpm check', 'pnpm test', 'yarn test', 'make test']);
const VAGUE = /\b(works well|optimi[sz]ed|good enough|as needed|etc\.?|properly|robust)\b/i;

const depIds = (t) => (t.dependencies ?? []).map((d) => (typeof d === 'string' ? d : d.id));
function blockers(t) {
  const result = depIds(t)
    .filter((id) => byId.get(id)?.status !== 'DONE')
    .map((id) => ({ kind: 'dependency', id, status: byId.get(id)?.status ?? 'MISSING' }));
  if (t.approvalGate && gates.get(t.approvalGate)?.status !== 'APPROVED')
    result.push({ kind: 'approval', id: t.approvalGate });
  for (const condition of t.blockingConditions ?? [])
    result.push({ kind: 'external', id: condition });
  if (t.kind === 'epic') result.push({ kind: 'epic', id: 'decompose into 4–16h iterations' });
  return result;
}
function gaps(t) {
  const found = [];
  if (!t.owner || t.owner === 'unassigned') found.push('no owner');
  const commands = t.verificationCommands ?? [];
  if (!commands.length) found.push('no verification commands');
  else if (commands.every((c) => GENERIC_COMMANDS.has(c.trim())))
    found.push('only generic verification; register task-specific commands before start');
  const criteria = t.acceptanceCriteria ?? [];
  if (!criteria.length) found.push('no acceptance criteria');
  else if (criteria.some((c) => VAGUE.test(c))) found.push('vague acceptance wording');
  const expected = t.estimate?.expected;
  if (typeof expected === 'number' && expected > MAX_ITERATION_HOURS)
    found.push(`estimate ${expected}h > ${MAX_ITERATION_HOURS}h; decompose`);
  if (t.kind === 'epic') found.push('epic; decompose before execution');
  const spec = join(batonDir, 'iterations', `${t.id}.md`);
  if (existsSync(join(batonDir, 'iterations')) && !existsSync(spec))
    found.push('no iteration spec');
  if (!(t.affectedFiles ?? []).length) found.push('no affected files (parallel safety unknown)');
  return found;
}

const active = tasks.filter((t) => ACTIVE.includes(t.status));
/** Path-segment containment: src/a contains src/a/x.ts but not src/ab. */
const within = (path, dir) => path === dir || path.startsWith(dir.replace(/\/+$/, '') + '/');
const activeFiles = active.flatMap((t) => (t.affectedFiles ?? []).map((f) => [f, t.id]));
const overlaps = (t) =>
  (t.affectedFiles ?? []).flatMap((f) =>
    activeFiles
      .filter(([g, id]) => id !== t.id && (within(f, g) || within(g, f)))
      .map(([g, id]) => `${f} overlaps ${id} (${g})`),
  );
const summary = (t, extra = {}) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority ?? null,
  owner: t.owner ?? null,
  expectedHours: t.estimate?.expected ?? null,
  critical: Boolean(t.criticalPath),
  ...extra,
});
const rank = (a, b) =>
  Number(b.critical) - Number(a.critical) ||
  String(a.priority).localeCompare(String(b.priority)) ||
  a.id.localeCompare(b.id);

const eligible = tasks.filter((t) => OPEN.includes(t.status) && !blockers(t).length);
const ready = eligible.filter((t) => t.status === 'READY');
const promotable = eligible.filter((t) => t.status !== 'READY');
const unmetDeps = (t) => blockers(t).filter((x) => x.kind === 'dependency');
const otherBlockers = (t) =>
  blockers(t)
    .filter((x) => x.kind !== 'dependency')
    .map((x) => `${x.kind}: ${x.id}`);
// Next wave: every unmet dependency is already active or eligible, so plan (or decompose, or
// request inputs for) these now and promote them as soon as that work lands.
const nextWave = tasks.filter((t) => {
  const deps = unmetDeps(t);
  return (
    OPEN.includes(t.status) &&
    !eligible.includes(t) &&
    deps.length > 0 &&
    deps.every((x) => ACTIVE.includes(x.status) || eligible.some((e) => e.id === x.id))
  );
});
// Blocked now: dependencies are all DONE; only a gate, external condition or epic stands in the way.
const blocked = tasks.filter(
  (t) => OPEN.includes(t.status) && !eligible.includes(t) && !unmetDeps(t).length,
);
const later = tasks.filter(
  (t) => OPEN.includes(t.status) && ![...eligible, ...nextWave, ...blocked].includes(t),
);
const owners = new Map();
// Same rule as the plan tool: REVIEW_REQUIRED waits on a human, so it does not count toward WIP.
for (const t of active.filter((x) => x.status !== 'REVIEW_REQUIRED'))
  owners.set(t.owner, [...(owners.get(t.owner) ?? []), t.id]);
const wipViolations = [...owners].filter(([, ids]) => ids.length > 1);

const lastChange = tasks
  .flatMap((t) => (t.history ?? []).map((h) => Date.parse(h.at)))
  .filter(Number.isFinite)
  .reduce((a, b) => Math.max(a, b), 0);
const stale = ['PROJECT_STATE.md', 'HANDOFF.md'].filter((name) => {
  const path = join(batonDir, name);
  return existsSync(path) && lastChange && statSync(path).mtimeMs + 1000 < lastChange;
});

const report = {
  plan: file,
  counts: Object.fromEntries(
    [...new Set(tasks.map((t) => t.status))].map((s) => [
      s,
      tasks.filter((t) => t.status === s).length,
    ]),
  ),
  active: active.map((t) => summary(t)),
  wipViolations: wipViolations.map(([owner, ids]) => ({ owner, ids })),
  ready: ready.map((t) => summary(t, { gaps: gaps(t), overlaps: overlaps(t) })).sort(rank),
  promotable: promotable
    .map((t) => summary(t, { gaps: gaps(t), overlaps: overlaps(t) }))
    .sort(rank),
  nextWave: nextWave
    .map((t) =>
      summary(t, {
        waitingOn: unmetDeps(t).map((x) => `${x.id} (${x.status})`),
        alsoNeeds: otherBlockers(t),
        gaps: gaps(t),
      }),
    )
    .sort(rank),
  blocked: blocked.map((t) => summary(t, { blockers: otherBlockers(t) })).sort(rank),
  laterCount: later.length,
  pendingGates: [...gates.values()].filter((g) => g.status !== 'APPROVED').map((g) => g.id),
  staleStateDocs: stale,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (t) =>
    `  ${t.critical ? '*' : ' '} ${t.id} [${t.priority ?? '-'}] ${t.title} (${t.status}, ${t.expectedHours ?? '?'}h, owner ${t.owner ?? '-'})`;
  const notes = (label, list) => (list?.length ? `      ${label}: ${list.join('; ')}\n` : '');
  const section = (title, list, render) =>
    `${title} (${list.length})\n${list.map(render).join('') || '  none\n'}\n`;
  let out = `BATON scan of ${file}\nStatus counts: ${JSON.stringify(report.counts)}\n* = critical path\n\n`;
  out += section('ACTIVE', report.active, (t) => `${line(t)}\n`);
  if (report.wipViolations.length)
    out += `WIP VIOLATION: ${report.wipViolations.map((v) => `${v.owner} → ${v.ids.join(', ')}`).join('; ')}\n\n`;
  const planned = (t) =>
    `${line(t)}\n${notes('plan gaps', t.gaps)}${notes('write overlap', t.overlaps)}`;
  out += section('READY', report.ready, planned);
  out += section(
    'PROMOTABLE (all blockers cleared; transition to READY)',
    report.promotable,
    planned,
  );
  out += section(
    'NEXT WAVE (plan now; waits only on active/eligible work)',
    report.nextWave,
    (t) =>
      `${line(t)}\n${notes('waiting on', t.waitingOn)}${notes('also needs', t.alsoNeeds)}${notes('plan gaps', t.gaps)}`,
  );
  out += section(
    'BLOCKED NOW (dependencies done; gate, external input or decomposition needed)',
    report.blocked,
    (t) => `${line(t)}\n${notes('blockers', t.blockers)}`,
  );
  out += `Later (dependencies not yet in reach): ${report.laterCount}\n`;
  out += `Pending gates: ${report.pendingGates.join(', ') || 'none'}\n`;
  if (stale.length)
    out += `STALE: ${stale.join(', ')} older than the latest TASKS.json transition\n`;
  process.stdout.write(out);
}
