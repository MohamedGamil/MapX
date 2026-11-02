import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.resolve('./review-scope.mjs'));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const task = (id, status, patch = {}) => ({
  id,
  title: id,
  status,
  dependencies: [],
  affectedFiles: [`src/${id}`],
  verificationCommands: ['node --test'],
  evidence: [],
  history: [],
  ...patch,
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'baton-review-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  const write = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const run = (...args) => {
    const r = spawnSync('node', [script, ...args], { cwd: dir, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const scope = (...args) => JSON.parse(run('scope', '--json', ...args).out);
  git('init', '-q');
  write('.gitignore', 'ignored/\n');
  write('docs/baton/reports/A.md', 'evidence\n');
  write('src/A/a.ts', 'export const a = 1;\n');
  write(
    'docs/baton/TASKS.json',
    JSON.stringify({
      gates: [{ id: 'G1', status: 'PENDING' }],
      tasks: [
        task('A', 'DONE', {
          evidence: [{ command: 'node --test', exitCode: 0, artifact: 'docs/baton/reports/A.md' }],
          history: [
            { to: 'VERIFYING', at: '2026-01-01T00:00:00Z' },
            { to: 'DONE', at: '2026-01-01T00:00:00Z' },
          ],
        }),
        task('B', 'IN_PROGRESS', { dependencies: [{ id: 'C', type: 'hard' }], approvalGate: 'G1' }),
        task('C', 'BACKLOG'),
        task('D', 'DONE', {
          evidence: [{ command: 'other', exitCode: 1, artifact: 'missing.md' }],
        }),
      ],
    }),
  );
  git('add', '-A');
  git('commit', '-qm', 'one');
  return { dir, git, write, run, scope };
}

test('first run is a full review; record moves the marker; next run is incremental incl. untracked', () => {
  const r = repo();
  const first = r.scope();
  assert.equal(first.mode, 'full');
  assert.match(first.notes[0], /No review marker/);
  r.write('docs/baton/reviews/R1.md', 'review\n');
  assert.equal(
    r.run('record', '--report', 'docs/baton/reviews/R1.md').code,
    2,
    'record requires --from',
  );
  const recorded = r.run('record', '--report', 'docs/baton/reviews/R1.md', '--from', first.target);
  assert.equal(recorded.code, 0);
  assert.match(
    recorded.out,
    /docs\/baton\/reviews\/R1\.md/,
    'drift list shows files changed since scoping',
  );
  const state = JSON.parse(readFileSync(join(r.dir, 'docs/baton/reviews/state.json'), 'utf8'));
  assert.equal(r.git('rev-parse', 'refs/baton-review/last'), state.lastReviewed.snapshot);

  r.write('src/A/a.ts', 'export const a = 2;\n');
  r.write('src/new/untracked.ts', 'x\n');
  r.write('ignored/secret.txt', 'never\n');
  r.git('add', 'src/A/a.ts');
  // Stale stat data (same content, new mtime) is what makes a plain `git status` rewrite the index.
  const later = new Date(Date.now() + 5000);
  utimesSync(join(r.dir, '.gitignore'), later, later);
  const indexBefore = readFileSync(join(r.dir, '.git/index'));
  const next = r.scope();
  assert.equal(next.mode, 'incremental');
  assert.equal(next.workingTreeIncluded, true);
  assert.deepEqual(next.files.map((f) => f.path).sort(), ['src/A/a.ts', 'src/new/untracked.ts']);
  assert.deepEqual(next.tasksTouched, ['A']);
  assert.deepEqual(
    next.doneToReverify.map((t) => t.id),
    ['A'],
  );
  assert.deepEqual(next.unmappedFiles, ['A src/new/untracked.ts']);
  assert.ok(
    readFileSync(join(r.dir, '.git/index')).equals(indexBefore),
    'real index bytes untouched',
  );
  assert.equal(r.git('status', '--porcelain', '--', 'ignored'), '');
});

test('explicit commit and range modes; they do not move the marker unless --advance', () => {
  const r = repo();
  r.write('src/C/c.ts', 'c\n');
  r.git('add', '-A');
  r.git('commit', '-qm', 'two');
  const commit = r.scope('--commit', 'HEAD');
  assert.equal(commit.mode, 'commit');
  assert.deepEqual(
    commit.files.map((f) => f.path),
    ['src/C/c.ts'],
  );
  assert.deepEqual(
    r.scope('--range', 'HEAD~1..HEAD').files.map((f) => f.path),
    ['src/C/c.ts'],
  );
  r.write('docs/baton/reviews/R.md', 'r\n');
  const refused = r.run(
    'record',
    '--report',
    'docs/baton/reviews/R.md',
    '--commit',
    'HEAD',
    '--from',
    commit.target,
  );
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--advance/);
  assert.equal(
    r.run(
      'record',
      '--report',
      'docs/baton/reviews/R.md',
      '--commit',
      'HEAD',
      '--advance',
      '--from',
      commit.target,
    ).code,
    0,
  );
  assert.equal(r.scope().base, r.git('rev-parse', 'HEAD'));
  assert.equal(r.run('record', '--report', 'missing.md', '--from', commit.target).code, 2);
});

test('integrity checks flag dependency, gate and evidence violations', () => {
  const r = repo();
  const issues = r
    .scope('--full')
    .integrity.filter((f) => f.severity !== 'info')
    .map((f) => `${f.id}: ${f.issue}`);
  assert.ok(issues.includes('B: IN_PROGRESS while dependency C is BACKLOG'));
  assert.ok(issues.includes('B: IN_PROGRESS without approved gate G1'));
  assert.ok(issues.includes('D: evidence "other" exit 1'));
  assert.ok(issues.includes('D: evidence artifact missing: missing.md'));
  assert.ok(issues.includes('D: registered command never evidenced: node --test'));
  assert.ok(issues.includes('D: DONE without evidence') === false);
  assert.ok(!issues.some((i) => i.startsWith('A:')), 'well-evidenced task is clean');
});

test('a trailing /** in affectedFiles claims every file under that folder', () => {
  const r = repo();
  const plan = JSON.parse(readFileSync(join(r.dir, 'docs/baton/TASKS.json'), 'utf8'));
  plan.tasks.find((t) => t.id === 'C').affectedFiles = ['src/glob/**'];
  r.write('docs/baton/TASKS.json', JSON.stringify(plan));
  r.git('add', '-A');
  r.git('commit', '-qm', 'glob claim');
  r.write('src/glob/deep/x.ts', 'x\n');
  r.write('src/globby.ts', 'y\n');
  r.git('add', '-A');
  r.git('commit', '-qm', 'files');
  const s = r.scope('--commit', 'HEAD');
  assert.deepEqual(
    s.files.find((f) => f.path === 'src/glob/deep/x.ts')?.tasks,
    ['C'],
  );
  assert.deepEqual(s.unmappedFiles, ['A src/globby.ts']);
});
