// Every value the dashboard interpolates into HTML is escaped (M4-24). Reads src/ui/main.ts with
// the TypeScript parser, finds each template literal that builds HTML (its text contains a tag),
// and checks every `${…}` in it. An interpolation is safe when it is:
// - escapeHtml(…) or attr(…), or a helper that returns escaped HTML (SAFE_CALLS);
// - numeric: a number literal, arithmetic, .length, .toFixed(…), .toLocaleString(), Math.*(…),
//   or a name in NUMERIC_NAMES;
// - a constant the code itself chose: a string literal, or a name in TRUSTED_NAMES (CSS tokens,
//   class names, ids built from numbers);
// - a conditional, `||`/`??` or nested template literal whose parts are all safe;
// - a `.map(…).join('')` whose callback returns a safe template.
// Anything else is reported with its line.
//   npx tsx scripts/ui/check-escaping.ts [file]     exit 1 and a list when one is unsafe
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/** Helpers that return escaped HTML or a constant the code chose (their own templates are checked too). */
const SAFE_CALLS = new Set(['escapeHtml', 'renderYesNo', 'num', 'boxHtml', 'highlightMatch', 'renderPills', 'configValueHtml', 'chips', 'barList', 'statTiles', 'layerToken', 'getRouteMethodColor', 'getHookTypeColor']);
const NUMERIC_NAMES = new Set(['i', 'j', 'n', 'pct', 'alpha', 'total', 'offset', 'count', 'cnt', 'deg', 'depth', 'pageSize', 'start', 'end', 'healthScore', 'val', 'textVal', 'fileCount', 'lineCount', 'symbolCount', 'inDegree', 'outDegree']);
const TRUSTED_NAMES = new Set(['methodColor', 'hookColor', 'roleColor', 'color', 'bgStyle', 'cellClass', 'statusIcon', 'durationStr', 'severityClass', 'badgeClass', 'chevron', 'DETAILS_PLACEHOLDER', 'unit']);

export interface Unsafe { line: number; expression: string }

/**
 * Local variables holding HTML fragments (`smellsHtml`, `gitStatusHTML`…): safe when every value
 * assigned to them is a string literal, a template literal (whose spans this check covers), a
 * conditional of those, a `.map(…).join('')` of safe templates, or another such fragment.
 */
let fragmentAssignments = new Map<string, ts.Expression[]>();

function collectAssignments(sf: ts.SourceFile) {
  fragmentAssignments = new Map();
  const add = (name: string, e: ts.Expression) => {
    const list = fragmentAssignments.get(name) ?? [];
    list.push(e);
    fragmentAssignments.set(name, list);
  };
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) add(n.name.text, n.initializer);
    if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && (n.operatorToken.kind === ts.SyntaxKind.EqualsToken || n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) add(n.left.text, n.right);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function fragmentSafe(name: string, sf: ts.SourceFile, seen = new Set<string>()): boolean {
  if (seen.has(name)) return true;
  seen.add(name);
  const values = fragmentAssignments.get(name);
  if (!values?.length || !/(Html|HTML|Str|List|Badge|^types|^html)$/.test(name)) return false;
  const htmlSafe = (e: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(e)) return htmlSafe(e.expression);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
    if (ts.isTemplateExpression(e)) return true; // its spans are checked where it stands
    if (ts.isConditionalExpression(e)) return htmlSafe(e.whenTrue) && htmlSafe(e.whenFalse);
    if (ts.isIdentifier(e)) return fragmentSafe(e.text, sf, seen);
    return isSafe(e, sf);
  };
  return values.every(htmlSafe);
}

function isSafe(node: ts.Expression, sf: ts.SourceFile): boolean {
  if (ts.isParenthesizedExpression(node)) return isSafe(node.expression, sf);
  if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node)) return NUMERIC_NAMES.has(node.text) || TRUSTED_NAMES.has(node.text) || fragmentSafe(node.text, sf);
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((s) => isSafe(s.expression, sf));
  if (ts.isConditionalExpression(node)) return isSafe(node.whenTrue, sf) && isSafe(node.whenFalse, sf);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if ([ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken].includes(op)) return true;
    if (op === ts.SyntaxKind.PlusToken) return isSafe(node.left, sf) && isSafe(node.right, sf);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return isSafe(node.left, sf) && isSafe(node.right, sf);
    if ([ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanEqualsToken].includes(op)) return true;
    return false;
  }
  if (ts.isPropertyAccessExpression(node)) {
    // x.length; a trusted name's property
    if (node.name.text === 'length') return true;
    return false;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      if (SAFE_CALLS.has(callee.text)) return true;
      if (callee.text === 'String' || callee.text === 'Number') return node.arguments.every((a) => isSafe(a, sf));
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      if (['toFixed', 'toLocaleString', 'toPrecision'].includes(m)) return true;
      if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Math') return true;
      // xs.map(cb).join('')
      if (m === 'join' && ts.isCallExpression(callee.expression)) {
        const inner = callee.expression;
        if (ts.isPropertyAccessExpression(inner.expression) && ['map'].includes(inner.expression.name.text)) {
          const cb = inner.arguments[0];
          if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return callbackSafe(cb, sf);
        }
        return false;
      }
    }
    return false;
  }
  return false;
}

function callbackSafe(fn: ts.ArrowFunction | ts.FunctionExpression, sf: ts.SourceFile): boolean {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return isSafe(fn.body, sf);
  let ok = true;
  const visit = (n: ts.Node) => {
    if (ts.isReturnStatement(n) && n.expression) ok = ok && isSafe(n.expression, sf);
    if (!ts.isFunctionLike(n) || n === fn) ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body!, visit);
  return ok;
}

/** Unsafe interpolations in HTML-building template literals of `source`. */
export function findUnescaped(source: string, fileName = 'main.ts'): Unsafe[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  collectAssignments(sf);
  const out: Unsafe[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((s) => s.literal.text).join('');
      if (/<[a-zA-Z\/]/.test(text)) {
        for (const span of node.templateSpans) {
          // Nested HTML templates are visited on their own; a nested template counts as safe here
          // only through its own spans.
          if (!isSafe(span.expression, sf)) {
            out.push({ line: sf.getLineAndCharacterOfPosition(span.expression.getStart(sf)).line + 1, expression: span.expression.getText(sf).slice(0, 120) });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = resolve(process.argv[2] ?? 'src/ui/main.ts');
  const found = findUnescaped(readFileSync(path, 'utf8'), path);
  for (const u of found) console.log(`${path}:${u.line}  \${${u.expression}}`);
  console.log(found.length ? `${found.length} unescaped interpolation(s) in HTML templates.` : 'Every interpolation in HTML templates is escaped or numeric.');
  process.exitCode = found.length ? 1 : 0;
}
