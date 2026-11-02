#!/usr/bin/env node
// BATON review scope and plan-integrity checks. Zero dependencies; never modifies the working
// tree, the real index or any branch. Snapshots use a temporary index plus a private ref.
//
//   node review-scope.mjs scope  [--commit REV | --range A..B | --full] [--plan PATH] [--json]
//   node review-scope.mjs record --report PATH [--from SCOPED_TARGET] [--full | --commit REV --advance] [--plan PATH]
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const REF = 'refs/baton-review/last';
const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'scope';
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(`--${name}`);

const git = (args, env) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    // No optional locks: plain status must not refresh or lock the real index.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'], // Probing missing refs is expected; keep git's stderr quiet.
  }).trim();
const tryGit = (args) => {
  try {
    return git(args);
  } catch {
    return null;
  }
};
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const root = tryGit(['rev-parse', '--show-toplevel']) ?? fail('Not inside a git repository');
process.chdir(root);
const planPath = resolve(option('plan') ?? 'docs/baton/TASKS.json');
const batonDir = dirname(planPath);
const reviewDir = join(batonDir, 'reviews');
const statePath = join(reviewDir, 'state.json');
const head = tryGit(['rev-parse', '--verify', 'HEAD']);

/** Commit-ish of the current state including uncommitted and untracked (non-ignored) files. */
function snapshot() {
  const dirty =
    git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']) !== '';
  if (!dirty && head) return { sha: head, dirty: false };
  const temp = mkdtempSync(join(tmpdir(), 'baton-review-'));
  const env = {
    GIT_INDEX_FILE: join(temp, 'index'),
    GIT_AUTHOR_NAME: 'baton-review',
    GIT_AUTHOR_EMAIL: 'baton-review@localhost',
    GIT_COMMITTER_NAME: 'baton-review',
    GIT_COMMITTER_EMAIL: 'baton-review@localhost',
  };
  try {
    if (head) git(['read-tree', head], env);
    git(['add', '-A'], env);
    const tree = git(['write-tree'], env);
    const parents = head ? ['-p', head] : [];
    const sha = git(
      ['commit-tree', tree, ...parents, '-m', 'baton-review working-tree snapshot'],
      env,
    );
    return { sha, dirty: true };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
const exists = (rev) => rev && tryGit(['cat-file', '-e', `${rev}^{object}`]) !== null;
const readState = () =>
  existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

/** Resolve base/target for the requested mode; explain any fallback. */
function resolveScope() {
  const notes = [];
  const commit = option('commit');
  const range = option('range');
  if (commit) {
    const target =
      tryGit(['rev-parse', '--verify', `${commit}^{commit}`]) ?? fail(`Unknown commit ${commit}`);
    const base = tryGit(['rev-parse', '--verify', `${target}^`]) ?? EMPTY_TREE;
    return { mode: 'commit', base, target, dirty: false, notes };
  }
  if (range) {
    const [a, b] = range.split('..');
    const base =
      tryGit(['rev-parse', '--verify', `${a}^{commit}`]) ?? fail(`Unknown range start ${a}`);
    const target =
      tryGit(['rev-parse', '--verify', `${b || 'HEAD'}^{commit}`]) ??
      fail(`Unknown range end ${b}`);
    return { mode: 'range', base, target, dirty: false, notes };
  }
  const snap = snapshot();
  if (flag('full'))
    return { mode: 'full', base: EMPTY_TREE, target: snap.sha, dirty: snap.dirty, notes };
  const state = readState();
  const candidates = [
    state?.lastReviewed?.snapshot,
    tryGit(['rev-parse', '--verify', REF]),
    state?.lastReviewed?.head,
  ];
  const base = candidates.find(exists);
  if (!state && !base) {
    notes.push('No review marker found: first review covers the whole repository.');
    return { mode: 'full', base: EMPTY_TREE, target: snap.sha, dirty: snap.dirty, notes };
  }
  if (base && base !== candidates[0])
    notes.push(`Recorded snapshot unavailable here; using ${base.slice(0, 12)} instead.`);
  if (!base) {
    notes.push('Recorded review commit is not in this clone: falling back to a full review.');
    return { mode: 'full', base: EMPTY_TREE, target: snap.sha, dirty: snap.dirty, notes };
  }
  return {
    mode: 'incremental',
    base,
    target: snap.sha,
    dirty: snap.dirty,
    notes,
    since: state?.lastReviewed,
  };
}

function changedFiles(base, target) {
  const out = git(['diff', '--name-status', '--find-renames', base, target]);
  return out
    ? out.split('\n').map((line) => {
        const [status, ...paths] = line.split('\t');
        return {
          status: status[0],
          path: paths.at(-1),
          from: paths.length > 1 ? paths[0] : undefined,
        };
      })
    : [];
}

function loadPlan() {
  if (!existsSync(planPath)) return null;
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  return { tasks: Array.isArray(plan) ? plan : (plan.tasks ?? []), gates: plan.gates ?? [] };
}

/** Which tasks claim a file: affected paths, artifacts, evidence, iteration spec or report. */
function owners(plan, path) {
  // A trailing `/**` (or `/*`) claims the folder; plain prefix matching handles the rest.
  const rel = (p) => relative(root, resolve(root, p.replace(/\/\*\*?$/, '')));
  const under = (file, prefix) => file === prefix || file.startsWith(prefix.replace(/\/?$/, '/'));
  const specDir = relative(root, batonDir);
  return plan.tasks
    .filter((t) => {
      const claimed = [
        ...(t.affectedFiles ?? []),
        ...(t.artifacts ?? []),
        ...(t.evidence ?? []).map((e) => e.artifact).filter(Boolean),
        join(specDir, 'iterations', `${t.id}.md`),
        join(specDir, 'reports', `${t.id}.md`),
      ].map(rel);
      return claimed.some((c) => under(path, c));
    })
    .map((t) => t.id);
}

function integrity(plan) {
  const findings = [];
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const gates = new Map(plan.gates.map((g) => [g.id, g]));
  const started = ['IN_PROGRESS', 'VERIFYING', 'REVIEW_REQUIRED', 'DONE'];
  const add = (severity, id, issue) => findings.push({ severity, id, issue });
  for (const t of plan.tasks) {
    const deps = (t.dependencies ?? []).map((d) => (typeof d === 'string' ? d : d.id));
    if (started.includes(t.status))
      for (const id of deps)
        if (byId.get(id)?.status !== 'DONE')
          add(
            'high',
            t.id,
            `${t.status} while dependency ${id} is ${byId.get(id)?.status ?? 'missing'}`,
          );
    if (
      started.includes(t.status) &&
      t.approvalGate &&
      gates.get(t.approvalGate)?.status !== 'APPROVED'
    )
      add('high', t.id, `${t.status} without approved gate ${t.approvalGate}`);
    if (started.includes(t.status) && t.kind === 'epic')
      add('medium', t.id, 'epic executed without decomposition');
    if (t.status !== 'DONE') continue;
    const evidence = t.evidence ?? [];
    if (!evidence.length) add('high', t.id, 'DONE without evidence');
    for (const e of evidence) {
      if (e.exitCode !== 0) add('high', t.id, `evidence "${e.command}" exit ${e.exitCode}`);
      if (e.artifact && !existsSync(resolve(root, e.artifact)))
        add('high', t.id, `evidence artifact missing: ${e.artifact}`);
    }
    for (const c of t.verificationCommands ?? [])
      if (!evidence.some((e) => e.command === c && e.exitCode === 0))
        add('high', t.id, `registered command never evidenced: ${c}`);
    const history = (t.history ?? []).map((h) => h.to);
    if (!history.length)
      add('info', t.id, 'DONE without transition history (status set outside the plan tool)');
    else if (!history.includes('VERIFYING')) add('medium', t.id, 'reached DONE without VERIFYING');
    const done = (t.history ?? []).find((h) => h.to === 'DONE');
    const report = join(batonDir, 'reports', `${t.id}.md`);
    if (done && existsSync(report) && statSync(report).mtimeMs > Date.parse(done.at) + 60_000)
      add(
        'info',
        t.id,
        'report edited after DONE; check for post-acceptance defects or changed claims',
      );
  }
  for (const g of plan.gates)
    if (
      g.status === 'APPROVED' &&
      (!g.approvedBy || !g.artifact || !existsSync(resolve(root, g.artifact)))
    )
      add('high', g.id, 'gate APPROVED without approver or approval artifact');
  const owners = new Map();
  for (const t of plan.tasks.filter((x) => ['IN_PROGRESS', 'VERIFYING'].includes(x.status)))
    owners.set(t.owner, [...(owners.get(t.owner) ?? []), t.id]);
  for (const [owner, ids] of owners)
    if (ids.length > 1) add('medium', owner, `WIP violation: ${ids.join(', ')}`);
  const last = plan.tasks
    .flatMap((t) => (t.history ?? []).map((h) => Date.parse(h.at)))
    .filter(Number.isFinite)
    .reduce((a, b) => Math.max(a, b), 0);
  for (const doc of ['PROJECT_STATE.md', 'HANDOFF.md']) {
    const path = join(batonDir, doc);
    if (existsSync(path) && last && statSync(path).mtimeMs + 1000 < last)
      add('medium', doc, 'older than the latest plan transition');
  }
  const handoff = join(batonDir, 'HANDOFF.md');
  if (existsSync(handoff)) {
    const next = readFileSync(handoff, 'utf8').match(/Next READY:\s*([A-Z0-9][\w-]*)/)?.[1];
    if (next && byId.get(next) && !['READY', 'BACKLOG', 'BLOCKED'].includes(byId.get(next).status))
      add('medium', 'HANDOFF.md', `names ${next} as next READY but it is ${byId.get(next).status}`);
  }
  return findings;
}

if (command === 'scope') {
  const scope = resolveScope();
  const files = changedFiles(scope.base, scope.target);
  const plan = loadPlan();
  const control = relative(root, batonDir);
  // Review bookkeeping (marker, past review reports) is never itself review scope.
  const reviews = `${relative(root, reviewDir)}/`;
  const mapped = files
    .filter((f) => !f.path.startsWith(reviews))
    .map((f) => ({ ...f, tasks: plan ? owners(plan, f.path) : [] }));
  const touched = [...new Set(mapped.flatMap((f) => f.tasks))];
  const doneTouched = plan
    ? plan.tasks.filter((t) => t.status === 'DONE' && touched.includes(t.id))
    : [];
  const report = {
    mode: scope.mode,
    base: scope.base,
    target: scope.target,
    head,
    workingTreeIncluded: scope.dirty,
    since: scope.since ?? null,
    notes: scope.notes,
    files: mapped,
    tasksTouched: touched,
    doneToReverify: (scope.mode === 'full' && plan
      ? plan.tasks.filter((t) => t.status === 'DONE')
      : doneTouched
    ).map((t) => ({
      id: t.id,
      title: t.title,
      verificationCommands: t.verificationCommands ?? [],
    })),
    unmappedFiles: mapped
      .filter((f) => !f.tasks.length && !f.path.startsWith(`${control}/`))
      .map((f) => `${f.status} ${f.path}`),
    integrity: plan ? integrity(plan) : [],
    plan: plan ? relative(root, planPath) : null,
  };
  if (flag('json')) console.log(JSON.stringify(report, null, 2));
  else {
    const short = (s) => (s === EMPTY_TREE ? 'empty tree' : s.slice(0, 12));
    let out = `Review scope: ${report.mode} ${short(report.base)}..${short(report.target)}`;
    out += report.workingTreeIncluded ? ' (includes uncommitted/untracked work)\n' : '\n';
    if (report.since)
      out += `Last reviewed: ${report.since.reviewedAt} (${report.since.mode}) report ${report.since.report}\n`;
    for (const n of report.notes) out += `NOTE: ${n}\n`;
    const shown =
      touched.length > 15
        ? `${touched.slice(0, 15).join(', ')}, … (+${touched.length - 15})`
        : touched.join(', ');
    out += `Changed files: ${mapped.length}; tasks touched (${touched.length}): ${shown || 'none'}\n`;
    out += `DONE items to re-verify (${report.doneToReverify.length}):\n`;
    for (const t of report.doneToReverify)
      out += `  ${t.id} ${t.title}\n      ${t.verificationCommands.join('; ') || 'no registered commands'}\n`;
    out += `Files no task accounts for (${report.unmappedFiles.length}):\n`;
    out += report.unmappedFiles.map((f) => `  ${f}\n`).join('') || '  none\n';
    out += `Plan integrity findings (${report.integrity.length}):\n`;
    out +=
      report.integrity.map((f) => `  [${f.severity}] ${f.id}: ${f.issue}\n`).join('') || '  none\n';
    process.stdout.write(out);
  }
} else if (command === 'record') {
  const reportFile =
    option('report') ?? fail('record needs --report PATH (write the review report first)');
  if (!existsSync(resolve(root, reportFile))) fail(`Report not found: ${reportFile}`);
  const scope = resolveScope();
  if (['commit', 'range'].includes(scope.mode) && !flag('advance'))
    fail('Explicit commit/range reviews do not move the marker; pass --advance to record anyway.');
  const from = option('from');
  if (!from)
    fail(
      'record needs --from SCOPED_TARGET (the target printed by scope) so later changes cannot be marked reviewed unseen',
    );
  {
    // Everything changed since the scoped target is being marked reviewed too; show it.
    const extra = changedFiles(from, scope.target);
    console.log(
      `Changed since scoped target ${from.slice(0, 12)} (${extra.length} files; must be this review's own edits):`,
    );
    for (const f of extra) console.log(`  ${f.status} ${f.path}`);
  }
  const previous = readState();
  const entry = {
    snapshot: scope.target,
    head,
    workingTreeIncluded: scope.dirty,
    mode: scope.mode,
    base: scope.base,
    reviewedAt: new Date().toISOString(),
    report: relative(root, resolve(root, reportFile)),
  };
  mkdirSync(reviewDir, { recursive: true });
  const history = [
    ...(previous?.history ?? []),
    ...(previous?.lastReviewed ? [previous.lastReviewed] : []),
  ].slice(-50);
  writeFileSync(
    statePath,
    JSON.stringify({ schemaVersion: 1, lastReviewed: entry, history }, null, 2) + '\n',
  );
  git(['update-ref', '-m', `baton-review ${entry.reviewedAt}`, REF, scope.target]);
  console.log(
    `Recorded review of ${scope.target.slice(0, 12)} (${scope.mode}) in ${relative(root, statePath)} and ${REF}`,
  );
} else fail(`Unknown command ${command}; use scope or record`);
