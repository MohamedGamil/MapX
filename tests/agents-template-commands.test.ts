// M4-28-R1: the agent templates advertise only what the CLI takes. Every `mapx …` command line in
// a template (a code span, or a fenced line starting with `mapx `) names an existing command, and
// each flag on it is listed by the `--help` of the command it is written on: M4-28 found
// `mapx explain <file> [--reclassify]`, a flag no command has.
import { describe, it, expect } from 'vitest';
import type { Command, Option } from 'commander';
import { buildCLI } from '../src/cli.js';
import { TEMPLATES } from '../src/agents/templates.js';

/** The command lines a template advertises, without the leading `mapx `. */
function commandLines(content: string): string[] {
  const spans = [...content.matchAll(/`mapx ([^`\n]+)`/g)].map((m) => m[1]!);
  const fenced: string[] = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence && line.startsWith('mapx ')) fenced.push(line.slice(5));
  }
  return [...spans, ...fenced];
}

/** The flags `<cmd> --help` lists. */
function helpFlags(cmd: Command): Set<string> {
  const opts: Option[] = cmd.createHelp().visibleOptions(cmd);
  return new Set(opts.flatMap((o) => [o.long, o.short]).filter((f): f is string => !!f));
}

const findSub = (cmd: Command, name: string): Command | undefined =>
  (cmd.commands as Command[]).find((c) => c.name() === name || c.aliases().includes(name));

/** Resolves a command line against the program; returns its problems. */
function check(program: Command, line: string): string[] {
  const problems: string[] = [];
  const tokens = line.split(/\s+/).map((t) => t.replace(/^\[|\]$/g, '')).filter(Boolean);
  let cmd = program;
  let descending = true;
  const operands: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const flag = tok.match(/^(--?[A-Za-z][\w-]*)(=.*)?$/);
    if (flag) {
      if (!helpFlags(cmd).has(flag[1]!)) problems.push(`mapx ${line}: \`${cmd.name()} --help\` does not list ${flag[1]}`);
      // The value written after an option that takes one is neither a command nor an operand.
      const opt = (cmd.options as Option[]).find((o) => o.long === flag[1] || o.short === flag[1]);
      if (opt && (opt.required || opt.optional) && !flag[2]) i++;
      continue;
    }
    if (!descending) { operands.push(tok); continue; }
    const sub = findSub(cmd, tok);
    if (sub) { cmd = sub; continue; }
    if (tok.includes('|') && cmd.commands.length) {
      // `mapx arch layers|which|…`: alternatives, each a subcommand.
      for (const alt of tok.split('|')) if (!findSub(cmd, alt)) problems.push(`mapx ${line}: no command \`${cmd.name()} ${alt}\``);
      descending = false;
      continue;
    }
    if (cmd === program) problems.push(`mapx ${line}: no command \`${tok}\``);
    descending = false; // an operand; the remaining flags are this command's
    operands.push(tok);
  }
  if (cmd === program && descending) problems.push(`mapx ${line}: names no command`);
  // A command with subcommands takes a word that names none of them only as one of its own
  // operands, and no more operands than it declares: `mapx lang lst` and `mapx arch allowd <a> <b>`
  // exit 1 with "unknown command" (review of M4-28-R1).
  if (cmd !== program && cmd.commands.length && operands.length) {
    const declared = cmd.registeredArguments;
    const room = declared.some((a) => a.variadic) ? Infinity : declared.length;
    if (operands.length > room) problems.push(`mapx ${line}: no command \`${cmd.name()} ${operands[0]}\``);
  }
  return problems;
}

describe('agent templates advertise only commands and flags the CLI takes', () => {
  const program = buildCLI();
  const lines = Object.entries(TEMPLATES).flatMap(([provider, t]) => commandLines(t.content).map((l) => ({ provider, line: l })));

  it('finds the command lines of the templates (explain, trace, serve and arch among them)', () => {
    const all = lines.map((l) => l.line);
    expect(all.length).toBeGreaterThan(50);
    for (const prefix of ['explain <file>', 'trace [symbol-or-file]', 'serve --sse --port', 'arch allowed', '-d /path/to/project scan'])
      expect(all.some((l) => l.startsWith(prefix)), prefix).toBe(true);
  });

  it('every command line names an existing command, and that command\'s --help lists each flag', () => {
    const problems = [...new Set(lines.flatMap(({ provider, line }) => check(program, line).map((p) => `${provider}: ${p}`)))];
    expect(problems).toEqual([]);
  });

  it('the checker rejects an unknown flag, an unknown command and a flag of another command', () => {
    expect(check(program, 'explain <file> [--reclassify]')).toHaveLength(1);
    expect(check(program, 'frobnicate --json')).not.toEqual([]);
    expect(check(program, 'query <term> --include-members')).toHaveLength(1);
    expect(check(program, 'arch layers|nope')).toHaveLength(1);
    // A mistyped subcommand (review of M4-28-R1): the CLI exits 1 with "unknown command".
    expect(check(program, 'lang lst')).toHaveLength(1);
    expect(check(program, 'workspaces lst')).toHaveLength(1);
    expect(check(program, 'arch allowd <a> <b>')).toHaveLength(1);
    expect(check(program, 'arch [path] [--smells]')).toEqual([]);
    expect(check(program, 'node <symbol> --include-members --format json')).toEqual([]);
    expect(check(program, '-d /path/to/project scan')).toEqual([]);
  });
});
