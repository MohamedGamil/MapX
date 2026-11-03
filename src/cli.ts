import { printBanner } from './branding.js';
import { Command } from 'commander';
import { resolve, join, dirname, relative, basename, sep, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import { Store } from './core/store.js';
import { MapxGraph } from './core/graph.js';
import { Scanner } from './core/scanner.js';
import { buildPathFilter } from './core/file-rules.js';
import { Config } from './core/config.js';
import { FlowTracer, TraceNode } from './core/flow-tracer.js';
import { ContextBuilder } from './core/context-builder.js';
import { AgentGenerator, needsConsent, droppedCommentsWarning } from './agents/generator.js';
import { WorkspaceManager } from './core/workspace-manager.js';
import { applyCollapsedRepos, codeWorkspaceFiles, crossRepoDependencies, crossRepoPairs, summarizeRepos, table, timeAgo, workspaceExport } from './core/workspace-summary.js';
import { LLMExporter } from './exporters/llm-exporter.js';
import { GraphExporter } from './exporters/graph-exporter.js';
import { DotExporter } from './exporters/dot-exporter.js';
import { SvgExporter } from './exporters/svg-exporter.js';
import { ToonExporter } from './exporters/toon-exporter.js';
import { calculateDSM, buildMetricsReport, formatDsmText, formatMetricsText, parseFormat, parseTop, METRICS_DEFAULT_TOP } from './core/metrics.js';
import { currentSmells } from './core/architecture-analyzer.js';
import { getChangedFiles, isGitRepo, type GitFileStatus } from './core/git-tracker.js';
import { filterChanges, findStaleFiles, indexableChanges, staleCount, staleNames, unlistedStale } from './core/staleness.js';
import { outdatedIndexWarning } from './core/extractor-version.js';
import { indexGate } from './arch/index-gate.js';
import { fileNotFoundMessage, resolveFilePaths } from './core/file-resolve.js';
import { calleeScopeHints, directionError, edgeView, fileEdges, formatFileEdgesText, indexedPath, notIndexedMessage, type EdgeDirection } from './core/edge-view.js';
import { describeBinding, describeRelation, fileBindings, modelRelations } from './core/relations.js';
import { ImpactAnalyzer, checkTryCatch as coreCheckTryCatch } from './core/impact-analyzer.js';
import { formatLanguageInfo, formatLanguageList, installLanguage, uninstallLanguage } from './languages/installer.js';
import type { ScanProgress, ProgressCallback } from './types.js';
import { RouteRegistry, toRouteView } from './frameworks/route-registry.js';
import { loadClientCalls } from './frameworks/http/http-registry.js';
import { VERSION } from './version.js';
import { architectureConfigPath, ConfigError, formatValidation, loadArchitectureConfig, PRESETS, validateArchitectureConfig } from './arch/config.js';
import { InitError, INIT_SOURCES, initOptionsProblem, runInit, type InitSource } from './arch/infer.js';
import { EDGE_TYPES, type ArchitectureConfig } from './arch/schema.js';
import { buildReport, configErrorReport, runArchitecture, type ArchReport } from './arch/report.js';
import { CHECK_RULES, EXIT, exitCode, shownReport, type CheckOptions } from './arch/check.js';
import { baselineLocation, displayPath, loadBaseline, loadCompareReport, renderBaseline } from './arch/baseline.js';
import { defaultFormat, FORMATS, GRAPH_FORMATS, layerGraph, renderLayerGraph, renderReport, reportPathPrefix, type GraphFormat, type ReportContext, type ReportFormat } from './arch/reporters/index.js';
import { keyLine } from './arch/reporters/context.js';

/** The line of a configuration file naming `key`, or undefined (an unreadable file, or none). */
const configKeyLine = (file: string, key: string) => { try { return keyLine(readFileSync(file, 'utf8'), key); } catch { return undefined; } };
import { changedLayers, changedSince, IntrospectError, isAllowed, layerDependencies, layerMembers, layerSummaries, openArchitecture, unassignedElements, unusedAllowances, whichLayers, type ArchContext } from './arch/introspect.js';
import { findSimilarSymbols, globToLike } from './core/fuzzy-matcher.js';
import * as clack from '@clack/prompts';

const dynamicRequire = createRequire(import.meta.url);

function collectPatterns(val: string, memo: string[]): string[] {
  // An empty pattern (`--include ''`, `--exclude 'src/**,'`) names nothing; picomatch throws on one.
  return memo.concat(val.split(',').map(s => s.trim()).filter(Boolean));
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
    .option('--no-discover', 'Skip monorepo / nested-repo discovery step')
    .option('--no-workspaces', 'Skip the submodule and VS Code workspace registration step')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      // The compact MapX logo heads init's output on a terminal (D028, M4-25); never in pipes or CI.
      printBanner();
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
            if (action.status === 'key_conflict') {
              clack.log.warn(`Skipped ${action.filename}: ${action.note}`);
              continue;
            }
            if (needsConsent(action)) {
              const confirm = await clack.confirm({ message: `${action.filename} has content mapx did not write. ${action.status === 'remove' ? 'Remove' : 'Overwrite'} it?`, initialValue: false });
              if (clack.isCancel(confirm) || !confirm) {
                clack.log.warn(`Skipped ${action.filename}.`);
                continue;
              }
            }
            generator.execute(action);
            clack.log.success(action.status === 'remove' ? `${action.filename}: ${action.note}` : `Generated ${action.filename} (${action.status})`);
          }
        } else {
          const generator = new AgentGenerator();
          const actions = generator.plan(['generic'], { dir });
          for (const action of actions) {
            if (action.status === 'key_conflict') {
              clack.log.warn(`Skipped ${action.filename}: ${action.note}`);
              continue;
            }
            if (needsConsent(action)) {
              clack.log.warn(`Skipped ${action.filename}: it has content mapx did not write; run \`mapx agents generate --force\` to overwrite it.`);
              continue;
            }
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
            if (action.status === 'unparseable') {
              clack.log.warn(`Skipped ${action.filename}: it is not valid JSON, so the mapx server was not added.`);
              continue;
            }
            generator.executeMcpConfig(action);
            const verb = action.status === 'merge' ? 'merged into' : action.status === 'create' ? 'created' : 'updated';
            clack.log.success(`MCP config ${verb} ${action.filename} (${action.tool})`);
            const lost = droppedCommentsWarning(action);
            if (lost) clack.log.warn(lost);
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

      // Submodules and VS Code workspace folders (F18; skip with --no-workspaces). Registering
      // needs a TTY prompt; otherwise init only reports what it found (M0-10-R1).
      if (opts.workspaces !== false) {
        const registered = new Set(config.repos.map(r => WorkspaceManager.repoKey(dir, r.path)));
        const groups: { title: string; question: string; repos: { name: string; path: string }[] }[] = [];
        const submodules = WorkspaceManager.discoverSubmodules(dir);
        if (submodules.length > 0) {
          console.log(`\nDetected .gitmodules with ${submodules.length} submodule(s):`);
          for (const s of submodules) console.log(`  ${s.name.padEnd(20)} (${s.path}) ${s.isInitialized ? '✓ initialised' : '✗ not initialised'}`);
          groups.push({ title: 'submodule', question: 'Register initialised submodules?', repos: submodules.filter(s => s.isInitialized && !registered.has(WorkspaceManager.repoKey(dir, s.path))) });
        }
        // A folder offered once (e.g. a submodule, or a symlink to it) is not offered again (M0-10-R2).
        const offered = new Set([...registered, ...submodules.filter(s => s.isInitialized).map(s => WorkspaceManager.repoKey(dir, s.path))]);
        for (const file of codeWorkspaceFiles(dir)) {
          const folders = WorkspaceManager.discoverVSCodeWorkspace(file, dir).filter(f => {
            const key = WorkspaceManager.repoKey(dir, f.path);
            if (offered.has(key)) return false;
            offered.add(key);
            return true;
          });
          if (!folders.length) continue;
          console.log(`\nDetected VS Code workspace file: ${basename(file)}`);
          console.log(`  Additional repos: ${folders.map(f => `${f.name} (${f.path})`).join(', ')}`);
          groups.push({ title: 'workspace repo', question: 'Register workspace repos?', repos: folders });
        }
        for (const group of groups.filter(g => g.repos.length)) {
          if (!process.stdin.isTTY) {
            console.log(`Run \`mapx workspaces sync\` to register ${group.repos.length} ${group.title}(s).`);
            continue;
          }
          const ok = await clack.confirm({ message: group.question, initialValue: true });
          if (clack.isCancel(ok) || !ok) continue;
          for (const r of group.repos) {
            config.addRepo(r.name, r.path);
            registered.add(WorkspaceManager.repoKey(dir, r.path));
          }
          await config.save();
          clack.log.success(`Registered ${group.repos.length} ${group.title}(s). Run \`mapx scan --all\` to index all repos.`);
        }
      }

      // Monorepo / nested-repo discovery step (default on, disable with --no-discover)
      if (opts.discover !== false && process.stdin.isTTY) {
        const nestedRepos = WorkspaceManager.discoverNestedGitRepos(dir);
        const monoPkgs = WorkspaceManager.discoverMonorepoPackages(dir);
        const registeredPaths = new Set(config.repos.map(r => WorkspaceManager.repoKey(dir, r.path)));
        const newNested = nestedRepos.filter(n => !registeredPaths.has(WorkspaceManager.repoKey(dir, n.path)));
        const newMono   = monoPkgs.filter(p => !registeredPaths.has(WorkspaceManager.repoKey(dir, p.path)));

        if (newNested.length > 0 || newMono.length > 0) {
          const totalFound = newNested.length + newMono.length;
          clack.log.info(`Found ${totalFound} additional package${totalFound === 1 ? '' : 's'} / nested repo${totalFound === 1 ? '' : 's'} in this workspace.`);

          const shouldDiscover = await clack.confirm({
            message: `Discover and register them now?`,
            initialValue: true,
          });

          if (!clack.isCancel(shouldDiscover) && shouldDiscover) {
            const toRegister: Array<{ name: string; path: string }> = [];

            if (newNested.length > 0) {
              const chosenNested = await clack.multiselect({
                message: `Select nested git repositories to register (${newNested.length} found):`,
                options: newNested.map(n => ({ value: n.path, label: `${n.name}  (${n.path})` })),
                required: false,
              });
              if (!clack.isCancel(chosenNested)) {
                for (const p of chosenNested as string[]) {
                  const n = newNested.find(x => x.path === p)!;
                  toRegister.push({ name: n.name, path: n.path });
                }
              }
            }

            if (newMono.length > 0) {
              const mgr = newMono[0].packageManager;
              const chosenMono = await clack.multiselect({
                message: `Select monorepo packages to register [${mgr}] (${newMono.length} found):`,
                options: newMono.map(p => ({ value: p.path, label: `${p.name}  (${p.path})` })),
                required: false,
              });
              if (!clack.isCancel(chosenMono)) {
                for (const p of chosenMono as string[]) {
                  const pkg = newMono.find(x => x.path === p);
                  if (pkg) toRegister.push({ name: pkg.name, path: pkg.path });
                }
              }
            }

            if (toRegister.length > 0) {
              for (const item of toRegister) {
                config.addRepo(item.name, item.path);
                clack.log.success(`Registered: ${item.name} -> ${item.path}`);
              }
              await config.save();
            }
          }
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
    .option('--repo <name>', 'Scan only a specific registered repository (default: every registered repository)')
    .option('--all', 'Scan all registered repositories (the default)')
    .option('--force', 'Force re-parsing of all files (bypass cache)', false)
    .option('--no-parallel', 'Parse on the main thread only (default: worker threads when the work repays them; see settings.parseWorkers)')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      // The compact MapX logo heads scan's output on a terminal (M4-25, D031); never in pipes or CI.
      printBanner();
      const dir = path ? resolve(path) : resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);

      const onProgress = createProgressRenderer();
      const scanner = new Scanner(store, config, graph, onProgress, {
        excludes: opts.exclude as string[],
        includes: opts.include as string[],
        parallel: opts.parallel as boolean | undefined,
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
    .option('--repo <name>', 'Update only a specific registered repository (default: every registered repository)')
    .option('--all', 'Update all registered repositories (the default)')
    .option('--no-parallel', 'Parse on the main thread only (default: worker threads when the work repays them; see settings.parseWorkers)')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      // As for scan: the compact logo heads update/sync on a terminal (M4-25, D031).
      printBanner();
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
        parallel: opts.parallel as boolean | undefined,
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
    .option('--all', 'Per-repository status table for every registered repository')
    .addHelpText('after', '\nPer-file coupling (Ca, Ce, instability, PageRank) is in `mapx metrics` (`--format json --top N`).')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);

      if (opts.all) {
        // F18 per-repo table; changed files are attributed through each file's repo (M0-10-R1).
        const stale = findStaleFiles(store, dir);
        const repoOf = new Map(store.getAllFiles().map(f => [f.path as string, f.repo as string]));
        const changed = new Map<string, number>();
        for (const f of [...stale.changed, ...stale.deleted]) {
          const repo = repoOf.get(f) ?? config.repo.name;
          changed.set(repo, (changed.get(repo) ?? 0) + 1);
        }
        // A new file belongs to the innermost registered repo whose folder holds it (M5-05-R1).
        const prefixes = config.repos
          .map(r => ({ name: r.name, prefix: !r.path || r.path === '.' ? '' : `${r.path.replace(/^\.\//, '').replace(/\/+$/, '')}/` }))
          .sort((a, b) => b.prefix.length - a.prefix.length);
        for (const f of stale.added) {
          const repo = prefixes.find(p => f.startsWith(p.prefix))?.name ?? config.repo.name;
          changed.set(repo, (changed.get(repo) ?? 0) + 1);
        }
        const summaries = summarizeRepos(dir, config.repos, config.repo.name, store);
        const n = (v: number) => v.toLocaleString('en-US');
        const rows = summaries.map(r => {
          const c = changed.get(r.name) ?? 0;
          // A repo registered but never scanned has nothing indexed to be stale: not "clean" (M0-10-R2).
          const state = !r.lastScanned ? 'unscanned' : c ? `${c} file${c === 1 ? '' : 's'}` : 'clean';
          return [r.name, n(r.files), n(r.symbols), n(r.edges), r.head ?? '-', timeAgo(r.lastScanned), state];
        });
        console.log('');
        for (const line of table(['Repo', 'Files', 'Symbols', 'Edges', 'HEAD', 'Last scan', 'Changed'], rows)) console.log(line);
        const sum = (k: 'files' | 'symbols' | 'edges') => summaries.reduce((a, r) => a + r[k], 0);
        console.log(`\nTotal: ${n(sum('files'))} files, ${n(sum('symbols'))} symbols, ${n(sum('edges'))} edges`);
        const pairs = crossRepoPairs(store);
        const total = pairs.reduce((a, p) => a + p.count, 0);
        console.log(`Cross-repo edges: ${n(total)}${pairs.length ? ` (${pairs.map(p => `${p.from} → ${p.to}: ${n(p.count)}`).join(', ')})` : ''}`);
        return;
      }

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
      const printChanges = (changes: Array<{ path: string; status: string }>) => {
        const byStatus: Record<string, number> = { added: 0, modified: 0, removed: 0, renamed: 0, unchanged: 0 };
        for (const c of changes) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
        const summary = Object.entries(byStatus)
          .filter(([, n]) => n > 0)
          .map(([s, n]) => `${n} ${s}`)
          .join(', ');
        console.log(`  ${changes.length} changed files  (${summary})  (⚠ stale)`);
        const icon: Record<string, string> = { added: '+', modified: '~', removed: '-', renamed: '>', unchanged: '=' };
        for (const change of changes) {
          console.log(`    ${icon[change.status]} ${change.path}`);
        }
      };
      // One walk for the whole status (M5-05-R1): the new files git cannot list, in a workspace that
      // is not a git repository or in a nested repo, come from it.
      const stale = findStaleFiles(store, dir);
      // An index an older MapX built (an older extractor, or older external-reference attribution rules).
      const outdated = outdatedIndexWarning(store, "run 'mapx sync' or 'mapx scan'");
      if (outdated) {
        isStale = true;
        console.log('\n── Index version ────────────────────────────────────');
        console.log(`  ⚠ ${outdated}`);
      }
      const git = isGitRepo(repoRoot);
      // --exclude/--include narrow the changed files reported, as in mapx_status (M4-28-R2).
      const cliExcludes = (opts.exclude as string[]) ?? [];
      const cliIncludes = (opts.include as string[]) ?? [];
      let gitChanges: GitFileStatus[] = [];
      if (!git) {
        console.log('\n── Git ──────────────────────────────────────────────');
        console.log('  Not a git repository');
      } else {
        // Only the changes a scan would index, or that touch an indexed file: git also lists dotfiles,
        // excluded and non-source files (M0-11-R3).
        gitChanges = indexableChanges(store, dir, repoRoot, getChangedFiles(repoRoot, lastCommit || undefined), config.repo.name, stale);
        const shown = filterChanges(gitChanges, dir, repoRoot, cliExcludes, cliIncludes);
        console.log('\n── Git changes since last scan ──────────────────────');
        if (shown.length === 0) {
          console.log('  No changes since last scan  (✓ index is current)');
        } else {
          isStale = true;
          printChanges(shown);
        }
      }
      const others = filterChanges(unlistedStale(stale, dir, repoRoot, gitChanges), dir, dir, cliExcludes, cliIncludes);
      if (others.length) {
        isStale = true;
        console.log(git ? '\n── Other changes since last scan ────────────────────' : '\n── Changes since last scan ──────────────────────────');
        printChanges(others);
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
        // An Eloquent model lists its relationships (F07, M0-05-R2).
        if (sym.kind === 'class') {
          const relations = modelRelations(store, { file: sym.file_path as string }).filter(r => r.model === sym.name);
          if (relations.length) {
            console.log('    relationships:');
            for (const r of relations) console.log(`      ${describeRelation(r)}`);
          }
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
    .option('--limit <limit>', 'Max results to return (default 20; a wildcard file listing returns every symbol)')
    .option('--format <format>', 'Output format: text | json', 'text')
    .action(async (term: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store, graph } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const kind = opts.kind as string | undefined;
      const filePrefix = opts.file as string | undefined;
      const exact = !!opts.exact;
      const isWildcard = term === '*' || term === '';
      // Listing a whole file (wildcard + --file) returns every symbol unless --limit is given.
      const limit = opts.limit !== undefined
        ? parseInt(opts.limit as string, 10)
        : isWildcard && filePrefix ? Math.max(1, store.countSymbolsFiltered({ term, kind, filePrefix, exact })) : 20;
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

      const rankMap = new Map<string, number>();
      if (results.length > 0) {
        const filePaths = Array.from(new Set(results.map(r => r.file_path)));
        const placeholders = filePaths.map(() => '?').join(',');
        const fileRanks = store.raw.prepare(`
          SELECT path, pagerank FROM files WHERE path IN (${placeholders})
        `).all(...filePaths) as any[];
        const fileRankMap = new Map<string, number>(fileRanks.map(f => [f.path, f.pagerank]));
        for (const sym of results) {
          const parentFileRank = fileRankMap.get(sym.file_path) || 0;
          const symbolRank = parentFileRank * (1 + (sym.scope ? 2 : 1) * 0.1);
          rankMap.set(`${sym.file_path}::${sym.name}`, symbolRank);
        }
      }

      const totalMatches = store.countSymbolsFiltered({ term, kind: broadened ? undefined : kind, filePrefix, exact });

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
        console.log(JSON.stringify({ total: results.length, totalMatches, broadened, term, kind: kind || null, results: jsonResults }, null, 2));
        return;
      }

      // Summary header
      let header = results.length < totalMatches
        ? `Found ${results.length} of ${totalMatches} symbols`
        : `Found ${results.length} symbol${results.length !== 1 ? 's' : ''}`;
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
      const results: Array<{ caller: string; callee: string; file: string; line: number | null; depth: number }> = [];

      while (queue.length > 0) {
        const { symName, depth } = queue.shift()!;
        if (depth >= maxDepth) continue;

        const callees = store.getCalleesOfSymbol(symName);
        for (const edge of callees) {
          const calleeName = edge.target_symbol || '<unknown>';
          const callerName = edge.source_symbol || symName;

          results.push({
            caller: callerName,
            callee: calleeName,
            file: edge.target_file,
            // The callee's own declaration, or none: never the call site in the caller (M0-11-R2).
            line: store.getSymbolLineInFile(edge.target_file, calleeName, calleeScopeHints(callees, edge)),
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
        console.log(`${indent}  @ ${res.file}${res.line ? `:${res.line}` : ''}`);
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
    .option('--include-members', 'List member symbols (methods, properties) of a class, interface or trait', false)
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
      // Same member rule as mapx_node include_members: symbols in the file scoped to this one.
      const members = opts.includeMembers
        ? store.getSymbolsForFile(sym.file_path as string).filter((s: any) => s.scope === sym.name)
        : [];

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
        if (opts.includeMembers) {
          result.members = members.map((m: any) => ({ name: m.name, kind: m.kind, startLine: m.start_line, endLine: m.end_line }));
        }
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

      if (opts.includeMembers) {
        console.log('\nMembers:');
        if (members.length === 0) console.log('  (none)');
        for (const m of members) console.log(`  ${m.kind} ${m.name} (L${m.start_line}-${m.end_line})`);
      }

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
    .option('--path <pattern>', 'Filter by path prefix or glob (e.g. src/core/*.ts)')
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
    .option('--cross-repo', 'Only dependencies that cross into or come from another registered repository')
    .action(async (file: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store, graph } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const allFiles = store.getAllFiles() as Array<{ path: unknown }>;
      // Backslash, `./` and absolute forms as `mapx edges` takes them (M0-11-R3).
      const resolved = resolveFilePaths(indexedPath(dir, file), allFiles);

      if (!resolved) {
        const { error, tip } = fileNotFoundMessage(file);
        console.error(error);
        console.log(`\n${tip}`);
        process.exit(1);
      }

      for (const filePath of resolved) {
        if (resolved.length > 1) console.log(`\n── ${filePath} ──`);

        if (opts.crossRepo) {
          // F18: edges whose two ends live in different registered repos (M0-10-R1); shared with
          // mapx_dependencies {crossRepo} (M0-10-R2).
          for (const line of crossRepoDependencies(store, filePath)) console.log(line);
          continue;
        }

        const deps = graph.getDependencies(filePath);
        const rdeps = graph.getReverseDependencies(filePath);

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

        // Service container bindings declared here: abstract → concrete (F08, M0-05-R2).
        const bindings = fileBindings(store, filePath);
        if (bindings.length > 0) {
          console.log('\nBindings (abstract → concrete):');
          for (const b of bindings) console.log(`  ${describeBinding(b)}`);
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
    .option('--include-leaf-libraries', 'Include high-import leaf libraries in terminal consumers output', false)
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
        const includeLeaf = !!opts.includeLeafLibraries;
        const sinks = tracer.findSinks(config.repo.name, includeLeaf);
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
    .option('--include-leaf-libraries', 'Include high-import leaf libraries in output', false)
    .action(async (opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);

      const tracer = new FlowTracer(store);
      const includeLeaf = !!opts.includeLeafLibraries;
      const sinks = tracer.findSinks(config.repo.name, includeLeaf);
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
    .option('--all', 'All registered repositories; the LLM format gets one section per repo')
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
      const matcher = buildPathFilter(excludes, includes);
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
          if (opts.all && !opts.repo) {
            // F18 combined export, shared with mapx_export {all} (M0-10-R1, M0-10-R2).
            output = workspaceExport(dir, config.repos, config.repo.name, store, exporter, tokenBudget, filteredFiles);
            break;
          }
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
      console.log(formatLanguageList());
    });

  langCmd
    .command('info <lang>')
    .description('Show extensions, tier and grammar/query files of a language')
    .action((lang: string) => {
      try {
        console.log(formatLanguageInfo(lang));
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }
    });

  langCmd
    .command('install <lang>')
    .description('No-op: all language grammars are bundled')
    .action(async (lang: string) => {
      try {
        clack.log.info(await installLanguage(lang));
      } catch (err: any) {
        clack.log.error(`Error installing language '${lang}': ${err.message}`);
        process.exit(1);
      }
    });

  langCmd
    .command('uninstall <lang>')
    .description('No-op: bundled grammars cannot be removed (use --exclude)')
    .action(async (lang: string) => {
      try {
        clack.log.info(await uninstallLanguage(lang));
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
        startUiServer({ port: uiPort, host: uiHost, token: uiToken, dir: defaultDir, devBuild: true });
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
      startUiServer({ port, host, token, dir, devBuild: true });

      const url = `http://${host}:${port}`;
      console.log(`Mapx Web Dashboard started at ${url}`);

      if (opts.open !== false) {
        // An argument array, not a shell string: `--host` is user input (review of M5-14).
        const { spawn } = await import('node:child_process');
        const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
        spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      }
    });

  program
    .command('metrics')
    .description('Show coupling and instability metrics for files')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--lang <language>', 'Filter metrics by language')
    .option('--verified-only', 'Only compute metrics using verified edges')
    .option('--format <format>', 'Output format: text (alias llm) or json', 'text')
    .option('--top <n>', 'Rows to show, ranked by total degree (in + out); 0 lists every file', String(METRICS_DEFAULT_TOP))
    .option('--exclude <glob>', 'Leave out matching files and their edges (comma-separated or repeated)', collectPatterns, [])
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      // Validate before loading anything (M0-03-R3: bad values were silent no-ops).
      const format = parseFormat(opts.format, 'text');
      const top = parseTop(opts.top);
      for (const v of [format, top]) {
        if (typeof v === 'object') {
          console.error(v.error);
          process.exit(1);
        }
      }
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      const { config, store, graph } = await loadContext(dir);
      if (format !== 'json') checkAndPrintStaleness(store, dir);

      // F02's envelope with camelCase keys (D012); text renders the same report.
      const { report, total } = buildMetricsReport(store, new Map(graph.getRankedFiles().map(f => [f.path, f.pagerank])), {
        dir,
        repo: config.repo.name,
        language: opts.lang as string | undefined,
        verifiedOnly: !!opts.verifiedOnly,
        exclude: (opts.exclude as string[]).filter(Boolean),
        top: top as number,
      });
      if (format === 'json') {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (report.files.length === 0) {
        console.log('No metrics found.');
        return;
      }
      console.log(formatMetricsText(report, total, store.getMeta('last_scan_time:' + config.repo.name)));
    });

  program
    .command('clusters')
    .description('List detected code clusters/modules')
    .argument('[clusterOrPath]', 'Target directory or a specific cluster name to inspect')
    .option('-d, --dir <path>', 'Target directory')
    .option('--source <source>', 'Filter by cluster source: namespace, directory, community, layer, or all', 'all')
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
      const layerCount = filtered.filter((c: any) => c.source === 'layer').length;
      const layerSuffix = layerCount > 0 ? `, ${layerCount} layer` : '';
      console.log(`\n${filtered.length} clusters detected (${nsCount} namespace, ${dirCount} directory, ${commCount} community${layerSuffix})\n`);
    });

  program
    .command('edges')
    .description('Granular query of dependency edges')
    .argument('[file]', 'File whose edges to list (relative or absolute); a directory is taken as the target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--type <types>', 'Filter edges by type (comma-separated: relation,extends)')
    .option('--direction <dir>', 'With a file: outgoing, incoming or both (default both)')
    .option('--verified-only', 'Leave out inferred edges')
    .option('--format <format>', 'Output format: text (alias llm) or json', 'text')
    .option('--from <file>', 'Filter edges originating from a file pattern')
    .option('--to <file>', 'Filter edges targeting a file pattern')
    .action(async (fileArg: string | undefined, opts: Record<string, unknown>) => {
      // The positional used to be the target directory; a directory still means that.
      const isDir = !!fileArg && existsSync(resolve(fileArg)) && statSync(resolve(fileArg)).isDirectory();
      const hasFile = !!fileArg && !isDir;
      // Validate before loading anything (M0-03-R3: bad values were silent no-ops).
      const format = parseFormat(opts.format, 'text');
      const direction = String(opts.direction ?? 'both');
      const error = typeof format === 'object' ? format.error : directionError(opts.direction, hasFile);
      if (error) {
        console.error(error);
        process.exit(1);
      }
      const dir = isDir ? resolve(fileArg!) : resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      if (format !== 'json') checkAndPrintStaleness(store, dir);
      const file = hasFile ? indexedPath(dir, fileArg!) : undefined;
      const edges = store.queryEdges({
        // A file's neighbourhood spans every registered repo: edges are stored under their source
        // repo, so another repo's edge into this file is not under ours (M0-03-R4).
        repo: file ? undefined : config.repo.name,
        type: opts.type as string | undefined,
        file,
        direction: direction as EdgeDirection,
        verifiedOnly: !!opts.verifiedOnly,
        from: opts.from as string | undefined,
        to: opts.to as string | undefined,
      });

      // With a file: F04's incoming / outgoing neighbourhood (D012). Without: the flat list.
      if (file) {
        if (edges.length === 0 && !store.getFile(file)) {
          console.error(notIndexedMessage(file));
          process.exit(1);
        }
        const neighbourhood = fileEdges(file, direction as EdgeDirection, edges);
        console.log(format === 'json' ? JSON.stringify(neighbourhood, null, 2) : formatFileEdgesText(neighbourhood));
        return;
      }

      if (format === 'json') {
        console.log(JSON.stringify(edges.map(edgeView), null, 2));
        return;
      }

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
    .option('--clients', 'Show frontend HTTP call sites and the routes they reach instead of routes')
    .option('--unmatched', 'With --clients: only calls that reach no live route')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      if (opts.clients) {
        const calls = await loadClientCalls(dir, {
          unmatched: !!opts.unmatched,
          method: opts.method as string | undefined,
          path: opts.pathPattern as string | undefined,
        });
        if (opts.json) {
          console.log(JSON.stringify(calls, null, 2));
          return;
        }
        if (calls.length === 0) {
          console.log(opts.unmatched ? 'No unmatched HTTP calls.' : 'No frontend HTTP calls found.');
          return;
        }
        console.log(`\nFrontend HTTP calls (${calls.length}):`);
        for (const c of calls) {
          const target = c.route ? `${c.route.handlerSymbol ?? c.route.handlerFile} [${c.route.confidence}]` : 'UNMATCHED';
          console.log(`  ${c.file}:${c.line}  ${c.method.padEnd(6)} ${(c.url ?? c.rawUrl).padEnd(36)} → ${target}`);
        }
        console.log('');
        return;
      }
      const routeRegistry = new RouteRegistry();
      await routeRegistry.load(dir);

      const routes = routeRegistry.queryRoutes({
        framework: opts.framework as string | undefined,
        method: opts.method as string | undefined,
        path: opts.pathPattern as string | undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(routes.map(toRouteView), null, 2));
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
        const v = toRouteView(r);
        const flags = [!v.reachable && 'unreachable', v.reachability === 'unknown' && 'reachability unknown', v.overridden && 'overridden', v.conditional && 'conditional'].filter(Boolean);
        console.log(`${r.framework.padEnd(12)} | ${r.method.toUpperCase().padEnd(8)} | ${r.path.padEnd(30)} | ${handler}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
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

  program
    .command('profile')
    .description('Show codebase profile: archetype, frameworks, and patterns')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .action(async (pathArg: string | undefined, opts: Record<string, unknown>) => {
      const dir = pathArg ? resolve(pathArg) : resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);
      const repo = config.repo.name;
      const profileStr = store.getMeta('codebase_profile:' + repo);
      if (!profileStr) {
        console.log(`No codebase profile found for repo "${repo}". Run a scan first.`);
        return;
      }
      const profile = JSON.parse(profileStr);
      console.log('\n── Codebase Profile ───────────────────────────────────');
      console.log(`  Archetype:             ${profile.archetype} (confidence: ${profile.archetypeConfidence.toFixed(2)})`);
      console.log(`  Detected Frameworks:   ${profile.detectedFrameworks.join(', ') || 'none'}`);
      console.log(`  Architecture Patterns: ${profile.detectedPatterns.join(', ') || 'none'}`);
      console.log(`  Dominant Languages:    ${profile.dominantLanguages.join(', ')}`);
      console.log(`  Has Backend:           ${profile.hasBackend}`);
      console.log(`  Has Frontend:          ${profile.hasFrontend}`);
      console.log(`  Is Monorepo:           ${profile.isMonorepo}`);
      console.log('');
    });

  const archCmd = program
    .command('arch')
    .description('Show full architecture report: profile, layers, smells, and DSM')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--smells', 'Show only architectural smells')
    .option('--dsm', 'Show only Dependency Structure Matrix (DSM)')
    .option('--violations', 'Show only layer violations')
    .action(async (pathArg: string | undefined, opts: Record<string, unknown>) => {
      const dir = pathArg ? resolve(pathArg) : resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);
      const repo = config.repo.name;

      const showAll = !opts.smells && !opts.dsm && !opts.violations;
      // With .mapx/architecture.jsonc, layer violations come from the rules (M5-16). Computed once
      // per command: the list and the health line share it.
      let smellList: ReturnType<typeof currentSmells> | undefined;
      const smellsNow = () => (smellList ??= currentSmells(store, dir, [repo], { primary: repo, repoPaths: Object.fromEntries(config.repos.map((r) => [r.name, r.path])) }));

      if (showAll || opts.smells || opts.violations) {
        const smells = smellsNow();
        const filtered = opts.violations ? smells.filter((s: any) => s.type === 'layer-violation') : smells;
        
        console.log(`\n── Architectural Smells & Violations (${filtered.length}) ─────────────────`);
        if (filtered.length === 0) {
          console.log('🟢 Clean! No architectural smells detected.');
        } else {
          for (const s of filtered) {
            console.log(`\n  [${s.severity.toUpperCase()}] ${s.type}`);
            console.log(`    Description: ${s.description}`);
            if (s.involvedFiles.length > 0) {
              console.log(`    Files:       ${s.involvedFiles.join(', ')}`);
            }
            if (s.involvedClusters && s.involvedClusters.length > 0) {
              console.log(`    Clusters:    ${s.involvedClusters.join(', ')}`);
            }
            if (s.involvedLayers && s.involvedLayers.length > 0) {
              console.log(`    Layers:      ${s.involvedLayers.join(', ')}`);
            }
            console.log(`    Suggestion:  ${s.suggestion}`);
            if (s.source) console.log(`    Source:      ${s.source}`);
          }
        }
        console.log('');
        if (!showAll) return;
      }

      if (showAll || opts.dsm) {
        const dsm = calculateDSM(store, repo);
        if (dsm.clusterNames.length === 0) {
          console.log('No clusters found to build DSM.');
        } else {
          console.log(formatDsmText(dsm.clusterNames, dsm.matrix, {
            title: '\n── Dependency Structure Matrix (DSM) ──────────────────',
            prefix: 'C',
            legend: ['number = edge count from row cluster to column cluster'],
            keyTitle: 'Cluster Key:',
          }));
        }
        console.log('');
        if (!showAll) return;
      }

      if (showAll) {
        const profileStr = store.getMeta('codebase_profile:' + repo);
        if (profileStr) {
          const profile = JSON.parse(profileStr);
          console.log('── Codebase Profile Summary ───────────────────────────');
          console.log(`  Archetype:  ${profile.archetype} (confidence: ${profile.archetypeConfidence.toFixed(2)})`);
          console.log(`  Languages:  ${profile.dominantLanguages.join(', ')}`);
          console.log('');
        }

        const smells = smellsNow();
        console.log('── Architecture Health ────────────────────────────────');
        if (smells.length === 0) {
          console.log('🟢 Clean! No smells detected.');
        } else {
          console.log(`⚠️  Detected ${smells.length} architectural smell(s). Run 'mapx arch --smells' for details.`);
        }
        console.log('');
      }
    });

  // Validates .mapx/architecture.jsonc (or a view) without an index (M5-02-R1; AR-17: exit 3 on
  // configuration errors). `mapx arch [path]` keeps working: only this name is a subcommand.
  archCmd
    .command('validate-config')
    .description('Validate .mapx/architecture.jsonc (or a view): every problem with its file and JSON pointer; exit 0 valid, 3 invalid or missing')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--view <name>', 'Validate the view .mapx/architecture/<name>.jsonc')
    .option('--format <format>', 'Output format: text or json', 'text')
    .exitOverride((err) => { process.exit(err.exitCode === 0 ? 0 : EXIT.config); })
    .action((pathArg: string | undefined, opts: Record<string, unknown>) => {
      // `arch` has its own --dir, which takes the option when it precedes any unknown one.
      const dir = pathArg ? resolve(pathArg) : resolveDir({ dir: opts.dir ?? archCmd.opts().dir }, program.opts());
      const format = String(opts.format);
      if (!['text', 'json'].includes(format)) {
        console.error(`Error: --format must be text or json, not "${format}"`);
        process.exitCode = EXIT.config;
        return;
      }
      const { report, config } = validateArchitectureConfig(dir, { view: opts.view as string | undefined });
      console.log(format === 'json' ? JSON.stringify(report, null, 2) : formatValidation(report, config ?? undefined));
      process.exitCode = report.valid ? EXIT.ok : EXIT.config;
    });

  // A starting configuration (M5-17; AR-15): inferred from roles or clusters, or a preset, with the
  // observed layer graph in its comments and optionally a baseline. Dry run by default; the same
  // engine as mapx_arch_init (src/arch/infer.ts). Exit 3 for usage errors and refused writes.
  archCmd
    .command('init')
    .description('Propose .mapx/architecture.jsonc from roles, clusters, the detected framework or a preset (dry run unless --write; exit 3 over an existing file without --force)')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--from <source>', `Where layers come from: ${INIT_SOURCES.join(', ')} (default roles; framework uses the detected framework's preset)`)
    .option('--preset <id>', `Start from a shipped preset: ${Object.keys(PRESETS).sort().join(', ')}`)
    .option('--baseline', "Also write .mapx/architecture.baseline.json with today's violations, so `mapx check` passes until new ones appear")
    .option('--write', 'Write the files (otherwise print the proposal and write nothing)')
    .option('--force', 'With --write: overwrite an existing configuration and baseline, or write a proposal whose every layer is empty (never through a symlink)')
    .option('--view <name>', 'Propose the view .mapx/architecture/<name>.jsonc instead')
    .option('--sync', 'Sync the index first when files changed since the last scan (--baseline needs a current index)')
    .option('--format <format>', 'Output format: text or json', 'text')
    .option('--json', 'Same as --format json')
    .exitOverride((err) => { process.exit(err.exitCode === 0 ? 0 : EXIT.config); })
    .action(async (pathArg: string | undefined, opts: Record<string, unknown>) => {
      const dir = pathArg ? resolve(pathArg) : resolveDir({ dir: opts.dir ?? archCmd.opts().dir }, program.opts());
      const format = opts.json ? 'json' : String(opts.format);
      const fail = (message: string, extra: Record<string, unknown> = {}) => {
        if (format === 'json') console.log(JSON.stringify({ error: message, ...extra }, null, 2));
        else console.error(`Error: ${message}`);
        process.exitCode = EXIT.config;
      };
      if (!['text', 'json'].includes(format)) {
        console.error(`Error: --format must be text or json, not "${format}"`);
        process.exitCode = EXIT.config;
        return;
      }
      const request = {
        from: opts.from as InitSource | undefined, preset: opts.preset as string | undefined, view: opts.view as string | undefined,
        baseline: !!opts.baseline, write: !!opts.write, force: !!opts.force, forceHint: '--force',
      };
      const problem = initOptionsProblem(request);
      if (problem) { fail(problem); return; }
      try {
        // Roles survive a stale index; a baseline lists today's violations and needs a current one.
        const problems: string[] = [];
        const context = await openCurrentIndex(dir, { sync: !!opts.sync, command: 'mapx arch init', allowStale: !request.baseline, problems });
        if (!context) {
          if (format === 'json') console.log(JSON.stringify({ error: problems.join(' ') }, null, 2));
          return;
        }
        const { config, store } = context;
        const result = runInit(store, dir, { ...request, repoPaths: Object.fromEntries(config.repos.map((r) => [r.name, r.path])), repos: config.repos.map((r) => r.name) });
        process.exitCode = EXIT.ok;
        if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
        for (const w of result.warnings) console.error(`Warning: ${w}`);
        const counts = `${result.layers.length} layer${result.layers.length === 1 ? '' : 's'}, ${result.violations} violation${result.violations === 1 ? '' : 's'} today`;
        if (result.written) {
          console.log(`Wrote ${result.path} (${counts}).`);
          if (result.baseline?.written) console.log(`Wrote ${result.baseline.path} (${result.baseline.entries} entr${result.baseline.entries === 1 ? 'y' : 'ies'}).`);
          else if (result.baseline) console.log(`No baseline written: there are no violations to list.`);
          console.log('Review it, then run `mapx check`.');
          return;
        }
        process.stdout.write(result.config);
        for (const i of result.issues) console.error(`Problem: ${i.file}${i.pointer ? `#${i.pointer}` : ''}: ${i.message}`);
        const baseline = result.baseline ? ` and ${result.baseline.path} (${result.baseline.entries} entr${result.baseline.entries === 1 ? 'y' : 'ies'})` : '';
        const over = result.exists || result.baseline?.exists ? ` ${result.exists ? result.path : result.baseline!.path} exists: add --force to overwrite it.` : '';
        console.error(`Dry run (${counts}): nothing written. Add --write to create ${result.path}${baseline}.${over}`);
      } catch (err) {
        if (err instanceof InitError) { fail(err.message, err.extra); return; }
        const message = `mapx arch init failed: ${err instanceof Error ? err.message : String(err)}`;
        if (format === 'json') console.log(JSON.stringify({ error: message }, null, 2));
        console.error(message);
        process.exitCode = EXIT.index;
      }
    });

  // Introspection (M5-08; AR-13a–g, docs/architecture-rules.md#introspection): questions about the
  // configuration answered from the index. Each prints text or `--format json` (the object
  // src/arch/introspect.ts returns) and exits by AR-17: 3 for configuration and usage errors (an
  // unknown layer, an element no query resolves), 4 for a missing or stale index; `unassigned`
  // exits 2 when anything is unassigned and `allowed` 1 when the dependency would be an error.
  const archQuestion = (
    name: string, description: string,
    answer: (ctx: ArchContext, args: unknown[], opts: Record<string, unknown>) => { json: unknown; text: string; exit?: number },
    options: { allowStale?: boolean; configure?: (cmd: Command) => void; formats?: readonly string[]; defaultFormat?: string } = {},
  ) => {
    // Formats other than json print the answer's text (`mapx arch graph`: dot, svg, mermaid, dsm).
    const formats = options.formats ?? ['text', 'json'];
    const cmd = archCmd.command(name).description(description)
      .option('-d, --dir <path>', 'Target directory')
      .option('--view <name>', 'Use the view .mapx/architecture/<name>.jsonc')
      .option('--format <format>', `Output format: ${formats.slice(0, -1).join(', ')} or ${formats[formats.length - 1]}`, options.defaultFormat ?? 'text')
      .option('--json', 'Same as --format json');
    if (!options.allowStale) cmd.option('--sync', 'Sync the index first when files changed since the last scan');
    options.configure?.(cmd);
    cmd.exitOverride((err) => { process.exit(err.exitCode === 0 ? 0 : EXIT.config); });
    cmd.action(async function (this: Command) {
      const opts = this.opts();
      // `arch` has its own --dir, which takes the option when it precedes any unknown one.
      const dir = resolveDir({ dir: opts.dir ?? archCmd.opts().dir }, program.opts());
      const format = opts.json ? 'json' : String(opts.format);
      if (!formats.includes(format)) {
        console.error(`Error: --format must be ${formats.slice(0, -1).join(', ')} or ${formats[formats.length - 1]}, not "${format}"`);
        process.exitCode = EXIT.config;
        return;
      }
      const fail = (message: string, extra: Record<string, unknown> = {}) => {
        if (format === 'json') console.log(JSON.stringify({ error: message, ...extra }, null, 2));
        else console.error(`Error: ${message}`);
        process.exitCode = EXIT.config;
      };
      try {
        // Every failure prints `{ "error": … }` on stdout in JSON, whatever its exit code.
        const problems: string[] = [];
        const context = await openCurrentIndex(dir, { sync: !!opts.sync, command: `mapx arch ${name}`, allowStale: options.allowStale, problems });
        if (!context) {
          if (format === 'json') console.log(JSON.stringify({ error: problems.join(' ') }, null, 2));
          return;
        }
        const view = opts.view as string | undefined;
        let ctx: ArchContext | null;
        try {
          ctx = openArchitecture(dir, context.store, { view, repoPaths: Object.fromEntries(context.config.repos.map((r) => [r.name, r.path])) });
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          if (format === 'json') console.log(JSON.stringify({ error: 'Invalid architecture configuration', issues: err.issues }, null, 2));
          else console.error(err.message);
          process.exitCode = EXIT.config;
          return;
        }
        if (!ctx) {
          fail(view ? `No view "${view}" in ${dir}: .mapx/architecture/${view}.jsonc does not exist.` : `No architecture configuration in ${dir}: create .mapx/architecture.jsonc (see docs/architecture-rules.md).`);
          return;
        }
        if (ctx.policy.errors.length) {
          fail(`Invalid architecture configuration: ${ctx.policy.errors.join('; ')}`);
          return;
        }
        const out = answer(ctx, this.processedArgs, opts);
        const text = format === 'json' ? `${JSON.stringify(out.json, null, 2)}\n` : out.text.endsWith('\n') ? out.text : `${out.text}\n`;
        if (opts.output) {
          // Relative to the current directory, like `mapx check --output`; its folder is created.
          const file = resolve(String(opts.output));
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, text);
        } else process.stdout.write(text);
        process.exitCode = out.exit ?? EXIT.ok;
      } catch (err) {
        if (err instanceof IntrospectError) { fail(err.message, err.candidates.length ? { candidates: err.candidates } : {}); return; }
        const message = `mapx arch ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
        if (format === 'json') console.log(JSON.stringify({ error: message }, null, 2));
        console.error(message);
        process.exitCode = EXIT.index;
      }
    });
    return cmd;
  };
  const refText = (r: { element: string; kind: string; symbolKind?: string }) => `${(r.symbolKind ?? r.kind).padEnd(9)} ${r.element}`;

  archQuestion('layers', 'Layers and their sizes; with a layer, its members (files and top-level symbols), --why naming the matching selector (AR-13a)', (ctx, [layer], opts) => {
    if (layer === undefined) {
      const s = layerSummaries(ctx);
      const w = Math.max(5, ...s.layers.map((l) => l.name.length));
      return {
        json: s,
        text: [`${'Layer'.padEnd(w)}  Elements  Files`, ...s.layers.map((l) => `${l.name.padEnd(w)}  ${String(l.elements).padStart(8)}  ${String(l.files).padStart(5)}${l.overlay ? '  (overlay)' : ''}`)].join('\n'),
      };
    }
    const m = layerMembers(ctx, String(layer), { why: !!opts.why, nested: !!opts.nested });
    const lines = [`${m.name}${m.overlay ? ' (overlay)' : ''}: ${m.files} file(s), ${m.elements} element(s)`];
    for (const e of m.members) lines.push(`  ${refText(e)}${e.selector ? `  ← ${e.selector}${e.chain ? `: ${e.chain.join(' → ')}` : ''}${e.via !== 'self' ? ` via ${e.via}` : ''}` : ''}`);
    if (!m.members.length) lines.push('  (no members)');
    return { json: m, text: lines.join('\n') };
  }, { configure: (c) => c.argument('[layer]', 'A layer name').option('--why', 'Name the selector that put each member in the layer').option('--nested', 'List members of types too (methods, properties)') });

  archQuestion('which', 'The layers an element (file, qualified name or symbol name) is in, and the selector trace (AR-13b)', (ctx, [query]) => {
    const r = whichLayers(ctx, String(query));
    const lines: string[] = [];
    for (const m of r.matches) {
      lines.push(`${m.element} (${m.symbolKind ?? m.kind}, ${m.file})`);
      if (!m.trace.length) lines.push('  in no layer');
      for (const t of m.trace) lines.push(`  ${t.layer}  ← ${t.selector}${t.chain ? `: ${t.chain.join(' → ')}` : ''}${t.via !== 'self' ? ` via ${t.via}` : ''}`);
      if (m.private.length) lines.push(`  private to ${m.private.join(', ')}`);
    }
    return { json: r, text: lines.join('\n') };
  }, { configure: (c) => c.argument('<element>', 'A file path, qualified name, scoped name (Order::run) or top-level symbol name') });

  archQuestion('unassigned', 'Files and top-level symbols in no layer; exit 2 when there are any (AR-13c)', (ctx, _args, opts) => {
    const r = unassignedElements(ctx, { kind: opts.kind as string | undefined, path: opts.path as string | undefined, nested: !!opts.nested });
    const text = r.total ? [...r.elements.map((e) => `  ${refText(e)}`), `${r.total} unassigned element(s).`].join('\n') : 'Every element is in a layer.';
    return { json: r, text, exit: r.total ? EXIT.uncovered : EXIT.ok };
  }, { configure: (c) => c.option('--kind <kind>', 'Only file, symbol, or a symbol kind (class, function, …)').option('--path <path>', 'Only under this path prefix, or matching this glob').option('--nested', 'List members of types too') });

  archQuestion('deps', 'The stored edges from one layer to another (or to every other), with file:line, edge type, verifiability and decision (AR-13d)', (ctx, [from, to]) => {
    const r = layerDependencies(ctx, String(from), to === undefined ? undefined : String(to));
    const mark = { allowed: '✔', violation: '✖', uncovered: '?' } as const;
    const lines = r.dependencies.map((d) => `${mark[d.kind]} ${d.source.file}${d.source.line !== undefined ? `:${d.source.line}` : ''}  ${d.source.element} → ${d.target.element} (${d.edgeType}, ${d.verifiability}) [${d.targetLayers.join(', ') || 'no layer'}]${d.kind === 'violation' ? `  ${d.rule} [${d.severity}]` : ''}${d.via ? `  inherited via ${d.via.join(' → ')}` : ''}`);
    lines.push(`${r.from} → ${r.to ?? 'any layer'}: ${r.dependencies.length} edge(s): ${r.counts.allowed} allowed, ${r.counts.violation} violating, ${r.counts.uncovered} uncovered.`);
    return { json: r, text: lines.join('\n') };
  }, { configure: (c) => c.argument('<from>', 'Source layer').argument('[to]', 'Target layer (default: every other layer, and none)') });

  archQuestion('unused', 'Allowances used at most --limit times (default 0: unused), with their use counts (AR-13e)', (ctx, _args, opts) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 0) throw new IntrospectError(`--limit must be a whole number, not "${String(opts.limit)}"`);
    const r = unusedAllowances(ctx, { limit });
    const lines = r.allowances.map((a) => `  ${a.from} → ${a.to}  (${a.rule}${a.types ? `; ${a.types.join(', ')}` : ''}${a.severity === 'warn' ? '; advisory' : ''})  uses: ${a.uses}`);
    lines.push(`${r.allowances.length} of ${r.total} allowance(s) used at most ${limit} time(s).`);
    return { json: r, text: lines.join('\n') };
  }, { configure: (c) => c.option('--limit <n>', 'Report allowances used at most n times', '0') });

  archQuestion('changed', 'The layers some files touch (or the files changed since a git ref), and with --with-dependents the layers that depend on them; reads the index as it is (AR-13f)', (ctx, [files], opts) => {
    const list = [...((files as string[] | undefined) ?? [])];
    if (opts.since !== undefined) list.push(...changedSince(ctx.dir, String(opts.since), ctx.repoPaths));
    else if (!list.length) throw new IntrospectError('give the changed files, or --since <ref>');
    const r = changedLayers(ctx, list, { withDependents: !!opts.withDependents });
    const lines = r.files.map((f) => `  ${f.file}  ${!f.indexed ? '(not indexed)' : !f.inScope ? '(outside the scope)' : f.layers.join(', ') || '(no layer)'}`);
    lines.push(`Layers: ${r.layers.join(', ') || 'none'}`);
    if (r.dependents) {
      lines.push('Dependents:');
      for (const d of r.dependents) lines.push(`  ${d.layer}: ${d.files.join(', ')}`);
      if (r.unassignedDependents!.length) lines.push(`  (no layer): ${r.unassignedDependents!.join(', ')}`);
      if (!r.dependents.length && !r.unassignedDependents!.length) lines.push('  none');
    }
    return { json: r, text: lines.join('\n') };
  }, {
    allowStale: true,
    configure: (c) => c.argument('[files...]', 'Workspace-relative paths').option('--since <ref>', 'Add the files changed since this git ref (committed, staged, unstaged and untracked)').option('--with-dependents', 'Also the layers of the files that depend on them'),
  });

  archQuestion('allowed', 'Would a dependency from <from> to <to> (layers, files or symbols) be allowed? Decision, rule and reason; exit 1 when it would be an error (AR-13g)', (ctx, [from, to], opts) => {
    const type = opts.type as string | undefined;
    if (type !== undefined && !(EDGE_TYPES as readonly string[]).includes(type)) throw new IntrospectError(`--type "${type}" is not an edge type (${EDGE_TYPES.join(', ')})`);
    const r = isAllowed(ctx, String(from), String(to), { edgeType: type });
    const head = r.allowed ? `✔ allowed${r.rule === 'allowed' ? '' : ` (${r.rule})`}` : `✖ not allowed (${r.rule}, ${r.severity})`;
    const lines = [`${head}: ${r.reason}`];
    // Every decision when there are several (edge types, source layers), the observed ones marked.
    if (r.decisions.length > 1) {
      for (const d of r.decisions) lines.push(`  ${d.allowed ? '✔' : '✖'} ${d.edgeType ?? ''}${d.sourceLayer ? ` [${d.sourceLayer}]` : ''} ${d.rule} (${d.severity})${d.observed ? `, in the index (${d.verifiability})` : ''}`);
    }
    if (!r.allowed && r.from.layers.length) lines.push(`${r.from.layers.join(', ')} may depend on: ${r.allowedLayers.join(', ') || 'no other layer'}`);
    // AR-19 alternatives (M5-14): symbols in those layers that match the target.
    for (const a of r.alternatives) lines.push(`  instead, in ${a.layer}: ${a.symbols.map((s) => `${s.element} (${s.match})`).join(', ')}${a.total > a.symbols.length ? `, and ${a.total - a.symbols.length} more` : ''}`);
    return { json: r, text: lines.join('\n'), exit: r.exitCode ? EXIT.violations : EXIT.ok };
  }, { configure: (c) => c.argument('<from>', 'Source layer, file or symbol').argument('<to>', 'Target layer, file or symbol, or an external package or built-in (pg, npm:pg)').option('--type <edgeType>', 'Decide for this edge type only (default: the types the index has between the two, else every type in scope)') });

  // The layer graph (M5-13, AR-16; docs/architecture-rules.md#layer-graphs): the dependencies
  // `mapx check` counts per layer pair, drawn. The baseline applies as in `mapx check`, so its
  // violations are drawn as skipped. Not a gate: exit 0 unless the configuration, the baseline (3)
  // or the index (4) cannot be used.
  archQuestion('graph', 'The layer graph: dependency counts per layer pair, violations red, skipped dashed, groups as subgraphs (dot, svg, mermaid, dsm or json; AR-16)', (ctx, _args, opts) => {
    let baseline;
    try {
      baseline = loadBaseline(ctx.dir, ctx.config, opts.baseline ? resolve(String(opts.baseline)) : undefined);
    } catch (err) {
      if (err instanceof ConfigError) throw new IntrospectError(err.message);
      throw err;
    }
    const graph = layerGraph(buildReport(ctx.store, ctx.config, ctx.membership, { baseline, repoPaths: ctx.repoPaths }), ctx.config);
    const format = (opts.json ? 'json' : String(opts.format)) as GraphFormat;
    return { json: graph, text: format === 'json' ? '' : renderLayerGraph(format, graph, { graphviz: opts.graphviz !== false }) };
  }, {
    formats: GRAPH_FORMATS,
    defaultFormat: 'dot',
    configure: (c) => c
      .option('-o, --output <file>', 'Write the graph to a file instead of stdout')
      .option('--baseline <file>', "Use this baseline instead of the configuration's (relative to the current directory)")
      .option('--no-graphviz', 'For svg: always use the built-in renderer, even when Graphviz is installed'),
  });

  // Architecture rules (M5-05; docs/architecture-rules.md, AR-16, AR-17): evaluate
  // .mapx/architecture.jsonc on the index, print the findings, exit with the AR-17 code.
  program
    .command('check')
    .description('Check the architecture rules in .mapx/architecture.jsonc against the index (exit 0 clean, 1 violations, 2 uncovered with --fail-on-uncovered, 3 configuration or baseline errors, 4 index missing or stale)')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--view <name>', 'Check the view .mapx/architecture/<name>.jsonc')
    .option('--format <format>', 'Output format: table, json, sarif, github, codeclimate or junit (default: table; github on stdout when GITHUB_ACTIONS is "true")')
    .option('-o, --output <file>', 'Write the report to a file instead of stdout')
    .option('--report-uncovered', 'Show dependencies on elements in no layer')
    .option('--fail-on-uncovered', 'Exit 2 when a dependency targets an element in no layer')
    .option('--report-skipped', 'Show violations a baseline or --compare skips')
    .option('--report-allowed', 'Show allowed dependencies too')
    .option('--fail-on <severity>', 'Lowest severity that fails the run: error or warn', 'error')
    .option('--layer <name>', 'Only findings about this layer')
    .option('--rule <rule>', 'Only findings of this rule (disallowed-layer, internal-element, private-layer, uncovered, multi-layer, …)')
    .option('--sync', 'Sync the index first when files changed since the last scan')
    .option('--baseline <file>', "Use this baseline instead of the configuration's (relative to the current directory)")
    .option('--generate-baseline [file]', 'Write every current violation to the baseline (or to <file>) and exit 0')
    .option('--compare <report>', 'Fail only on violations absent from this JSON report of the base revision')
    // A usage error (unknown option, missing value) is a configuration error, exit 3 (AR-17), not
    // commander's exit 1, which the contract keeps for violations.
    .exitOverride((err) => { process.exit(err.exitCode === 0 ? 0 : EXIT.config); })
    .action(async (pathArg: string | undefined, opts: Record<string, unknown>) => {
      const dir = pathArg ? resolve(pathArg) : resolveDir(opts, program.opts());
      // No --format inside GitHub Actions: annotations on stdout (M5-07, AR-16); a file keeps the table.
      const format = defaultFormat(opts.format as string | undefined, process.env, !opts.output) as ReportFormat;
      const failOn = String(opts.failOn);
      if (!FORMATS.includes(format)) {
        console.error(`Error: --format must be one of ${FORMATS.join(', ')}, not "${format}"`);
        process.exitCode = EXIT.config;
        return;
      }
      if (!['error', 'warn'].includes(failOn)) {
        console.error(`Error: --fail-on must be error or warn, not "${failOn}"`);
        process.exitCode = EXIT.config;
        return;
      }
      // `--generate-baseline [file]` takes an optional value, so a word after it is taken as the
      // file: `mapx check --generate-baseline <dir>` would write over a directory or check the
      // wrong workspace. The file must be a .json file that is not a directory (review of M5-06).
      if (typeof opts.generateBaseline === 'string') {
        const file = String(opts.generateBaseline);
        if (!file.toLowerCase().endsWith('.json') || (existsSync(resolve(file)) && statSync(resolve(file)).isDirectory())) {
          console.error(`Error: --generate-baseline writes a .json file, not "${file}". Put the workspace path before the option: \`mapx check <path> --generate-baseline [file.json]\`.`);
          process.exitCode = EXIT.config;
          return;
        }
      }
      const options: CheckOptions = {
        reportUncovered: !!opts.reportUncovered, failOnUncovered: !!opts.failOnUncovered,
        reportSkipped: !!opts.reportSkipped, reportAllowed: !!opts.reportAllowed,
        failOn: failOn as CheckOptions['failOn'], layer: opts.layer as string | undefined, rule: opts.rule as string | undefined,
      };
      const selection = { view: (opts.view as string | undefined) ?? null, layer: options.layer ?? null, rule: options.rule ?? null };
      // What the CI formats need besides the report (M5-07): set once the configuration is loaded.
      const reportContext: ReportContext = {
        configFile: relative(dir, architectureConfigPath(dir, selection.view)).split(sep).join('/'),
        pathPrefix: reportPathPrefix(format, dir), // CI tools read paths from the repository root (M5-07-R1)
        // A baseline outside the repository is located where the configuration names it (review of M5-07-R2).
        baselineLine: opts.baseline ? undefined : configKeyLine(architectureConfigPath(dir, selection.view), 'baseline'),
        check: options,
        version: VERSION,
      };
      const emit = (report: ArchReport) => {
        const shown = { ...shownReport(report, options), selection };
        const text = renderReport(format, shown, reportContext);
        if (opts.output) {
          // Relative to the current directory, like any output path; its folder is created.
          const out = resolve(String(opts.output));
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, text);
        } else process.stdout.write(text);
      };
      try {
        // 4 first (AR-17: the lowest-level problem wins): no index, a repo never scanned, or files
        // changed since the last scan (unless --sync brings the index up to date).
        const context = await openCurrentIndex(dir, { sync: !!opts.sync, command: 'mapx check' });
        if (!context) return;
        const { config, store } = context;

        // 3: no configuration, or one that cannot be used.
        const view = (opts.view as string | undefined) ?? undefined;
        let archConfig: ArchitectureConfig | null;
        try {
          archConfig = loadArchitectureConfig(dir, { view });
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          emit(configErrorReport(err));
          process.exitCode = EXIT.config;
          return;
        }
        if (!archConfig) {
          const missing = view ? `.mapx/architecture/${view}.jsonc` : '.mapx/architecture.jsonc';
          const message = view
            ? `No view "${view}" in ${dir}: ${missing} does not exist.`
            : `No architecture configuration in ${dir}: create ${missing} (see docs/architecture-rules.md), or propose one with \`mapx arch init\`.`;
          console.error(message);
          // A JSON or CI-format consumer still gets a report: one configuration error.
          if (format !== 'table' || opts.output) emit(configErrorReport(new ConfigError([{ file: missing, pointer: '', message: 'not found' }])));
          process.exitCode = EXIT.config;
          return;
        }
        reportContext.codeclimate = archConfig.report.codeclimate;
        // --layer and --rule must name something: a typo would silently turn the gate off.
        const layerNames = archConfig.layers.map((l) => l.name);
        if (options.layer && !layerNames.includes(options.layer)) {
          console.error(`Error: --layer "${options.layer}" is not a layer of this configuration (${layerNames.join(', ')}).`);
          process.exitCode = EXIT.config;
          return;
        }
        if (options.rule && !CHECK_RULES.includes(options.rule)) {
          console.error(`Error: --rule "${options.rule}" is not a rule (${CHECK_RULES.join(', ')}).`);
          process.exitCode = EXIT.config;
          return;
        }
        const repoPaths = Object.fromEntries(config.repos.map((r) => [r.name, r.path]));
        // Baselines and the ratchet (M5-06, AR-10). Paths given on the command line are relative to
        // the current directory, like --output; the configuration's `baseline` is relative to the workspace.
        const baselineFile = opts.baseline ? resolve(String(opts.baseline)) : undefined;
        if (opts.generateBaseline !== undefined) {
          if (opts.compare || options.layer || options.rule) {
            console.error('Error: --generate-baseline writes every violation; it takes no --compare, --layer or --rule.');
            process.exitCode = EXIT.config;
            return;
          }
          // Evaluated without any baseline, so a regenerated baseline lists every violation again.
          const report = runArchitecture(dir, { store, repoPaths, view, baseline: false })!;
          if (exitCode(report, {}) === EXIT.config) {
            emit(report);
            process.exitCode = EXIT.config;
            return;
          }
          const used = baselineLocation(dir, archConfig, baselineFile).path;
          const target = typeof opts.generateBaseline === 'string' ? resolve(opts.generateBaseline) : used;
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, renderBaseline(report.findings));
          const n = report.counts.violation;
          console.log(`Wrote ${n} baseline ${n === 1 ? 'entry' : 'entries'} to ${displayPath(dir, target)}.`);
          // MapX indexes JSON: a baseline in the workspace outside .mapx/ is a new file, so the next
          // check finds the index stale (exit 4). Point at .mapx/ instead (review of M5-06).
          const rel = relative(dir, target);
          const inWorkspace = !rel.startsWith('..') && !isAbsolute(rel);
          if (inWorkspace && rel.split(sep)[0] !== '.mapx') {
            const suggested = displayPath(process.cwd(), join(dir, '.mapx', basename(target)));
            console.error(`Warning: ${displayPath(dir, target)} is inside the workspace, and MapX indexes JSON files, so \`mapx check\` finds the index stale (exit 4) until the next scan. Keep baselines under .mapx/: \`mapx check --generate-baseline ${suggested}\`, then \`--baseline ${suggested}\` or "baseline": ".mapx/${basename(target)}" in the configuration.`);
          } else if (target !== used) {
            // --baseline is relative to the current directory, so the hint is too.
            console.log(`\`mapx check\` reads ${displayPath(dir, used)}: pass \`--baseline ${displayPath(process.cwd(), target)}\`, or set "baseline" in the configuration.`);
          }
          process.exitCode = EXIT.ok;
          return;
        }
        let known: Set<string> | undefined;
        if (opts.compare) {
          try {
            known = loadCompareReport(resolve(String(opts.compare)), String(opts.compare), selection);
          } catch (err) {
            if (!(err instanceof ConfigError)) throw err;
            emit(configErrorReport(err));
            process.exitCode = EXIT.config;
            return;
          }
        }
        const report = runArchitecture(dir, { store, repoPaths, view, baseline: baselineFile, known })!;
        reportContext.check = { ...options, known };
        emit(report);
        process.exitCode = exitCode(report, { ...options, known });
      } catch (err) {
        console.error(`mapx check failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = EXIT.index;
      }
    });

  program
    .command('explain <file>')
    .description('Explain why a file was classified with a specific role')
    .option('-d, --dir <path>', 'Target directory')
    .action(async (file: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);
      
      const fileRecord = store.getFile(file);
      if (!fileRecord) {
        console.log(`File "${file}" not found in graph.`);
        return;
      }

      const signals = store.getClassificationSignals(file);
      const role = fileRecord.role || 'other';
      const confidence = typeof fileRecord.role_confidence === 'number' ? fileRecord.role_confidence : 0.5;

      console.log(`\n── Classification Explanation: ${file} ──`);
      console.log(`  Role:       ${role} (confidence: ${confidence.toFixed(2)})`);
      console.log(`\n  Signals:`);
      for (const s of signals) {
        console.log(`    [${s.source.padEnd(9)}] ${s.role.padEnd(12)} (conf: ${s.confidence.toFixed(2)}) - ${s.reason}`);
      }
      if (signals.length === 0) {
        console.log('    (none)');
      }
      console.log('');
    });

  program
    .command('layers')
    .description('List files grouped by architectural roles/layers')
    .argument('[path]', 'Target directory')
    .option('-d, --dir <path>', 'Target directory')
    .option('--json', 'Output results as JSON')
    .action(async (pathArg: string | undefined, opts: Record<string, unknown>) => {
      const dir = pathArg ? resolve(pathArg) : resolveDir(opts, program.opts());
      const { config, store } = await loadContext(dir);
      checkAndPrintStaleness(store, dir);
      const repo = config.repo.name;

      const files = store.getAllFiles(repo);
      const roleGroups = new Map<string, string[]>();
      for (const f of files) {
        const role = (f.role as string) || 'other';
        if (!roleGroups.has(role)) {
          roleGroups.set(role, []);
        }
        roleGroups.get(role)!.push(f.path as string);
      }

      if (opts.json) {
        const out: Record<string, string[]> = {};
        for (const [r, paths] of roleGroups.entries()) {
          out[r] = paths;
        }
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      console.log(`\n── Architectural Layers / Roles for "${repo}" ─────────`);
      const sortedRoles = Array.from(roleGroups.keys()).sort();
      for (const role of sortedRoles) {
        const list = roleGroups.get(role)!;
        console.log(`\n  ${role.toUpperCase()} (${list.length} files):`);
        for (const f of list.slice(0, 10)) {
          console.log(`    • ${f}`);
        }
        if (list.length > 10) {
          console.log(`    • ...and ${list.length - 10} more`);
        }
      }
      console.log('');
    });

  const agentsCmd = program.command('agents').description('Manage LLM agent integration files');

  agentsCmd
    .command('list')
    .description('List all supported LLM integration providers')
    .action(() => {
      const generator = new AgentGenerator();
      const providers = generator.listProviders();
      const dir = program.opts().dir ? resolve(program.opts().dir) : process.cwd();
      // Status of each provider's file in this project, from the same plan `update` would run.
      const STATUS: Record<string, string> = {
        create: 'missing', append: 'missing', up_to_date: 'current', update_clean: 'outdated',
        update_conflict: 'edited', no_sentinel: 'unmanaged (no mapx block)', key_conflict: 'conflicting keys',
        remove: 'legacy, removed by agents generate/update',
      };
      const plan = generator.plan(providers, { dir });
      const statusOf = new Map(plan.map(a => [a.filename, STATUS[a.status] ?? a.status]));
      console.log('\nSupported LLM integration providers:');
      for (const p of providers) {
        const temp = generator.getTemplate(p);
        const appendStr = temp?.isAppend ? ' (append-mode)' : '';
        console.log(`  - ${p.padEnd(12)} -> ${temp?.filename}${appendStr}  [${statusOf.get(temp?.filename ?? '') ?? 'missing'}]`);
        // Companion files (Continue's prompts, Aider's config) and legacy files still present (M0-09-R4).
        for (const c of temp?.companions ?? []) {
          const f = generator.getTemplate(c)?.filename;
          if (f) console.log(`      + ${f}  [${statusOf.get(f) ?? 'missing'}]`);
        }
        for (const a of plan.filter(a => a.provider === p && a.status === 'remove')) {
          console.log(`      - ${a.filename}  [${STATUS.remove}]`);
        }
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

      const listed: string[] = opts.providers ? opts.providers.split(',').map((s: string) => s.trim().toLowerCase()) : [];
      if (opts.all || listed.includes('all')) {
        targets = available;
      } else if (opts.providers) {
        targets = listed.filter((p: string) => available.includes(p));
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
        if (action.status === 'key_conflict') {
          clack.log.warn(`Skipped ${action.filename}: ${action.note}`);
          continue;
        }

        if (needsConsent(action)) {
          clack.log.warn(`Conflict/Modification detected in ${action.filename}:`);
          if (action.diff) {
            console.log(action.diff);
          }
          if (!opts.force && !process.stdin.isTTY) {
            clack.log.warn(`Skipped ${action.filename}: it was edited; re-run with --force to overwrite.`);
            continue;
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
          clack.log.info(`[DRY RUN] Would ${action.status === 'remove' ? 'remove' : 'write to'} ${action.filepath} (status: ${action.status})`);
        } else {
          generator.execute(action);
          clack.log.success(action.status === 'remove' ? `${action.filename}: ${action.note}` : `Wrote to ${action.filename} (status: ${action.status})`);
        }
      }

      // Providers whose MCP server lives in an editor config (Zed) get it merged in (M0-09-R2).
      for (const action of generator.generateMcpConfigs(generator.companionMcpConfigs(targets), { dir })) {
        if (action.status === 'up_to_date') continue;
        if (action.status === 'unparseable') {
          clack.log.warn(`Skipped ${action.filename}: it is not valid JSON, so the mapx server was not added.`);
        } else if (opts.dryRun) {
          clack.log.info(`[DRY RUN] Would ${action.status} ${action.filename} (${action.tool})`);
        } else {
          generator.executeMcpConfig(action);
          clack.log.success(`MCP config ${action.status === 'merge' ? 'merged into' : 'written to'} ${action.filename} (${action.tool})`);
          const lost = droppedCommentsWarning(action);
          if (lost) clack.log.warn(lost);
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

      // A provider whose legacy file is still there is migrated (M0-09-R4).
      const existingProviders = available.filter(p => {
        const temp = generator.getTemplate(p);
        return temp && [temp.filename, ...(temp.legacyFiles ?? [])].some(f => existsSync(join(dir, f)));
      });

      if (existingProviders.length === 0) {
        clack.log.info('No existing LLM integration files found to update.');
        return;
      }

      // Update never creates files: missing instructions or companion files stay missing (M0-09-R3).
      const actions = generator.plan(existingProviders, { dir, mcpPort: parseInt(opts.mcpPort, 10), onlyExisting: true });
      let updatedCount = 0;

      for (const action of actions) {
        if (action.status === 'up_to_date') {
          continue;
        }
        if (action.status === 'key_conflict') {
          clack.log.warn(`Skipped ${action.filename}: ${action.note}`);
          continue;
        }

        if (needsConsent(action)) {
          clack.log.warn(`Customized content detected in ${action.filename}:`);
          if (action.diff) {
            console.log(action.diff);
          }
          if (!opts.force && !process.stdin.isTTY) {
            clack.log.warn(`Skipped ${action.filename}: its mapx block was edited; re-run with --force to overwrite.`);
            continue;
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
          clack.log.info(`[DRY RUN] Would ${action.status === 'remove' ? 'remove' : 'update'} ${action.filepath}`);
          if (action.diff && action.status !== 'update_conflict') console.log(action.diff);
        } else {
          generator.execute(action);
          clack.log.success(action.status === 'remove' ? `${action.filename}: ${action.note}` : `Updated ${action.filename}`);
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
        if (action.status === 'unparseable') {
          clack.log.warn(`Skipped ${action.filename}: it is not valid JSON, so the mapx server was not added.`);
          continue;
        }
        if (opts.dryRun) {
          clack.log.info(`[DRY RUN] Would ${action.status} ${action.filename} (${action.tool})`);
        } else {
          generator.executeMcpConfig(action);
          const verb = action.status === 'merge' ? 'merged into' : action.status === 'create' ? 'created' : 'updated';
          clack.log.success(`MCP config ${verb} ${action.filename} (${action.tool})`);
          const lost = droppedCommentsWarning(action);
          if (lost) clack.log.warn(lost);
        }
      }
    });

  // Registered repos as the F18 table (Name, Path, Type, Files, Last scanned, HEAD), with
  // uninitialised submodules listed after them (M0-10-R1).
  const printWorkspacesTable = (dir: string, config: Config, store: Store) => {
    const summaries = summarizeRepos(dir, config.repos, config.repo.name, store);
    const registered = new Set(config.repos.map(r => WorkspaceManager.repoKey(dir, r.path)));
    const uninitialised = WorkspaceManager.discoverSubmodules(dir).filter(s => !s.isInitialized && !registered.has(WorkspaceManager.repoKey(dir, s.path)));
    const rows = summaries.map(r => [r.name, r.path, r.type, String(r.files), timeAgo(r.lastScanned), r.head ?? '-']);
    for (const s of uninitialised) rows.push([s.name, s.path, 'submodule', '✗ not initialised', '', '']);
    console.log(`\nWorkspace: ${dir}\n`);
    for (const line of table(['Name', 'Path', 'Type', 'Files', 'Last scanned', 'HEAD'], rows)) console.log(line);
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    console.log(`\n${plural(summaries.length, 'registered repo')}${uninitialised.length ? `, ${plural(uninitialised.length, 'uninitialised submodule')}` : ''}.`);
    for (const s of uninitialised) console.log(`Run \`git submodule update --init ${s.path}\` to initialise it.`);
  };

  const workspacesCmd = program
    .command('workspaces')
    .description('Manage multi-repository workspace contexts (without a subcommand: list registered repos)')
    .action(async () => {
      const dir = resolveDir({}, program.opts());
      const { config, store } = await loadContext(dir);
      printWorkspacesTable(dir, config, store);
    });

  workspacesCmd
    .command('list')
    .alias('show')
    .description('List registered repositories and other discovered peer/submodule directories')
    .option('--include-peers', 'Also list sibling git repositories of the workspace root')
    .action(async (opts: Record<string, unknown>) => {
      const dir = resolveDir({}, program.opts());
      const { config, store } = await loadContext(dir);

      printWorkspacesTable(dir, config, store);
      const registeredPaths = new Set<string>(config.repos.map(r => WorkspaceManager.repoKey(dir, r.path)));

      // Discover uninitialized submodules
      const submodules = WorkspaceManager.discoverSubmodules(dir);
      const uninitSubmodules = submodules.filter(s => !registeredPaths.has(WorkspaceManager.repoKey(dir, s.path)));
      if (uninitSubmodules.length > 0) {
        console.log('\nDiscovered submodules:');
        for (const s of uninitSubmodules) {
          const status = s.isInitialized ? 'available' : 'uninitialized';
          console.log(`  - ${s.name.padEnd(15)} -> ${s.path} (${status})`);
        }
      }

      // Peer repos are opt-in: sibling directories are often unrelated projects (F18)
      const peers = opts.includePeers ? WorkspaceManager.discoverPeerRepos(dir) : [];
      const uninitPeers = peers.filter(p => !registeredPaths.has(WorkspaceManager.repoKey(dir, p.path)));
      if (uninitPeers.length > 0) {
        console.log('\nDiscovered peer repositories:');
        for (const p of uninitPeers) {
          console.log(`  - ${p.name.padEnd(15)} -> ${p.path} (available)`);
        }
      }

      // Discover VS Code workspace files
      const wsFiles = codeWorkspaceFiles(dir);
      if (wsFiles.length > 0) {
        console.log('\nDiscovered VS Code Workspace folders:');
        for (const f of wsFiles) {
          const wsFolderRepos = WorkspaceManager.discoverVSCodeWorkspace(f, dir);
          const uninitWs = wsFolderRepos.filter(p => !registeredPaths.has(WorkspaceManager.repoKey(dir, p.path)));
          for (const p of uninitWs) {
            console.log(`  - ${p.name.padEnd(15)} -> ${p.path} (available)`);
          }
        }
      }

      // Deep-scan for nested git repos (up to 3 levels)
      const nested = WorkspaceManager.discoverNestedGitRepos(dir);
      const uninitNested = nested.filter(n => !registeredPaths.has(WorkspaceManager.repoKey(dir, n.path)));
      if (uninitNested.length > 0) {
        console.log('\nNested git repositories (deep scan):');
        for (const n of uninitNested) {
          console.log(`  - ${n.name.padEnd(15)} -> ${n.path} (available)`);
        }
      }

      // Monorepo packages discovered via workspace manifests or common dirs
      const monoPkgs = WorkspaceManager.discoverMonorepoPackages(dir);
      const uninitMono = monoPkgs.filter(p => !registeredPaths.has(WorkspaceManager.repoKey(dir, p.path)));
      if (uninitMono.length > 0) {
        console.log('\nMonorepo packages:');
        for (const p of uninitMono) {
          console.log(`  - ${p.name.padEnd(15)} -> ${p.path} [${p.packageManager}]`);
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

      // A symlink to a registered repo is the same repo (M0-10-R2).
      const existing = config.repos.find(r => r.name === name || WorkspaceManager.repoKey(dir, r.path) === WorkspaceManager.repoKey(dir, relPath));
      if (existing) {
        clack.log.warn(`Repository already registered: ${existing.name} (${existing.path})`);
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
      // A repo whose folder holds the removed one indexes those files again: git lists none of them,
      // so its next sync re-walks it once, as its next scan does (M0-10-R4).
      const removedRoot = resolve(dir, repo.path);
      for (const other of config.repos) {
        const root = resolve(dir, other.path);
        if (removedRoot.startsWith(root + sep)) store.setMeta('scan_filters:' + other.name, JSON.stringify({ rewalk: true }));
      }
      clack.log.success(`Done.`);
    });

  workspacesCmd
    .command('discover')
    .description('Discover unregistered submodules, peer repos, and VS Code workspace folders (read-only)')
    .option('--include-peers', 'Also list sibling git repositories of the workspace root')
    .action(async (opts: Record<string, unknown>) => {
      const dir = resolveDir({}, program.opts());
      const { config } = await loadContext(dir);

      const registeredPaths = new Set<string>();
      for (const r of config.repos) {
        registeredPaths.add(WorkspaceManager.repoKey(dir, r.path));
      }

      let found = 0;

      // Submodules
      const submodules = WorkspaceManager.discoverSubmodules(dir);
      const uninitSubs = submodules.filter(s => !registeredPaths.has(WorkspaceManager.repoKey(dir, s.path)));
      if (uninitSubs.length > 0) {
        console.log('\nSubmodules:');
        for (const s of uninitSubs) {
          const status = s.isInitialized ? 'available' : 'uninitialized';
          console.log(`  - ${s.name.padEnd(20)} -> ${s.path} (${status})`);
        }
        found += uninitSubs.length;
      }

      // Peer repos are opt-in (F18): without the flag only say that some exist
      const peers = WorkspaceManager.discoverPeerRepos(dir);
      const uninitPeers = peers.filter(p => !registeredPaths.has(WorkspaceManager.repoKey(dir, p.path)));
      if (uninitPeers.length > 0 && opts.includePeers) {
        console.log('\nPeer repositories:');
        for (const p of uninitPeers) {
          console.log(`  - ${p.name.padEnd(20)} -> ${p.path} (available)`);
        }
        found += uninitPeers.length;
      } else if (uninitPeers.length > 0) {
        console.log(`\nPeer repositories: ${uninitPeers.length} sibling repo${uninitPeers.length === 1 ? '' : 's'} (use --include-peers to list them)`);
      }

      // VS Code workspace folders
      const wsFiles = codeWorkspaceFiles(dir);
      const vsEntries: Array<{ name: string; path: string }> = [];
      for (const f of wsFiles) {
        const wsFolderRepos = WorkspaceManager.discoverVSCodeWorkspace(f, dir);
        for (const p of wsFolderRepos) {
          if (!registeredPaths.has(WorkspaceManager.repoKey(dir, p.path))) {
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

      // Deep-scan for nested git repos (up to 3 levels)
      const nestedRepos = WorkspaceManager.discoverNestedGitRepos(dir);
      const uninitNestedDiscover = nestedRepos.filter(n => !registeredPaths.has(WorkspaceManager.repoKey(dir, n.path)));
      if (uninitNestedDiscover.length > 0) {
        console.log('\nNested git repositories (deep scan ≤3 levels):');
        for (const n of uninitNestedDiscover) {
          console.log(`  - ${n.name.padEnd(20)} -> ${n.path} (available)`);
        }
        found += uninitNestedDiscover.length;
      }

      // Monorepo packages
      const monoDiscover = WorkspaceManager.discoverMonorepoPackages(dir);
      const uninitMonoDiscover = monoDiscover.filter(p => !registeredPaths.has(WorkspaceManager.repoKey(dir, p.path)));
      if (uninitMonoDiscover.length > 0) {
        console.log('\nMonorepo packages:');
        for (const p of uninitMonoDiscover) {
          console.log(`  - ${p.name.padEnd(20)} -> ${p.path} [${p.packageManager}]`);
        }
        found += uninitMonoDiscover.length;
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
    .option('--include-peers', 'Also register sibling git repositories of the workspace root')
    .action(async (opts: Record<string, unknown>) => {
      const dir = resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);

      const registeredPaths = new Set<string>();
      for (const r of config.repos) {
        registeredPaths.add(WorkspaceManager.repoKey(dir, r.path));
      }

      const toAdd: Array<{ name: string; path: string }> = [];

      // 1. Submodules
      const submodules = WorkspaceManager.discoverSubmodules(dir);
      for (const s of submodules) {
        if (s.isInitialized) {
          const abs = WorkspaceManager.repoKey(dir, s.path);
          if (!registeredPaths.has(abs)) {
            toAdd.push({ name: s.name, path: s.path });
            registeredPaths.add(abs);
          }
        }
      }

      // 2. Peer repos (opt-in)
      const peers = opts.includePeers ? WorkspaceManager.discoverPeerRepos(dir) : [];
      for (const p of peers) {
        const abs = WorkspaceManager.repoKey(dir, p.path);
        if (!registeredPaths.has(abs)) {
          toAdd.push({ name: p.name, path: p.path });
          registeredPaths.add(abs);
        }
      }

      // 3. VS Code Workspaces
      for (const f of codeWorkspaceFiles(dir)) {
        const wsFolderRepos = WorkspaceManager.discoverVSCodeWorkspace(f, dir);
        for (const p of wsFolderRepos) {
          const abs = WorkspaceManager.repoKey(dir, p.path);
          if (!registeredPaths.has(abs)) {
            toAdd.push({ name: p.name, path: p.path });
            registeredPaths.add(abs);
          }
        }
      }

      // 4. Nested git repositories — prompt user to select which to add
      const nestedReposSync = WorkspaceManager.discoverNestedGitRepos(dir);
      const newNestedRepos = nestedReposSync.filter(n => !registeredPaths.has(WorkspaceManager.repoKey(dir, n.path)));
      // Choosing nested repos and packages needs a TTY; without one, sync registers the rest
      // instead of cancelling everything at the prompt (M0-10-R2).
      const canPrompt = !!process.stdin.isTTY;
      const notPrompted = (what: string) =>
        clack.log.info(`${what} found; run sync in a terminal to choose, or \`mapx workspaces add <path>\`.`);
      if (newNestedRepos.length > 0 && !canPrompt) notPrompted(`${newNestedRepos.length} nested repositor${newNestedRepos.length === 1 ? 'y' : 'ies'}`);
      if (newNestedRepos.length > 0 && canPrompt) {
        clack.log.step(`Found ${newNestedRepos.length} nested git repositor${newNestedRepos.length === 1 ? 'y' : 'ies'} via deep scan (up to 3 levels):`);
        const chosen = await clack.multiselect({
          message: 'Select nested repositories to register and scan:',
          options: newNestedRepos.map(n => ({ value: n.path, label: `${n.name}  (${n.path})` })),
          required: false,
        });
        if (clack.isCancel(chosen)) {
          clack.cancel('Sync cancelled.');
          process.exit(0);
        }
        for (const chosenPath of chosen as string[]) {
          const nested = newNestedRepos.find(n => n.path === chosenPath)!;
          toAdd.push({ name: nested.name, path: nested.path });
          registeredPaths.add(WorkspaceManager.repoKey(dir, nested.path));
        }
      }

      // 5. Monorepo packages — prompt user to select which to register
      const monoPkgsSync = WorkspaceManager.discoverMonorepoPackages(dir);
      const newMonoPkgs = monoPkgsSync.filter(p => !registeredPaths.has(WorkspaceManager.repoKey(dir, p.path)));
      if (newMonoPkgs.length > 0 && !canPrompt) notPrompted(`${newMonoPkgs.length} monorepo package${newMonoPkgs.length === 1 ? '' : 's'}`);
      if (newMonoPkgs.length > 0 && canPrompt) {
        const mgr = newMonoPkgs[0].packageManager;
        clack.log.step(`Found ${newMonoPkgs.length} monorepo package${newMonoPkgs.length === 1 ? '' : 's'} [${mgr}]:`);
        const chosenMono = await clack.multiselect({
          message: 'Select monorepo packages to register and scan:',
          options: newMonoPkgs.map(p => ({ value: p.path, label: `${p.name}  (${p.path})` })),
          required: false,
        });
        if (clack.isCancel(chosenMono)) {
          clack.cancel('Sync cancelled.');
          process.exit(0);
        }
        for (const chosenPath of chosenMono as string[]) {
          const pkg = newMonoPkgs.find(p => p.path === chosenPath);
          if (pkg) {
            toAdd.push({ name: pkg.name, path: pkg.path });
            registeredPaths.add(WorkspaceManager.repoKey(dir, pkg.path));
          }
        }
      }

      if (toAdd.length === 0) {
        clack.log.info('No new repositories discovered to sync.');
        return;
      }

      clack.log.step(`Syncing ${toAdd.length} newly discovered repositories:`);
      const newNames: string[] = [];
      for (const item of toAdd) {
        if (!config.addRepo(item.name, item.path)) continue;
        newNames.push(item.name);
        clack.log.success(`Registered: ${item.name} -> ${item.path}`);
      }
      await config.save();

      clack.log.step('Running initial full scan for new repositories...');
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

/**
 * The stores loadContext opened, closed when the process exits or is interrupted. One exit, SIGINT
 * and SIGTERM listener serves them all, added with the first and removed when the last is closed
 * (M4-31): a set per call passed ten in in-process runs and printed MaxListenersExceededWarning.
 */
const openStores = new Set<Store>();
const closeOpenStores = () => {
  for (const s of [...openStores]) { try { s.close(); } catch { /* already closed */ } }
};
const onExitClose = () => closeOpenStores();
const onSigIntClose = () => { closeOpenStores(); process.exit(130); };
const onSigTermClose = () => { closeOpenStores(); process.exit(143); };

function closeOnExit(store: Store): void {
  if (openStores.size === 0) {
    process.on('exit', onExitClose);
    process.on('SIGINT', onSigIntClose);
    process.on('SIGTERM', onSigTermClose);
  }
  openStores.add(store);
  store.onClose(() => {
    if (!openStores.delete(store) || openStores.size > 0) return;
    process.removeListener('exit', onExitClose);
    process.removeListener('SIGINT', onSigIntClose);
    process.removeListener('SIGTERM', onSigTermClose);
  });
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
  for (const message of applyCollapsedRepos(config, store)) console.error(message);

  // Ensure the DB connection is closed when the process exits normally or
  // after an unhandled error — this prevents the process from hanging after
  // command completion due to SQLite's open file descriptor keeping the event
  // loop alive.
  closeOnExit(store);

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

  // Symbols loading is skipped to optimize memory and context load times.
  // CLI search and query use SQLite directly, avoiding graphology overhead.

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

/**
 * The index gate of `mapx check` and the `mapx arch` introspection subcommands (AR-17, exit 4; see
 * src/arch/index-gate.ts, shared with the mapx_arch_* MCP tools). Prints why and sets exit 4,
 * returning null, when the index cannot be used; `problems` collects the messages for a caller that
 * also reports them in JSON.
 */
async function openCurrentIndex(dir: string, options: { sync?: boolean; command: string; allowStale?: boolean; problems?: string[] }): Promise<Awaited<ReturnType<typeof loadContext>> | null> {
  const gate = await indexGate(dir, () => loadContext(dir), {
    allowStale: options.allowStale,
    sync: options.sync ? ({ store, config, graph }) => new Scanner(store, config, graph).scanIncremental() : undefined,
    syncAdvice: `\`${options.command} --sync\``,
    updateAdvice: '`mapx update`',
  });
  if ('context' in gate) return gate.context;
  for (const message of gate.problems) console.error(message);
  options.problems?.push(...gate.problems);
  process.exitCode = EXIT.index;
  return null;
}

export function getStaleFilesCount(store: Store, dir: string): number {
  return staleCount(findStaleFiles(store, dir));
}

export function checkAndPrintStaleness(store: Store, dir: string): void {
  const outdated = outdatedIndexWarning(store, "run 'mapx scan' or 'mapx update'");
  if (outdated) console.warn(`⚠️  Warning: ${outdated}\n`);
  const report = findStaleFiles(store, dir);
  const count = staleCount(report);
  if (count > 0) {
    const changed = staleNames(report, 5);
    const fileList = changed.length > 0
      ? `\nChanged: ${changed.join(', ')}${count > changed.length ? ` (and ${count - changed.length} more)` : ''}`
      : '';
    console.warn(`⚠️  Warning: Graph index may be stale. ${count} file(s) have changed on disk since the last scan. Run 'mapx update' to sync.${fileList}\n`);
  }
}

export function checkTryCatch(content: string, lineNum: number, startLine: number, isPython: boolean): boolean {
  return coreCheckTryCatch(content, lineNum, startLine, isPython);
}

