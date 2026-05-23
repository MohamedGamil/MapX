import type { LanguageParser } from './parser-interface.js';
import type { LanguageDefinition } from '../languages/registry.js';
import { getLanguageForFile, getBuiltinLanguages } from '../languages/registry.js';
import { PhpParser } from './languages/php.js';
import { JavaScriptParser } from './languages/javascript.js';
import { TypeScriptParser } from './languages/typescript.js';
import { FallbackParser } from './fallback-parser.js';
import { GenericWasmParser } from './generic-wasm-parser.js';
import { isLanguageInstalled } from '../languages/installer.js';

const parserCache = new Map<string, LanguageParser>();
const fallbackParser = new FallbackParser();

export function getParserForFile(filePath: string, userLanguages?: Record<string, LanguageDefinition>): LanguageParser {
  const langDef = getLanguageForFile(filePath, userLanguages);
  if (!langDef) return fallbackParser;

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
      return new TypeScriptParser(langDef);
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
