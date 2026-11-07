import type { LanguageParser } from '../parser-interface.js';
import type { ParseResult, ExtractedSymbol, ExtractedReference } from '../../types.js';
import type { LanguageDefinition } from '../../languages/registry.js';
import { TypeScriptParser } from './typescript.js';
import { getBuiltinLanguages } from '../../languages/registry.js';
import { analyzeOptionsComponent, annotateThisCalls, type OptionsComponent } from './vue-options.js';
import { assignOwners, componentSymbol, scriptBlocks, templateReferences } from './vue-template.js';
import { analyzeScriptBlock, annotateComposableCalls, interfaceMetadata, type VueInterface } from './vue-script-setup.js';
import { navigationReferences } from './vue-navigation.js';

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

    // The Options API object, whose members and mixins template calls see like `this.x()` (M3-02).
    const hasTemplate = /<template\b/i.test(source);
    let optionsComponent: OptionsComponent | null = null;
    // Each block's props / emits, for the component symbol (M3-04).
    const interfaces: VueInterface[] = [];

    // Each <script> block (also `<script setup generic="T extends …<…>">`: M3-11-R1).
    for (const { code, start } of scriptBlocks(source)) {
      // The start line of the code block.
      const startLine = source.slice(0, start).split('\n').length;

      try {
        const res = await this.tsParser.parse(filePath, code, options);
        // Options API `this.x()`: own member, then mixins (M3-03).
        if (res.references) await annotateThisCalls(code, res.references);
        if (hasTemplate && !optionsComponent) optionsComponent = await analyzeOptionsComponent(code).catch(() => null);
        // Macros and composables: the interface, and useX() / destructured calls through the import (M3-04).
        const setup = await analyzeScriptBlock(code).catch(() => null);
        if (setup) {
          interfaces.push(setup.interface);
          if (res.references) annotateComposableCalls(setup, res.references);
        }

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

    // Edge contract rules 1, 2, 4 and 5 (docs/baton/iterations/M3-01.md): the component symbol,
    // template calls and component tags, and the component as owner of code outside any member.
    const component = componentSymbol(filePath, source);
    Object.assign(component.metadata!, interfaceMetadata(interfaces));
    symbols.unshift(component);
    try {
      references.push(...templateReferences(source, component.name, optionsComponent));
      // Rule 9: router.push / <router-link :to> → `navigate` (M3-06).
      references.push(...navigationReferences(source));
    } catch (err: any) {
      errors.push({ message: `Failed to read the Vue template: ${err.message}`, line: 1 });
    }
    assignOwners(references, symbols, component);

    return { symbols, references, errors };
  }
}
