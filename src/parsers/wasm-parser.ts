import { Parser, Language, Query, QueryCapture } from 'web-tree-sitter';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageDefinition } from '../languages/registry.js';

import { findAssetRoot } from './assets.js';

const PROJECT_ROOT = findAssetRoot(import.meta.url);

let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile(path: string) {
        if (path === 'web-tree-sitter.wasm') {
          return resolve(PROJECT_ROOT, 'wasm', 'web-tree-sitter.wasm');
        }
        return path;
      }
    });
  }
  return initPromise;
}

/** Grammar files loaded in this thread, with how many times each was loaded (M4-10). */
const grammarLoads = new Map<string, number>();

export function grammarLoadCounts(): Array<{ grammar: string; loads: number }> {
  return [...grammarLoads].map(([path, loads]) => ({ grammar: basename(path).replace(/^tree-sitter-/, '').replace(/\.wasm$/, ''), loads }));
}

/**
 * One Language per grammar file per thread (M4-10): parsers sharing a grammar (the TypeScript and
 * JavaScript parsers, the Vue script parser) share its Language, its compiled queries and its pooled
 * parser. Each grammar was loaded once per user. A promise, so concurrent first uses share one load;
 * a failed load is forgotten, so a later use retries.
 */
const languageByPath = new Map<string, Promise<Language>>();

export function loadLanguage(langDef: LanguageDefinition): Promise<Language> {
  const wasmPath = isAbsolute(langDef.grammarWasm) ? langDef.grammarWasm : resolve(PROJECT_ROOT, langDef.grammarWasm);
  let loading = languageByPath.get(wasmPath);
  if (!loading) {
    loading = (async () => {
      await ensureInit();
      const language = await Language.load(await readFile(wasmPath));
      grammarLoads.set(wasmPath, (grammarLoads.get(wasmPath) ?? 0) + 1);
      return language;
    })();
    languageByPath.set(wasmPath, loading);
    loading.catch(() => { if (languageByPath.get(wasmPath) === loading) languageByPath.delete(wasmPath); });
  }
  return loading;
}

export interface ParsedCaptures {
  symbols: Map<string, QueryCapture[]>;
  references: Map<string, QueryCapture[]>;
  nameByNodeId: Map<number, string>;
  scopeByNodeId: Map<number, string>;
}

/**
 * Parser pool: reuses Parser instances per Language to avoid WASM re-init overhead.
 * Each language gets its own parser to prevent language-switching races.
 */
const parserPool = new Map<Language, Parser>();

export function getPooledParser(language: Language): Parser {
  let parser = parserPool.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parserPool.set(language, parser);
  }
  return parser;
}

/**
 * Compiled queries per language. Compiling a query costs far more than running it (about 130 ms
 * for each PHP query), so each (language, query) pair is compiled once per process, as the parse
 * workers already do; small scans and syncs parse on the main thread (M0-02-R3).
 */
const queryCache = new Map<Language, Map<string, Query | null>>();

export function compiledQuery(language: Language, source: string): Query | null {
  let bySource = queryCache.get(language);
  if (!bySource) queryCache.set(language, (bySource = new Map()));
  if (!bySource.has(source)) {
    try {
      bySource.set(source, new Query(language, source));
    } catch (e: any) {
      if (!e.message?.includes('no query')) throw e;
      bySource.set(source, null);
    }
  }
  return bySource.get(source)!;
}

export async function parseWithQueries(
  source: string,
  language: Language,
  symbolsQuery: string,
  referencesQuery: string
): Promise<ParsedCaptures> {
  await ensureInit();
  // Pool parsers per language to avoid re-creating WASM instances on every parse.
  // Each language gets its own parser to avoid language-switching races.
  const parser = getPooledParser(language);
  const tree = parser.parse(source);
  if (!tree) {
    return { symbols: new Map(), references: new Map(), nameByNodeId: new Map(), scopeByNodeId: new Map() };
  }

  const symbolCaptures = new Map<string, QueryCapture[]>();
  const refCaptures = new Map<string, QueryCapture[]>();
  const nameByNodeId = new Map<number, string>();
  const scopeByNodeId = new Map<number, string>();

  const symQuery = compiledQuery(language, symbolsQuery);
  if (symQuery) {
    const symMatches = symQuery.captures(tree.rootNode);
    const kindNodeIds = new Set<number>();
    for (const capture of symMatches) {
      const existing = symbolCaptures.get(capture.name) || [];
      existing.push(capture);
      symbolCaptures.set(capture.name, existing);

      if (capture.name.startsWith('symbol.kind_')) {
        kindNodeIds.add(capture.node.id);
      }
    }
    for (const capture of symMatches) {
      if (capture.name === 'symbol.name') {
        let node: any = capture.node.parent;
        while (node) {
          if (kindNodeIds.has(node.id)) {
            nameByNodeId.set(node.id, capture.node.text);
            break;
          }
          node = node.parent;
        }
      } else if (capture.name === 'symbol.scope') {
        let node: any = capture.node.parent;
        while (node) {
          if (kindNodeIds.has(node.id)) {
            scopeByNodeId.set(node.id, capture.node.text);
            break;
          }
          node = node.parent;
        }
      }
    }
  }

  const refQuery = compiledQuery(language, referencesQuery);
  if (refQuery) {
    const refMatches = refQuery.captures(tree.rootNode);
    for (const capture of refMatches) {
      const existing = refCaptures.get(capture.name) || [];
      existing.push(capture);
      refCaptures.set(capture.name, existing);
    }
  }

  return { symbols: symbolCaptures, references: refCaptures, nameByNodeId, scopeByNodeId };
}

export async function loadQueryFile(queryPath: string): Promise<string> {
  const fullPath = isAbsolute(queryPath) ? queryPath : resolve(PROJECT_ROOT, queryPath);
  return readFile(fullPath, 'utf-8');
}

export { PROJECT_ROOT };
