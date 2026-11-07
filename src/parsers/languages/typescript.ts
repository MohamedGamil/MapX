import { GenericWasmParser } from '../generic-wasm-parser.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import type { ParseResult } from '../../types.js';
import { annotateStoreRefs } from './vue-stores.js';
import { moduleNavigationReferences } from './vue-navigation.js';
import { dropRepeatedAssignments, memberAssignmentMetadata, memberAssignmentSignature } from './javascript.js';

export class TypeScriptParser extends GenericWasmParser {
  constructor(langDef: LanguageDefinition) {
    super(langDef);
  }

  override async parse(filePath: string, source: string, options?: any): Promise<ParseResult> {
    const result = await super.parse(filePath, source, options);
    result.symbols = dropRepeatedAssignments(result.symbols);
    // Vuex / Pinia store references and store models (M3-05); also runs on .vue script blocks.
    await annotateStoreRefs(filePath, source, result, options?.absolutePath);
    // Vue Router navigation in stores, guards and composables (M3-11); SFCs have their own pass.
    if (!filePath.endsWith('.vue')) result.references.push(...moduleNavigationReferences(source, result.symbols));
    return result;
  }

  protected override symbolMetadata(node: any): Record<string, unknown> {
    return memberAssignmentMetadata(node);
  }

  protected override extractSignature(source: string, node: any, name: string, kind: string, startLine: number): string {
    return memberAssignmentSignature(source, node) ?? super.extractSignature(source, node, name, kind, startLine);
  }
}
