import { Parser, Language, Query, QueryCapture } from 'web-tree-sitter';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageDefinition } from '../languages/registry.js';

const __thisFile = fileURLToPath(import.meta.url);

/**
 * Find the root directory that contains wasm/ and queries/ subdirectories.
 *
 * Three execution contexts:
 *   1. Source/dev (tsx or bun run src/main.ts):
 *      __thisFile = /path/to/mapx/src/parsers/wasm-parser.ts  → exists
 *      asset root  = resolve(dir, '..', '..')  →  /path/to/mapx/
 *
 *   2. npm-installed (node dist/main.js via npm bin symlink):
 *      __thisFile = /path/to/node_modules/mapx/dist/parsers/wasm-parser.js  → exists
 *      asset root  = resolve(dir, '..', '..')  →  /path/to/node_modules/mapx/
 *
 *   3. Compiled native binary (bun build --compile):
 *      __thisFile = virtual bun:// path  → does NOT exist
 *      falls through to process.execPath-relative search
 */
function findAssetRoot(): string {
  if (existsSync(__thisFile)) {
    // Source/dev or npm-installed transpiled: navigate up from dist/parsers/ or src/parsers/
    return resolve(dirname(__thisFile), '..', '..');
  }

  // Compiled binary: search candidate directories for the wasm/ subdir
  const binDir = dirname(process.execPath);
  const candidates = [
    binDir,                                              // assets next to binary
    resolve(binDir, '..', 'share', 'mapx'),         // XDG system: /usr/local/share/mapx
    join(process.env['HOME'] ?? '', '.local', 'share', 'mapx'), // XDG user
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'wasm'))) return dir;
  }

  return binDir; // fallback — will produce a clear "file not found" on first use
}

const PROJECT_ROOT = findAssetRoot();

let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

export async function loadLanguage(langDef: LanguageDefinition): Promise<Language> {
  await ensureInit();
  const wasmPath = resolve(PROJECT_ROOT, langDef.grammarWasm);
  const wasmBuffer = await readFile(wasmPath);
  const language = await Language.load(wasmBuffer);
  return language;
}

export interface ParsedCaptures {
  symbols: Map<string, QueryCapture[]>;
  references: Map<string, QueryCapture[]>;
  nameByNodeId: Map<number, string>;
}

export async function parseWithQueries(
  source: string,
  language: Language,
  symbolsQuery: string,
  referencesQuery: string
): Promise<ParsedCaptures> {
  await ensureInit();
  // Use a fresh parser instance per call to avoid language-switching races
  // when multiple concurrent parses share the same instance.
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) {
    return { symbols: new Map(), references: new Map(), nameByNodeId: new Map() };
  }

  const symbolCaptures = new Map<string, QueryCapture[]>();
  const refCaptures = new Map<string, QueryCapture[]>();
  const nameByNodeId = new Map<number, string>();

  try {
    const symQuery = new Query(language, symbolsQuery);
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
      }
    }
  } catch (e: any) {
    if (!e.message?.includes('no query')) throw e;
  }

  try {
    const refQuery = new Query(language, referencesQuery);
    const refMatches = refQuery.captures(tree.rootNode);
    for (const capture of refMatches) {
      const existing = refCaptures.get(capture.name) || [];
      existing.push(capture);
      refCaptures.set(capture.name, existing);
    }
  } catch (e: any) {
    if (!e.message?.includes('no query')) throw e;
  }

  return { symbols: symbolCaptures, references: refCaptures, nameByNodeId };
}

export async function loadQueryFile(queryPath: string): Promise<string> {
  const fullPath = resolve(PROJECT_ROOT, queryPath);
  return readFile(fullPath, 'utf-8');
}

export { PROJECT_ROOT };
