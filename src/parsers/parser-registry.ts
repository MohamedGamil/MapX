import type { LanguageParser } from './parser-interface.js';
import type { LanguageDefinition } from '../languages/registry.js';
import { getLanguageByName, getLanguageForFile, getBuiltinLanguages } from '../languages/registry.js';
import { PhpParser } from './languages/php.js';
import { JavaScriptParser } from './languages/javascript.js';
import { TypeScriptParser } from './languages/typescript.js';
import { VueParser } from './languages/vue.js';
import { SvelteParser } from './languages/svelte.js';
import { FallbackParser } from './fallback-parser.js';
import { StaticFileParser } from './static-file-parser.js';
import { GenericWasmParser } from './generic-wasm-parser.js';
import { isLanguageInstalled } from '../languages/installer.js';

const parserCache = new Map<string, LanguageParser>();
const fallbackParser = new FallbackParser();
const staticFileParser = new StaticFileParser();

/**
 * Parser for a file. `languageName` overrides extension lookup — used for extensionless scripts
 * whose language came from their shebang line.
 */
export function getParserForFile(filePath: string, userLanguages?: Record<string, LanguageDefinition>, languageName?: string): LanguageParser {
  const langDef = (languageName ? getLanguageByName(languageName, userLanguages) : null) ?? getLanguageForFile(filePath, userLanguages);
  if (!langDef) return fallbackParser;

  if (langDef.tier === 'static') return staticFileParser;

  if (langDef.tier === 'installable' && !isLanguageInstalled(langDef.name)) {
    return fallbackParser;
  }

  const cached = parserCache.get(langDef.name);
  if (cached) return cached;

  const parser = createParser(langDef);
  parserCache.set(langDef.name, parser);
  return parser;
}



function createParser(langDef: LanguageDefinition): LanguageParser {
  switch (langDef.name) {
    case 'php':
      return new PhpParser(langDef);
    case 'javascript':
      return new JavaScriptParser(langDef);
    case 'typescript':
    case 'tsx':
      return new TypeScriptParser(langDef);
    case 'vue':
      return new VueParser(langDef);
    case 'svelte':
      return new SvelteParser(langDef);
    case 'python':
    case 'go':
    case 'rust':
    case 'java':
    case 'c-sharp':
      return new GenericWasmParser(langDef);
    default:
      if (langDef.tier === 'bundled' || langDef.tier === 'installable' || langDef.tier === 'user') {
        return new GenericWasmParser(langDef);
      }
      return fallbackParser;
  }
}

export function clearParserCache(): void {
  parserCache.clear();
}
