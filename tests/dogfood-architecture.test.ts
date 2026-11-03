import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateArchitectureConfig } from '../src/arch/config.js';
import { loadBaseline } from '../src/arch/baseline.js';

// MapX checks its own architecture in CI (M5-18): .mapx/architecture.jsonc and its baseline are
// committed, while the rest of .mapx/ stays ignored (D030). The check itself runs in the CI job; these
// tests keep the pieces it needs in place.
const ROOT = join(new URL('..', import.meta.url).pathname);

describe("MapX's own architecture configuration", () => {
  it('is valid, with the layers of the research map (§3.9) plus Arch, and an Outside guard', () => {
    const { report, config } = validateArchitectureConfig(ROOT);
    expect(report.issues).toEqual([]);
    expect(config!.layers.map((l) => l.name)).toEqual([
      'Entry', 'UI', 'Agents', 'Arch', 'Exporters', 'Core', 'Frameworks', 'Parsers', 'Languages', 'Shared', 'Packages', 'Outside',
    ]);
    // M5-24: runtime npm packages are a layer every layer may use; a dev-only one is uncovered.
    expect(config!.layers.find((l) => l.name === 'Packages')!.selectors).toEqual([{ package: '*', dev: false }]);
    expect(config!.rules['*']).toContain('Packages');
    // Tests and scripts are in scope only as targets: an overlay every layer denies, so production code
    // may not import them, while their own imports (sources in no layer) are never judged.
    expect(config!.scope.include).toEqual(['src/**', 'tests/**', 'scripts/**']);
    const outside = config!.layers.find((l) => l.name === 'Outside')!;
    expect(outside.overlay).toBe(true);
    expect(outside.selectors).toEqual([{ path: '{tests,scripts}/**' }]);
    expect(config!.rules['*']).toContain('!Outside');
    // Imports only: calls and type references are resolved by name, and some resolve wrongly.
    expect(config!.scope.types).toEqual(['import', 'require']);
  });

  it('has a baseline that parses, holding the Languages → Parsers and Agents → Parsers findings', () => {
    const { config } = validateArchitectureConfig(ROOT);
    const baseline = loadBaseline(ROOT, config!)!;
    expect(baseline.file).toBe('.mapx/architecture.baseline.json');
    const pairs = baseline.entries.map((e) => `${e.source} → ${e.target} (${e.edgeType})`);
    expect(pairs).toContain('src/languages/installer.ts → src/parsers/assets.ts (import)');
    expect(pairs).toContain('src/agents/generator.ts → src/parsers/static-file-parser.ts (import)');
  });
});

const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
let inGit = true;
try {
  git('rev-parse', '--is-inside-work-tree');
} catch {
  inGit = false;
}

describe.skipIf(!inGit)('.gitignore keeps only the configuration and baseline of .mapx/', () => {
  it('ignores the index and every other file a scan writes, at the root and in nested workspaces', () => {
    const paths = [
      '.mapx/architecture.jsonc', '.mapx/architecture.baseline.json',
      '.mapx/mapx.db', '.mapx/config.json', '.mapx/tool-calls.jsonl', '.mapx/architecture/view.jsonc',
      'packages/app/.mapx/architecture.jsonc',
    ];
    // `-v --non-matching` prints every path with the pattern that decided it (empty when none did).
    const out = git('check-ignore', '--no-index', '-v', '--non-matching', ...paths);
    const ignored = new Map(out.trim().split('\n').map((line) => {
      const [where, path] = line.split('\t');
      const pattern = where.split(':').slice(2).join(':');
      return [path, pattern !== '' && !pattern.startsWith('!')] as const;
    }));
    expect(Object.fromEntries(ignored)).toEqual({
      '.mapx/architecture.jsonc': false,
      '.mapx/architecture.baseline.json': false,
      '.mapx/mapx.db': true,
      '.mapx/config.json': true,
      '.mapx/tool-calls.jsonl': true,
      '.mapx/architecture/view.jsonc': true,
      'packages/app/.mapx/architecture.jsonc': true,
    });
  });
});

describe('CI workflow', () => {
  it('has an Architecture job that indexes MapX and runs mapx check, keeping SARIF as an artifact', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const job = ci.match(/^ {2}architecture:\n((?: {4,}.*\n|\n)+)/m)?.[1] ?? '';
    expect(job).toMatch(/^ {4}name: Architecture$/m);
    expect(job).toMatch(/^ {4}needs: lint$/m);
    const steps = [
      'run: npm ci --legacy-peer-deps',
      'run: npm run build:npm',
      'node dist/main.js init . --no-agents --no-suggestions --no-mcp-configs',
      'node dist/main.js scan .',
      'run: node dist/main.js check --fail-on-uncovered --format github',
      'run: node dist/main.js check --fail-on-uncovered --report-skipped --format sarif -o mapx-architecture.sarif',
      'path: mapx-architecture.sarif',
    ].map((s) => job.indexOf(s));
    expect(steps.every((i) => i > -1)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // No code-scanning upload: fork pull requests never get `security-events: write`.
    const code = ci.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/security-events|upload-sarif/);
  });
});
