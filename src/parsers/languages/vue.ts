import type { LanguageParser } from '../parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference } from '../../types.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import { TypeScriptParser } from './typescript.js';
import { getBuiltinLanguages } from '../../languages/registry.js';

export class VueParser implements LanguageParser {
  readonly languageName = 'vue';
  readonly supportedExtensions = ['.vue'];

  private tsParser: TypeScriptParser;

  constructor(langDef: LanguageDefinition) {
    const builtin = getBuiltinLanguages();
    this.tsParser = new TypeScriptParser(builtin.typescript);
  }

  async parse(filePath: string, source: string, options?: any): Promise<ParseResult> {
    const symbols: ExtractedSymbol[] = [];
    const references: ExtractedReference[] = [];
    const errors: ParseResult['errors'] = [];

    // Match all <script> blocks
    const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptRegex.exec(source)) !== null) {
      const code = match[2];
      const matchIndex = match.index;

      // Find the start line of the code block.
      const openingTagMatch = source.slice(matchIndex).match(/<script\b[^>]*>/i);
      const openingTagLength = openingTagMatch ? openingTagMatch[0].length : 0;
      
      const beforeCode = source.slice(0, matchIndex + openingTagLength);
      const startLine = beforeCode.split('\n').length;

      try {
        const res = await this.tsParser.parse(filePath, code, options);

        if (res.symbols) {
          for (const sym of res.symbols) {
            symbols.push({
              ...sym,
              startLine: sym.startLine + startLine - 1,
              endLine: sym.endLine + startLine - 1,
            });
          }
        }

        if (res.references) {
          for (const ref of res.references) {
            references.push({
              ...ref,
              startLine: ref.startLine + startLine - 1,
            });
          }
        }

        if (res.errors) {
          for (const err of res.errors) {
            errors.push({
              ...err,
              line: err.line ? err.line + startLine - 1 : startLine,
            });
          }
        }
      } catch (err: any) {
        errors.push({
          message: `Failed to parse Vue script block starting at line ${startLine}: ${err.message}`,
          line: startLine,
        });
      }
    }

    return { symbols, references, errors };
  }
}
