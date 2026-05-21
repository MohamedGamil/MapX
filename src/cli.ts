import { Command } from 'commander';
import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import { Store } from './core/store.js';
import { CodeGraph } from './core/graph.js';
import { Scanner } from './core/scanner.js';
import { Config } from './core/config.js';
import { LLMExporter } from './exporters/llm-exporter.js';
import { GraphExporter } from './exporters/graph-exporter.js';
import { DotExporter } from './exporters/dot-exporter.js';
import { SvgExporter } from './exporters/svg-exporter.js';
import { getChangedFiles, isGitRepo } from './core/git-tracker.js';
import { getBuiltinLanguages } from './languages/registry.js';
import type { ScanProgress, ProgressCallback } from './types.js';

const dynamicRequire = createRequire(import.meta.url);

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
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⸦', '⢼', '⣴', '⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽', '⣾'];
let spinnerIdx = 0;

function createProgressRenderer(): ProgressCallback {
  let lastPhase: ScanProgress['phase'] | null = null;
  let lastLineLen = 0;

  const writeLine = (line: string) => {
    const clear = lastLineLen > 0 ? '\r' + ' '.repeat(lastLineLen) + '\r' : '\r';
    process.stderr.write(clear + line);
    lastLineLen = line.length;
  };

  const renderBar = (current: number, total: number, width: number = 20): string => {
    if (total === 0) {
      const frame = SPINNER_FRAMES[spinnerIdx++ % SPINNER_FRAMES.length];
      return `${frame} `;
    }
    const filled = Math.round((current / total) * width);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const pct = Math.round((current / total) * 100);
    return `${bar} ${pct}%`;
  };

  return (progress: ScanProgress) => {
    const { phase, current, total, file } = progress;
    const label = PHASE_LABELS[phase];
    const isNewPhase = phase !== lastPhase;

    if (isNewPhase && lastPhase !== null) {
      const prevLabel = PHASE_LABELS[lastPhase];
      writeLine(`  ✔ ${prevLabel.done}\n`);
    }

    lastPhase = phase;

    const bar = renderBar(current, total);
    const counter = total > 0 ? `${current}/${total}` : `${current}`;
    let line = `  ${label.active} ${bar} ${counter}`;

    if (file) {
      const maxFileLen = Math.max(0, 60 - line.length);
      const displayFile = file.length > maxFileLen && maxFileLen > 3
        ? '…' + file.slice(-(maxFileLen - 1))
        : file.length <= maxFileLen ? file : '';
      if (displayFile) {
        line += ` ${displayFile}`;
      }
    }

    writeLine(line);
  };
}

const CODEGRAPH_MARKER_START = '<!-- codegraph -->';
const CODEGRAPH_MARKER_END = '<!-- /codegraph -->';

function readStubContent(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const stubPath = resolve(thisDir, 'agents.stub.md');
    return readFileSync(stubPath, 'utf-8');
  } catch {
    return [
      '# CodeGraph - LLM Integration Guide',
      '',
      'This project uses **CodeGraph** — a local code graph memory system for LLMs.',
      '',
      '## Commands',
      '',
      '```bash',
      'codegraph init [/path]         # First-time setup',
      'codegraph scan [/path]         # Full scan',
      'codegraph update [/path]       # Incremental update',
      'codegraph export [--dir /path] # Export graph summary (8K tokens)',
      'codegraph query <term>         # Search symbols',
      'codegraph deps <file>          # File dependencies',
      'codegraph summary [/path]      # Project summary',
      'codegraph serve --dir /path    # Start MCP server',
      '```',
      '',
      '## MCP Tools',
      '',
      '- `codegraph_scan` — Scan/update the code graph',
      '- `codegraph_query` — Search symbols by name',
      '- `codegraph_dependencies` — Get deps for a file',
      '- `codegraph_export` — Export compact graph summary',
      '- `codegraph_status` — Check scan status',
      '',
      '## When to Use',
      '',
      '1. Start of session: `codegraph export`',
      '2. Find something: `codegraph query <term>`',
      '3. Understand a file: `codegraph deps <file>`',
      '4. Files changed: `codegraph update`',
      '5. Major changes: `codegraph scan`',
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
  return `${CODEGRAPH_MARKER_START}\n${content}\n${CODEGRAPH_MARKER_END}`;
}

function hasMarkers(content: string): boolean {
  return content.includes(CODEGRAPH_MARKER_START) && content.includes(CODEGRAPH_MARKER_END);
}

function replaceBetweenMarkers(existing: string, block: string): string {
  const startIdx = existing.indexOf(CODEGRAPH_MARKER_START);
  const endIdx = existing.indexOf(CODEGRAPH_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return existing;
  }
  return existing.slice(0, startIdx) + block + existing.slice(endIdx + CODEGRAPH_MARKER_END.length);
}

function prompt(question: string, options: string[]): Promise<number> {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const labels = options.map((o, i) => `  ${i + 1}) ${o}`);
    process.stderr.write(question + '\n' + labels.join('\n') + '\n> ');
    rl.question('', (answer) => {
      rl.close();
      const num = parseInt(answer.trim(), 10);
      res(num >= 1 && num <= options.length ? num - 1 : options.length - 1);
    });
  });
}

async function writeAgentsMd(dir: string): Promise<void> {
  const agentsPath = join(dir, 'AGENTS.md');
  const block = generateAgentsBlock();

  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, block + '\n', 'utf-8');
    console.log('Created AGENTS.md with CodeGraph documentation');
    return;
  }

  const existing = readFileSync(agentsPath, 'utf-8');

  if (hasMarkers(existing)) {
    const updated = replaceBetweenMarkers(existing, block);
    if (updated !== existing) {
      writeFileSync(agentsPath, updated, 'utf-8');
      console.log('Updated CodeGraph docs in AGENTS.md');
    }
    return;
  }

  if (existing.includes(CODEGRAPH_MARKER_START)) {
    writeFileSync(agentsPath, existing.replace(CODEGRAPH_MARKER_START, block), 'utf-8');
    console.log('Updated CodeGraph docs in AGENTS.md');
    return;
  }

  if (!process.stdin.isTTY) {
    console.log('AGENTS.md exists without CodeGraph docs. Re-run `init` in a terminal to add them.');
    return;
  }

  console.log(`\nAGENTS.md already exists in ${dir}`);
  const choice = await prompt('How would you like to handle AGENTS.md?', [
    'Insert CodeGraph docs at the end',
    'Insert CodeGraph docs at the beginning',
    'Skip (keep current file)',
  ]);

  if (choice === 0) {
    writeFileSync(agentsPath, existing.trimEnd() + '\n\n' + block + '\n', 'utf-8');
    console.log('Inserted CodeGraph documentation into AGENTS.md');
  } else if (choice === 1) {
    writeFileSync(agentsPath, block + '\n\n' + existing.trimStart(), 'utf-8');
    console.log('Inserted CodeGraph documentation into AGENTS.md');
  } else {
    console.log('Skipped AGENTS.md (kept existing file)');
  }
}

export function buildCLI(): Command {
  const program = new Command();

  program
    .name('codegraph')
    .description('Multi-language code graph memory system for LLMs')
    .version('0.1.2')
    .option('-d, --dir <path>', 'Target project directory (default: current directory)');

  program
    .command('init')
    .description('Initialize codegraph for a project')
    .argument('[path]', 'Target directory')
    .option('--name <name>', 'Repository name')
    .option('--no-agents', 'Skip AGENTS.md creation')
    .action(async (path: string | undefined, opts: Record<string, unknown>) => {
      const dir = path ? resolve(path) : resolveDir(opts, program.opts());
      const config = await Config.init(dir, opts.name as string | undefined);
      if (opts.agents !== false) {
        await writeAgentsMd(dir);
      }
      console.log(`Initialized codegraph in ${dir}/.codegraph/`);
      console.log(`Repo: ${config.repo.name}`);
    });

  program
    .command('scan')
    .description('Full scan: parse all files, build graph')
    .argument('[path]', 'Target directory')
    .action(async (path: string | undefined) => {
      const dir = path ? resolve(path) : resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);

      const onProgress = createProgressRenderer();
      const scanner = new Scanner(store, config, graph, onProgress);

      const onSigInt = () => {
        scanner.abort();
        process.stderr.write('\n');
      };
      process.once('SIGINT', onSigInt);

      const result = await scanner.scanFull();

      process.removeListener('SIGINT', onSigInt);
      process.stderr.write('\r' + ' '.repeat(80) + '\r');

      if (result.interrupted) {
        console.log(`Scan interrupted after ${result.filesScanned}/${result.totalFiles} files. Progress saved — run \`scan\` again to resume.`);
      } else {
        console.log(`Scanned ${result.filesScanned} files in ${result.durationMs}ms`);
      }
      console.log(`Languages: ${Object.entries(result.languageBreakdown).map(([l, c]) => `${l}: ${c}`).join(', ')}`);
      console.log(`Found ${result.symbolsFound} symbols, ${result.edgesFound} edges`);
    });

  program
    .command('update')
    .description('Incremental scan: re-scan only changed files')
    .argument('[path]', 'Target directory')
    .action(async (path: string | undefined) => {
      const dir = path ? resolve(path) : resolveDir({}, program.opts());
      const { config, store, graph } = await loadContext(dir);
      const onProgress = createProgressRenderer();

      const repoRoot = resolve(dir, config.repo.path);
      if (!isGitRepo(repoRoot)) {
        console.log('Not a git repo, falling back to full scan');
        const scanner = new Scanner(store, config, graph, onProgress);
        process.once('SIGINT', () => scanner.abort());
        const result = await scanner.scanFull();
        process.stderr.write('\r' + ' '.repeat(80) + '\r');
        console.log(`Scanned ${result.filesScanned} files, ${result.symbolsFound} symbols, ${result.edgesFound} edges in ${result.durationMs}ms`);
        return;
      }

      const changes = getChangedFiles(repoRoot);
      if (changes.length === 0) {
        console.log('No changes detected');
        return;
      }

      const scanner = new Scanner(store, config, graph, onProgress);
      process.once('SIGINT', () => scanner.abort());
      const result = await scanner.scanIncremental();

      process.stderr.write('\r' + ' '.repeat(80) + '\r');
      console.log(`Updated ${result.filesScanned} files in ${result.durationMs}ms`);
      console.log(`${result.symbolsFound} symbols updated, ${result.edgesFound} edges updated`);
    });

  program
    .command('status')
    .description('Show changed files since last scan')
    .argument('[path]', 'Target directory')
    .action(async (path: string | undefined) => {
      const dir = path ? resolve(path) : resolveDir({}, program.opts());
      const { config, store } = await loadContext(dir);

      const repoRoot = resolve(dir, config.repo.path);
      if (!isGitRepo(repoRoot)) {
        console.log('Not a git repo');
        return;
      }

      const lastScan = store.getMeta('last_scan_time');
      const lastCommit = store.getMeta('last_scan_commit');
      console.log(`Last scan: ${lastScan || 'never'}`);
      console.log(`Last commit: ${lastCommit || 'none'}`);

      const changes = getChangedFiles(repoRoot, lastCommit || undefined);
      if (changes.length === 0) {
        console.log('No changes since last scan');
      } else {
        console.log(`\n${changes.length} changed files:`);
        for (const change of changes) {
          const icon = { added: '+', modified: '~', removed: '-', renamed: '>', unchanged: '=' }[change.status];
          console.log(`  ${icon} ${change.path}`);
        }
      }
    });

  program
    .command('query <term>')
    .description('Search for symbols by name')
    .option('-d, --dir <path>', 'Target directory')
    .action(async (term: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store } = await loadContext(dir);

      const results = store.searchSymbols(term);
      if (results.length === 0) {
        console.log(`No symbols matching "${term}"`);
        return;
      }

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
    .command('deps <file>')
    .description('Show dependencies for a file')
    .option('-d, --dir <path>', 'Target directory')
    .action(async (file: string, opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store, graph } = await loadContext(dir);

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
    .command('export')
    .description('Export code graph for LLM consumption')
    .option('-d, --dir <path>', 'Target directory')
    .option('--format <format>', 'Output format: llm, json, dot, svg', 'llm')
    .option('--tokens <budget>', 'Token budget for LLM export', '8192')
    .option('--repo <name>', 'Filter by repo name')
    .option('-o, --output <file>', 'Write output to file instead of stdout')
    .action(async (opts: Record<string, unknown>) => {
      const dir = resolveDir(opts, program.opts());
      const { store, graph } = await loadContext(dir);

      const format = opts.format as string;
      const tokenBudget = parseInt(opts.tokens as string, 10) || 8192;
      const outputPath = opts.output as string | undefined;

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

      let output: string;

      switch (format) {
        case 'json': {
          const exporter = new GraphExporter(store, graph);
          output = exporter.exportAsJSONString(opts.repo as string | undefined);
          break;
        }
        case 'dot': {
          const exporter = new DotExporter(store, graph);
          output = exporter.export(opts.repo as string | undefined);
          break;
        }
        case 'svg': {
          const exporter = new SvgExporter(store, graph);
          output = exporter.export(opts.repo as string | undefined);
          break;
        }
        case 'llm':
        default: {
          const exporter = new LLMExporter(store, graph);
          output = exporter.export({
            format: 'llm',
            tokenBudget,
            repo: opts.repo as string | undefined,
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

  program
    .command('lang')
    .description('Language support commands')
    .addCommand(
      new Command('list')
        .description('List available languages')
        .action(() => {
          const langs = getBuiltinLanguages();
          console.log('Built-in languages:');
          for (const [name, def] of Object.entries(langs)) {
            console.log(`  ${name}: ${def.extensions.join(', ')} [${def.tier}]`);
          }
        })
    );

  program
    .command('serve')
    .description('Start MCP server (stdio transport)')
    .option('-d, --dir <path>', 'Default target directory for MCP tools')
    .action(async (opts: Record<string, unknown>) => {
      const defaultDir = resolveDir(opts, program.opts());
      const { startMcpServer } = await import('./mcp.js');
      await startMcpServer(defaultDir);
    });

  return program;
}

export async function loadContext(dir: string): Promise<{
  config: Config;
  store: Store;
  graph: CodeGraph;
}> {
  const configPath = resolve(dir, '.codegraph', 'config.json');
  if (!existsSync(configPath)) {
    console.error(`CodeGraph not initialized in ${dir}. Run \`codegraph init ${dir}\` first.`);
    process.exit(1);
  }

  const config = await Config.load(dir);
  const dbPath = resolve(dir, '.codegraph', 'codegraph.db');
  const store = new Store(dbPath);
  const graph = new CodeGraph(config.repo.name);

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
    });
  }

  return { config, store, graph };
}
