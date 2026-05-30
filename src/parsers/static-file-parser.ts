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

function extractJsonRefs(source: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  let parsed: any;
  try { parsed = JSON.parse(source); } catch { return refs; }

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

export class StaticFileParser implements LanguageParser {
  readonly languageName = 'static';

  get supportedExtensions(): string[] {
    return ['.md', '.mdx', '.markdown', '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.json', '.jsonc', '.json5'];
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
    }

    return { symbols: [], references, errors: [] };
  }
}
