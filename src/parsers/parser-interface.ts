import type { ParseResult, ExtractedSymbol, ExtractedReference } from '../types.js';

export interface LanguageParser {
  readonly languageName: string;
  readonly supportedExtensions: string[];

  parse(filePath: string, source: string, options?: any): Promise<ParseResult>;
}
