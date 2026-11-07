import { describe, it, expect, afterAll } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, init, mapx, mapxResult, mapxResultEnv, useBuiltCli, workspace } from './helpers/e2e';
import type { ArchReport, Finding } from '../src/arch/report';

// M5-98-R1 (REQ-ARCH-021): `mapx check --since <git-ref>` judges only the dependencies written in
// files changed since the ref, end to end: temp git repos, the real CLI, the JSON report.
//
// Synthetic TypeScript app, labelled. domain may use nothing; app may use domain; infra may use domain.
//   src/domain/Old.ts    → src/infra/Repo.ts     violation, committed before the ref ("base")
//   src/domain/Fresh.ts  → src/infra/Other.ts    violation, added after the ref (each test adds it)
//   src/app/Run.ts       → src/domain/Old.ts     allowed
const APP: Record<string, string> = {
  'package.json': '{"name":"since-app","version":"1.0.0"}\n',
  'src/domain/Old.ts': "import { Repo } from '../infra/Repo';\nexport class Old { repo = new Repo(); }\n",
  'src/infra/Repo.ts': 'export class Repo {}\n',
  'src/infra/Other.ts': 'export class Other {}\n',
  'src/app/Run.ts': "import { Old } from '../domain/Old';\nexport const run = () => new Old();\n",
  '.mapx/architecture.jsonc': JSON.stringify({
    layers: [
      { name: 'App', selectors: [{ path: 'src/app/**' }] },
      { name: 'Domain', selectors: [{ path: 'src/domain/**' }] },
      { name: 'Infra', selectors: [{ path: 'src/infra/**' }] },
    ],
    rules: { App: ['Domain'], Domain: [], Infra: ['Domain'] },
  }),
};
const FRESH = "import { Other } from '../infra/Other';\nexport class Fresh { other = new Other(); }\n";
const OLD = 'src/domain/Old.ts';
const NEW = 'src/domain/Fresh.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
const temps: string[] = [];
const outside = mkdtempSync(join(tmpdir(), 'mapx-arch-since-out-'));
temps.push(outside);

/** A git repo of APP committed and tagged `base`, indexed. */
function repo(): string {
  const root = workspace(APP);
  temps.push(root);
  git(root, 'init', '-q');
  writeFileSync(join(root, '.gitignore'), '.mapx/mapx.db*\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'tag', 'base');
  init(root);
  mapx(root, 'scan');
  return root;
}
/** The source files of the violations `mapx_arch_check` returns for `since`, through a real MCP client. */
async function mcpViolationSources(root: string, since: string): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  try {
    const r = await client.callTool({ name: 'mapx_arch_check', arguments: { dir: root, since } }) as { content: Array<{ text: string }> };
    const body = JSON.parse(r.content[0]!.text) as ArchReport;
    return [...new Set(body.findings.filter((f) => f.kind === 'violation').map((f) => f.source!.file))];
  } finally {
    await client.close();
  }
}
/** Adds the second violation and brings the index up to date. */
function addFresh(root: string, commit: boolean) {
  writeFileSync(join(root, NEW), FRESH);
  if (commit) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'fresh'); }
  mapx(root, 'scan');
}

/** `mapx check --format json`: its exit code, report and the violations' source files. */
function check(root: string, ...args: string[]): { status: number | null; report: ArchReport; sources: string[]; stdout: string; stderr: string } {
  const r = mapxResult(root, 'check', '--format', 'json', ...args);
  const report = JSON.parse(r.stdout) as ArchReport;
  const sources = [...new Set(report.findings.filter((f: Finding) => f.kind === 'violation').map((f) => f.source!.file))].sort();
  return { status: r.status, report, sources, stdout: r.stdout, stderr: r.stderr };
}

afterAll(() => { for (const t of temps) cleanup(t); });
useBuiltCli();

describe('check --since: a ratchet over the files changed since a git ref', () => {
  it('reports only the violation added after the ref and exits 1; with none added it exits 0', () => {
    const root = repo();
    // Each source has two violations (the import and the instantiation); sources are listed once. Old is a violation from the start of the history: the whole check fails, the ratchet does not.
    expect(check(root)).toMatchObject({ status: 1, sources: [OLD] });
    const clean = check(root, '--since', 'base');
    expect({ status: clean.status, sources: clean.sources, violations: clean.report.counts.violation }).toEqual({ status: 0, sources: [], violations: 0 });
    expect(clean.report.selection).toMatchObject({ since: 'base' });

    addFresh(root, true);
    expect(check(root)).toMatchObject({ status: 1, sources: [NEW, OLD] });
    const ratchet = check(root, '--since', 'base');
    expect({ status: ratchet.status, sources: ratchet.sources, targets: ratchet.report.findings.map((f) => f.target!.file) }).toEqual({ status: 1, sources: [NEW], targets: ['src/infra/Other.ts', 'src/infra/Other.ts'] });
    // The ref can be any revision: HEAD sees a clean tree.
    expect(check(root, '--since', 'HEAD')).toMatchObject({ status: 0, sources: [] });
    expect(check(root, '--since', 'HEAD~1')).toMatchObject({ status: 1, sources: [NEW] });
  }, 120_000);

  it('counts an untracked file, a staged file and an unstaged edit as changed', () => {
    const root = repo();
    addFresh(root, false); // untracked
    expect(check(root, '--since', 'HEAD')).toMatchObject({ status: 1, sources: [NEW] });
    git(root, 'add', '-A');
    expect(check(root, '--since', 'HEAD')).toMatchObject({ status: 1, sources: [NEW] }); // staged
    git(root, 'commit', '-q', '-m', 'fresh');
    appendFileSync(join(root, OLD), '// edited, unstaged\n');
    mapx(root, 'scan');
    expect(check(root, '--since', 'HEAD')).toMatchObject({ status: 1, sources: [OLD] }); // the edited source is judged again
  }, 120_000);

  it('a dependency whose only target changed is not new (the decision: the source file decides)', () => {
    const root = repo();
    appendFileSync(join(root, 'src/infra/Repo.ts'), '// the target changed, the dependency did not\n');
    mapx(root, 'scan');
    expect(check(root, '--since', 'base')).toMatchObject({ status: 0, sources: [] });
  }, 120_000);

  it('a renamed source file is changed under its new path', () => {
    const root = repo();
    mkdirSync(join(root, 'src/domain/moved'), { recursive: true });
    git(root, 'mv', OLD, 'src/domain/moved/Old.ts');
    writeFileSync(join(root, 'src/domain/moved/Old.ts'), "import { Repo } from '../../infra/Repo';\nexport class Old { repo = new Repo(); }\n");
    mapx(root, 'scan');
    expect(check(root, '--since', 'base')).toMatchObject({ status: 1, sources: ['src/domain/moved/Old.ts'] });
  }, 120_000);

  it('composes with --baseline and --compare, and a baseline error still wins', () => {
    const root = repo();
    const baseline = join(outside, 'since-baseline.json');
    const baseReport = join(outside, 'since-base-report.json');
    expect(mapxResult(root, 'check', '--generate-baseline', baseline).status).toBe(0);
    writeFileSync(baseReport, mapxResult(root, 'check', '--format', 'json').stdout);
    addFresh(root, true);
    // The baseline skips Old; the new one is not in it. --since agrees.
    expect(check(root, '--since', 'base', '--baseline', baseline)).toMatchObject({ status: 1, sources: [NEW] });
    expect(check(root, '--baseline', baseline)).toMatchObject({ status: 1, sources: [NEW] });
    // The skipped violation is in an unchanged file: --report-skipped under --since does not list it.
    expect(check(root, '--since', 'base', '--baseline', baseline, '--report-skipped').report.findings.filter((f) => f.kind === 'skipped')).toEqual([]);
    expect(check(root, '--baseline', baseline, '--report-skipped').report.counts.skipped).toBe(2); // Old's import and instantiation
    // --compare: the base report knows Old only.
    expect(check(root, '--since', 'base', '--compare', baseReport)).toMatchObject({ status: 1, sources: [NEW] });
    // The base report knows everything now: nothing new, exit 0.
    writeFileSync(baseReport, mapxResult(root, 'check', '--format', 'json').stdout);
    expect(check(root, '--since', 'base', '--compare', baseReport)).toMatchObject({ status: 0 });
    // A base report that was itself made with --since lacks findings: refused (exit 3).
    const narrowed = join(outside, 'since-narrowed.json');
    writeFileSync(narrowed, mapxResult(root, 'check', '--format', 'json', '--since', 'base').stdout);
    const refused = mapxResult(root, 'check', '--format', 'json', '--compare', narrowed);
    expect(refused.status).toBe(3);
    expect(refused.stdout).toContain('narrowed by --since');
    // A stale baseline entry is a baseline error whatever --since keeps: exit 3.
    git(root, 'rm', '-q', '-f', OLD);
    git(root, 'commit', '-q', '-m', 'drop old');
    mapx(root, 'scan');
    expect(check(root, '--since', 'HEAD', '--baseline', baseline).status).toBe(3);
  }, 180_000);

  it('every format shows the new violation only', () => {
    const root = repo();
    addFresh(root, true);
    for (const format of ['table', 'json', 'sarif', 'github', 'codeclimate', 'junit']) {
      const r = mapxResult(root, 'check', '--format', format, '--since', 'base');
      expect(r.status, format).toBe(1);
      expect(r.stdout, format).toContain('Fresh.ts');
      expect(r.stdout, format).not.toContain('Old.ts');
    }
    const none = mapxResult(root, 'check', '--format', 'junit', '--since', 'HEAD');
    expect(none.status).toBe(0);
    expect(none.stdout).not.toContain('<failure');
  }, 120_000);

  it('a ref is never a shell command or an option; an unknown ref and a non-repository are exit 3', () => {
    const root = repo();
    for (const ref of ['HEAD^{/.|$(touch PWNED)}', 'HEAD^{/.|`touch PWNED`}', '--output=PWNED', 'HEAD; touch PWNED', '-n']) {
      const r = mapxResult(root, 'check', `--since=${ref}`);
      expect([ref, r.status]).toEqual([ref, 3]);
    }
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'PWNED'))).toBe(false);
    const unknown = mapxResult(root, 'check', '--since', 'no-such-ref');
    expect(unknown.status).toBe(3);
    expect(unknown.stderr).toContain('no-such-ref');
    // --generate-baseline writes every violation: it takes no --since.
    expect(mapxResult(root, 'check', '--since', 'base', '--generate-baseline', join(outside, 'x.json')).status).toBe(3);
    const plain = workspace(APP);
    temps.push(plain);
    init(plain);
    mapx(plain, 'scan');
    const bare = mapxResult(plain, 'check', '--since', 'HEAD');
    expect(bare.status).toBe(3);
    expect(bare.stderr).toContain('git repository');
  }, 120_000);

  // Review of M5-98-R1 (P1): `git diff <ref>` is two-dot, so a ref that moved on after the branch left
  // it (main edits Old.ts) made the branch's untouched Old.ts "changed". The base is the merge base.
  it('a ref that moved on since the branch left it does not make the old files changed', async () => {
    const root = repo();
    git(root, 'branch', '-M', 'main');
    appendFileSync(join(root, OLD), '// main edits Old.ts after the branch point\n');
    git(root, 'commit', '-q', '-am', 'main touches Old');
    git(root, 'checkout', '-q', '-b', 'feature', 'base');
    writeFileSync(join(root, 'src/domain/K.ts'), 'export class K {}\n'); // the branch adds a clean file only
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'feature adds K');
    mapx(root, 'scan');
    expect(check(root, '--since', 'main')).toMatchObject({ status: 0, sources: [] });
    const mergeBase = execFileSync('git', ['merge-base', 'main', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    expect(check(root, '--since', mergeBase)).toMatchObject({ status: 0, sources: [] });
    // The feature then adds a violation: the ratchet reports it only, with the branch name or the merge base alike.
    addFresh(root, false);
    expect(check(root, '--since', 'main')).toMatchObject({ status: 1, sources: [NEW] });
    expect(check(root, '--since', mergeBase)).toMatchObject({ status: 1, sources: [NEW] });
    // mapx_arch_check takes the same base.
    expect(await mcpViolationSources(root, 'main')).toEqual([NEW]);
  }, 120_000);

  it('with no merge base (unrelated histories) the ref itself is the base', () => {
    const root = repo();
    git(root, 'branch', '-M', 'main');
    git(root, 'checkout', '-q', '--orphan', 'other');
    writeFileSync(join(root, NEW), FRESH);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'unrelated root with Fresh');
    mapx(root, 'scan');
    // Old.ts is the same content as on main; Fresh.ts differs from it.
    expect(check(root, '--since', 'main')).toMatchObject({ status: 1, sources: [NEW] });
  }, 120_000);

  // Review of M5-98-R1 (P2): `${ref}^{commit}` made `:/text` refs unknown.
  it('accepts a :/text ref and an abbreviated id', () => {
    const root = repo();
    addFresh(root, true);
    expect(check(root, '--since=:/base')).toMatchObject({ status: 1, sources: [NEW] });
    const short = execFileSync('git', ['rev-parse', '--short', 'base'], { cwd: root, encoding: 'utf8' }).trim();
    expect(check(root, '--since', short)).toMatchObject({ status: 1, sources: [NEW] });
    expect(check(root, '--since=:/no-commit-says-this').status).toBe(3);
  }, 120_000);

  // Review of M5-98-R1 (P2): a failed `git diff` read as "no changes".
  it.skipIf(process.platform === 'win32')('a git failure after the ref resolved is exit 3 with the git error, never an empty change list', () => {
    const root = repo();
    addFresh(root, true);
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = mkdtempSync(join(tmpdir(), 'mapx-arch-since-bin-'));
    temps.push(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = diff ]; then echo "fatal: simulated diff failure" >&2; exit 128; fi; done\nexec ${real} "$@"\n`, { mode: 0o755 });
    const r = mapxResultEnv(root, { PATH: `${bin}:${process.env.PATH}` }, 'check', '--format', 'json', '--since', 'base');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('simulated diff failure');
    const report = JSON.parse(r.stdout) as ArchReport;
    expect(report.findings.some((f) => f.kind === 'error')).toBe(true);
    expect(report.counts.violation).toBe(0);
  }, 120_000);

  it('mapx_arch_check agrees: the same source-file semantics, the same selection', async () => {
    const root = repo();
    addFresh(root, true);
    appendFileSync(join(root, 'src/infra/Repo.ts'), '// target only\n');
    mapx(root, 'scan');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      const r = await client.callTool({ name: 'mapx_arch_check', arguments: { dir: root, since: 'base' } }) as { content: Array<{ text: string }> };
      const body = JSON.parse(r.content[0]!.text) as ArchReport & { exitCode: number };
      expect([...new Set(body.findings.filter((f) => f.kind === 'violation').map((f) => f.source!.file))]).toEqual([NEW]);
      expect(body.exitCode).toBe(1);
      expect(body.selection).toMatchObject({ since: 'base' });
      const cli = check(root, '--since', 'base');
      expect(body.findings.map((f) => f.fingerprint)).toEqual(cli.report.findings.map((f) => f.fingerprint));
    } finally {
      await client.close();
    }
  }, 120_000);
});
