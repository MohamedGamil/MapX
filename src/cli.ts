import { Command } from 'commander';
import { resolve, join, dirname, relative, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import { Store } from './core/store.js';
import { MapxGraph } from './core/graph.js';
import { Scanner, buildMatcher } from './core/scanner.js';
import { Config } from './core/config.js';
import { FlowTracer, TraceNode } from './core/flow-tracer.js';
import { ContextBuilder } from './core/context-builder.js';
import { AgentGenerator } from './agents/generator.js';
import { WorkspaceManager } from './core/workspace-manager.js';
import { LLMExporter } from './exporters/llm-exporter.js';
import { GraphExporter } from './exporters/graph-exporter.js';
import { DotExporter } from './exporters/dot-exporter.js';
import { SvgExporter } from './exporters/svg-exporter.js';
import { ToonExporter } from './exporters/toon-exporter.js';
import { calculateMetrics } from './core/metrics.js';
import { getChangedFiles, isGitRepo } from './core/git-tracker.js';
import { ImpactAnalyzer, checkTryCatch as coreCheckTryCatch } from './core/impact-analyzer.js';
import { getBuiltinLanguages } from './languages/registry.js';
import { isLanguageInstalled, installLanguage, uninstallLanguage } from './languages/installer.js';
import type { ScanProgress, ProgressCallback } from './types.js';
import { RouteRegistry } from './frameworks/route-registry.js';
import { VERSION } from './version.js';
import { findSimilarSymbols } from './core/fuzzy-matcher.js';
import * as clack from '@clack/prompts';

const dynamicRequire = createRequire(import.meta.url);

function collectPatterns(val: string, memo: string[]): string[] {
  return memo.concat(val.split(',').map(s => s.trim()));
}

function resolveDir(cmdOpts: Record<string, unknown>, programOpts: Record<string, unknown>): string {
  const raw = (cmdOpts.dir as string) || (programOpts.dir as string) || process.cwd();
  return resolve(raw);
}

const PHASE_LABELS: Record<ScanProgress['phase'], { active: string; done: string }> = {
  discover: { active: 'Discovering files', done: 'Discovered files' },
  index: { active: 'Indexing files', done: 'Indexed files' },
  parse: { active: 'Parsing files', done: 'Parsed files' },
  resolve: { active: 'Resolving references', done: 'Resolved references' },
  detect: { active: 'Detecting changes', done: 'Detected changes' },
  cluster: { active: 'Detecting clusters', done: 'Detected clusters' },
};

interface ProgressRendererCallback {
  (progress: ScanProgress): void;
  stop: (title?: string) => void;
}

function truncatePath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;
  if (maxLength <= 3) return '...';
  return '...' + path.slice(path.length - maxLength + 3);
}

function createProgressRenderer(): ProgressRendererCallback {
  let lastPhase: ScanProgress['phase'] | null = null;
  let p: any = null;
  let s: any = null;
  let lastCurrent = 0;

  const callback = (progressData: ScanProgress) => {
    const { phase, current, total, file } = progressData;
    const label = PHASE_LABELS[phase];
    if (!label) return;
    const isNewPhase = phase !== lastPhase;

    if (isNewPhase) {
      if (s) {
        const prevLabel = lastPhase ? PHASE_LABELS[lastPhase] : null;
        s.stop(prevLabel ? `✔ ${prevLabel.done}` : '✔ Done');
        s = null;
      }
      if (p) {
        const prevLabel = lastPhase ? PHASE_LABELS[lastPhase] : null;
        p.stop(prevLabel ? `✔ ${prevLabel.done}` : '✔ Done');
        p = null;
      }

      lastPhase = phase;
      lastCurrent = 0;

      if (total > 0) {
        p = clack.progress({
          style: 'heavy',
          max: total,
          size: 40,
        });
        p.start(label.active);
      } else {
        s = clack.spinner();
        s.start(label.active);
      }
    }

    const cols = process.stdout.columns || 80;
    let fileLabel = '';
    if (file) {
      const prefixText = p 
        ? `${label.active} (${current}/${total}) - `
        : `${label.active} (${current}) - `;
      const clackDecorationLength = p ? 45 : 5;
      const reserved = prefixText.length + clackDecorationLength;
      const maxFileLen = Math.max(10, cols - reserved - 3);
      fileLabel = ` - ${truncatePath(file, maxFileLen)}`;
    }

    if (p) {
      const diff = current - lastCurrent;
      const msg = `${label.active} (${current}/${total})${fileLabel}`;
      if (diff > 0) {
        p.advance(diff, msg);
        lastCurrent = current;
      } else {
        p.message(msg);
      }
    } else if (s) {
      s.message(`${label.active} (${current})${fileLabel}`);
    }
  };

  callback.stop = (title?: string) => {
    if (s) {
      const prevLabel = lastPhase ? PHASE_LABELS[lastPhase] : null;
      s.stop(title || (prevLabel ? `✔ ${prevLabel.done}` : '✔ Done'));
      s = null;
    }
    if (p) {
      const prevLabel = lastPhase ? PHASE_LABELS[lastPhase] : null;
      p.stop(title || (prevLabel ? `✔ ${prevLabel.done}` : '✔ Done'));
      p = null;
    }
  };

  return callback;
}

const MAPX_MARKER_START = '<!-- mapx -->';
const MAPX_MARKER_END = '<!-- /mapx -->';

function readStubContent(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const stubPath = resolve(thisDir, 'agents.stub.md');
    return readFileSync(stubPath, 'utf-8');
  } catch {
    return [
      '# MapxGraph - LLM Integration Guide',
      '',
      'This project uses **MapxGraph** — a local code graph memory system that provides persistent, structured understanding of the codebase across LLM sessions.',
      '',
      '## Commands',
      '',
      'All commands accept a target directory. Three ways to specify:',
      '',
      '```bash',
      '# 1. Positional path argument',
      'mapx scan /path/to/project',
      '',
      '# 2. --dir / -d flag',
      'mapx scan --dir /path/to/project',
      'mapx query "MyClass" -d /path/to/project',
      '',
      '# 3. Global flag (works with any subcommand)',
      'mapx -d /path/to/project scan',
      '```',
      '',
      '```bash',
      'mapx init [/path]                                # First-time setup',
      'mapx uninit [/path]                              # Reverse installation',
      'mapx scan [/path]                                # Full scan (survives Ctrl+C)',
      'mapx update [/path]                              # Incremental update',
      'mapx export [--dir /path]                        # LLM summary (8K tokens)',
      'mapx export --format=json                        # Full JSON graph',
      'mapx export --format=dot                         # GraphViz DOT',
      'mapx export --format=svg                         # SVG visualization',
      'mapx export -o summary.txt                       # Export to file',
      'mapx export --format=svg -o graph.svg            # SVG to file',
      'mapx query <term>                                # Search symbols',
      'mapx deps <file>                                 # File dependencies',
      'mapx summary [/path]                             # Project summary',
      'mapx serve --dir /path                           # Start MCP server (stdio)',
      'mapx serve --sse --port 3456 --dir /path         # SSE (HTTP) transport',
      '```',
      '',
      '## MCP Tools',
      '',
      '- `mapx_scan` — Scan/update the code graph',
      '- `mapx_query` — Search symbols by name',
      '- `mapx_dependencies` — Get deps for a file',
      '- `mapx_export` — Export graph (llm, json, dot, svg)',
      '- `mapx_status` — Check scan status',
      '',
      '## When to Use',
      '',
      '1. Start of session: `mapx export`',
      '2. Find something: `mapx query <term>`',
      '3. Understand a file: `mapx deps <file>`',
      '4. Files changed: `mapx update`',
      '5. Major changes: `mapx scan`',
      '6. Visual overview: `mapx export --format=svg -o graph.svg`',
      '',
      '## Supported Languages',
      '',
      '- **PHP**: classes, methods, functions, interfaces, traits, enums, constants',
      '- **JavaScript**: classes, methods, functions, arrow functions',
      '- **TypeScript**: classes, methods, functions, interfaces, enums, type aliases, properties',
    ].join('\n');
  }
}

function generateAgentsBlock(): string {
  const content = readStubContent();
  return `${MAPX_MARKER_START}\n${content}\n${MAPX_MARKER_END}`;
}

function hasMarkers(content: string): boolean {
  return content.includes(MAPX_MARKER_START) && content.includes(MAPX_MARKER_END);
}

function replaceBetweenMarkers(existing: string, block: string): string {
  const startIdx = existing.indexOf(MAPX_MARKER_START);
  const endIdx = existing.indexOf(MAPX_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return existing;
  }
  return existing.slice(0, startIdx) + block + existing.slice(endIdx + MAPX_MARKER_END.length);
}

async function selectProvidersInteractive(): Promise<string[]> {
  const generator = new AgentGenerator();
  const providers = generator.listProviders();

  const selected = await clack.multiselect({
    message: 'Which LLM/agent tools do you use in this project?',
    options: providers.map(p => ({ value: p, label: p })),
    required: false,
  });

  if (clack.isCancel(selected)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  const result = selected as string[];
  return result.length === 0 ? ['generic'] : result;
}

export function buildCLI(): Command {
  const program = new Command();

  program
    .name('mapx')
    .description('Multi-language code graph memory system for LLMs')
    .version(VERSION)
    .option('-d, --dir <path>', 'Target project directory (default: current directory)');

function detectLaravel(workspaceRoot: string): boolean {
  const composerPath = join(workspaceRoot, 'composer.json');
  if (existsSync(composerPath)) {
    try {
      const content = readFileSync(composerPath, 'utf-8');
      const composer = JSON.parse(content);
      if (composer.require && composer.require['laravel/framework']) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  if (existsSync(join(workspaceRoot, 'artisan'))) {
    return true;
  }

  if (existsSync(join(workspaceRoot, 'app', 'Http', 'Kernel.php'))) {
    return true;
  }

  if (
    existsSync(join(workspaceRoot, 'app')) &&
    existsSync(join(workspaceRoot, 'routes')) &&
    existsSync(join(workspaceRoot, 'config')) &&
    existsSync(join(workspaceRoot, 'database'))
  ) {
    return true;
  }

  return false;
}


async function confirmLaravelExcludes(noSuggestions: boolean): Promise<boolean> {
  if (noSuggestions) return false;
  if (!process.stdin.isTTY) {
    return true;
  }
  
  console.log('\nDetected Laravel project.');
  console.log('\nSuggested exclusions (recommended):');
  console.log('  ✓ database/migrations/**   (schema DDL — no app logic)');
  console.log('  ✓ database/seeders/**      (data fixtures)');
  console.log('  ✓ database/factories/**    (test data)');
  console.log('  ✓ storage/**               (runtime-generated)');
  console.log('  ✓ bootstrap/cache/**       (artisan-generated cache)');
  console.log('  ✓ public/**                (web assets)');
  console.log('  ✓ resources/views/**       (Blade templates — not yet supported)');
  console.log('  ✓ **/*.blade.php           (Blade files)');
  
  const answer = await clack.confirm({
    message: 'Add these to .mapx/config.json?',
    initialValue: true,
  });
  if (clack.isCancel(answer)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }
  return answer;
}

  program
    .command('init')
    .description('Initialize mapx for a project')
    .argument('[path]', 'Target directory')
    .option('--name <name>', 'Repository name')
    .option('--no-agents', 'Skip AGENTS.md creation')
    .option('--no-suggestions', 'Skip interactive framework suggestions')
    .option('--no-mcp-configs', 'Skip auto-generating MCP config files for detected agent tools')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      const isLaravel = detectLaravel(dir);
      let shouldAddLaravelExcludes = false;
      if (isLaravel) {
        shouldAddLaravelExcludes = await confirmLaravelExcludes(opts.suggestions === false);
      }
      const config = await Config.init(dir, opts.name as string | undefined, isLaravel, shouldAddLaravelExcludes);
      if (opts.agents !== false) {
        if (process.stdin.isTTY && opts.suggestions !== false) {
          const selected = await selectProvidersInteractive();
          clack.log.step(`Generating integration files for: ${selected.join(', ')}...`);
          const generator = new AgentGenerator();
          const actions = generator.plan(selected, { dir });
          for (const action of actions) {
            generator.execute(action);
            clack.log.success(`Generated ${action.filename} (${action.status})`);
          }
        } else {
          const generator = new AgentGenerator();
          const actions = generator.plan(['generic'], { dir });
          for (const action of actions) {
            generator.execute(action);
            clack.log.success(`Generated ${action.filename} (${action.status})`);
          }
        }
      }
 
      // Auto-generate MCP config files for detected agent tools
      if (opts.mcpConfigs !== false) {
        const generator = new AgentGenerator();
        const detected = generator.detectAgentTools(dir);
        if (detected.length > 0) {
          const mcpActions = generator.generateMcpConfigs(detected, { dir });
          for (const action of mcpActions) {
            if (action.status === 'up_to_date') continue;
            generator.executeMcpConfig(action);
            const verb = action.status === 'merge' ? 'merged into' : action.status === 'create' ? 'created' : 'updated';
            clack.log.success(`MCP config ${verb} ${action.filename} (${action.tool})`);
          }
        }
      }
 
      // Auto-add .mapx/ to .gitignore
      const gitignorePath = join(dir, '.gitignore');
      const hasGitignore = existsSync(gitignorePath);
      const isGit = isGitRepo(dir);
      if (hasGitignore || isGit) {
        const content = hasGitignore ? readFileSync(gitignorePath, 'utf-8') : '';
        const lines = content.split('\n').map(l => l.trim());
        if (!lines.includes('.mapx/') && !lines.includes('.mapx')) {
          const entry = content.length > 0 && !content.endsWith('\n') ? '\n.mapx/\n' : '.mapx/\n';
          writeFileSync(gitignorePath, content + entry);
          clack.log.success(`Added .mapx/ to .gitignore`);
        }
      }
      clack.log.success(`Initialized mapx in ${dir}/.mapx/`);
      clack.log.info(`Repo: ${config.repo.name}`);
    });

  program
    .command('uninit')
    .description('Remove .mapx/ directory and reverse project integration changes')
    .argument('[path]', 'Target directory')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      const hasMapx = existsSync(join(dir, '.mapx'));

      if (!opts.force && process.stdin.isTTY) {
        const answer = await clack.confirm({
          message: `Are you sure you want to remove .mapx/ and reverse all mapx integrations in ${dir}?`,
          initialValue: false,
        });
        if (clack.isCancel(answer) || !answer) {
          clack.cancel('Aborted.');
          return;
        }
      }

      // 1. Revert LLM agent integrations
      const generator = new AgentGenerator();
      generator.revert({ dir });

      // 2. Remove mapx entries from MCP config files
      generator.revertMcpConfigs({ dir });

      // 3. Remove .mapx/ from .gitignore
      const gitignorePath = join(dir, '.gitignore');
      if (existsSync(gitignorePath)) {
        try {
          const content = readFileSync(gitignorePath, 'utf-8');
          const lines = content.split('\n');
          let removed = false;
          const filteredLines = lines.filter(line => {
            const trimmed = line.trim();
            if (trimmed === '.mapx' || trimmed === '.mapx/') {
              removed = true;
              return false;
            }
            return true;
          });
          if (removed) {
            writeFileSync(gitignorePath, filteredLines.join('\n'), 'utf-8');
            clack.log.success(`Removed .mapx/ from .gitignore`);
          }
        } catch (err: any) {
          clack.log.error(`Failed to update .gitignore: ${err.message}`);
        }
      }

      // 4. Delete .mapx/ directory
      if (hasMapx) {
        try {
          rmSync(join(dir, '.mapx'), { recursive: true, force: true });
          clack.log.success(`Removed .mapx/ directory`);
        } catch (err: any) {
          clack.log.error(`Failed to remove .mapx/ directory: ${err.message}`);
        }
      }

      clack.log.success(`Successfully uninitialized mapx for project: ${dir}`);
    });


  program
    .command('scan')
    .description('Full scan: parse all files, build graph')
    .argument('[path]', 'Target directory')
    .option('--exclude <glob>', 'Exclude glob pattern(s)', collectPatterns, [])
    .option('--include <glob>', 'Include glob pattern(s)', collectPatterns, [])
    .option('--repo <name>', 'Scan only a specific registered repository')
    .option('--all', 'Scan all registered repositories')
    .option('--force', 'Force re-parsing of all files (bypass cache)', false)
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);

      const onProgress = createProgressRenderer();
      const scanner = new Scanner(store, config, graph, onProgress, {
        excludes: opts.exclude as string[],
        includes: opts.include as string[],
      });

      const onSigInt = () => {
        scanner.abort();
        onProgress.stop('Canceled');
        process.stderr.write('\n');
      };
      process.once('SIGINT', onSigInt);

      let repoNames: string[] | undefined = undefined;
      if (opts.repo) {
        repoNames = [opts.repo as string];
      } else if (opts.all) {
        repoNames = ['all'];
      }

      const result = await scanner.scanFull(repoNames, { force: !!opts.force }).catch((err: Error) => {
        onProgress.stop();
        if (err.message.includes('Another scan is already running')) {
          clack.log.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      });

      process.removeListener('SIGINT', onSigInt);
      onProgress.stop();

      if (result.interrupted) {
        clack.log.warn(`Scan interrupted after ${result.filesScanned}/${result.totalFiles} files. Progress saved — run \`scan\` again to resume.`);
      } else {
        clack.log.success(`Scanned ${result.filesScanned} files in ${result.durationMs}ms`);
      }
      clack.log.info(`Languages: ${Object.entries(result.languageBreakdown).map(([l, c]) => `${l}: ${c}`).join(', ')}`);
      clack.log.info(`Found ${result.symbolsFound} symbols, ${result.edgesFound} edges`);
    });

  program
    .command('update')
    .alias('sync')
    .description('Incremental scan: re-scan only changed files')
    .argument('[path]', 'Target directory')
    .option('--exclude <glob>', 'Exclude glob pattern(s)', collectPatterns, [])
    .option('--include <glob>', 'Include glob pattern(s)', collectPatterns, [])
    .option('--repo <name>', 'Update only a specific registered repository')
    .option('--all', 'Update all registered repositories')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);
      const onProgress = createProgressRenderer();

      const handleLockError = (err: Error): never => {
        if (err.message.includes('Another scan is already running')) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      };

      let repoNames: string[] | undefined = undefined;
      if (opts.repo) {
        repoNames = [opts.repo as string];
      } else if (opts.all) {
        repoNames = ['all'];
      }

      const scanner = new Scanner(store, config, graph, onProgress, {
        excludes: opts.exclude as string[],
        includes: opts.include as string[],
      });
      const onSigInt = () => {
        scanner.abort();
        onProgress.stop('Canceled');
      };
      process.once('SIGINT', onSigInt);
      const result = await scanner.scanIncremental(repoNames).catch((err: Error) => {
        onProgress.stop();
        handleLockError(err);
        throw err;
      });

      process.removeListener('SIGINT', onSigInt);
      onProgress.stop();
      if (result.interrupted) {
        clack.log.warn(`Update interrupted after ${result.filesScanned} files.`);
      } else {
        clack.log.success(`Updated ${result.filesScanned} files in ${result.durationMs}ms`);
        clack.log.info(`${result.symbolsFound} symbols updated, ${result.edgesFound} edges updated`);
      }
    });

  program
    .command('status')
    .description('Show scan status, collected metrics, and changed files')
    .argument('[path]', 'Target directory')
    .option('--exclude <glob>', 'Exclude glob pattern(s)', collectPatterns, [])
    .option('--include <glob>', 'Include glob pattern(s)', collectPatterns, [])
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);

      const lastScan    = store.getMeta('last_scan_time:' + config.repo.name) || store.getMeta('last_scan_time');
      const lastCommit  = store.getMeta('last_scan_commit:' + config.repo.name) || store.getMeta('last_scan_commit');
      const schemaVer   = store.getMeta('schema_version');
      const dbPath      = resolve(dir, '.mapx', 'mapx.db');

      const activeExcludes = [
        ...(config.settings.excludePatterns ?? []),
        ...((opts.exclude as string[]) ?? []),
      ];
      const activeIncludes = [
        ...(config.settings.includePatterns ?? []),
        ...((opts.include as string[]) ?? []),
      ];

      // ── Scan info ──────────────────────────────────────────────────────
      console.log('\n── Scan ─────────────────────────────────────────────');
      console.log(`  Project:     ${config.repo.name}`);
      console.log(`  Framework:   ${config.repo.framework || 'generic'}`);
      console.log(`  Directory:   ${dir}`);
      console.log(`  Last scan:   ${lastScan  || 'never'}`);
      console.log(`  Last commit: ${lastCommit || 'none'}`);
      console.log(`  Schema:      v${schemaVer || '?'}`);
      console.log(`  Excludes:    [${activeExcludes.join(', ')}]`);
      console.log(`  Includes:    [${activeIncludes.join(', ')}]`);

      // ── Collected data ─────────────────────────────────────────────────
      const fileCount   = store.getFileCount();
      const symbolCount = store.getSymbolCount();
      const edgeCount   = store.getEdgeCount();
      const breakdown   = store.getLanguageBreakdown();
      const verifiedEdgeCount = (store.raw.prepare("SELECT COUNT(*) as cnt FROM edges WHERE verifiability = 'verified'").get() as any)?.cnt || 0;
      const inferredEdgeCount = (store.raw.prepare("SELECT COUNT(*) as cnt FROM edges WHERE verifiability = 'inferred'").get() as any)?.cnt || 0;

      console.log('\n── Collected data ───────────────────────────────────');
      console.log(`  Files:       ${fileCount}`);
      console.log(`  Symbols:     ${symbolCount}`);
      console.log(`  Edges:       ${edgeCount} (verified: ${verifiedEdgeCount}, inferred: ${inferredEdgeCount})`);

      // Language breakdown
      const langs = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
      if (langs.length > 0) {
        console.log(`  Languages:`);
        for (const [lang, cnt] of langs) {
          console.log(`    ${lang.padEnd(14)} ${cnt} files`);
        }
      }

      // Symbol kind breakdown (direct SQL aggregation)
      const kindRows = store.raw.prepare(
        'SELECT kind, COUNT(*) as cnt FROM symbols GROUP BY kind ORDER BY cnt DESC'
      ).all() as Array<{ kind: string; cnt: number }>;
      if (kindRows.length > 0) {
        console.log(`  Symbol kinds:`);
        for (const row of kindRows) {
          console.log(`    ${row.kind.padEnd(14)} ${row.cnt}`);
        }
      }

      // Edge type breakdown
      const edgeTypeRows = store.raw.prepare(
        'SELECT edge_type, COUNT(*) as cnt FROM edges GROUP BY edge_type ORDER BY cnt DESC'
      ).all() as Array<{ edge_type: string; cnt: number }>;
      if (edgeTypeRows.length > 0) {
        console.log(`  Edge types:`);
        for (const row of edgeTypeRows) {
          console.log(`    ${row.edge_type.padEnd(14)} ${row.cnt}`);
        }
      }

      // ── Graph metrics ──────────────────────────────────────────────────
      if (fileCount > 0) {
        const densityNum = edgeCount / Math.max(fileCount * (fileCount - 1), 1);
        const density = (densityNum * 100).toFixed(2);

        // Top 5 most-connected files (highest out-degree = most dependencies)
        const connRows = store.raw.prepare(`
          SELECT source_file, COUNT(*) as cnt FROM edges
          GROUP BY source_file ORDER BY cnt DESC LIMIT 5
        `).all() as Array<{ source_file: string; cnt: number }>;

        console.log('\n── Graph metrics ────────────────────────────────────');
        console.log(`  Density:     ${density}%`);
        const avgEdges = fileCount > 0 ? (edgeCount / fileCount).toFixed(1) : '0';
        console.log(`  Avg edges/file: ${avgEdges}`);
        if (connRows.length > 0) {
          console.log(`  Most connected files:`);
          for (const row of connRows) {
            const rel = row.source_file.replace(dir + '/', '');
            console.log(`    ${String(row.cnt).padStart(4)} edges  ${rel}`);
          }
        }
      }

      // ── Storage ────────────────────────────────────────────────────────
      try {
        const { statSync } = await import('node:fs');
        const dbSize = statSync(dbPath).size;
        const kb = (dbSize / 1024).toFixed(1);
        console.log('\n── Storage ──────────────────────────────────────────');
        console.log(`  Database:    ${kb} KB  (${dbPath})`);
      } catch { /* db may not exist yet */ }

      // ── PageRank Importance ──────────────────────────────
      console.log('\n── PageRank Importance ──────────────────────────────');
      const topFiles = store.getTopFilesByPageRank(graph, 5);
      const topSymbols = store.getTopSymbolsByPageRank(graph, 5);

      if (topFiles.length > 0) {
        console.log('  Top files by PageRank:');
        for (const tf of topFiles) {
          console.log(`    ${tf.pagerank.toFixed(6)}  ${tf.path}`);
        }
      } else {
        console.log('  No ranked files (run a scan first)');
      }

      if (topSymbols.length > 0) {
        console.log('\n  Top symbols by PageRank:');
        for (const ts of topSymbols) {
          const scope = ts.scope ? `${ts.scope}::` : '';
          console.log(`    ${ts.pagerank.toFixed(6)}  ${scope}${ts.name} (${ts.filePath})`);
        }
      } else {
        console.log('\n  No ranked symbols (run a scan first)');
      }

      // ── Git changes ────────────────────────────────────────────────────
      const repoRoot = resolve(dir, config.repo.path);
      let isStale = false;
      if (!isGitRepo(repoRoot)) {
        console.log('\n── Git ──────────────────────────────────────────────');
        console.log('  Not a git repository');
      } else {
        const changes = getChangedFiles(repoRoot, lastCommit || undefined);
        console.log('\n── Git changes since last scan ──────────────────────');
        if (changes.length === 0) {
          console.log('  No changes since last scan  (✓ index is current)');
        } else {
          isStale = true;
          const byStatus = { added: 0, modified: 0, removed: 0, renamed: 0, unchanged: 0 };
          for (const c of changes) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
          const summary = (Object.entries(byStatus) as Array<[string, number]>)
            .filter(([, n]) => n > 0)
            .map(([s, n]) => `${n} ${s}`)
            .join(', ');
          console.log(`  ${changes.length} changed files  (${summary})  (⚠ stale)`);
          const icon = { added: '+', modified: '~', removed: '-', renamed: '>', unchanged: '=' };
          for (const change of changes) {
            console.log(`    ${icon[change.status]} ${change.path}`);
          }
        }
      }

      console.log('\n── Recommendations ──────────────────────────────────');
      if (isStale) {
        console.log('  ⚠ Index is stale. Run `mapx sync` or `mapx update` to bring it up to date.');
      } else {
        console.log('  ✓ Index is up to date.');
      }
      console.log('');
    });

  program
    .command('query <term>')
    .description('Search for symbols by name (supports glob patterns: *Service, get*)')
    .option('-d, --dir <path>', 'Target directory')
    .action(async (term: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const results = store.searchSymbols(term);
      if (results.length === 0) {
        // Fuzzy fallback: suggest similar symbol names
        const candidates = store.getSymbolCandidatesForFuzzy();
        const suggestions = findSimilarSymbols(term, candidates);
        console.log(`No symbols matching "${term}"`);
        if (suggestions.length > 0) {
          console.log(`\nDid you mean:`);
          for (const s of suggestions) {
            console.log(`  • ${s.name} (${s.kind} @ ${s.filePath})`);
          }
        }
        console.log(`\nTip: Use glob patterns like "${term.length > 3 ? term.slice(0, 4) : term}*" or "*" to list all.`);
        return;
      }

      console.log(`Found ${results.length} symbol${results.length !== 1 ? 's' : ''} matching "${term}":\n`);
      for (const sym of results) {
        const scope = sym.scope ? `${sym.scope}::` : '';
        console.log(`  ${sym.kind} ${scope}${sym.name}`);
        console.log(`    @ ${sym.file_path}:${sym.start_line}`);
        if (sym.signature && sym.signature !== sym.name) {
          console.log(`    signature: ${sym.signature}`);
        }
      }
    });

  program
    .command('search <term>')
    .description('Symbol search with kind/file/exact filters and glob patterns (*, ?)')
    .option('-d, --dir <path>', 'Target directory')
    .option('--kind <kind>', 'Filter by symbol kind (class, method, function, interface, trait, constant, enum, property, namespace, struct, module)')
    .option('--file <prefix>', 'Filter by file path prefix')
    .option('--exact', 'Only match exact name (case-insensitive)', false)
    .option('--limit <limit>', 'Max results to return', '20')
    .option('--format <format>', 'Output format: text | json', 'text')
    .action(async (term: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store, graph } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const kind = opts.kind as string | undefined;
      const filePrefix = opts.file as string | undefined;
      const exact = !!opts.exact;
      const limit = parseInt(opts.limit as string, 10);
      const format = (opts.format as string) || 'text';

      let results = store.searchSymbolsFiltered({ term, kind, filePrefix, exact, limit });
      let broadened = false;

      // Auto-expand: if kind filter yields 0 results, retry without kind
      if (results.length === 0 && kind && term !== '*' && term !== '') {
        const withoutKind = store.searchSymbolsFiltered({ term, filePrefix, exact, limit });
        if (withoutKind.length > 0) {
          results = withoutKind;
          broadened = true;
        }
      }

      if (results.length === 0) {
        // Fuzzy fallback
        console.log(`No symbols matching "${term}"`);
        if (kind) {
          const kinds = store.listSymbolKinds();
          console.log(`\nAvailable kinds:`);
          for (const k of kinds) console.log(`  ${k.kind}: ${k.count} symbols`);
        }
        if (term !== '*' && term !== '') {
          const candidates = store.getSymbolCandidatesForFuzzy();
          const suggestions = findSimilarSymbols(term, candidates);
          if (suggestions.length > 0) {
            console.log(`\nDid you mean:`);
            for (const s of suggestions) {
              console.log(`  • ${s.name} (${s.kind} @ ${s.filePath})`);
            }
          }
          console.log(`\nTip: Use term="*" to list all, or glob patterns like "${term.length > 3 ? term.slice(0, 4) : term}*"`);
        }
        return;
      }

      const rankedAll = graph.getRankedSymbols();
      const rankMap = new Map<string, number>();
      for (const item of rankedAll) {
        rankMap.set(`${item.filePath}::${item.name}`, item.pagerank);
      }

      // JSON format
      if (format === 'json') {
        const jsonResults = results.map(sym => ({
          name: sym.name,
          kind: sym.kind,
          scope: sym.scope || null,
          file: sym.file_path,
          line: sym.start_line,
          endLine: sym.end_line,
          signature: sym.signature || '',
          pagerank: rankMap.get(`${sym.file_path}::${sym.name}`) || 0,
        }));
        console.log(JSON.stringify({ total: results.length, broadened, term, kind: kind || null, results: jsonResults }, null, 2));
        return;
      }

      // Summary header
      let header = `Found ${results.length} symbol${results.length !== 1 ? 's' : ''}`;
      if (kind && !broadened) header += ` of kind "${kind}"`;
      if (filePrefix) header += ` in ${filePrefix}`;
      if (broadened) header += ` (broadened from kind="${kind}" which had 0 results)`;
      console.log(header + ':\n');

      for (const sym of results) {
        const scope = sym.scope ? `${sym.scope}::` : '';
        const key = `${sym.file_path}::${sym.name}`;
        const pagerankVal = rankMap.get(key) || 0;
        console.log(`  ${sym.kind} ${scope}${sym.name} [pagerank: ${pagerankVal.toFixed(6)}]`);
        console.log(`    @ ${sym.file_path}:${sym.start_line}`);
        if (sym.signature && sym.signature !== sym.name) {
          console.log(`    signature: ${sym.signature}`);
        }
      }
    });

  program
    .command('callers <symbol>')
    .description('Show callers of a symbol')
    .option('-d, --dir <path>', 'Target directory')
    .option('--depth <depth>', 'Traversal depth', '1')
    .action(async (symbol: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);
      const maxDepth = parseInt(opts.depth as string, 10);

      const queue: Array<{ symName: string; depth: number }> = [{ symName: symbol, depth: 0 }];
      const visited = new Set<string>([symbol]);
      const results: Array<{ caller: string; callee: string; file: string; line: number; depth: number }> = [];

      while (queue.length > 0) {
        const { symName, depth } = queue.shift()!;
        if (depth >= maxDepth) continue;

        const callers = store.getCallersOfSymbol(symName);
        for (const edge of callers) {
          const callerName = edge.source_symbol ? `${edge.source_symbol}` : '<top-level>';
          const calleeName = edge.target_symbol || symName;
          const meta = edge.metadata ? JSON.parse(edge.metadata) : {};

          results.push({
            caller: callerName,
            callee: calleeName,
            file: edge.source_file,
            line: meta.startLine || 1,
            depth: depth + 1
          });

          const nextSym = edge.source_symbol;
          if (nextSym && !visited.has(nextSym)) {
            visited.add(nextSym);
            queue.push({ symName: nextSym, depth: depth + 1 });
          }
        }
      }

      if (results.length === 0) {
        // Fuzzy fallback: check if symbol exists
        const sym = store.getSymbolByName(symbol);
        if (!sym) {
          const candidates = store.getSymbolCandidatesForFuzzy();
          const suggestions = findSimilarSymbols(symbol, candidates);
          console.log(`Symbol "${symbol}" not found.`);
          if (suggestions.length > 0) {
            console.log(`\nDid you mean:`);
            for (const s of suggestions) {
              console.log(`  • ${s.name} (${s.kind} @ ${s.filePath})`);
            }
          }
        } else {
          console.log(`No callers found for "${symbol}"`);
        }
        return;
      }

      console.log(`${results.length} caller${results.length !== 1 ? 's' : ''} of "${symbol}"${maxDepth > 1 ? ` (depth ${maxDepth})` : ''}:`);
      for (const res of results) {
        const indent = '  '.repeat(res.depth);
        console.log(`${indent}← ${res.caller} (calls ${res.callee})`);
        console.log(`${indent}  @ ${res.file}:${res.line}`);
      }
    });

  program
    .command('callees <symbol>')
    .description('Show callees of a symbol')
    .option('-d, --dir <path>', 'Target directory')
    .option('--depth <depth>', 'Traversal depth', '1')
    .action(async (symbol: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);
      const maxDepth = parseInt(opts.depth as string, 10);

      const queue: Array<{ symName: string; depth: number }> = [{ symName: symbol, depth: 0 }];
      const visited = new Set<string>([symbol]);
      const results: Array<{ caller: string; callee: string; file: string; line: number; depth: number }> = [];

      while (queue.length > 0) {
        const { symName, depth } = queue.shift()!;
        if (depth >= maxDepth) continue;

        const callees = store.getCalleesOfSymbol(symName);
        for (const edge of callees) {
          const calleeName = edge.target_symbol || '<unknown>';
          const callerName = edge.source_symbol || symName;
          const meta = edge.metadata ? JSON.parse(edge.metadata) : {};

          results.push({
            caller: callerName,
            callee: calleeName,
            file: edge.target_file,
            line: meta.startLine || 1,
            depth: depth + 1
          });

          if (edge.target_symbol && !visited.has(edge.target_symbol)) {
            visited.add(edge.target_symbol);
            queue.push({ symName: edge.target_symbol, depth: depth + 1 });
          }
        }
      }

      if (results.length === 0) {
        // Fuzzy fallback: check if symbol exists
        const sym = store.getSymbolByName(symbol);
        if (!sym) {
          const candidates = store.getSymbolCandidatesForFuzzy();
          const suggestions = findSimilarSymbols(symbol, candidates);
          console.log(`Symbol "${symbol}" not found.`);
          if (suggestions.length > 0) {
            console.log(`\nDid you mean:`);
            for (const s of suggestions) {
              console.log(`  • ${s.name} (${s.kind} @ ${s.filePath})`);
            }
          }
        } else {
          console.log(`No callees found for "${symbol}"`);
        }
        return;
      }

      console.log(`${results.length} callee${results.length !== 1 ? 's' : ''} of "${symbol}"${maxDepth > 1 ? ` (depth ${maxDepth})` : ''}:`);
      for (const res of results) {
        const indent = '  '.repeat(res.depth);
        console.log(`${indent}→ ${res.callee} (called by ${res.caller})`);
        console.log(`${indent}  @ ${res.file}:${res.line}`);
      }
    });

  program
    .command('impact <symbol>')
    .description('Show transitive blast-radius of changing a symbol')
    .option('-d, --dir <path>', 'Target directory')
    .option('--depth <depth>', 'Traversal depth', '3')
    .option('--format <format>', 'text | json', 'text')
    .action(async (symbol: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);
      const maxDepth = parseInt(opts.depth as string, 10);

      // Fuzzy pre-check: verify symbol exists before running analysis
      const sym = store.getSymbolByName(symbol);
      if (!sym) {
        const candidates = store.getSymbolCandidatesForFuzzy();
        const suggestions = findSimilarSymbols(symbol, candidates);
        console.error(`Error: Symbol "${symbol}" not found.`);
        if (suggestions.length > 0) {
          console.log(`\nDid you mean:`);
          for (const s of suggestions) {
            console.log(`  • ${s.name} (${s.kind} @ ${s.filePath})`);
          }
        }
        process.exit(1);
      }

      const analyzer = new ImpactAnalyzer(store);
      const result = analyzer.analyze(symbol, maxDepth, dir);

      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.affected.length === 0) {
          console.log(`No callers affected by changing "${symbol}"`);
        } else {
          console.log(`Impact analysis for "${symbol}":`);
          for (const item of result.affected) {
            console.log(`  [${item.risk}] ${item.symbol} (${item.file}) [depth: ${item.depth}, type: ${item.edgeType}]`);
          }
        }
        console.log(`\nRecommendation: ${result.recommendation}`);
      }
    });

  program
    .command('node <symbol>')
    .description('Show full symbol details and optional source code')
    .option('-d, --dir <path>', 'Target directory')
    .option('--source', 'Extract and display source code', false)
    .option('--format <format>', 'Output format: text | json', 'text')
    .action(async (symbol: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const sym = store.getSymbolByName(symbol);
      if (!sym) {
        // Fuzzy fallback
        const candidates = store.getSymbolCandidatesForFuzzy();
        const suggestions = findSimilarSymbols(symbol, candidates);
        console.error(`Error: Symbol "${symbol}" not found.`);
        if (suggestions.length > 0) {
          console.log(`\nDid you mean:`);
          for (const s of suggestions) {
            console.log(`  • ${s.name} (${s.kind} @ ${s.filePath})`);
          }
        }
        console.log(`\nTip: Use mapx search to find symbols by pattern. Example: mapx search "${symbol.length > 3 ? symbol.slice(0, 4) : symbol}*"`);
        process.exit(1);
      }

      const callers = store.getCallersOfSymbol(symbol);
      const callees = store.getCalleesOfSymbol(symbol);
      const format = (opts.format as string) || 'text';

      // JSON format
      if (format === 'json') {
        const result: Record<string, any> = {
          name: sym.name,
          kind: sym.kind,
          scope: sym.scope || null,
          file: sym.file_path,
          startLine: sym.start_line,
          endLine: sym.end_line,
          signature: sym.signature || '',
          callerCount: callers.length,
          calleeCount: callees.length,
        };
        if (opts.source) {
          try {
            const absolutePath = resolve(dir, sym.file_path as string);
            const content = readFileSync(absolutePath, 'utf8');
            const lines = content.split('\n');
            const start = (sym.start_line as number) - 1;
            const end = (sym.end_line as number);
            result.source = lines.slice(start, end).join('\n');
          } catch (err: any) {
            result.sourceError = err.message;
          }
        }
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Symbol: ${sym.scope ? `${sym.scope}::` : ''}${sym.name}`);
      console.log(`Kind:   ${sym.kind}`);
      console.log(`File:   ${sym.file_path}`);
      console.log(`Lines:  ${sym.start_line}-${sym.end_line}`);
      console.log(`Signature: ${sym.signature}`);
      console.log(`Callers: ${callers.length}`);
      console.log(`Callees: ${callees.length}`);

      if (opts.source) {
        try {
          const absolutePath = resolve(dir, sym.file_path as string);
          const content = readFileSync(absolutePath, 'utf8');
          const lines = content.split('\n');
          const start = (sym.start_line as number) - 1;
          const end = (sym.end_line as number);
          const sliced = lines.slice(start, end).join('\n');
          console.log('\nSource Code:');
          console.log('----------------------------------------');
          console.log(sliced);
          console.log('----------------------------------------');
        } catch (err: any) {
          console.error(`Failed to read source code: ${err.message}`);
        }
      }
    });

  program
    .command('files')
    .description('List indexed files with prefix/lang/sort filters')
    .option('-d, --dir <path>', 'Target directory')
    .option('--path <prefix>', 'Filter by path prefix')
    .option('--lang <lang>', 'Filter by language')
    .option('--sort <sort>', 'lines | path', 'path')
    .option('--limit <limit>', 'Max files to return', '50')
    .action(async (opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const results = store.getFilesFiltered({
        pathPrefix: opts.path as string,
        lang: opts.lang as string,
        sort: opts.sort as 'lines' | 'path',
        limit: parseInt(opts.limit as string, 10),
      });

      if (results.length === 0) {
        console.log('No files found matching filters');
        return;
      }

      for (const file of results) {
        console.log(`  ${file.path} (${file.language}, ${file.lines} lines, ${file.size_bytes} bytes)`);
      }
    });

  program
    .command('deps <file>')
    .description('Show dependencies for a file')
    .option('-d, --dir <path>', 'Target directory')
    .action(async (file: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store, graph } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const deps = graph.getDependencies(file);
      const rdeps = graph.getReverseDependencies(file);

      if (deps.length > 0) {
        console.log('Dependencies:');
        for (const dep of deps) {
          console.log(`  → ${dep.target} (${dep.type})`);
        }
      } else {
        console.log('No dependencies found');
      }

      if (rdeps.length > 0) {
        console.log('\nDepended on by:');
        for (const rdep of rdeps) {
          console.log(`  ← ${rdep.source} (${rdep.type})`);
        }
      }
    });

  program
    .command('trace [symbol-or-file]')
    .description('Trace data flow paths from a starting symbol or file')
    .option('-d, --dir <path>', 'Target directory')
    .option('--direction <dir>', 'up | down | both', 'both')
    .option('--depth <n>', 'Maximum traversal depth', '3')
    .option('--max-depth <n>', 'Maximum traversal depth (alias for --depth)')
    .option('--format <fmt>', 'text | dot | json', 'text')
    .option('--include-structural', 'Include import/extends edges in trace', false)
    .option('--sources', 'Show entry points', false)
    .option('--sinks', 'Show terminal consumers', false)
    .option('--to <target>', 'Find the shortest path to target symbol/file')
    .action(async (start: string | undefined, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const tracer = new FlowTracer(store);

      if (opts.sources) {
        const sources = tracer.findSources(config.repo.name);
        console.log(`\nEntry points (data sources) — ${sources.length} found:`);
        for (const s of sources) {
          let extra = '[no incoming data edges]';
          if (s.file.includes('routes/')) {
            const routes = store.getEdgesForFile(s.file).filter(e => e.edge_type === 'route');
            extra = `[route file — ${routes.length} controller endpoints]`;
          } else if (s.file.includes('app/Jobs/')) {
            extra = '[dispatched externally — queue worker]';
          } else if (s.file.includes('app/Listeners/')) {
            extra = '[event listener — external trigger]';
          } else if (s.file.includes('app/Http/Middleware/')) {
            extra = '[middleware — filter chain entry]';
          }
          console.log(`  ${s.file.padEnd(40)} ${extra}`);
        }
        return;
      }

      if (opts.sinks) {
        const sinks = tracer.findSinks(config.repo.name);
        console.log(`\nTerminal consumers (data sinks) — ${sinks.length} found:`);
        for (const s of sinks) {
          const inEdges = store.getReverseEdges(s.file).filter(e => [
            'call', 'instantiation', 'param_type', 'return_type', 'relation', 'dispatch', 'notify', 'route', 'render'
          ].includes(e.edge_type as string));
          let extra = `[terminal — no outgoing data edges]`;
          if (s.file.includes('DatabaseManager') || s.file.includes('database')) {
            extra = `[DB facade → raw SQL — ${inEdges.length} in-edges]`;
          } else if (s.file.includes('CacheManager') || s.file.includes('cache')) {
            extra = `[Cache facade → Redis/Memcache — ${inEdges.length} in-edges]`;
          } else if (s.file.includes('Mailer') || s.file.includes('mail')) {
            extra = `[Mail facade → SMTP — ${inEdges.length} in-edges]`;
          } else if (s.file.includes('QueueManager') || s.file.includes('queue')) {
            extra = `[Queue::push — ${inEdges.length} in-edges]`;
          }
          console.log(`  ${s.file.padEnd(40)} ${extra}`);
        }
        return;
      }

      if (!start) {
        console.error('Error: start symbol or file is required unless --sources or --sinks is specified.');
        process.exit(1);
      }

      if (opts.to) {
        const path = tracer.findCriticalPath(start, opts.to as string, config.repo.name);
        if (!path) {
          console.log(`No path found from "${start}" to "${opts.to}"`);
          return;
        }

        console.log(`\nCritical data path: ${start} → ${opts.to}`);
        console.log(`Length: ${path.nodes.length - 1} hops\n`);

        for (let i = 0; i < path.nodes.length; i++) {
          const node = path.nodes[i];
          const indent = '  '.repeat(i);
          const prefix = i === 0 ? '' : `└─[${node.incomingEdgeType}]─→  `;
          const suffix = i === path.nodes.length - 1 ? '  ⊗' : '';
          const name = node.symbol ? node.symbol : node.file;
          console.log(`${indent}${prefix}${name}${suffix}`);
        }
        return;
      }

      const requestedDepth = opts.maxDepth !== undefined ? opts.maxDepth : opts.depth;
      const parsedDepth = parseInt(requestedDepth as string, 10);

      const result = tracer.trace({
        startSymbol: start,
        direction: opts.direction as any,
        maxDepth: parsedDepth,
        includeStructural: !!opts.includeStructural,
        repo: config.repo.name,
      });

      if (opts.format === 'json') {
        const jsonOutput = {
          start: result.start,
          direction: result.direction,
          maxDepth: parsedDepth,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          maxDepthReached: result.maxDepthReached,
          sources: result.sources.map(s => ({ file: s.file, symbol: s.symbol })),
          sinks: result.sinks.map(s => ({ file: s.file, symbol: s.symbol })),
          cycles: result.cycles,
          nodes: Array.from(new Map(result.paths.flatMap(p => p.nodes).map(n => [`${n.file}::${n.symbol || ''}`, n])).values()).map(n => ({
            file: n.file,
            symbol: n.symbol,
            depth: n.depth,
            incomingEdgeType: n.incomingEdgeType,
          })),
          edges: Array.from(new Set(result.paths.flatMap(p => {
            const arr = [];
            for (let i = 1; i < p.nodes.length; i++) {
              arr.push(JSON.stringify({
                from: p.nodes[i - 1].file,
                to: p.nodes[i].file,
                edgeType: p.nodes[i].incomingEdgeType,
                fromSymbol: p.nodes[i - 1].symbol,
                toSymbol: p.nodes[i].symbol,
              }));
            }
            return arr;
          }))).map(s => JSON.parse(s)),
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }

      if (opts.format === 'dot') {
        const lines: string[] = [];
        const safeStartName = (result.start.symbol || result.start.file).replace(/[^a-zA-Z0-9]/g, '_');
        lines.push(`digraph Trace_${safeStartName} {`);
        lines.push('  rankdir=TB;');
        lines.push(`  label="Trace: ${result.start.symbol || result.start.file} (${result.direction}stream, depth≤${parsedDepth})";`);
        lines.push('  fontsize=12;');
        lines.push('  node [shape=box, style=filled, fontsize=10];');
        lines.push('');

        const uniqueNodes = new Map<string, { file: string; symbol: string | null; shape: string; color: string }>();
        const edgesSet = new Set<string>();

        for (const p of result.paths) {
          for (let i = 0; i < p.nodes.length; i++) {
            const n = p.nodes[i];
            const key = `${n.file}::${n.symbol || ''}`;
            if (!uniqueNodes.has(key)) {
              let shape = 'box';
              let color = '#E8F4FD';

              const isStart = n.file === result.start.file && n.symbol === result.start.symbol;
              const isSink = result.sinks.some(s => s.file === n.file && s.symbol === n.symbol);
              const isSource = result.sources.some(s => s.file === n.file && s.symbol === n.symbol);

              if (isStart) {
                shape = 'diamond';
                color = '#FFE0B2';
              } else if (isSink) {
                shape = 'octagon';
                color = '#FFEBEE';
              } else if (isSource) {
                shape = 'ellipse';
                color = '#E8F5E9';
              }

              uniqueNodes.set(key, { file: n.file, symbol: n.symbol, shape, color });
            }

            if (i > 0) {
              const fromNode = p.nodes[i - 1];
              const toNode = p.nodes[i];
              edgesSet.add(JSON.stringify({
                from: `${fromNode.file}::${fromNode.symbol || ''}`,
                to: `${toNode.file}::${toNode.symbol || ''}`,
                type: toNode.incomingEdgeType,
              }));
            }
          }
        }

        for (const [key, n] of uniqueNodes.entries()) {
          const label = n.symbol || n.file.split('/').pop() || n.file;
          lines.push(`  "${key}" [label="${label}", fillcolor="${n.color}", shape=${n.shape}];`);
        }

        lines.push('');

        for (const edgeStr of edgesSet) {
          const e = JSON.parse(edgeStr);
          lines.push(`  "${e.from}" -> "${e.to}" [label="${e.type}"];`);
        }

        lines.push('}');
        console.log(lines.join('\n'));
        return;
      }

      const dirSymbol = result.direction === 'down' ? '↓ downstream' : result.direction === 'up' ? '↑ upstream' : '↕ bidirectional';
      console.log(`\nTrace: ${start}  ${dirSymbol}  depth≤${parsedDepth}`);
      console.log('─'.repeat(53));
      console.log('');

      const printNode = (node: TraceNode, indentLevel: number) => {
        const indent = '  '.repeat(indentLevel);
        const prefix = indentLevel === 0 ? '' : `└─[${node.incomingEdgeType}]─→  `;
        const displayName = node.symbol || node.file;
        const filePart = node.symbol ? `  (${node.file})` : '';

        const isSink = result.sinks.some(s => s.file === node.file && s.symbol === node.symbol);
        const sinkStr = isSink ? '  ⊗ sink' : '';

        const cycle = result.cycles.find(c => c.fromFile === node.file && c.fromSymbol === node.symbol);
        const cycleStr = cycle ? '  ↻ cycle' : '';

        console.log(`${indent}${prefix}${displayName}${filePart}${sinkStr}${cycleStr}`);

        if (!cycle) {
          const children: TraceNode[] = [];
          const seenChildKeys = new Set<string>();
          for (const path of result.paths) {
            const idx = path.nodes.findIndex(n => n.file === node.file && n.symbol === node.symbol && n.depth === node.depth);
            if (idx !== -1 && idx + 1 < path.nodes.length) {
              const nextNode = path.nodes[idx + 1];
              const key = `${nextNode.file}::${nextNode.symbol || ''}::${nextNode.depth}`;
              if (!seenChildKeys.has(key)) {
                seenChildKeys.add(key);
                children.push(nextNode);
              }
            }
          }

          for (const child of children) {
            printNode(child, indentLevel + 1);
          }
        }
      };

      const startNode: TraceNode = {
        file: result.start.file,
        symbol: result.start.symbol,
        depth: 0,
        incomingEdgeType: 'start',
      };
      printNode(startNode, 0);

      console.log('');
      const cyclesStr = result.cycles.length > 0 ? `   Cycles: ${result.cycles.length}` : '';
      console.log(`Nodes: ${result.nodeCount}   Edges: ${result.edgeCount}   Max depth: ${parsedDepth}${cyclesStr}`);
      if (result.sinks.length > 0) {
        const sinkNames = result.sinks.map(s => s.symbol || s.file.split('/').pop() || s.file);
        console.log(`Sinks: ${sinkNames.join(', ')}`);
      }
    });

  program
    .command('sources')
    .description('Find entry points (data sources) in the codebase')
    .option('-d, --dir <path>', 'Target directory')
    .action(async (opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const tracer = new FlowTracer(store);
      const sources = tracer.findSources(config.repo.name);
      console.log(`\nEntry points (data sources) — ${sources.length} found:`);
      for (const s of sources) {
        let extra = '[no incoming data edges]';
        if (s.file.includes('routes/')) {
          const routes = store.getEdgesForFile(s.file).filter(e => e.edge_type === 'route');
          extra = `[route file — ${routes.length} controller endpoints]`;
        } else if (s.file.includes('app/Jobs/')) {
          extra = '[dispatched externally — queue worker]';
        } else if (s.file.includes('app/Listeners/')) {
          extra = '[event listener — external trigger]';
        } else if (s.file.includes('app/Http/Middleware/')) {
          extra = '[middleware — filter chain entry]';
        }
        console.log(`  ${s.file.padEnd(40)} ${extra}`);
      }
    });

  program
    .command('sinks')
    .description('Find terminal consumers (data sinks) in the codebase')
    .option('-d, --dir <path>', 'Target directory')
    .action(async (opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const tracer = new FlowTracer(store);
      const sinks = tracer.findSinks(config.repo.name);
      console.log(`\nTerminal consumers (data sinks) — ${sinks.length} found:`);
      for (const s of sinks) {
        const inEdges = store.getReverseEdges(s.file).filter(e => [
          'call', 'instantiation', 'param_type', 'return_type', 'relation', 'dispatch', 'notify', 'route', 'render'
        ].includes(e.edge_type as string));
        let extra = `[terminal — no outgoing data edges]`;
        if (s.file.includes('DatabaseManager') || s.file.includes('database')) {
          extra = `[DB facade → raw SQL — ${inEdges.length} in-edges]`;
        } else if (s.file.includes('CacheManager') || s.file.includes('cache')) {
          extra = `[Cache facade → Redis/Memcache — ${inEdges.length} in-edges]`;
        } else if (s.file.includes('Mailer') || s.file.includes('mail')) {
          extra = `[Mail facade → SMTP — ${inEdges.length} in-edges]`;
        } else if (s.file.includes('QueueManager') || s.file.includes('queue')) {
          extra = `[Queue::push — ${inEdges.length} in-edges]`;
        }
        console.log(`  ${s.file.padEnd(40)} ${extra}`);
      }
    });

  program
    .command('context <task>')
    .description('Generate task-specific workspace context within a token budget')
    .option('-d, --dir <path>', 'Target directory')
    .option('--seeds <list>', 'Comma-separated list of seed symbols or file paths')
    .option('--tokens <budget>', 'Maximum estimated token budget', '8192')
    .option('--depth <n>', 'Graph traversal depth', '2')
    .option('--format <format>', 'Output format: text | json', 'text')
    .action(async (task: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { config, store, graph } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const builder = new ContextBuilder(store, graph);
      const parsedTokens = parseInt(opts.tokens as string, 10) || 8192;
      const parsedDepth = parseInt(opts.depth as string, 10) || 2;
      const format = opts.format as string;
      const seeds = opts.seeds ? (opts.seeds as string).split(',').map(s => s.trim()) : undefined;

      const result = await builder.buildContext({
        task,
        seeds,
        tokens: parsedTokens,
        depth: parsedDepth,
      });

      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log('# MapX Smart Context');
      console.log(`*Estimated tokens:* ${result.estimatedTokens}\n`);
      
      console.log('## Included Files');
      if (result.includedFiles.length === 0) {
        console.log('None');
      } else {
        for (const f of result.includedFiles) {
          console.log(`### [${f.path}](file://${resolve(dir, f.path)})`);
          console.log(`- Language: ${f.language}`);
          console.log(`- Lines: ${f.lineCount} | Size: ${f.sizeBytes} bytes`);
          if (f.symbols.length > 0) {
            console.log('- Symbols:');
            for (const sym of f.symbols) {
              const scopeStr = sym.scope ? `${sym.scope}::` : '';
              console.log(`  - \`${sym.kind}\` \`${scopeStr}${sym.name}\` (lines ${sym.startLine}-${sym.endLine})`);
            }
          }
        }
      }

      if (result.edges.length > 0) {
        console.log('\n## Cross-File Dependencies');
        for (const edge of result.edges) {
          const srcSym = edge.sourceSymbol ? `#${edge.sourceSymbol}` : '';
          const tgtSym = edge.targetSymbol ? `#${edge.targetSymbol}` : '';
          console.log(`- \`${edge.sourceFile}${srcSym}\` → \`${edge.targetFile}${tgtSym}\` (${edge.edgeType})`);
        }
      }

      if (result.excludedFiles.length > 0) {
        console.log('\n## Excluded Files (Token budget exhausted)');
        for (const f of result.excludedFiles) {
          console.log(`- ${f}`);
        }
      }
    });

  program
    .command('export')
    .description('Export code graph for LLM consumption')
    .option('-d, --dir <path>', 'Target directory')
    .option('--format <format>', 'Output format: llm, json, dot, svg, toon', 'llm')
    .option('--tokens <budget>', 'Token budget for LLM export', '8192')
    .option('--repo <name>', 'Filter by repo name')
    .option('-o, --output <file>', 'Write output to file instead of stdout')
    .option('--exclude <glob>', 'Exclude glob pattern(s)', collectPatterns, [])
    .option('--include <glob>', 'Include glob pattern(s)', collectPatterns, [])
    .option('--delimiter <delimiter>', 'Delimiter for TOON format: comma, tab, pipe', 'comma')
    .option('--key-folding', 'Collapse single-key chains into dotted paths for TOON', false)
    .option('--cluster <mode>', 'Cluster rendering mode for DOT/SVG: none, auto', 'none')
    .option('--depth <n>', 'Maximum cluster nesting depth for DOT/SVG export', '3')
    .option('--fallback-grid', 'Force using fallback grid SVG export', false)
    .action(async (opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { config, store, graph } = await loadContext(dir);

      const format = opts.format as string;
      const tokenBudget = parseInt(opts.tokens as string, 10) || 8192;
      const outputPath = opts.output as string | undefined;
      const delimiter = opts.delimiter as 'comma' | 'tab' | 'pipe' | undefined;
      const keyFolding = !!opts.keyFolding;
      const clusterMode = (opts.cluster as string) === 'none' ? 'none' as const : 'auto' as const;
      const clusterDepth = opts.depth ? parseInt(opts.depth as string, 10) : 3;
      const fallbackGrid = !!opts.fallbackGrid;
      const clusterOpts = { cluster: clusterMode, depth: clusterDepth, forceFallback: fallbackGrid };

      if (outputPath) {
        const outputDir = resolve(outputPath, '..');
        if (!existsSync(outputDir)) {
          console.error(`Error: output directory does not exist: ${outputDir}`);
          process.exit(1);
        }
        try {
          writeFileSync(outputPath, '', 'utf-8');
        } catch {
          console.error(`Error: cannot write to: ${resolve(outputPath)}`);
          process.exit(1);
        }
      }

      const excludes = [
        ...(config.settings.excludePatterns ?? []),
        ...((opts.exclude as string[]) ?? []),
      ];
      const includes = [
        ...(config.settings.includePatterns ?? []),
        ...((opts.include as string[]) ?? []),
      ];
      const matcher = buildMatcher(excludes, includes);
      const allFiles = store.getAllFiles(opts.repo as string | undefined).map(f => f.path as string);
      const filteredFiles = allFiles.filter(f => matcher(f));

      let output: string;

      switch (format) {
        case 'json': {
          const exporter = new GraphExporter(store, graph);
          output = exporter.exportAsJSONString(opts.repo as string | undefined, filteredFiles);
          break;
        }
        case 'dot': {
          const exporter = new DotExporter(store, graph);
          output = exporter.export(opts.repo as string | undefined, filteredFiles, clusterOpts);
          break;
        }
        case 'svg': {
          const exporter = new SvgExporter(store, graph);
          output = exporter.export(opts.repo as string | undefined, filteredFiles, clusterOpts);
          break;
        }
        case 'toon': {
          const exporter = new ToonExporter(store, graph);
          output = exporter.export({
            format: 'toon',
            tokenBudget,
            repo: opts.repo as string | undefined,
            files: filteredFiles,
            delimiter,
            keyFolding,
          });
          break;
        }
        case 'llm':
        default: {
          const exporter = new LLMExporter(store, graph);
          output = exporter.export({
            format: 'llm',
            tokenBudget,
            repo: opts.repo as string | undefined,
            files: filteredFiles,
          });
          break;
        }
      }

      if (outputPath) {
        writeFileSync(resolve(outputPath), output, 'utf-8');
        console.log(`Exported ${format} to ${resolve(outputPath)} (${Buffer.byteLength(output, 'utf-8')} bytes)`);
      } else {
        console.log(output);
      }
    });

  program
    .command('summary')
    .description('Show project summary')
    .argument('[path]', 'Target directory')
    .action(async (path: string | undefined) => {
      const dir = path ? resolve(path) : resolveDir({}, program.opts());
      const { store, graph, config } = await loadContext(dir);

      const fileCount = store.getFileCount();
      const symbolCount = store.getSymbolCount();
      const edgeCount = store.getEdgeCount();
      const breakdown = store.getLanguageBreakdown();

      console.log(`Project: ${config.repo.name} (${dir})`);
      console.log(`Files: ${fileCount}`);
      console.log(`Symbols: ${symbolCount}`);
      console.log(`Dependencies: ${edgeCount}`);
      console.log(`Languages: ${Object.entries(breakdown).map(([l, c]) => `${l} (${c})`).join(', ')}`);
    });

  const langCmd = program
    .command('lang')
    .description('Manage language grammars and configuration');

  langCmd
    .command('list')
    .description('List all supported languages, their extensions, tier, and status')
    .action(() => {
      const langs = getBuiltinLanguages();
      console.log('Supported languages:');
      for (const [name, def] of Object.entries(langs)) {
        const installed = isLanguageInstalled(name) ? 'Installed' : 'Not Installed';
        console.log(`  - ${name} (${def.extensions.join(', ')} | tier: ${def.tier} | status: ${installed})`);
      }
    });

  langCmd
    .command('install <lang>')
    .description('Install grammar and query files for an installable language')
    .action(async (lang: string) => {
      try {
        clack.log.step(`Installing language '${lang}'...`);
        await installLanguage(lang);
        clack.log.success(`Successfully installed language '${lang}'.`);
      } catch (err: any) {
        clack.log.error(`Error installing language '${lang}': ${err.message}`);
        process.exit(1);
      }
    });

  langCmd
    .command('uninstall <lang>')
    .description('Uninstall grammar and query files for an installable language')
    .action(async (lang: string) => {
      try {
        clack.log.step(`Uninstalling language '${lang}'...`);
        await uninstallLanguage(lang);
        clack.log.success(`Successfully uninstalled language '${lang}'.`);
      } catch (err: any) {
        clack.log.error(`Error uninstalling language '${lang}': ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command('serve')
    .description('Start MCP server (stdio transport)')
    .option('-d, --dir <path>', 'Default target directory for MCP tools')
    .option('--port <port>', 'Port for SSE transport (default: 45123)', '45123')
    .option('--sse', 'Enable SSE transport instead of stdio')
    .option('--ui', 'Enable UI dashboard alongside MCP server')
    .option('--ui-port <port>', 'Port to run UI on (default: 45124)', '45124')
    .option('--ui-host <host>', 'Host to run UI on (default: 127.0.0.1)', '127.0.0.1')
    .option('--ui-token <token>', 'Bearer token for authorization')
    .option('--debug', 'Enable verbose debug logging of MCP calls to stderr')
    .action(async (opts: Record<string, unknown>) => {
      const defaultDir = resolveDir(opts, program.opts());
      const { startMcpServer } = await import('./mcp.js');
      
      if (opts.ui) {
        const { startUiServer } = await import('./ui-server.js');
        const uiPort = parseInt(opts.uiPort as string, 10) || 45124;
        const uiHost = (opts.uiHost as string) || '127.0.0.1';
        const uiToken = opts.uiToken as string | undefined;
        startUiServer({ port: uiPort, host: uiHost, token: uiToken, dir: defaultDir });
      }

      await startMcpServer(defaultDir, {
        sse: opts.sse as boolean | undefined,
        port: parseInt(opts.port as string, 10) || 45123,
        debug: opts.debug as boolean | undefined,
      });
    });

  program
    .command('ui')
    .description('Start the Web Dashboard')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('-p, --port <port>', 'Port to run UI on (default: 45124)', '45124')
    .option('--host <host>', 'Host to run UI on (default: 127.0.0.1)', '127.0.0.1')
    .option('--token <token>', 'Bearer token for authorization')
    .option('--no-open', 'Do not open the dashboard in the browser automatically')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      const port = parseInt(opts.port as string, 10) || 45124;
      const host = (opts.host as string) || '127.0.0.1';
      const token = opts.token as string | undefined;

      const { startUiServer } = await import('./ui-server.js');
      startUiServer({ port, host, token, dir });

      const url = `http://${host}:${port}`;
      console.log(`Mapx Web Dashboard started at ${url}`);

      if (opts.open !== false) {
        const { exec } = await import('node:child_process');
        const openCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        exec(`${openCmd} ${url}`).unref();
      }
    });

  program
    .command('metrics')
    .description('Show coupling and instability metrics for files')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--lang <language>', 'Filter metrics by language')
    .option('--verified-only', 'Only compute metrics using verified edges')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);
      const metrics = calculateMetrics(store, {
        repo: config.repo.name,
        language: opts.lang as string | undefined,
        verifiedOnly: !!opts.verifiedOnly,
      });

      if (metrics.length === 0) {
        console.log('No metrics found.');
        return;
      }

      console.log('\n── Coupling & Instability Metrics ─────────────────────');
      console.log(`${'File Path'.padEnd(45)} | ${'Lang'.padEnd(10)} | ${'Ca'.padStart(4)} | ${'Ce'.padStart(4)} | ${'Instability'.padStart(11)}`);
      console.log('-'.repeat(85));
      for (const m of metrics) {
        const pathTrunc = m.path.length > 45 ? '...' + m.path.substring(m.path.length - 42) : m.path;
        console.log(`${pathTrunc.padEnd(45)} | ${m.language.padEnd(10)} | ${String(m.afferent).padStart(4)} | ${String(m.efferent).padStart(4)} | ${m.instability.toFixed(4).padStart(11)}`);
      }
      console.log('');
    });

  program
    .command('clusters')
    .description('List detected code clusters/modules')
    .argument('[clusterOrPath]', 'Target directory or a specific cluster name to inspect')
    .option('-d, --dir <path>', 'Target directory')
    .option('--source <source>', 'Filter by cluster source: namespace, directory, community, or all', 'all')
    .option('--json', 'Output results as JSON')
    .action(async (clusterOrPath: string | undefined, opts: Record<string, unknown>) => {
      let dir = resolveDir(opts, program.opts());
      let clusterQuery: string | undefined = undefined;

      if (clusterOrPath) {
        const resolvedPath = resolve(clusterOrPath);
        if (existsSync(resolvedPath)) {
          dir = resolvedPath;
        } else {
          clusterQuery = clusterOrPath;
        }
      }

      const { config, store } = await loadContext(dir);
      const source = opts.source as string;
      const json = !!opts.json;

      const clusters = store.getClusters(config.repo.name);

      let filtered = clusters;
      if (source && source !== 'all') {
        filtered = clusters.filter((c: any) => c.source === source);
      }

      if (clusterQuery) {
        const targetCluster = clusters.find((c: any) => c.name === clusterQuery);
        if (!targetCluster) {
          console.error(`Cluster "${clusterQuery}" not found.`);
          process.exit(1);
        }

        const files = store.getClusterFiles(targetCluster.name as string, config.repo.name);
        const clusterEdges = store.getClusterEdges(targetCluster.name as string, config.repo.name);

        if (json) {
          console.log(JSON.stringify({
            cluster: targetCluster,
            files,
            edges: clusterEdges
          }, null, 2));
          return;
        }

        console.log(`\n${targetCluster.name}  [${targetCluster.source}]  ${targetCluster.file_count} files`);
        for (const f of files) {
          console.log(`  ${f}`);
        }

        const dependsOn = clusterEdges.filter(e => e.sourceCluster === targetCluster.name);
        console.log('\nDepends on:');
        if (dependsOn.length === 0) {
          console.log('  (none)');
        } else {
          for (const dep of dependsOn) {
            console.log(`  ${dep.targetCluster.padEnd(25)} [${dep.edgeCount} edges — dominant: ${dep.dominantType}]`);
          }
        }

        const dependedOnBy = clusterEdges.filter(e => e.targetCluster === targetCluster.name);
        console.log('\nDepended on by:');
        if (dependedOnBy.length === 0) {
          console.log('  (none)');
        } else {
          for (const dep of dependedOnBy) {
            console.log(`  ${dep.sourceCluster.padEnd(25)} [${dep.edgeCount} edges — dominant: ${dep.dominantType}]`);
          }
        }
        console.log('');
        return;
      }

      if (json) {
        console.log(JSON.stringify({ clusters: filtered }, null, 2));
        return;
      }

      const roots: any[] = [];
      const childrenMap = new Map<string, any[]>();
      
      for (const c of filtered) {
        if (!c.parent_name) {
          roots.push(c);
        } else {
          const parentName = c.parent_name as string;
          if (!childrenMap.has(parentName)) {
            childrenMap.set(parentName, []);
          }
          childrenMap.get(parentName)!.push(c);
        }
      }

      for (const list of childrenMap.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name));
      }
      roots.sort((a, b) => a.name.localeCompare(b.name));

      const printTree = (node: any, indent: number) => {
        const padding = '  '.repeat(indent);
        const namePart = node.name;
        const sourcePart = `(${node.source})`;
        const filesPart = `[${node.file_count} files]`;
        
        const formatted = `${padding}${namePart.padEnd(35 - indent * 2)}${sourcePart.padEnd(15)} ${filesPart}`;
        console.log(formatted);

        const children = childrenMap.get(node.name) || [];
        for (const child of children) {
          printTree(child, indent + 1);
        }
      };

      console.log('');
      for (const root of roots) {
        printTree(root, 0);
      }

      const nsCount = filtered.filter((c: any) => c.source === 'namespace').length;
      const dirCount = filtered.filter((c: any) => c.source === 'directory').length;
      const commCount = filtered.filter((c: any) => c.source === 'community').length;
      console.log(`\n${filtered.length} clusters detected (${nsCount} namespace, ${dirCount} directory, ${commCount} community)\n`);
    });

  program
    .command('edges')
    .description('Granular query of dependency edges')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--type <type>', 'Filter edges by type')
    .option('--from <file>', 'Filter edges originating from a file pattern')
    .option('--to <file>', 'Filter edges targeting a file pattern')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);
      const edges = store.queryEdges({
        repo: config.repo.name,
        type: opts.type as string | undefined,
        from: opts.from as string | undefined,
        to: opts.to as string | undefined,
      });

      if (edges.length === 0) {
        console.log('No matching edges found.');
        return;
      }

      console.log(`\nFound ${edges.length} matching edges:`);
      for (const e of edges) {
        const srcSym = e.source_symbol ? `#${e.source_symbol}` : '';
        const tgtSym = e.target_symbol ? `#${e.target_symbol}` : '';
        const infSuffix = e.verifiability === 'inferred' ? ' [inferred]' : '';
        console.log(`- ${e.source_file}${srcSym} → ${e.target_file}${tgtSym} (${e.edge_type})${infSuffix}`);
      }
      console.log('');
    });

  program
    .command('routes')
    .description('Show routes from all detected frameworks')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--framework <name>', 'Filter by framework name')
    .option('--method <verb>', 'Filter by HTTP method (GET, POST, etc.)')
    .option('--path-pattern <pattern>', 'Filter by route path pattern')
    .option('--json', 'Output routes as JSON')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      const routeRegistry = new RouteRegistry();
      await routeRegistry.load(dir);

      const routes = routeRegistry.queryRoutes({
        framework: opts.framework as string | undefined,
        method: opts.method as string | undefined,
        path: opts.pathPattern as string | undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(routes, null, 2));
        return;
      }

      if (routes.length === 0) {
        console.log('No routes found.');
        return;
      }

      console.log(`\nDetected Routes (${routes.length}):`);
      console.log(''.padEnd(80, '-'));
      console.log(`${'Framework'.padEnd(12)} | ${'Method'.padEnd(8)} | ${'Path'.padEnd(30)} | ${'Handler'}`);
      console.log(''.padEnd(80, '-'));
      for (const r of routes) {
        const handler = r.handlerSymbol || r.handlerFile;
        console.log(`${r.framework.padEnd(12)} | ${r.method.toUpperCase().padEnd(8)} | ${r.path.padEnd(30)} | ${handler}`);
      }
      console.log(''.padEnd(80, '-'));
      console.log('');
    });

  program
    .command('hooks')
    .description('Show hooks from all detected frameworks')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--framework <name>', 'Filter by framework name')
    .option('--type <type>', 'Filter by hook type')
    .option('--name <pattern>', 'Filter by hook name pattern')
    .option('--json', 'Output hooks as JSON')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      const routeRegistry = new RouteRegistry();
      await routeRegistry.load(dir);

      const hooks = routeRegistry.queryHooks({
        framework: opts.framework as string | undefined,
        hookType: opts.type as string | undefined,
        hookName: opts.name as string | undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(hooks, null, 2));
        return;
      }

      if (hooks.length === 0) {
        console.log('No hooks found.');
        return;
      }

      console.log(`\nDetected Hooks (${hooks.length}):`);
      console.log(''.padEnd(80, '-'));
      console.log(`${'Framework'.padEnd(12)} | ${'Type'.padEnd(15)} | ${'Hook Name'.padEnd(25)} | ${'Handler'}`);
      console.log(''.padEnd(80, '-'));
      for (const h of hooks) {
        const handler = h.handlerSymbol || h.handlerFile;
        console.log(`${h.framework.padEnd(12)} | ${h.hookType.padEnd(15)} | ${h.hookName.padEnd(25)} | ${handler}`);
      }
      console.log(''.padEnd(80, '-'));
      console.log('');
    });

  const agentsCmd = program.command('agents').description('Manage LLM agent integration files');

  agentsCmd
    .command('list')
    .description('List all supported LLM integration providers')
    .action(() => {
      const generator = new AgentGenerator();
      const providers = generator.listProviders();
      console.log('\nSupported LLM integration providers:');
      for (const p of providers) {
        const temp = generator.getTemplate(p);
        const appendStr = temp?.isAppend ? ' (append-mode)' : '';
        console.log(`  - ${p.padEnd(12)} -> ${temp?.filename}${appendStr}`);
      }
      console.log('');
    });

  agentsCmd
    .command('generate')
    .description('Generate/overwrite LLM integration files')
    .option('--providers <list>', 'Comma-separated list of providers to generate')
    .option('--all', 'Generate integration files for all supported providers')
    .option('--dry-run', 'Show actions without writing files')
    .option('--force', 'Force overwrite of existing files without prompt')
    .option('--mcp-port <number>', 'Port for the MCP SSE transport server', '3456')
    .action(async (opts: Record<string, any>) => {
      const dir = program.opts().dir ? resolve(program.opts().dir) : process.cwd();
      const generator = new AgentGenerator();
      const available = generator.listProviders();
      let targets: string[] = [];

      if (opts.all) {
        targets = available;
      } else if (opts.providers) {
        targets = opts.providers.split(',').map((s: string) => s.trim().toLowerCase()).filter((p: string) => available.includes(p));
      } else {
        if (process.stdin.isTTY) {
          targets = await selectProvidersInteractive();
        } else {
          targets = ['generic'];
        }
      }

      if (targets.length === 0) {
        clack.log.error('No valid providers specified.');
        process.exit(1);
      }

      const actions = generator.plan(targets, { dir, mcpPort: parseInt(opts.mcpPort, 10) });

      for (const action of actions) {
        if (action.status === 'up_to_date') {
          clack.log.info(`${action.filename}: Up to date. Skipping.`);
          continue;
        }

        if (action.status === 'update_conflict' || action.status === 'no_sentinel') {
          clack.log.warn(`Conflict/Modification detected in ${action.filename}:`);
          if (action.diff) {
            console.log(action.diff);
          }
          if (!opts.force) {
            const confirm = await clack.confirm({
              message: `Overwrite ${action.filename}?`,
              initialValue: false,
            });
            if (clack.isCancel(confirm) || !confirm) {
              clack.log.warn(`Skipped ${action.filename}.`);
              continue;
            }
          }
        }

        if (opts.dryRun) {
          clack.log.info(`[DRY RUN] Would write to ${action.filepath} (status: ${action.status})`);
        } else {
          generator.execute(action);
          clack.log.success(`Wrote to ${action.filename} (status: ${action.status})`);
        }
      }
    });

  agentsCmd
    .command('update')
    .description('Update existing LLM integration files to the current MapxGraph version')
    .option('--dry-run', 'Show updates without writing files')
    .option('--force', 'Force overwrite of customized blocks without prompt')
    .option('--mcp-port <number>', 'Port for the MCP SSE transport server', '3456')
    .action(async (opts: Record<string, any>) => {
      const dir = program.opts().dir ? resolve(program.opts().dir) : process.cwd();
      const generator = new AgentGenerator();
      const available = generator.listProviders();

      const existingProviders = available.filter(p => {
        const temp = generator.getTemplate(p);
        return temp && existsSync(join(dir, temp.filename));
      });

      if (existingProviders.length === 0) {
        clack.log.info('No existing LLM integration files found to update.');
        return;
      }

      const actions = generator.plan(existingProviders, { dir, mcpPort: parseInt(opts.mcpPort, 10) });
      let updatedCount = 0;

      for (const action of actions) {
        if (action.status === 'up_to_date') {
          continue;
        }

        if (action.status === 'update_conflict') {
          clack.log.warn(`Customized content detected in ${action.filename}:`);
          if (action.diff) {
            console.log(action.diff);
          }
          if (!opts.force) {
            const confirm = await clack.confirm({
              message: `Overwrite customizations in ${action.filename}?`,
              initialValue: false,
            });
            if (clack.isCancel(confirm) || !confirm) {
              clack.log.warn(`Skipped ${action.filename}.`);
              continue;
            }
          }
        }

        if (opts.dryRun) {
          clack.log.info(`[DRY RUN] Would update ${action.filepath}`);
        } else {
          generator.execute(action);
          clack.log.success(`Updated ${action.filename}`);
          updatedCount++;
        }
      }

      if (updatedCount === 0 && !opts.dryRun) {
        clack.log.success('All integration files are already up to date.');
      }
    });

  agentsCmd
    .command('mcp')
    .description('Auto-detect agent tools and generate/update MCP config files')
    .option('--tools <list>', 'Comma-separated list of tools to generate configs for (opencode, gemini-cli, cursor-mcp, vscode-mcp)')
    .option('--all', 'Generate MCP configs for all supported tools')
    .option('--detect', 'Only detect agent tools without writing files')
    .option('--dry-run', 'Show actions without writing files')
    .action(async (opts: Record<string, any>) => {
      const dir = program.opts().dir ? resolve(program.opts().dir) : process.cwd();
      const generator = new AgentGenerator();
      const allConfigs = generator.listMcpConfigs();

      // Select targets
      let targets: typeof allConfigs;
      if (opts.all) {
        targets = allConfigs;
      } else if (opts.tools) {
        const requested = opts.tools.split(',').map((s: string) => s.trim().toLowerCase());
        targets = allConfigs.filter(c => requested.includes(c.name));
      } else {
        // Auto-detect
        targets = generator.detectAgentTools(dir);
      }

      if (opts.detect) {
        if (targets.length === 0) {
          clack.log.info('No agent tools detected in this project.');
        } else {
          clack.log.info(`Detected agent tools (${targets.length}):`);
          for (const t of targets) {
            clack.log.success(`${t.name.padEnd(15)} → ${t.filename}`);
          }
        }
        clack.log.info(`All available targets:`);
        for (const c of allConfigs) {
          const detected = targets.includes(c);
          const icon = detected ? '✓' : '·';
          clack.log.info(`${icon} ${c.name.padEnd(15)} → ${c.filename}`);
        }
        return;
      }

      if (targets.length === 0) {
        clack.log.warn('No agent tools detected. Use --all or --tools to specify targets.');
        return;
      }

      const actions = generator.generateMcpConfigs(targets, { dir });
      for (const action of actions) {
        if (action.status === 'up_to_date') {
          clack.log.info(`${action.filename}: Up to date.`);
          continue;
        }
        if (opts.dryRun) {
          clack.log.info(`[DRY RUN] Would ${action.status} ${action.filename} (${action.tool})`);
        } else {
          generator.executeMcpConfig(action);
          const verb = action.status === 'merge' ? 'merged into' : action.status === 'create' ? 'created' : 'updated';
          clack.log.success(`MCP config ${verb} ${action.filename} (${action.tool})`);
        }
      }
    });

  const workspacesCmd = program.command('workspaces').description('Manage multi-repository workspace contexts');

  workspacesCmd
    .command('list')
    .alias('show')
    .description('List registered repositories and other discovered peer/submodule directories')
    .action(async () => {
      const dir = resolveDir({}, program.opts());
      const { config } = await loadContext(dir);

      console.log('\nRegistered repositories:');
      const registeredPaths = new Set<string>();
      for (const r of config.repos) {
        const absPath = resolve(dir, r.path);
        registeredPaths.add(absPath);
        const fwStr = r.framework ? ` [${r.framework}]` : '';
        console.log(`  - ${r.name.padEnd(15)} -> ${r.path} (active)${fwStr}`);
      }

      // Discover uninitialized submodules
      const submodules = WorkspaceManager.discoverSubmodules(dir);
      const uninitSubmodules = submodules.filter(s => !registeredPaths.has(resolve(dir, s.path)));
      if (uninitSubmodules.length > 0) {
        console.log('\nDiscovered submodules:');
        for (const s of uninitSubmodules) {
          const status = s.isInitialized ? 'available' : 'uninitialized';
          console.log(`  - ${s.name.padEnd(15)} -> ${s.path} (${status})`);
        }
      }

      // Discover peer repos
      const peers = WorkspaceManager.discoverPeerRepos(dir);
      const uninitPeers = peers.filter(p => !registeredPaths.has(resolve(dir, p.path)));
      if (uninitPeers.length > 0) {
        console.log('\nDiscovered peer repositories:');
        for (const p of uninitPeers) {
          console.log(`  - ${p.name.padEnd(15)} -> ${p.path} (available)`);
        }
      }

      // Discover VS Code workspace files
      const wsFiles = readdirSync(dir).filter(f => f.endsWith('.code-workspace'));
      if (wsFiles.length > 0) {
        console.log('\nDiscovered VS Code Workspace folders:');
        for (const f of wsFiles) {
          const wsFolderRepos = WorkspaceManager.discoverVSCodeWorkspace(join(dir, f), dir);
          const uninitWs = wsFolderRepos.filter(p => !registeredPaths.has(resolve(dir, p.path)));
          for (const p of uninitWs) {
            console.log(`  - ${p.name.padEnd(15)} -> ${p.path} (available)`);
          }
        }
      }
      console.log('');
    });

  workspacesCmd
    .command('add <path>')
    .description('Register a repository path')
    .option('--name <name>', 'Repository name (defaults to folder name)')
    .action(async (repoPath: string, opts: Record<string, unknown>) => {
      const dir = resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);

      const absPath = resolve(dir, repoPath);
      if (!existsSync(absPath)) {
        clack.log.error(`Path ${repoPath} does not exist.`);
        process.exit(1);
      }
      if (!isGitRepo(absPath)) {
        clack.log.error(`Path ${repoPath} is not a git repository.`);
        process.exit(1);
      }

      const relPath = relative(dir, absPath);
      const name = (opts.name as string) || basename(absPath);

      if (config.repos.some(r => r.name === name || r.path === relPath)) {
        clack.log.warn(`Repository already registered: ${name} (${relPath})`);
        return;
      }

      config.addRepo(name, relPath);
      await config.save();
      clack.log.success(`Registered repository: ${name} -> ${relPath}`);

      clack.log.step('Running initial full scan for the new repository...');
      const onProgress = createProgressRenderer();
      const scanner = new Scanner(store, config, graph, onProgress);

      const onSigInt = () => {
        scanner.abort();
        onProgress.stop('Canceled');
      };
      process.once('SIGINT', onSigInt);

      const result = await scanner.scanFull([name]).catch((err) => {
        onProgress.stop();
        throw err;
      });

      process.removeListener('SIGINT', onSigInt);
      onProgress.stop();
      clack.log.success(`Scanned ${result.filesScanned} files, ${result.symbolsFound} symbols, ${result.edgesFound} edges in ${result.durationMs}ms`);
    });

  workspacesCmd
    .command('remove <name>')
    .description('Unregister a repository by name or path')
    .action(async (name: string) => {
      const dir = resolveDir({}, program.opts());
      const { config, store } = await loadContext(dir);

      const repo = config.repos.find(r => r.name === name || r.path === name);
      if (!repo) {
        clack.log.error(`Repository ${name} is not registered.`);
        process.exit(1);
      }

      const repoName = repo.name;
      config.removeRepo(name);
      await config.save();
      clack.log.success(`Unregistered repository: ${repoName}`);

      clack.log.step(`Cleaning up stored data for repository: ${repoName}...`);
      store.deleteRepo(repoName);
      clack.log.success(`Done.`);
    });

  workspacesCmd
    .command('discover')
    .description('Discover unregistered submodules, peer repos, and VS Code workspace folders (read-only)')
    .action(async () => {
      const dir = resolveDir({}, program.opts());
      const { config } = await loadContext(dir);

      const registeredPaths = new Set<string>();
      for (const r of config.repos) {
        registeredPaths.add(resolve(dir, r.path));
      }

      let found = 0;

      // Submodules
      const submodules = WorkspaceManager.discoverSubmodules(dir);
      const uninitSubs = submodules.filter(s => !registeredPaths.has(resolve(dir, s.path)));
      if (uninitSubs.length > 0) {
        console.log('\nSubmodules:');
        for (const s of uninitSubs) {
          const status = s.isInitialized ? 'available' : 'uninitialized';
          console.log(`  - ${s.name.padEnd(20)} -> ${s.path} (${status})`);
        }
        found += uninitSubs.length;
      }

      // Peer repos
      const peers = WorkspaceManager.discoverPeerRepos(dir);
      const uninitPeers = peers.filter(p => !registeredPaths.has(resolve(dir, p.path)));
      if (uninitPeers.length > 0) {
        console.log('\nPeer repositories:');
        for (const p of uninitPeers) {
          console.log(`  - ${p.name.padEnd(20)} -> ${p.path} (available)`);
        }
        found += uninitPeers.length;
      }

      // VS Code workspace folders
      const wsFiles = readdirSync(dir).filter(f => f.endsWith('.code-workspace'));
      const vsEntries: Array<{ name: string; path: string }> = [];
      for (const f of wsFiles) {
        const wsFolderRepos = WorkspaceManager.discoverVSCodeWorkspace(join(dir, f), dir);
        for (const p of wsFolderRepos) {
          if (!registeredPaths.has(resolve(dir, p.path))) {
            vsEntries.push({ name: p.name, path: p.path });
          }
        }
      }
      if (vsEntries.length > 0) {
        console.log('\nVS Code workspace folders:');
        for (const p of vsEntries) {
          console.log(`  - ${p.name.padEnd(20)} -> ${p.path} (available)`);
        }
        found += vsEntries.length;
      }

      if (found === 0) {
        console.log('No unregistered repositories discovered.');
      } else {
        console.log(`\n${found} unregistered repositor${found === 1 ? 'y' : 'ies'} discovered. Use \`mapx workspaces add <path>\` to register.`);
      }
    });

  workspacesCmd
    .command('sync')
    .description('Sync all discovered submodules, peer repos, and VS Code workspace folders')
    .action(async () => {
      const dir = resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);

      const registeredPaths = new Set<string>();
      for (const r of config.repos) {
        registeredPaths.add(resolve(dir, r.path));
      }

      const toAdd: Array<{ name: string; path: string }> = [];

      // 1. Submodules
      const submodules = WorkspaceManager.discoverSubmodules(dir);
      for (const s of submodules) {
        if (s.isInitialized) {
          const abs = resolve(dir, s.path);
          if (!registeredPaths.has(abs)) {
            toAdd.push({ name: s.name, path: s.path });
            registeredPaths.add(abs);
          }
        }
      }

      // 2. Peer repos
      const peers = WorkspaceManager.discoverPeerRepos(dir);
      for (const p of peers) {
        const abs = resolve(dir, p.path);
        if (!registeredPaths.has(abs)) {
          toAdd.push({ name: p.name, path: p.path });
          registeredPaths.add(abs);
        }
      }

      // 3. VS Code Workspaces
      const wsFiles = readdirSync(dir).filter(f => f.endsWith('.code-workspace'));
      for (const f of wsFiles) {
        const wsFolderRepos = WorkspaceManager.discoverVSCodeWorkspace(join(dir, f), dir);
        for (const p of wsFolderRepos) {
          const abs = resolve(dir, p.path);
          if (!registeredPaths.has(abs)) {
            toAdd.push({ name: p.name, path: p.path });
            registeredPaths.add(abs);
          }
        }
      }

      if (toAdd.length === 0) {
        clack.log.info('No new repositories discovered to sync.');
        return;
      }

      clack.log.step(`Syncing ${toAdd.length} newly discovered repositories:`);
      for (const item of toAdd) {
        config.addRepo(item.name, item.path);
        clack.log.success(`Registered: ${item.name} -> ${item.path}`);
      }
      await config.save();

      clack.log.step('Running initial full scan for new repositories...');
      const newNames = toAdd.map(item => item.name);
      const onProgress = createProgressRenderer();
      const scanner = new Scanner(store, config, graph, onProgress);

      const onSigInt = () => {
        scanner.abort();
        onProgress.stop('Canceled');
      };
      process.once('SIGINT', onSigInt);

      const result = await scanner.scanFull(newNames).catch((err) => {
        onProgress.stop();
        throw err;
      });

      process.removeListener('SIGINT', onSigInt);
      onProgress.stop();
      clack.log.success(`Scanned ${result.filesScanned} files, ${result.symbolsFound} symbols, ${result.edgesFound} edges in ${result.durationMs}ms`);
    });

  return program;
}

export async function loadContext(dir: string): Promise<{
  config: Config;
  store: Store;
  graph: MapxGraph;
}> {
  const configPath = resolve(dir, '.mapx', 'config.json');
  if (!existsSync(configPath)) {
    console.error(`MapxGraph not initialized in ${dir}. Run \`mapx init ${dir}\` first.`);
    process.exit(1);
  }

  const config = await Config.load(dir);
  const dbPath = resolve(dir, '.mapx', 'mapx.db');
  const store = new Store(dbPath);

  // Ensure the DB connection is closed when the process exits normally or
  // after an unhandled error — this prevents the process from hanging after
  // command completion due to SQLite's open file descriptor keeping the event
  // loop alive.
  const closeStore = () => { try { store.close(); } catch { /* already closed */ } };
  process.once('exit', closeStore);
  process.once('SIGINT', () => { closeStore(); process.exit(130); });
  process.once('SIGTERM', () => { closeStore(); process.exit(143); });

  const graph = new MapxGraph(config.repo.name);

  const files = store.getAllFiles();
  for (const file of files) {
    graph.addFileNode(
      file.path as string,
      file.language as string,
      file.size_bytes as number,
      file.lines as number
    );
  }

  const symbols = store.getAllSymbols();
  for (const sym of symbols) {
    graph.addSymbolNode(
      sym.name as string,
      sym.file_path as string,
      sym.name as string,
      sym.kind as any,
      sym.start_line as number,
      sym.end_line as number,
      sym.scope as string | null
    );
  }

  const edges = store.getAllEdges();
  for (const edge of edges) {
    graph.addDependencyEdge({
      sourceFile: edge.source_file as string,
      targetFile: edge.target_file as string,
      sourceSymbol: edge.source_symbol as string | null,
      targetSymbol: edge.target_symbol as string | null,
      edgeType: edge.edge_type as any,
      repo: edge.repo as string,
      weight: edge.weight as number,
      verifiability: edge.verifiability as any,
      targetRepo: edge.target_repo as string | null,
    });
  }

  return { config, store, graph };
}

export function getStaleFilesCount(store: Store, dir: string): number {
  try {
    const files = store.getAllFiles();
    let changedCount = 0;
    for (const file of files) {
      const absPath = resolve(dir, file.path as string);
      if (existsSync(absPath)) {
        const stats = statSync(absPath);
        const dbTime = new Date(file.last_scanned as string).getTime();
        if (stats.mtimeMs > dbTime) {
          changedCount++;
        }
      } else {
        changedCount++;
      }
    }
    return changedCount;
  } catch {
    return 0;
  }
}

export function checkAndPrintStaleness(store: Store, dir: string): void {
  const staleCount = getStaleFilesCount(store, dir);
  if (staleCount > 0) {
    // Show up to 5 changed file names
    const files = store.getAllFiles();
    const changed: string[] = [];
    for (const file of files) {
      if (changed.length >= 5) break;
      const absPath = resolve(dir, file.path as string);
      if (existsSync(absPath)) {
        const stats = statSync(absPath);
        const dbTime = new Date(file.last_scanned as string).getTime();
        if (stats.mtimeMs > dbTime) changed.push(file.path as string);
      } else {
        changed.push(`${file.path} (deleted)`);
      }
    }
    const fileList = changed.length > 0
      ? `\nChanged: ${changed.join(', ')}${staleCount > changed.length ? ` (and ${staleCount - changed.length} more)` : ''}`
      : '';
    console.warn(`⚠️  Warning: Graph index may be stale. ${staleCount} file(s) have changed on disk since the last scan. Run 'mapx update' to sync.${fileList}\n`);
  }
}

export function checkTryCatch(content: string, lineNum: number, startLine: number, isPython: boolean): boolean {
  return coreCheckTryCatch(content, lineNum, startLine, isPython);
}

