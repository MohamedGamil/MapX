import { GenericWasmParser } from '../generic-wasm-parser.js';
import type { LanguageDefinition } from '../../languages/registry.js';

export class TypeScriptParser extends GenericWasmParser {
  constructor(langDef: LanguageDefinition) {
    super(langDef);
  }
}
