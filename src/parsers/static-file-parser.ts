/**
 * StaticFileParser — index-only parser for Markdown, HTML, CSS, and JSON files.
 *
 * Does NOT extract symbols. Only extracts file-level dependency references so
 * these files appear in the graph and their link relationships are recorded.
 *
 * Extraction rules:
 *  - Markdown : [text](url) inline links + ![alt](url) image links
 *  - HTML     : href="…", src="…", @import "…", url("…")
 *  - CSS/SCSS : @import "…", url("…")
 *  - JSON     : $ref, $schema, "extends", top-level string values that look like paths
 */

import type { LanguageParser } from './parser-interface.js';
import type { ParseResult, ExtractedReference } from '../types.js';

// Relative path heuristic: starts with ./ or ../ or /  (excludes http/https/data:)
const isRelativeLike = (s: string) =>
  /^[./]/.test(s) && !/^https?:|^data:|^mailto:|^#/.test(s);

const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown']);
const isMarkdownPath = (s: string) => {
  const dot = s.lastIndexOf('.');
  return dot !== -1 && MARKDOWN_EXTS.has(s.slice(dot).toLowerCase());
};

function extractMarkdownRefs(source: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  // [text](url) and ![alt](url)
  const linkRe = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  const lines = source.split('\n');
  const lineOf = (idx: number) => source.slice(0, idx).split('\n').length;
  while ((m = linkRe.exec(source)) !== null) {
    const target = m[1].split(' ')[0].trim(); // strip optional title
    if (!isRelativeLike(target) || !isMarkdownPath(target)) continue;
    refs.push({ sourceSymbol: null, targetName: target, referenceType: 'import', startLine: lineOf(m.index), verifiability: 'inferred' });
  }
  return refs;
}

function extractHtmlRefs(source: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  // href="…", src="…"
  const attrRe = /(?:href|src)=["']([^"'#?]+)["']/gi;
  // @import "…" / @import '…'
  const importRe = /@import\s+["']([^"']+)["']/g;
  // url("…") / url('…') / url(…)
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

function extractCssRefs(source: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
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

/**
 * Normalise JSONC / JSON5 text into strict JSON that `JSON.parse` accepts.
 *
 * Handles the most common deviations found in tsconfig.json, VS Code settings,
 * and JSON5 config files:
 *   1. Line comments (`// …`)
 *   2. Block comments (`/* … *​/`)
 *   3. Trailing commas before `}` or `]`
 *   4. Single-quoted strings → double-quoted
 *   5. Unquoted object keys
 */
function stripJsoncSyntax(raw: string): string {
  let result = '';
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const ch = raw[i];

    // --- Double-quoted string: copy verbatim (preserving escapes) ---
    if (ch === '"') {
      let j = i + 1;
      while (j < len && raw[j] !== '"') {
        if (raw[j] === '\\') j++; // skip escaped char
        j++;
      }
      result += raw.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // --- Single-quoted string → double-quoted ----------------------
    if (ch === "'") {
      let j = i + 1;
      let inner = '';
      while (j < len && raw[j] !== "'") {
        if (raw[j] === '\\') {
          inner += raw[j] + raw[j + 1];
          j += 2;
        } else {
          // Escape embedded double-quotes so the result stays valid
          inner += raw[j] === '"' ? '\\"' : raw[j];
          j++;
        }
      }
      result += '"' + inner + '"';
      i = j + 1;
      continue;
    }

    // --- Line comment: skip to EOL --------------------------------
    if (ch === '/' && i + 1 < len && raw[i + 1] === '/') {
      i += 2;
      while (i < len && raw[i] !== '\n') i++;
      continue;
    }

    // --- Block comment: skip to closing *​/ -------------------------
    if (ch === '/' && i + 1 < len && raw[i + 1] === '*') {
      i += 2;
      while (i + 1 < len && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }

    result += ch;
    i++;
  }

  // Remove trailing commas before } or ]
  result = result.replace(/,\s*([}\]])/g, '$1');

  // Wrap unquoted object keys:  { foo: … }  →  { "foo": … }
  // Matches a word at a position where a JSON key is expected (after { or ,).
  result = result.replace(/([\{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

  return result;
}

function extractJsonRefs(source: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  let parsed: any;
  try { parsed = JSON.parse(stripJsoncSyntax(source)); } catch { return refs; }

  const check = (val: unknown, line: number) => {
    if (typeof val === 'string' && isRelativeLike(val) && val.includes('/')) {
      refs.push({ sourceSymbol: null, targetName: val, referenceType: 'import', startLine: line, verifiability: 'inferred' });
    }
  };

  // $ref / $schema / extends
  for (const key of ['$ref', '$schema', 'extends']) {
    if (typeof parsed?.[key] === 'string') check(parsed[key], 1);
    else if (Array.isArray(parsed?.[key])) parsed[key].forEach((v: unknown) => check(v, 1));
  }
  return refs;
}
function extractYamlRefs(source: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const lines = source.split('\n');
  
  // Match relative-like paths ending in .yaml or .yml (e.g. ./config.yaml, ../other.yml)
  const yamlPathRe = /["']?(\.\.?\/[^"'\s#]+?\.(?:yaml|yml))["']?/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    yamlPathRe.lastIndex = 0; // Reset regex
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

export class StaticFileParser implements LanguageParser {
  readonly languageName = 'static';

  get supportedExtensions(): string[] {
    return ['.md', '.mdx', '.markdown', '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.json', '.jsonc', '.json5', '.yaml', '.yml'];
  }

  async parse(filePath: string, source: string): Promise<ParseResult> {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    let references: ExtractedReference[] = [];

    if (ext === 'md' || ext === 'mdx' || ext === 'markdown') {
      references = extractMarkdownRefs(source);
    } else if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
      references = extractHtmlRefs(source);
    } else if (ext === 'css' || ext === 'scss' || ext === 'sass' || ext === 'less') {
      references = extractCssRefs(source);
    } else if (ext === 'json' || ext === 'jsonc' || ext === 'json5') {
      references = extractJsonRefs(source);
    } else if (ext === 'yaml' || ext === 'yml') {
      references = extractYamlRefs(source);
    }

    return { symbols: [], references, errors: [] };
  }
}
