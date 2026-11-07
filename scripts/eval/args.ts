// Strict command-line parsing for the totals-only scorers, score-routes.ts and score-http.ts (M4-08).
// score-edges.ts has its own parser, with per-pattern thresholds.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ScorerArgSpec {
  /** Flags without a value, such as `json`. */
  booleans: readonly string[];
  /** Flags with a numeric value: `ratio` in [0, 1], `count` an integer >= 0. */
  thresholds: Readonly<Record<string, 'ratio' | 'count'>>;
  /** A file the fixture directory must hold, such as `labels.json`. */
  requiredFile?: string;
}

export interface ScorerArgs {
  fixture: string;
  flags: Set<string>;
  thresholds: Record<string, number>;
}

/**
 * One fixture directory plus known `--flag` / `--flag value` options, each at most once. Throws on an
 * unknown flag (including the unsupported `--name=value` form), a missing or invalid value, a repeat,
 * an extra positional argument or a missing fixture.
 */
export function parseScorerArgs(args: string[], spec: ScorerArgSpec): ScorerArgs {
  let fixture: string | undefined;
  const flags = new Set<string>();
  const thresholds: Record<string, number> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) {
      if (fixture !== undefined) throw new Error(`unexpected argument ${a}`);
      fixture = a;
      continue;
    }
    const name = a.startsWith('--') ? a.slice(2) : '';
    if (spec.booleans.includes(name)) {
      if (flags.has(name)) throw new Error(`--${name} given twice`);
      flags.add(name);
      continue;
    }
    // Own keys only: `--constructor` is an unknown option, not an inherited property (review 2026-11-01).
    const kind = Object.hasOwn(spec.thresholds, name) ? spec.thresholds[name] : undefined;
    if (!kind) throw new Error(`unknown option ${a}`);
    if (Object.hasOwn(thresholds, name)) throw new Error(`--${name} given twice`);
    const raw = args[++i];
    if (raw === undefined || raw.startsWith('--')) throw new Error(`--${name} needs a value`);
    const n = raw.trim() === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${name} ${raw}: not a number`);
    if (kind === 'ratio' ? n < 0 || n > 1 : !Number.isInteger(n) || n < 0)
      throw new Error(`--${name} ${raw}: expected ${kind === 'ratio' ? 'a number in [0, 1]' : 'an integer >= 0'}`);
    thresholds[name] = n;
  }
  if (fixture === undefined) throw new Error('missing <fixture-dir>');
  if (spec.requiredFile && !existsSync(join(fixture, spec.requiredFile))) throw new Error(`${fixture}: no ${spec.requiredFile}`);
  return { fixture, flags, thresholds };
}
