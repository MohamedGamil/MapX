// M7-05: the GitHub Pages workflow and the CI job that builds the site. GitHub Actions cannot run here,
// so the workflows are checked statically against what the repository really has: the permissions are
// the least that deploying needs, every command is one the repository supports, both lockfiles satisfy
// their package.json (`npm ci --dry-run`), and the uploaded folder is the one the build writes.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { buildSiteDefaultOutput } from './helpers/site-build';

const ROOT = resolve(__dirname, '..');
const load = (file: string) => parse(readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8')) as Workflow;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  name?: string;
  'runs-on'?: string;
  needs?: string | string[];
  if?: string;
  environment?: string | { name: string; url?: string };
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}

const pages = load('pages.yml');
const ci = load('ci.yml');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const asList = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const commands = (job: Job) => job.steps.flatMap((s) => (s.run ? s.run.split('\n').map((l) => l.trim()).filter(Boolean) : []));
/** A pinned official action: `actions/<name>@v<major>`. */
const OFFICIAL = /^actions\/[a-z][a-z-]*@v\d+$/;

describe('pages.yml (M7-05)', () => {
  it('runs on pushes to main and on manual dispatch, and on nothing else', () => {
    expect(Object.keys(pages.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect((pages.on.push as { branches: string[] }).branches).toEqual(['main']);
    expect((pages.on.push as { paths?: unknown }).paths).toBeUndefined();
  });

  it('gives the build job read access only, and the Pages and OIDC permissions to the deploy job alone', () => {
    // The build job runs `npm ci` scripts and the repository's code: it must not be able to deploy.
    expect(pages.permissions).toEqual({ contents: 'read' });
    expect(pages.jobs.build!.permissions).toBeUndefined();
    expect(pages.jobs.deploy!.permissions).toEqual({ pages: 'write', 'id-token': 'write' });
  });

  it('deploys only from main, even when a manual run starts on another branch', () => {
    expect(pages.jobs.deploy!.if).toBe("github.ref == 'refs/heads/main'");
    expect(pages.jobs.build!.if).toBeUndefined();
  });

  it('deploys in the github-pages environment after the build, and never cancels a deploy in progress', () => {
    const { build, deploy } = pages.jobs;
    expect(Object.keys(pages.jobs).sort()).toEqual(['build', 'deploy']);
    expect(asList(deploy!.needs)).toEqual(['build']);
    const env = deploy!.environment;
    expect(typeof env === 'string' ? env : env?.name).toBe('github-pages');
    expect(pages.concurrency).toEqual({ group: 'pages', 'cancel-in-progress': false });
    expect(build!.environment).toBeUndefined();
  });

  it('builds with commands the repository supports', () => {
    const cmds = commands(pages.jobs.build!);
    expect(cmds).toEqual(['npm ci --legacy-peer-deps', 'npm ci --prefix site', 'npm run site:build']);
    for (const c of cmds) {
      const script = /^npm run (\S+)/.exec(c)?.[1];
      if (script) expect(pkg.scripts[script], `npm run ${script}`).toBeDefined();
    }
  });

  it('uses only pinned official actions', () => {
    const uses = Object.values(pages.jobs).flatMap((j) => j.steps.map((s) => s.uses).filter((u): u is string => !!u));
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const u of uses) expect(u, u).toMatch(OFFICIAL);
    expect(uses).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^actions\/checkout@/),
        expect.stringMatching(/^actions\/setup-node@/),
        expect.stringMatching(/^actions\/upload-pages-artifact@/),
        expect.stringMatching(/^actions\/deploy-pages@/),
      ]),
    );
  });

  it('uploads the folder the site build writes, with the Node version CI uses', () => {
    const upload = pages.jobs.build!.steps.find((s) => s.uses?.startsWith('actions/upload-pages-artifact'));
    expect(upload?.with?.path).toBe('site/.vitepress/dist');
    const node = (j: Job) => String(j.steps.find((s) => s.uses?.startsWith('actions/setup-node'))?.with?.['node-version']);
    expect(node(pages.jobs.build!)).toBe(node(ci.jobs.lint!));
    expect(pages.jobs.build!.steps.some((s) => s.env && 'SITE_BASE' in s.env)).toBe(false);
  });

  // Builds as the workflow does (no SITE_OUT), so the uploaded path is proved, not assumed. Skipped
  // without site/node_modules, as the other build tests; CI's Site job installs it.
  (existsSync(join(ROOT, 'site', 'node_modules', 'vitepress')) || process.env.REQUIRE_SITE === '1' ? it : it.skip)(
    'finds the built site where the upload step looks',
    () => {
      const dist = buildSiteDefaultOutput();
      const upload = pages.jobs.build!.steps.find((s) => s.uses?.startsWith('actions/upload-pages-artifact'));
      expect(resolve(ROOT, String(upload?.with?.path))).toBe(dist);
      for (const f of ['index.html', '404.html', 'docs/index.html']) expect(existsSync(join(dist, f)), f).toBe(true);
    },
    240_000,
  );
});

describe('the Site job of ci.yml (M7-05)', () => {
  const site = ci.jobs.site;

  it('exists, runs on every CI run and after the type check', () => {
    expect(site).toBeDefined();
    expect(site!['runs-on']).toBe('ubuntu-latest');
    expect(asList(site!.needs)).toEqual(['lint']);
    // The landing page reads src/ and README.md, so a path filter would miss real breakage.
    expect((ci.on.push as { paths?: unknown }).paths).toBeUndefined();
    expect((ci.on.pull_request as { paths?: unknown }).paths).toBeUndefined();
  });

  it('installs both package trees and Chromium before it tests', () => {
    const cmds = commands(site!);
    const at = (c: string) => cmds.findIndex((x) => x.startsWith(c));
    expect(at('npm ci --legacy-peer-deps')).toBeGreaterThan(-1);
    expect(at('npm ci --prefix site')).toBeGreaterThan(-1);
    expect(at('npx playwright install')).toBeGreaterThan(-1);
    const firstTest = Math.min(...['npx vitest', 'npx playwright test'].map(at).filter((i) => i >= 0));
    expect(Math.max(at('npm ci --legacy-peer-deps'), at('npm ci --prefix site'), at('npx playwright install'))).toBeLessThan(firstTest);
  });

  it('runs the site suites with REQUIRE_SITE=1 and the site browser tests', () => {
    const vitest = site!.steps.find((s) => s.run?.includes('npx vitest run') && s.run.includes('tests/site-'));
    expect(vitest, 'a step running tests/site-*').toBeDefined();
    expect(vitest!.env?.REQUIRE_SITE).toBe('1');
    expect(site!.steps.some((s) => s.run?.includes('npx playwright test -c playwright.site.config.ts'))).toBe(true);
    const upload = site!.steps.find((s) => s.uses?.startsWith('actions/upload-artifact'));
    expect(upload?.if).toMatch(/failure\(\)/);
    expect(upload?.with?.path).toBe('test-results/site/');
  });

  it('uses only pinned official actions', () => {
    for (const s of site!.steps) if (s.uses) expect(s.uses, s.uses).toMatch(OFFICIAL);
  });

  it('names a vitest filter that matches exactly the site test files', () => {
    const vitest = site!.steps.find((s) => s.run?.includes('npx vitest run'))!;
    const filter = /tests\/site-\S*/.exec(vitest.run!)![0]!;
    // Vitest filters by substring of the file path: list the test files the filter would select.
    const walk = (dir: string): string[] =>
      readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    const selected = walk('tests').filter((f) => f.endsWith('.test.ts') && f.includes(filter)).sort();
    expect(selected).toEqual(['tests/site-build.test.ts', 'tests/site-docs.test.ts', 'tests/site-landing.test.ts', 'tests/site-workflow.test.ts']);
  });
});

describe('the lockfiles the workflows install from (M7-05)', () => {
  const dryRun = (args: string[], cwd = ROOT) => spawnSync('npm', ['ci', '--dry-run', '--offline', ...args], { cwd, encoding: 'utf8' });

  it('satisfy their package.json: npm ci would succeed at the root and in site/', () => {
    expect(dryRun(['--legacy-peer-deps', '--ignore-scripts']).status).toBe(0);
    expect(dryRun(['--prefix', 'site']).status).toBe(0);
  });

  // Offline, a drifted manifest fails either because npm rejects the lockfile or because it cannot fetch
  // what is new; both stop an `npm ci`, and either way the dry run does not pass for a drifted pair.
  it('does not pass for a manifest that no longer matches its lockfile', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mapx-lock-'));
    try {
      cpSync(join(ROOT, 'site', 'package-lock.json'), join(tmp, 'package-lock.json'));
      const manifest = JSON.parse(readFileSync(join(ROOT, 'site', 'package.json'), 'utf8'));
      manifest.dependencies['left-pad'] = '1.3.0';
      writeFileSync(join(tmp, 'package.json'), JSON.stringify(manifest));
      expect(dryRun(['--prefix', tmp]).status).not.toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
