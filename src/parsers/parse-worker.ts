import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getParserForFile } from './parser-registry.js';
import { ignoredSymbolsForFile, type ScopedIgnoredSymbols } from './ignored-symbols.js';
// The main thread's JSONC normaliser (already loaded through parser-registry), so worker and
// main-thread JSON references match (M0-32-R2).
import { stripJsoncSyntax } from './static-file-parser.js';

// --- Self-contained static parsing helpers to avoid ESM loader issues in Workers ---
const isRelativeLike = (s: string) =>
  /^[./]/.test(s) && !/^https?:|^data:|^mailto:|^#/.test(s);

const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown']);
const isMarkdownPath = (s: string) => {
  const dot = s.lastIndexOf('.');
  return dot !== -1 && MARKDOWN_EXTS.has(s.slice(dot).toLowerCase());
};

function extractMarkdownRefs(source: string): any[] {
  const refs: any[] = [];
  const linkRe = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  const lineOf = (idx: number) => source.slice(0, idx).split('\n').length;
  while ((m = linkRe.exec(source)) !== null) {
    const target = m[1].split(' ')[0].trim();
    if (!isRelativeLike(target) || !isMarkdownPath(target)) continue;
    refs.push({ sourceSymbol: null, targetName: target, referenceType: 'import', startLine: lineOf(m.index), verifiability: 'inferred' });
  }
  return refs;
}

function extractHtmlRefs(source: string): any[] {
  const refs: any[] = [];
  const attrRe = /(?:href|src)=["']([^"'#?]+)["']/gi;
  const importRe = /@import\s+["']([^"']+)["']/g;
  const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
  const lineOf = (idx: number) => source.slice(0, idx).split('\n').length;
  for (const re of [attrRe, importRe, urlRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const target = m[1].trim();
      if (!isRelativeLike(target)) continue;
      refs.push({ sourceSymbol: null, targetName: target, referenceType: 'import', startLine: lineOf(m.index), verifiability: 'inferred' });
    }
  }
  return refs;
}

function extractCssRefs(source: string): any[] {
  const refs: any[] = [];
  const importRe = /@import\s+(?:url\(\s*)?["']?([^"');\s]+)["']?(?:\s*\))?/g;
  const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
  const lineOf = (idx: number) => source.slice(0, idx).split('\n').length;
  for (const re of [importRe, urlRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const target = m[1].trim();
      if (!isRelativeLike(target)) continue;
      refs.push({ sourceSymbol: null, targetName: target, referenceType: 'import', startLine: lineOf(m.index), verifiability: 'inferred' });
    }
  }
  return refs;
}

function extractJsonRefs(source: string): any[] {
  const refs: any[] = [];
  let parsed: any;
  try { parsed = JSON.parse(stripJsoncSyntax(source)); } catch { return refs; }
  const check = (val: unknown, line: number) => {
    if (typeof val === 'string' && isRelativeLike(val) && val.includes('/')) {
      refs.push({ sourceSymbol: null, targetName: val, referenceType: 'import', startLine: line, verifiability: 'inferred' });
    }
  };
  for (const key of ['$ref', '$schema', 'extends']) {
    if (typeof parsed?.[key] === 'string') check(parsed[key], 1);
    else if (Array.isArray(parsed?.[key])) parsed[key].forEach((v: unknown) => check(v, 1));
  }
  return refs;
}

function extractYamlRefs(source: string): any[] {
  const refs: any[] = [];
  const lines = source.split('\n');
  const yamlPathRe = /["']?(\.\.?\/[^"'\s#]+?\.(?:yaml|yml))["']?/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    yamlPathRe.lastIndex = 0;
    while ((m = yamlPathRe.exec(line)) !== null) {
      const target = m[1].trim();
      refs.push({
        sourceSymbol: null,
        targetName: target,
        referenceType: 'import',
        startLine: i + 1,
        verifiability: 'inferred'
      });
    }
  }
  return refs;
}


const REF_TYPE_MAP: Record<string, string> = {
  import: 'import',
  require: 'require',
  extends: 'extends',
  implements: 'implements',
  call: 'call',
  instantiation: 'instantiation',
  render: 'render',
};

interface ParseJob {
  id: number;
  filePath: string;
  absolutePath: string;
  language?: string;
}

interface ParseResult {
  id: number;
  symbols: Array<{
    name: string;
    kind: string;
    scope: string | null;
    signature: string;
    startLine: number;
    endLine: number;
    metadata: Record<string, unknown>;
  }>;
  references: Array<{
    sourceSymbol: string | null;
    targetName: string;
    referenceType: string;
    startLine: number;
    verifiability?: string;
  }>;
  errors: Array<{ message: string; line?: number }>;
}

let parserReady = false;
let Parser: any;
let Language: any;
let Query: any;
let loadedLanguages: Map<string, { language: any; symbolsQuery: string; referencesQuery: string; parser: any; compiledSymQuery: any; compiledRefQuery: any }> = new Map();
let langDefs: Map<string, any>;
let assetRoot: string;
let nameByNodeId: Map<number, string>;
let scopedIgnoredSymbols: ScopedIgnoredSymbols | undefined;

async function initParser(): Promise<void> {
  if (parserReady) return;
  assetRoot = workerData.assetRoot;
  const mod = await import('web-tree-sitter');
  Parser = mod.Parser;
  Language = mod.Language;
  Query = mod.Query;
  await Parser.init({
    locateFile(path: string) {
      if (path === 'web-tree-sitter.wasm') {
        return resolve(assetRoot, 'wasm', 'web-tree-sitter.wasm');
      }
      return path;
    }
  });
  parserReady = true;
}

const COMMON_FRAMEWORK_METHODS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback', 'useMemo', 'useRef', 'useImperativeHandle', 'useLayoutEffect', 'useDebugValue',
  'ref', 'computed', 'watch', 'watchEffect', 'provide', 'inject', 'onMounted', 'onUpdated', 'onUnmounted',
  'get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'any', 'all', 'use',
]);

function isContainerKind(kind: string): boolean {
  return kind === 'class' || kind === 'interface' || kind === 'trait' || kind === 'enum' || kind === 'struct' || kind === 'module';
}

function isMemberKind(kind: string): boolean {
  return kind === 'method' || kind === 'property' || kind === 'constant' || kind === 'field';
}

function extractSignature(source: string, node: any, name: string, kind: string, startLine: number): string {
  const lines = source.split('\n');
  const lineIdx = startLine - 1;
  if (lineIdx >= lines.length) return name;
  const line = lines[lineIdx].trim();

  if (kind === 'function') {
    const match = line.match(/(?:export\s+)?(?:async\s+)?function\s+\w+[^{]*/);
    if (match) return match[0].trim();
  }
  if (kind === 'method') {
    const match = line.match(/(?:abstract\s+)?(?:private|protected|public)?\s*(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\([^)]*\)(\s*:\s*[^{;]+)?/);
    if (match) return match[0].trim();
  }
  if (kind === 'class') {
    const match = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+\w+[^{]*/);
    if (match) return match[0].trim();
  }
  if (kind === 'interface') {
    const match = line.match(/(?:export\s+)?interface\s+\w+[^{]*/);
    if (match) return match[0].trim();
  }
  if (kind === 'enum') {
    const match = line.match(/(?:export\s+)?enum\s+\w+/);
    if (match) return match[0].trim();
  }
  return name;
}

function cleanTarget(name: string, refType: string): string {
  if (refType === 'import' || refType === 'require') {
    let cleaned = name.trim();
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    return cleaned.replace(/^['"]|['"]$/g, '');
  }
  return name;
}

async function parseFile(job: ParseJob): Promise<ParseResult> {
  const empty: ParseResult = { id: job.id, symbols: [], references: [], errors: [] };
  // A framework's ignore list applies only inside the folders it was detected for (M3-07).
  const ignoredSymbols = ignoredSymbolsForFile(scopedIgnoredSymbols, job.filePath);

  let source: string;
  try {
    source = await readFile(job.absolutePath, 'utf-8');
  } catch {
    return { ...empty, errors: [{ message: `Failed to read ${job.filePath}` }] };
  }

  // The scanner's language comes first, as on the main thread: it covers shebang scripts and
  // file names such as Rakefile, which have no extension to match.
  let langKey = '';
  let langDef: any = null;
  if (job.language && langDefs.has(job.language)) {
    langKey = job.language;
    langDef = langDefs.get(langKey);
  } else {
    const ext = job.filePath.substring(job.filePath.lastIndexOf('.'));
    for (const [key, def] of langDefs) {
      if (def.extensions.includes(ext)) {
        langKey = key;
        langDef = def;
        break;
      }
    }
  }
  if (!langKey) return empty;

  if (langDef && langDef.tier === 'static') {
    try {
      const parsedExt = job.filePath.split('.').pop()?.toLowerCase() ?? '';
      let references: any[] = [];
      if (parsedExt === 'md' || parsedExt === 'mdx' || parsedExt === 'markdown') {
        references = extractMarkdownRefs(source);
      } else if (parsedExt === 'html' || parsedExt === 'htm' || parsedExt === 'xhtml') {
        references = extractHtmlRefs(source);
      } else if (parsedExt === 'css' || parsedExt === 'scss' || parsedExt === 'sass' || parsedExt === 'less') {
        references = extractCssRefs(source);
      } else if (parsedExt === 'json' || parsedExt === 'jsonc' || parsedExt === 'json5') {
        references = extractJsonRefs(source);
      } else if (parsedExt === 'yaml' || parsedExt === 'yml') {
        references = extractYamlRefs(source);
      }
      return { id: job.id, symbols: [], references, errors: [] };
    } catch (e: any) {
      return { ...empty, errors: [{ message: `Failed to parse static file: ${e.message}` }] };
    }
  }

  // Parse with the same language parser the main thread uses, so language post-processing
  // (PHP facades, dispatch/notify, Laravel roles, TSX defaults, …) is identical in both paths.
  try {
    const parser = getParserForFile(job.filePath, workerData.userLanguages, job.language);
    const result = await parser.parse(job.filePath, source, { facadeMap: workerData.facadeMap, ignoredSymbols });
    return { id: job.id, ...result };
  } catch {
    // Fall back to the generic capture walk below.
  }

  let langCtx = loadedLanguages.get(langKey);
  if (!langCtx) {
    try {
      const def = langDefs.get(langKey);
      const wasmPath = resolve(assetRoot, def.grammarWasm);
      const wasmBuffer = await readFile(wasmPath);
      const language = await Language.load(wasmBuffer);

      const symbolsQuery = await readFile(resolve(assetRoot, def.queries.symbols), 'utf-8');
      const referencesQuery = await readFile(resolve(assetRoot, def.queries.references), 'utf-8');

      const parser = new Parser();
      parser.setLanguage(language);
      const compiledSymQuery = new Query(language, symbolsQuery);
      const compiledRefQuery = new Query(language, referencesQuery);
      langCtx = { language, symbolsQuery, referencesQuery, parser, compiledSymQuery, compiledRefQuery };
      loadedLanguages.set(langKey, langCtx);
    } catch {
      return { ...empty, errors: [{ message: `Failed to load language for ${job.filePath}` }] };
    }
  }

  try {
    const tree = langCtx.parser.parse(source);
    if (!tree) {
      return { ...empty, errors: [{ message: `Parser returned null for ${job.filePath}` }] };
    }

    const symbols: ParseResult['symbols'] = [];
    const references: ParseResult['references'] = [];
    nameByNodeId = new Map();

    try {
      const symQuery = langCtx.compiledSymQuery;
      const allSymCaptures = symQuery.captures(tree.rootNode);
      const kindNodeIds = new Set<number>();
      const scopeByNodeId = new Map<number, string>();

      for (const capture of allSymCaptures) {
        if (capture.name.startsWith('symbol.kind_')) {
          kindNodeIds.add(capture.node.id);
        }
      }
      for (const capture of allSymCaptures) {
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

      const seenNodeIds = new Set<number>();
      for (const capture of allSymCaptures) {
        if (capture.name.startsWith('symbol.kind_')) {
          if (seenNodeIds.has(capture.node.id)) continue;
          seenNodeIds.add(capture.node.id);

          let kind = capture.name.replace('symbol.kind_', '');
          let name = nameByNodeId.get(capture.node.id) || capture.node.text;

          const isDefaultOrAnonymous =
            capture.node.type === 'arrow_function' ||
            capture.node.type === 'function_expression' ||
            (capture.node.type === 'function_declaration' && !capture.node.childForFieldName('name')) ||
            (capture.node.type === 'class_declaration' && !capture.node.childForFieldName('name')) ||
            (capture.node.type === 'class' && !capture.node.childForFieldName('name')) ||
            capture.node.type === 'script_element';

          if (isDefaultOrAnonymous) {
            const baseName = job.filePath.split('/').pop() || '';
            name = baseName.replace(/\.[a-zA-Z0-9]+$/, '') || 'default';
          }

          const startLine = capture.node.startPosition.row + 1;
          const endLine = capture.node.endPosition.row + 1;

          let extractedScope: string | null = null;
          if (kind === 'function') {
            let curr = capture.node.parent;
            while (curr) {
              if (
                curr.type === 'class_definition' ||
                curr.type === 'class_declaration' ||
                curr.type === 'struct_specifier' ||
                curr.type === 'impl_item' ||
                curr.type === 'interface_declaration'
              ) {
                kind = 'method';
                if (curr.type === 'impl_item') {
                  const typeChild = curr.childForFieldName ? curr.childForFieldName('type') : null;
                  if (typeChild) {
                    extractedScope = typeChild.text;
                  }
                }
                break;
              }
              curr = curr.parent;
            }
          }

          const signature = extractSignature(source, capture.node, name, kind, startLine);
          const explicitScope = scopeByNodeId.get(capture.node.id) || extractedScope;
          let resolvedScope = explicitScope || null;
          if (!resolvedScope && isMemberKind(kind)) {
            let curr = capture.node.parent;
            while (curr) {
              const parentName = nameByNodeId.get(curr.id);
              if (parentName) {
                resolvedScope = parentName;
                break;
              }
              curr = curr.parent;
            }
          }

          if (ignoredSymbols?.has(name)) {
            continue;
          }

          symbols.push({
            name,
            kind,
            scope: resolvedScope,
            signature,
            startLine,
            endLine,
            metadata: {},
          });
        }
      }
    } catch {}

    try {
      const refQuery = langCtx.compiledRefQuery;
      for (const capture of refQuery.captures(tree.rootNode)) {
        const startLine = capture.node.startPosition.row + 1;

        if (capture.name.startsWith('ref.target_')) {
          const rawType = capture.name.replace('ref.target_', '');
          const targetText = capture.node.text;
          if (!targetText || typeof targetText !== 'string') continue;
          const targetName = cleanTarget(targetText, rawType);
          if (!targetName || typeof targetName !== 'string') continue;

          if (rawType === 'render') {
            const isReactComponent = /^[A-Z]/.test(targetName);
            if (!isReactComponent) continue;
          }

          const refType = REF_TYPE_MAP[rawType] || 'call';

          let verifiability: 'verified' | 'inferred' = 'verified';
          if (refType === 'call' && COMMON_FRAMEWORK_METHODS.has(targetName)) {
            verifiability = 'inferred';
          }

          if (ignoredSymbols?.has(targetName)) {
            continue;
          }

          references.push({
            sourceSymbol: null,
            targetName,
            referenceType: refType,
            startLine,
            verifiability,
          });
        }
      }
    } catch {}

    return { id: job.id, symbols, references, errors: [] };
  } catch {
    return { ...empty, errors: [{ message: `Failed to parse ${job.filePath}` }] };
  }
}

async function initLanguages(): Promise<void> {
  // Pre-warm all language grammars sequentially before accepting any jobs.
  // This avoids a race condition where concurrent async message handlers all see
  // loadedLanguages.get(lang) === null and try to compile WASM simultaneously,
  // saturating the libuv thread pool and causing a hang.
  for (const [key, def] of langDefs) {
    if (def.tier === 'static') continue;
    try {
      const wasmPath = resolve(assetRoot, def.grammarWasm);
      const wasmBuffer = await readFile(wasmPath);
      const language = await Language.load(wasmBuffer);
      const symbolsQuery = await readFile(resolve(assetRoot, def.queries.symbols), 'utf-8');
      const referencesQuery = await readFile(resolve(assetRoot, def.queries.references), 'utf-8');
      const parser = new Parser();
      parser.setLanguage(language);
      const compiledSymQuery = new Query(language, symbolsQuery);
      const compiledRefQuery = new Query(language, referencesQuery);
      loadedLanguages.set(key, { language, symbolsQuery, referencesQuery, parser, compiledSymQuery, compiledRefQuery });
    } catch {
      // language unavailable — files of this type will return empty results
    }
  }
}

async function main() {
  langDefs = new Map(Object.entries(workerData.languages));
  if (workerData.ignoredSymbols) {
    scopedIgnoredSymbols = workerData.ignoredSymbols;
  }

  await initParser();
  await initLanguages();

  parentPort!.on('message', async (job: ParseJob) => {
    const result = await parseFile(job);
    parentPort!.postMessage(result);
  });

  parentPort!.postMessage({ type: 'ready' });
}

main().catch((err) => {
  parentPort!.postMessage({ type: 'error', error: err.message });
});
