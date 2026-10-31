import { GenericWasmParser } from '../generic-wasm-parser.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import type { ParseResult } from '../../types.js';
import { annotateStoreRefs } from './vue-stores.js';

export class TypeScriptParser extends GenericWasmParser {
  constructor(langDef: LanguageDefinition) {
    super(langDef);
  }

  override async parse(filePath: string, source: string, options?: any): Promise<ParseResult> {
    const result = await super.parse(filePath, source, options);
    // Vuex / Pinia store references and store models (M3-05); also runs on .vue script blocks.
    await annotateStoreRefs(filePath, source, result);
    return result;
  }
}
