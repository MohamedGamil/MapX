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

/** Every supported language is bundled, so it is always available. */
export function isLanguageInstalled(name: string): boolean {
  return name in languages();
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
  return { name: def.name, tier: def.tier, extensions: def.extensions, grammar, grammarPresent: !!grammar && existsSync(grammar), queries };
}
