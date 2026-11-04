/**
 * Blade to PHP (M2-23): the source of a `.blade.php` file with the parts that are PHP turned into
 * `<?php … ?>` blocks, so the PHP grammar reads them. Everything else is text to the grammar, which
 * skips it. Only the code a Blade file writes as PHP is read:
 *   - `@php … @endphp` and `@php(expr)`;
 *   - the echoes `{{ expr }}`, `{!! expr !!}` and the legacy `{{{ expr }}}`;
 *   - `@use('Class')` and `@use('Class', 'Alias')`, which are `use` statements;
 *   - `@inject('name', 'Class')`, which names its class;
 *   - raw `<?php … ?>` and `<?= … ?>` blocks, kept as they are.
 * Other directives (`@if ($a)`, `@foreach ($xs as $x)`, `@include('view')`) are not complete PHP
 * and stay text; `{{-- … --}}` comments, `@verbatim … @endverbatim` and the escaped `@{{ … }}` are
 * blanked, since they are never PHP. Every replacement keeps the source's own newlines, so a line
 * number of the result is the line of the Blade file.
 */

/** The text with everything but its newlines removed: the same lines, nothing to read. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, '');
}

/** The index of the `)` that closes the `(` at `open`, skipping quoted strings; -1 when it never closes. */
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'" || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** The quoted strings of a directive's arguments, unescaped, in order. */
function stringArguments(args: string): string[] {
  const found: string[] = [];
  for (const m of args.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
    // PHP's own escapes: `\\` and the quote that delimits; any other backslash is literal.
    found.push(m[1] !== undefined ? m[1].replace(/\\([\\'])/g, '$1') : (m[2] ?? '').replace(/\\([\\"])/g, '$1'));
  }
  return found;
}

const NEXT_TOKEN = /<\?|\{\{|\{!!|@/g;
const END_PHP = /@endphp\b/g;

export function bladeToPhp(src: string): string {
  let out = '';
  let pos = 0;
  while (pos < src.length) {
    NEXT_TOKEN.lastIndex = pos;
    const m = NEXT_TOKEN.exec(src);
    if (!m) { out += src.slice(pos); break; }
    const at = m.index;
    out += src.slice(pos, at);
    const token = m[0];

    // Raw PHP tags are PHP already; copy them through their closing tag.
    if (token === '<?') {
      const close = src.indexOf('?>', at + 2);
      const stop = close === -1 ? src.length : close + 2;
      out += src.slice(at, stop);
      pos = stop;
      continue;
    }

    if (token === '{{' || token === '{!!') {
      // `{{-- comment --}}`
      if (src.startsWith('{{--', at)) {
        const close = src.indexOf('--}}', at + 4);
        const stop = close === -1 ? src.length : close + 4;
        out += blank(src.slice(at, stop));
        pos = stop;
        continue;
      }
      const open = token === '{!!' ? '{!!' : src.startsWith('{{{', at) ? '{{{' : '{{';
      const closer = open === '{!!' ? '!!}' : open === '{{{' ? '}}}' : '}}';
      const close = src.indexOf(closer, at + open.length);
      if (close === -1) { out += token; pos = at + token.length; continue; }
      out += `<?php echo ${src.slice(at + open.length, close)}; ?>`;
      pos = close + closer.length;
      continue;
    }

    // token === '@'
    if (src[at + 1] === '@') { out += '@@'; pos = at + 2; continue; }
    // `@{{ expr }}` is text for a JavaScript framework; Blade never evaluates it.
    if (src.startsWith('@{{', at)) {
      const close = src.indexOf('}}', at + 3);
      const stop = close === -1 ? src.length : close + 2;
      out += blank(src.slice(at, stop));
      pos = stop;
      continue;
    }
    // A directive starts at a non-word character: `webmaster@php.net` is an address (Blade's `\B@`).
    if (at > 0 && /\w/.test(src[at - 1]!)) { out += '@'; pos = at + 1; continue; }
    const name = /^@(\w+)/.exec(src.slice(at, at + 24))?.[1];
    const afterName = at + 1 + (name?.length ?? 0);

    if (name === 'verbatim') {
      const close = src.indexOf('@endverbatim', afterName);
      const stop = close === -1 ? src.length : close + '@endverbatim'.length;
      out += blank(src.slice(at, stop));
      pos = stop;
      continue;
    }

    if (name === 'php') {
      // Only spaces and tabs may lead the parenthesis, as in Blade: `@php`, a newline, then `(` opens a block.
      const paren = /^[ \t]*\(/.exec(src.slice(afterName, afterName + 64));
      if (paren) {
        // `@php($x = 1)`: one statement.
        const open = afterName + paren[0].length - 1;
        const close = closingParen(src, open);
        if (close !== -1) {
          out += `<?php ${src.slice(open + 1, close)}; ?>`;
          pos = close + 1;
          continue;
        }
      }
      // `@php … @endphp`: statements, up to the end tag (or the file's end).
      END_PHP.lastIndex = afterName;
      const end = END_PHP.exec(src);
      const bodyEnd = end ? end.index : src.length;
      out += `<?php ${src.slice(afterName, bodyEnd)} ?>`;
      pos = end ? bodyEnd + end[0].length : src.length;
      continue;
    }

    if (name === 'use' || name === 'inject') {
      const paren = /^[ \t]*\(/.exec(src.slice(afterName, afterName + 64));
      const open = paren ? afterName + paren[0].length - 1 : -1;
      const close = open === -1 ? -1 : closingParen(src, open);
      if (close !== -1) {
        const args = stringArguments(src.slice(open + 1, close));
        const bare = src.slice(open + 1, close).trim();
        // `@use('App\Models\Flight', 'F')`, or an unquoted `@use(App\Models\Flight)`.
        const cls = (name === 'use' ? args[0] ?? (/^[\w\\]+$/.test(bare) ? bare : undefined) : args[1])?.replace(/^\\/, '');
        if (cls && /^[\w\\]+$/.test(cls)) {
          const alias = name === 'use' ? args[1] : undefined;
          // The statement keeps the line of the directive's last line, where the arguments end.
          const lines = blank(src.slice(afterName, close + 1));
          out += name === 'use'
            ? `<?php use ${cls}${alias && /^\w+$/.test(alias) ? ` as ${alias}` : ''}; ?>${lines}`
            : `<?php \\${cls}::class; ?>${lines}`;
          pos = close + 1;
          continue;
        }
      }
    }

    // Any other directive, an email address, a decorator: text.
    out += '@';
    pos = at + 1;
  }
  return out;
}
