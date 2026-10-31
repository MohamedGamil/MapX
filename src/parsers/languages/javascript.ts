import { GenericWasmParser } from '../generic-wasm-parser.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import type { ParseResult } from '../../types.js';
import { annotateStoreRefs } from './vue-stores.js';
import { moduleNavigationReferences } from './vue-navigation.js';

export class JavaScriptParser extends GenericWasmParser {
  constructor(langDef: LanguageDefinition) {
    super(langDef);
  }

  override async parse(filePath: string, source: string, options?: any): Promise<ParseResult> {
    const result = await super.parse(filePath, source, options);
    // Vuex / Pinia store references and store models (M3-05).
    await annotateStoreRefs(filePath, source, result);
    // Vue Router navigation in stores, guards and composables (M3-11); SFCs have their own pass.
    if (!filePath.endsWith('.vue')) result.references.push(...moduleNavigationReferences(source, result.symbols));
    return result;
  }

  protected override extractSignature(source: string, node: any, name: string, kind: string, startLine: number): string {
    const lines = source.split('\n');
    const lineIdx = startLine - 1;
    if (lineIdx >= lines.length) return name;
    const line = lines[lineIdx].trim();

    if (kind === 'function') {
      const match = line.match(/(function\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)/);
      if (match) return match[0];
    }
    if (kind === 'method') {
      const match = line.match(/(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\([^)]*\)/);
      if (match) return match[0];
    }
    if (kind === 'class') {
      const match = line.match(/class\s+\w+(\s+extends\s+\w+)?(\s+implements\s+\w+)?/);
      if (match) return match[0];
    }
    return name;
  }
}
