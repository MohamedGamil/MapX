#!/usr/bin/env npx tsx
/**
 * MapX Benchmarking Runner
 *
 * Measures token consumption for common agentic coding tasks
 * with and without MapX MCP tools.
 *
 * Usage:
 *   npx tsx benchmarks/run.ts [/path/to/project] [--json] [--model claude-sonnet-4]
 *
 * If no path is given, benchmarks the current directory.
 */

import { resolve, join, relative, extname } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { estimateTokens, formatTokens, estimateCost, formatCost, PRICING, ModelId } from './token-counter.js';
import { SCENARIOS, ScenarioContext, ScenarioResult, FileInfo } from './scenarios.js';

// ─── CLI argument parsing ────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const eqForm = args.find(a => a.startsWith(`--${name}=`));
  if (eqForm) return eqForm.split('=')[1];
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

// Collect positional args (anything not a flag or a flag value)
const flagNames = new Set(['--json', '--model']);
const positionalArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    // If it's a flag with a separate value (not --flag=val), skip the next arg
    if (!args[i].includes('=') && !flagNames.has(args[i]) && i + 1 < args.length) {
      i++; // skip value
    } else if (args[i] === '--model') {
      i++; // skip model value
    }
    continue;
  }
  positionalArgs.push(args[i]);
}

const flags = {
  json: args.includes('--json'),
  model: (getFlag('model') || 'claude-sonnet-4') as ModelId,
};
const targetDir = resolve(positionalArgs[0] || '.');

// ─── Collect project data ────────────────────────────────────

function walkFiles(dir: string, base: string = dir): FileInfo[] {
  const results: FileInfo[] = [];
  const SKIP = new Set(['node_modules', 'vendor', '.git', 'dist', '.mapx', '__pycache__', '.next', 'build']);
  const EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.php', '.phtml',
    '.py', '.pyw',
    '.go', '.rs', '.java', '.cs',
    '.rb', '.c', '.h', '.cpp', '.hpp', '.cc',
    '.swift', '.kt', '.kts', '.dart', '.scala', '.sc',
    '.vue', '.svelte', '.lua', '.ex', '.exs',
    '.zig', '.sh', '.bash', '.pas', '.pp',
  ]);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) {
          results.push(...walkFiles(fullPath, base));
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (EXTENSIONS.has(ext)) {
          try {
            const stat = statSync(fullPath);
            const content = readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n').length;
            const tokens = estimateTokens(content);
            const langMap: Record<string, string> = {
              '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
              '.mjs': 'javascript', '.cjs': 'javascript', '.php': 'php', '.phtml': 'php',
              '.py': 'python', '.pyw': 'python', '.go': 'go', '.rs': 'rust',
              '.java': 'java', '.cs': 'c-sharp', '.rb': 'ruby', '.c': 'c', '.h': 'c',
              '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.swift': 'swift',
              '.kt': 'kotlin', '.kts': 'kotlin', '.dart': 'dart', '.scala': 'scala',
              '.sc': 'scala', '.vue': 'vue', '.svelte': 'svelte', '.lua': 'lua',
              '.ex': 'elixir', '.exs': 'elixir', '.zig': 'zig', '.sh': 'bash',
              '.bash': 'bash', '.pas': 'pascal', '.pp': 'pascal',
            };
            results.push({
              path: relative(base, fullPath),
              sizeBytes: stat.size,
              lines,
              language: langMap[ext] || 'unknown',
              tokens,
            });
          } catch {}
        }
      }
    }
  } catch {}
  return results;
}

function getMapxExportTokens(dir: string): number {
  try {
    const output = execSync(`npx tsx src/main.ts export --tokens=8192 --dir="${dir}"`, {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return estimateTokens(output);
  } catch {
    // Estimate: ~50 tokens per file + ~20 per symbol
    return 0;
  }
}

function getMapxJsonExportTokens(dir: string): number {
  try {
    const output = execSync(`npx tsx src/main.ts export --format=json --dir="${dir}"`, {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return estimateTokens(output);
  } catch {
    return 0;
  }
}

function getMapxStats(dir: string): { symbols: number; edges: number } {
  try {
    const output = execSync(`npx tsx src/main.ts summary "${dir}"`, {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const symbolMatch = output.match(/(\d+)\s+symbols?/i);
    const edgeMatch = output.match(/(\d+)\s+edges?/i);
    return {
      symbols: symbolMatch ? parseInt(symbolMatch[1]) : 0,
      edges: edgeMatch ? parseInt(edgeMatch[1]) : 0,
    };
  } catch {
    return { symbols: 0, edges: 0 };
  }
}

// ─── Run benchmarks ──────────────────────────────────────────

function runBenchmarks(): void {
  if (!flags.json) {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════════════╗');
    console.log('  ║          MapX Token Consumption Benchmark                    ║');
    console.log('  ╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Target:  ${targetDir}`);
    console.log(`  Model:   ${flags.model}`);
    console.log('');
    console.log('  Scanning project files...');
  }

  const files = walkFiles(targetDir);
  if (files.length === 0) {
    console.error('  No source files found. Make sure the path points to a code project.');
    process.exit(1);
  }

  const totalLines = files.reduce((s, f) => s + f.lines, 0);
  const totalBytes = files.reduce((s, f) => s + f.sizeBytes, 0);
  const totalTokens = files.reduce((s, f) => s + f.tokens, 0);
  const avgFileTokens = Math.round(totalTokens / files.length);
  const languages = [...new Set(files.map(f => f.language))];

  if (!flags.json) {
    console.log(`  Files:   ${files.length}`);
    console.log(`  Lines:   ${totalLines.toLocaleString()}`);
    console.log(`  Tokens:  ${formatTokens(totalTokens)} (total codebase)`);
    console.log(`  Avg:     ${formatTokens(avgFileTokens)} tokens/file`);
    console.log(`  Langs:   ${languages.join(', ')}`);
    console.log('');
  }

  // Get mapx-specific metrics
  let llmExportTokens = 0;
  let jsonExportTokens = 0;
  let symbolCount = 0;
  let edgeCount = 0;

  const hasMapx = existsSync(join(targetDir, '.mapx', 'mapx.db'));
  if (hasMapx) {
    if (!flags.json) console.log('  Loading mapx graph data...');
    llmExportTokens = getMapxExportTokens(targetDir);
    jsonExportTokens = getMapxJsonExportTokens(targetDir);
    const stats = getMapxStats(targetDir);
    symbolCount = stats.symbols;
    edgeCount = stats.edges;
    if (!flags.json) {
      console.log(`  MapX:    ${symbolCount} symbols, ${edgeCount} edges`);
      console.log(`  Export:  ${formatTokens(llmExportTokens)} tokens (LLM format)`);
      console.log('');
    }
  } else {
    // Estimate mapx metrics from project data
    symbolCount = Math.round(files.length * 8); // ~8 symbols per file
    edgeCount = Math.round(symbolCount * 2.5);  // ~2.5 edges per symbol
    llmExportTokens = Math.round(files.length * 50 + symbolCount * 15); // estimate
    jsonExportTokens = llmExportTokens * 5;
    if (!flags.json) {
      console.log(`  MapX:    Not initialized (using estimates)`);
      console.log(`           Run \`mapx init && mapx scan\` for exact numbers`);
      console.log('');
    }
  }

  const ctx: ScenarioContext = {
    files,
    totalLines,
    totalBytes,
    symbolCount,
    edgeCount,
    llmExportTokens,
    jsonExportTokens,
    estimateTokens,
    avgFileTokens,
    languages,
  };

  // Run all scenarios
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    const baseline = scenario.baseline(ctx);
    const mapx = scenario.mapx(ctx);
    const savings = {
      tokens: baseline.totalTokens - mapx.totalTokens,
      percent: Math.round((1 - mapx.totalTokens / baseline.totalTokens) * 100),
      toolCalls: baseline.toolCalls - mapx.toolCalls,
    };
    results.push({
      name: scenario.name,
      description: scenario.description,
      baseline,
      mapx,
      savings,
    });
  }

  // Output
  if (flags.json) {
    const output = {
      project: {
        path: targetDir,
        files: files.length,
        lines: totalLines,
        totalTokens,
        avgFileTokens,
        languages,
        mapxInitialized: hasMapx,
        symbolCount,
        edgeCount,
        llmExportTokens,
      },
      model: flags.model,
      scenarios: results,
      summary: buildSummary(results),
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    printReport(results, ctx);
  }
}

function buildSummary(results: ScenarioResult[]) {
  const totalBaseline = results.reduce((s, r) => s + r.baseline.totalTokens, 0);
  const totalMapx = results.reduce((s, r) => s + r.mapx.totalTokens, 0);
  const totalSavings = totalBaseline - totalMapx;
  const avgPercent = Math.round((1 - totalMapx / totalBaseline) * 100);
  const totalBaselineCalls = results.reduce((s, r) => s + r.baseline.toolCalls, 0);
  const totalMapxCalls = results.reduce((s, r) => s + r.mapx.toolCalls, 0);

  return {
    totalBaselineTokens: totalBaseline,
    totalMapxTokens: totalMapx,
    totalSavings,
    averageSavingsPercent: avgPercent,
    totalBaselineToolCalls: totalBaselineCalls,
    totalMapxToolCalls: totalMapxCalls,
    toolCallReduction: totalBaselineCalls - totalMapxCalls,
    estimatedCostBaseline: estimateCost(totalBaseline, 0, flags.model),
    estimatedCostMapx: estimateCost(totalMapx, 0, flags.model),
  };
}

function printReport(results: ScenarioResult[], ctx: ScenarioContext): void {
  const sep = '─'.repeat(72);
  const model = flags.model;

  console.log(`  ${sep}`);
  console.log('');

  for (const result of results) {
    const bar = '█'.repeat(Math.max(1, Math.round(result.savings.percent / 3)));
    console.log(`  📋 ${result.name}`);
    console.log(`     ${result.description}`);
    console.log('');
    console.log(`     Without MapX:  ${formatTokens(result.baseline.totalTokens).padStart(8)} tokens  (${result.baseline.toolCalls} tool calls)`);
    console.log(`     With MapX:     ${formatTokens(result.mapx.totalTokens).padStart(8)} tokens  (${result.mapx.toolCalls} tool calls)`);
    console.log(`     Savings:       ${formatTokens(result.savings.tokens).padStart(8)} tokens  (${result.savings.percent}%)  ${bar}`);
    console.log(`     Cost (${model}):  ${formatCost(estimateCost(result.baseline.totalTokens, 0, model))} → ${formatCost(estimateCost(result.mapx.totalTokens, 0, model))}`);
    console.log('');

    // Breakdown
    console.log('     Baseline breakdown:');
    for (const item of result.baseline.breakdown) {
      console.log(`       • ${item.label}: ${formatTokens(item.tokens)}`);
    }
    console.log('     MapX breakdown:');
    for (const item of result.mapx.breakdown) {
      console.log(`       • ${item.label}: ${formatTokens(item.tokens)}`);
    }
    console.log('');
    console.log(`  ${sep}`);
    console.log('');
  }

  // Summary
  const summary = buildSummary(results);
  console.log('  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║                        SUMMARY                              ║');
  console.log('  ╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Total (all scenarios):  Baseline ${formatTokens(summary.totalBaselineTokens)}  →  MapX ${formatTokens(summary.totalMapxTokens)}`);
  console.log(`  Token savings:          ${formatTokens(summary.totalSavings)} (${summary.averageSavingsPercent}% reduction)`);
  console.log(`  Tool call reduction:    ${summary.totalBaselineToolCalls} → ${summary.totalMapxToolCalls} (${summary.toolCallReduction} fewer calls)`);
  console.log('');
  console.log('  Estimated cost per run:');
  for (const [modelId, pricing] of Object.entries(PRICING)) {
    const costBase = estimateCost(summary.totalBaselineTokens, 0, modelId as ModelId);
    const costMapx = estimateCost(summary.totalMapxTokens, 0, modelId as ModelId);
    const saved = costBase - costMapx;
    const pct = Math.round((1 - costMapx / costBase) * 100);
    const marker = modelId === model ? ' ◀' : '';
    console.log(`    ${modelId.padEnd(18)} ${formatCost(costBase).padStart(8)} → ${formatCost(costMapx).padStart(8)}  saved ${formatCost(saved).padStart(8)} (${pct}%)${marker}`);
  }
  console.log('');

  // Extrapolated monthly savings
  const sessionsPerDay = 8;
  const workDays = 22;
  const monthlyBaseTokens = summary.totalBaselineTokens * sessionsPerDay * workDays;
  const monthlyMapxTokens = summary.totalMapxTokens * sessionsPerDay * workDays;
  const monthlySavingsTokens = monthlyBaseTokens - monthlyMapxTokens;
  const monthlyCostBase = estimateCost(monthlyBaseTokens, 0, model);
  const monthlyCostMapx = estimateCost(monthlyMapxTokens, 0, model);

  console.log(`  Monthly projection (${sessionsPerDay} sessions/day, ${workDays} work days):`);
  console.log(`    Baseline:       ${formatTokens(monthlyBaseTokens)} tokens  ${formatCost(monthlyCostBase)}`);
  console.log(`    With MapX:      ${formatTokens(monthlyMapxTokens)} tokens  ${formatCost(monthlyCostMapx)}`);
  console.log(`    Monthly saved:  ${formatTokens(monthlySavingsTokens)} tokens  ${formatCost(monthlyCostBase - monthlyCostMapx)}`);
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────

runBenchmarks();
