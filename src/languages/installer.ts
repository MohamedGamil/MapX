// Language grammar "installation" (D010): every grammar ships bundled in the package's wasm/ and
// queries/ directories, so there is nothing to install or uninstall. These functions keep the
// `mapx lang install/uninstall` and mapx_lang_* surfaces working with an honest answer.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { findAssetRoot } from '../parsers/assets.js';
import { getBuiltinLanguages, type LanguageDefinition } from './registry.js';

const languages = (): Record<string, LanguageDefinition> => getBuiltinLanguages();

function known(name: string): LanguageDefinition {
  const def = languages()[name];
  if (!def) throw new Error(`Unknown language '${name}'. Supported: ${Object.keys(languages()).join(', ')}`);
  return def;
}

/**
 * A supported language is available when its bundled grammar file is present (static file types
 * need none). A missing WASM means a broken install, not an uninstalled language (M0-12-R6).
 */
export function isLanguageInstalled(name: string): boolean {
  if (!(name in languages())) return false;
  const info = describeLanguage(name);
  return !info.grammar || info.grammarPresent;
}

/** Returns a message: all grammars are bundled, nothing is downloaded or copied. */
export async function installLanguage(name: string): Promise<string> {
  known(name);
  return `'${name}' is bundled with MapX; nothing to install.`;
}

/** Returns a message: bundled grammars cannot be removed (exclude files instead). */
export async function uninstallLanguage(name: string): Promise<string> {
  known(name);
  return `'${name}' is bundled with MapX and cannot be uninstalled. To skip its files, add an exclude pattern (e.g. \`mapx scan --exclude "**/*${known(name).extensions[0] ?? ''}"\`).`;
}

export interface LanguageInfo {
  name: string;
  tier: string;
  extensions: string[];
  filenames: string[];
  grammar: string | null;
  grammarPresent: boolean;
  queries: string[];
}

/** Details for `mapx lang info`. */
export function describeLanguage(name: string): LanguageInfo {
  const def = known(name);
  const root = findAssetRoot(import.meta.url);
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  const grammar = def.grammarWasm ? abs(def.grammarWasm) : null;
  const queries = def.queries ? [def.queries.symbols, def.queries.references].filter(Boolean).map(abs) : [];
  return { name: def.name, tier: def.tier, extensions: def.extensions, filenames: def.filenames ?? [], grammar, grammarPresent: !!grammar && existsSync(grammar), queries };
}

const fileMatches = (def: { extensions: string[]; filenames?: string[] }) => [...def.extensions, ...(def.filenames ?? [])].join(', ');

/** Text of `mapx lang list` and `mapx_lang_list` (one formatter keeps the CLI and MCP in step). */
export function formatLanguageList(): string {
  const rows = Object.entries(languages()).map(([name, def]) => {
    const status = isLanguageInstalled(name) ? 'bundled' : 'missing';
    return { status, line: `  - ${name} (${fileMatches(def)} | tier: ${def.tier} | status: ${status})` };
  });
  const missing = rows.filter((r) => r.status === 'missing').length;
  const header = missing
    ? `Supported languages (${missing} grammar ${missing === 1 ? 'file is' : 'files are'} missing; reinstall MapX):`
    : 'Supported languages (all grammars are bundled):';
  return [header, ...rows.map((r) => r.line)].join('\n');
}

/** Text of `mapx lang info <lang>` and `mapx_lang_info`; throws on an unknown language. */
export function formatLanguageInfo(name: string): string {
  const info = describeLanguage(name);
  const lines = [
    info.name,
    `  Tier:       ${info.tier}`,
    `  Extensions: ${info.extensions.join(', ')}`,
  ];
  if (info.filenames.length) lines.push(`  File names: ${info.filenames.join(', ')}`);
  lines.push(`  Grammar:    ${info.grammar ? `${info.grammar}${info.grammarPresent ? '' : ' (missing!)'}` : 'none (static parser)'}`);
  if (info.queries.length) lines.push(`  Queries:    ${info.queries.join(', ')}`);
  return lines.join('\n');
}
