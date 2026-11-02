// Every value the dashboard writes into HTML is escaped (M4-24, M4-24-R1). Reads src/ui/main.ts
// with the TypeScript parser and checker, and checks three kinds of place:
// - a template literal that builds HTML (its text contains a tag): every `${…}` in it;
// - a `+` concatenation with a tag in one of its string literals: every operand;
// - a value written to innerHTML, outerHTML or srcdoc (`el.innerHTML =`, `el['innerHTML'] =`,
//   `{ innerHTML: … }` as in Object.assign), or passed to insertAdjacentHTML(…), document.write(…),
//   createContextualFragment(…), parseFromString(…) or setAttribute('srcdoc', …), however it was built.
// A value is safe when it is:
// - escapeHtml(…): the module's own top-level function of that name, whose body escapes & < > " '
//   and which is never reassigned (a local of the same name is judged like any other function);
// - numeric or boolean: a number literal, arithmetic, a comparison, .length, .toFixed(…),
//   Number(…), parseInt(…), Math.*(…), typeof;
// - a string literal, or a property of a never-written `const` object literal of safe values;
// - a conditional, `||`/`??`/`&&`, `+` or tagless template literal whose parts are all safe
//   (an HTML template or concatenation is reported where it stands, so it counts as safe here);
// - String(…), .slice(…), .toUpperCase()… or .join(…) of safe values, and .map(…) with a safe callback;
//   .replace(…) only with a literal replacement free of < > & " ';
// - a variable whose every value is safe: its initializer and every assignment (`=`, `+=`, `??=`…).
//   An array's elements also count what is pushed or written into it; an array (or a constant
//   object) that is aliased, passed to a function or otherwise leaves this check's sight is unsafe;
// - a parameter whose argument is safe at every call of its function (a function also used as a
//   value is not judged), or the index of an array callback (forEach only on a known array: Map,
//   Set and URLSearchParams pass keys);
// - a call to a function declared in the source whose every returned value is safe, over every
//   function the name is ever assigned.
// Variables are resolved by the checker (scope, not name); nothing is trusted for its name.
// Anything else is reported with its line.
//   npx tsx scripts/ui/check-escaping.ts [file]     exit 1 and a list when one is unsafe
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface Unsafe { line: number; expression: string }

const TAG = /<[a-zA-Z\/!]/;
/** Globals whose result is a number or boolean, whatever they are given. */
const NUMERIC_CALLS = new Set(['Number', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Boolean']);
/** Methods that throw on anything but a number, so their result is digits. */
const NUMERIC_METHODS = new Set(['toFixed', 'toPrecision']);
/** String methods whose result is safe when the receiver and the arguments are. */
const PRESERVING_METHODS = new Set(['slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'padStart', 'padEnd', 'repeat', 'toString', 'toLocaleString', 'concat', 'at', 'charAt']);
/** Array methods that keep the receiver's elements. */
const ARRAY_KEEPING = new Set(['filter', 'slice', 'sort', 'reverse', 'concat', 'flat', 'toSorted', 'toReversed']);
/** Array methods that add the given elements (splice from its third argument, fill its first). */
const ARRAY_ADDING = new Set(['push', 'unshift', 'splice', 'fill']);
/** Array members that only read the array, or reorder or shorten it. */
const ARRAY_READING = new Set(['join', 'map', 'flatMap', 'filter', 'slice', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'indexOf', 'lastIndexOf', 'includes', 'length', 'concat', 'reduce', 'reduceRight', 'at', 'keys', 'values', 'entries', 'toSorted', 'toReversed', 'sort', 'reverse', 'flat', 'toString', 'pop', 'shift']);
/** Calls that read the array or object they are given, never write it. */
const READING_CALLS = new Set(['Array.isArray', 'Array.from', 'Object.keys', 'Object.values', 'Object.entries', 'Object.hasOwn', 'Object.freeze', 'JSON.stringify', 'String', 'Number', 'Boolean']);
/** Methods whose result is an array (split of a string, the rest of an array). */
const ARRAY_RESULTS = new Set(['map', 'flatMap', 'filter', 'slice', 'sort', 'reverse', 'concat', 'flat', 'split', 'toSorted', 'toReversed', 'querySelectorAll']);
/** Array methods whose callback gets (element, index); for reduce the index is the third. */
const CALLBACK_METHODS = new Set(['map', 'flatMap', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex']);
const HTML_PROPERTIES = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
/** What an escaper's body must produce: & < > " and '. */
const ESCAPES = [/&amp;/, /&lt;/, /&gt;/, /&quot;/, /&#0?39;|&apos;|&#x27;/];
const HTML_METHODS: Record<string, number> = { insertAdjacentHTML: 1, write: 0, writeln: 0, createContextualFragment: 0, parseFromString: 0 };

const ASSIGNMENTS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);
const NUMERIC_OPERATORS = new Set([ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, ts.SyntaxKind.InstanceOfKeyword, ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken]);

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

/**
 * A program over `source`, so the checker resolves each name to its declaration. Given an absolute
 * path, its relative imports in the same folder (`./chrome.js`) are read too; packages are not.
 */
function compile(source: string, fileName: string) {
  const options: ts.CompilerOptions = { noLib: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const dir = isAbsolute(fileName) ? dirname(fileName) + sep : null;
  const local = (name: string) => !!dir && name.startsWith(dir) && !name.slice(dir.length).includes(sep) && /\.[cm]?tsx?$/.test(name) && !name.endsWith('.d.ts') && ts.sys.fileExists(name);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === fileName ? sf : local(name) ? ts.createSourceFile(name, ts.sys.readFile(name)!, ts.ScriptTarget.ES2022, true) : undefined);
  host.fileExists = (name) => name === fileName || local(name);
  host.readFile = (name) => (name === fileName ? source : local(name) ? ts.sys.readFile(name) : undefined);
  const program = ts.createProgram([fileName], options, host);
  return { sf: program.getSourceFile(fileName)!, program, checker: program.getTypeChecker() };
}

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e;

/** The operands of a `+` chain, through parentheses. */
function plusOperands(e: ts.Expression): ts.Expression[] {
  const u = unwrap(e);
  return ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken ? [...plusOperands(u.left), ...plusOperands(u.right)] : [u];
}

const literalText = (e: ts.Expression): string | null => {
  const u = unwrap(e);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
  if (ts.isTemplateExpression(u)) return u.head.text + u.templateSpans.map((s) => s.literal.text).join('');
  return null;
};

const isHtmlTemplate = (e: ts.Node): e is ts.TemplateExpression =>
  ts.isTemplateExpression(e) && TAG.test(e.head.text + e.templateSpans.map((s) => s.literal.text).join(''));

/** A `+` chain with a tag in one of its literals; only the outermost `+` of a chain counts. */
function isHtmlConcat(e: ts.Node): e is ts.BinaryExpression {
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  let p = e.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) return false;
  return plusOperands(e).some((o) => { const t = literalText(o); return t !== null && TAG.test(t); });
}

/** A property name as written: `x`, `'x'` or `['x']`. */
function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return literalText(name.expression);
  return null;
}

/** `el.innerHTML` or `el['innerHTML']` (and outerHTML, srcdoc). */
function htmlProperty(target: ts.Expression): boolean {
  const t = unwrap(target);
  if (ts.isPropertyAccessExpression(t)) return HTML_PROPERTIES.has(t.name.text);
  if (ts.isElementAccessExpression(t)) { const k = literalText(t.argumentExpression); return k !== null && HTML_PROPERTIES.has(k); }
  return false;
}

class Checker {
  private refs = new Map<ts.Symbol, ts.Identifier[]>();
  private memo = new Map<string, boolean>();
  /** Keys being computed, outermost first; `low[i]` is the lowest frame the frame at i assumed safe. */
  private stack: string[] = [];
  private low: number[] = [];

  constructor(private sf: ts.SourceFile, program: ts.Program, private checker: ts.TypeChecker) {
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) {
        for (const sym of [this.symbol(n), ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : undefined]) {
          if (!sym) continue;
          const list = this.refs.get(sym) ?? [];
          list.push(n);
          this.refs.set(sym, list);
        }
      }
      ts.forEachChild(n, visit);
    };
    for (const file of program.getSourceFiles()) if (!file.isDeclarationFile) visit(file);
  }

  /** The symbol `n` names, through imports (for `{ x }`, the variable x). */
  private symbol(n: ts.Node): ts.Symbol | undefined {
    try {
      const sym = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n ? this.checker.getShorthandAssignmentValueSymbol(n.parent) : this.checker.getSymbolAtLocation(n);
      if (!sym || !(sym.flags & ts.SymbolFlags.Alias)) return sym;
      const target = this.checker.getAliasedSymbol(sym);
      return target.declarations?.length ? target : undefined;
    } catch { return undefined; }
  }

  /** Declared in a source of this program (not a library or an unresolved import). */
  private own(n: ts.Node): boolean {
    return !n.getSourceFile().isDeclarationFile;
  }

  /**
   * Memoised, and optimistic on a cycle: a value that depends on itself adds nothing new. A result
   * that relied on a frame still being computed below it is not kept, since that frame may yet
   * turn out unsafe (`a = b; a = data.name; b = a`); an unsafe result holds whatever was assumed.
   */
  private cached(kind: string, node: ts.Node, f: () => boolean): boolean {
    const key = `${kind}:${node.getSourceFile().fileName}:${node.pos}:${node.end}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const at = this.stack.indexOf(key);
    if (at >= 0) {
      const top = this.low.length - 1;
      this.low[top] = Math.min(this.low[top]!, at);
      return true;
    }
    const depth = this.stack.length;
    this.stack.push(key);
    this.low.push(depth);
    let v = false;
    try { v = f(); } finally { this.stack.pop(); }
    const low = this.low.pop()!;
    if (!v || low >= depth) this.memo.set(key, v);
    else this.low[this.low.length - 1] = Math.min(this.low[this.low.length - 1]!, low);
    return v;
  }

  isSafe(node: ts.Expression): boolean {
    const e = unwrap(node);
    if (ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isBigIntLiteral(e) || ts.isRegularExpressionLiteral(e)) return true;
    if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(e.kind)) return true;
    if (ts.isTypeOfExpression(e) || ts.isPostfixUnaryExpression(e) || ts.isVoidExpression(e)) return true;
    if (ts.isPrefixUnaryExpression(e)) return true; // -x, +x, !x, ~x, ++x: numbers or booleans
    // Reported where it stands, by the template and concatenation scans.
    if (isHtmlTemplate(e) || isHtmlConcat(e)) return true;
    if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => this.isSafe(s.expression));
    if (ts.isConditionalExpression(e)) return this.isSafe(e.whenTrue) && this.isSafe(e.whenFalse);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (NUMERIC_OPERATORS.has(op)) return true;
      if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return this.isSafe(e.left) && this.isSafe(e.right);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) return this.isSafe(e.right); // a falsy left prints as false/0/''/null
      return false;
    }
    if (ts.isIdentifier(e)) return this.identifierSafe(e);
    if (ts.isPropertyAccessExpression(e)) return e.name.text === 'length' || this.constMemberSafe(e.expression, e.name.text);
    if (ts.isElementAccessExpression(e)) return this.constMemberSafe(e.expression, null) || (ts.isIdentifier(unwrap(e.expression)) && this.arraySafe(e.expression));
    if (ts.isCallExpression(e)) return this.callSafe(e);
    return false;
  }

  private callSafe(call: ts.CallExpression): boolean {
    const callee = unwrap(call.expression);
    const args = call.arguments;
    if (ts.isIdentifier(callee)) {
      if (callee.text === 'escapeHtml' && this.isEscaper(callee)) return true;
      if (NUMERIC_CALLS.has(callee.text)) return true;
      if (callee.text === 'String') return args.every((a) => this.isSafe(a));
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      const receiver = unwrap(callee.expression);
      if (ts.isIdentifier(receiver) && receiver.text === 'Math') return true;
      if (NUMERIC_METHODS.has(m)) return true;
      if (m === 'join') return this.arraySafe(receiver) && args.every((a) => this.isSafe(a));
      if (m === 'replace' || m === 'replaceAll') {
        // The replacement is inserted as is: only a literal without markup characters keeps it safe.
        const r = args[1] && unwrap(args[1]);
        return !!r && (ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r)) && !/[<>&"']/.test(r.text) && this.isSafe(receiver);
      }
      if (PRESERVING_METHODS.has(m) && this.isSafe(receiver) && args.every((a) => this.isSafe(a) || this.callbackReturnsSafe(a))) return true;
    }
    const fns = this.functionsOf(callee);
    return !!fns && fns.every((fn) => this.returnsSafe(fn));
  }

  /** The module's own escaper: a top-level `function escapeHtml` that escapes & < > " ' and is never reassigned. */
  private isEscaper(callee: ts.Identifier): boolean {
    const sym = this.symbol(callee);
    const decl = sym?.valueDeclaration;
    if (!sym || !decl || !this.own(decl) || !ts.isFunctionDeclaration(decl) || !ts.isSourceFile(decl.parent) || !decl.body) return false;
    const body = decl.body.getText();
    return ESCAPES.every((re) => re.test(body)) && !(this.refs.get(sym) ?? []).some((r) => this.written(r));
  }

  /** `ref` is the target of an assignment (`=`, `+=`, `-=`…) or of a destructuring assignment. */
  private written(ref: ts.Identifier): boolean {
    const p = ref.parent;
    const op = ts.isBinaryExpression(p) ? p.operatorToken.kind : null;
    return (op !== null && (p as ts.BinaryExpression).left === ref && op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) || this.inDestructuringTarget(ref);
  }

  /**
   * Every function the callee can be, declared in this program: a function declaration never
   * reassigned, each function a variable is ever given (`let fmt = …; fmt = …`), or a member of a
   * constant object that is never written or handed out; null when one of them is not a function
   * this check can see.
   */
  private functionsOf(callee: ts.Expression): FunctionNode[] | null {
    const at = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    const sym = this.symbol(at);
    const decl = sym?.valueDeclaration;
    if (!sym || !decl || !this.own(decl)) return null;
    const fnValue = (e: ts.Expression | undefined): FunctionNode | null => {
      const v = e && unwrap(e);
      return v && (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) ? v : null;
    };
    const refs = this.refs.get(sym) ?? [];
    if (ts.isFunctionDeclaration(decl)) return decl.body && !refs.some((r) => this.written(r)) ? [decl] : null;
    if (ts.isMethodDeclaration(decl) || ts.isPropertyAssignment(decl)) {
      if (ts.isObjectLiteralExpression(decl.parent) && !this.sealedObject(decl.parent)) return null;
      const fn = ts.isMethodDeclaration(decl) ? (decl.body ? decl : null) : fnValue(decl.initializer);
      return fn ? [fn] : null;
    }
    if (!ts.isVariableDeclaration(decl)) return null;
    const values: (ts.Expression | undefined)[] = [decl.initializer];
    for (const r of refs) {
      const p = r.parent;
      if (ts.isBinaryExpression(p) && p.left === r && ASSIGNMENTS.has(p.operatorToken.kind)) values.push(p.right);
      else if (this.inDestructuringTarget(r)) return null;
    }
    const fns = values.map(fnValue);
    return fns.every((f): f is FunctionNode => !!f) ? fns : null;
  }

  /** An object literal that initializes a `const` never written through or handed out. */
  private sealedObject(o: ts.ObjectLiteralExpression): boolean {
    const decl = o.parent;
    if (!ts.isVariableDeclaration(decl) || decl.initializer !== o || !(decl.parent.flags & ts.NodeFlags.Const)) return false;
    const sym = this.symbol(decl.name);
    return !!sym && (this.refs.get(sym) ?? []).every((r) => r === decl.name || (this.readOnlyUse(r, false) && !this.memberWritten(r)));
  }

  /** `ref.x = …` or `ref[k] = …`. */
  private memberWritten(ref: ts.Identifier): boolean {
    const access = ref.parent;
    if (!(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) || access.expression !== ref) return false;
    const w = access.parent;
    return ts.isBinaryExpression(w) && w.left === access && w.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && w.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  }

  /**
   * `ref` (an array or an object) is only read here: a member read or a reading method, an element
   * read, iteration, a spread copy, a comparison, or an argument to a reading global. Writes of
   * its members are judged by the caller. An alias, a function argument or a return lets it out
   * of this check's sight, so whatever is written there is not seen.
   */
  private readOnlyUse(ref: ts.Identifier, array: boolean): boolean {
    let n: ts.Node = ref;
    while (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent)) n = n.parent;
    const p = n.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === n) {
      if (ts.isDeleteExpression(p.parent)) return false;
      if (ts.isBinaryExpression(p.parent) && p.parent.left === p) return !array || p.name.text === 'length';
      return !array || ARRAY_READING.has(p.name.text) || ARRAY_ADDING.has(p.name.text);
    }
    if (ts.isElementAccessExpression(p) && p.expression === n) return !ts.isDeleteExpression(p.parent);
    if (ts.isForOfStatement(p) && p.expression === n) return true;
    if (ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) return true;
    if (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.InKeyword) return true;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
    if (ts.isPrefixUnaryExpression(p) || ts.isTypeOfExpression(p) || ts.isIfStatement(p)) return true;
    if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression)) return READING_CALLS.has(p.expression.getText());
    return false;
  }

  /** An array for sure: a literal, an array result, Array.from, Object.keys/values/entries, or a variable only ever given those or typed as one. */
  private isArray(node: ts.Expression): boolean {
    const e = unwrap(node);
    if (ts.isArrayLiteralExpression(e)) return true;
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      return ARRAY_RESULTS.has(e.expression.name.text) || ['Array.from', 'Object.keys', 'Object.values', 'Object.entries'].includes(e.expression.getText());
    }
    if (!ts.isIdentifier(e)) return false;
    const sym = this.symbol(e);
    const decl = sym?.valueDeclaration;
    if (!sym || !decl || !this.own(decl)) return false;
    if ((ts.isVariableDeclaration(decl) || ts.isParameter(decl)) && decl.type && (ts.isArrayTypeNode(decl.type) || (ts.isTypeReferenceNode(decl.type) && decl.type.typeName.getText() === 'Array'))) return true;
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    return this.cached('isArray', decl, () => this.isArray(decl.initializer!) && (this.refs.get(sym) ?? []).every((r) => {
      const p = r.parent;
      return !(ts.isBinaryExpression(p) && p.left === r && ASSIGNMENTS.has(p.operatorToken.kind)) || this.isArray(p.right);
    }));
  }

  /** Every value `fn` returns is safe. */
  private returnsSafe(fn: FunctionNode): boolean {
    return this.cached('returns', fn, () => {
      if (!fn.body) return false;
      if (!ts.isBlock(fn.body)) return this.isSafe(fn.body);
      let ok = true;
      const visit = (n: ts.Node) => {
        if (!ok) return;
        if (ts.isReturnStatement(n) && n.expression) ok = this.isSafe(n.expression);
        if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
      };
      ts.forEachChild(fn.body, visit);
      return ok;
    });
  }

  /** An inline callback, or a function of this file passed by name, that returns safe values. */
  private callbackReturnsSafe(arg: ts.Expression): boolean {
    const a = unwrap(arg);
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return this.returnsSafe(a);
    const fns = ts.isIdentifier(a) ? this.functionsOf(a) : null;
    return !!fns && fns.every((fn) => this.returnsSafe(fn));
  }

  /** An array every element of which is safe. */
  private arraySafe(node: ts.Expression): boolean {
    const e = unwrap(node);
    if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => (ts.isSpreadElement(x) ? this.arraySafe(x.expression) : this.isSafe(x)));
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const m = e.expression.name.text;
      if (m === 'map' || m === 'flatMap') return !!e.arguments[0] && this.callbackReturnsSafe(e.arguments[0]);
      if (ARRAY_KEEPING.has(m)) return this.arraySafe(e.expression.expression) && (m !== 'concat' || e.arguments.every((a) => this.arraySafe(a) || this.isSafe(a)));
      if (m === 'split') return this.isSafe(e.expression.expression);
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'Array' && e.expression.name.text === 'from') {
      const [source, mapFn] = e.arguments;
      return mapFn ? this.callbackReturnsSafe(mapFn) : !!source && this.arraySafe(source);
    }
    if (ts.isIdentifier(e)) return this.variableSafe(e, (v) => this.arraySafe(v), true);
    return false;
  }

  private identifierSafe(id: ts.Identifier): boolean {
    if (['undefined', 'NaN', 'Infinity'].includes(id.text)) return true;
    return this.variableSafe(id, (v) => this.isSafe(v), false);
  }

  /**
   * Every value that can reach the variable `id` names is safe by `judge`: the declaration's
   * initializer (or the parameter's arguments) and every later assignment. For an array, also
   * every element pushed or written into it.
   */
  private variableSafe(id: ts.Identifier, judge: (v: ts.Expression) => boolean, array: boolean): boolean {
    const sym = this.symbol(id);
    if (!sym?.declarations?.length) return false;
    return this.cached(array ? 'array' : 'value', sym.declarations[0]!, () => {
      for (const decl of sym.declarations!) {
        if (!this.own(decl)) return false;
        if (ts.isParameter(decl)) { if (!this.parameterSafe(decl, array)) return false; continue; }
        if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return false; // destructuring, functions, classes, imports
        const list: ts.Node = decl.parent;
        const loop = list.parent;
        if (ts.isCatchClause(list)) return false;
        if (ts.isForOfStatement(loop)) { if (array || !this.arraySafe(loop.expression)) return false; continue; }
        if (ts.isForInStatement(loop)) return false;
        if (decl.initializer && !judge(decl.initializer)) return false;
      }
      for (const ref of this.refs.get(sym) ?? []) {
        const p = ref.parent;
        if (ts.isBinaryExpression(p) && p.left === ref && ASSIGNMENTS.has(p.operatorToken.kind)) {
          if (!judge(p.right)) return false;
        } else if (this.inDestructuringTarget(ref)) {
          return false;
        } else if (ts.isForOfStatement(p) && p.initializer === ref) {
          if (array || !this.arraySafe(p.expression)) return false;
        } else if (ts.isForInStatement(p) && p.initializer === ref) {
          return false;
        } else if (array && ts.isPropertyAccessExpression(p) && p.expression === ref && ts.isCallExpression(p.parent) && p.parent.expression === p && ARRAY_ADDING.has(p.name.text)) {
          const m = p.name.text;
          const added = m === 'splice' ? p.parent.arguments.slice(2) : m === 'fill' ? p.parent.arguments.slice(0, 1) : p.parent.arguments;
          if (!added.every((a) => (ts.isSpreadElement(a) ? this.arraySafe(a.expression) : this.isSafe(a)))) return false;
        } else if (array && ts.isElementAccessExpression(p) && p.expression === ref && ts.isBinaryExpression(p.parent) && p.parent.left === p && ASSIGNMENTS.has(p.parent.operatorToken.kind)) {
          if (!this.isSafe(p.parent.right)) return false;
        } else if (array && (ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.name === ref) {
          // its own declaration
        } else if (array && !this.readOnlyUse(ref, true)) {
          return false; // aliased, passed to a function or returned: writes through it are not seen
        }
      }
      return true;
    });
  }

  /** `[a, b] = …` or `({ a } = …)` writes `ref` with a value this check does not follow. */
  private inDestructuringTarget(ref: ts.Identifier): boolean {
    let n: ts.Node = ref;
    while (ts.isArrayLiteralExpression(n.parent) || ts.isObjectLiteralExpression(n.parent) || ts.isPropertyAssignment(n.parent) || ts.isShorthandPropertyAssignment(n.parent) || ts.isSpreadElement(n.parent) || ts.isSpreadAssignment(n.parent) || ts.isParenthesizedExpression(n.parent)) {
      n = n.parent;
    }
    return n !== ref && ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }

  /**
   * A parameter is safe when the argument for it is safe at every call of its function. An array
   * callback's index is a number; its element is safe when the array's elements are.
   */
  private parameterSafe(param: ts.ParameterDeclaration, array: boolean): boolean {
    if (!ts.isIdentifier(param.name) || param.dotDotDotToken) return false;
    const fn = param.parent;
    const index = fn.parameters.indexOf(param);
    const judge = (a: ts.Expression) => (array ? this.arraySafe(a) : this.isSafe(a));
    // xs.map((x, i) => …)
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isCallExpression(fn.parent) && fn.parent.arguments[0] === fn && ts.isPropertyAccessExpression(fn.parent.expression)) {
      const method = fn.parent.expression.name.text;
      if (CALLBACK_METHODS.has(method)) {
        // Map, Set, URLSearchParams… pass (value, key) to forEach: the index is only an array's.
        if (method === 'forEach' && !this.isArray(fn.parent.expression.expression)) return false;
        if (index === 1) return !array;
        if (index === 0) return !array && this.arraySafe(fn.parent.expression.expression);
        return false;
      }
      if (method === 'reduce') return index === 2 && !array;
    }
    // A named function: every reference to it must be a call.
    let nameNode: ts.Node | undefined;
    if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) nameNode = fn.name;
    else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && fn.parent.initializer === fn) nameNode = fn.parent.name;
    const fnSym = nameNode && this.symbol(nameNode);
    if (!fnSym) return false;
    // Imports and exports of the function name it without using it.
    const calls = (this.refs.get(fnSym) ?? []).filter((r) => r !== nameNode && !ts.isImportSpecifier(r.parent) && !ts.isExportSpecifier(r.parent) && !ts.isImportClause(r.parent));
    if (!calls.length) return false;
    for (const ref of calls) {
      const callee = ts.isPropertyAccessExpression(ref.parent) && ref.parent.name === ref ? ref.parent : ref;
      const call = callee.parent;
      if (!ts.isCallExpression(call) || call.expression !== callee) return false; // used as a value
      if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return false;
      const arg = call.arguments[index];
      if (arg ? !judge(arg) : param.initializer && !judge(param.initializer)) return false;
    }
    return true;
  }

  /** `C.key` or `C[k]` of a `const C = { … }` whose values are safe and that is never written. */
  private constMemberSafe(object: ts.Expression, key: string | null): boolean {
    const o = unwrap(object);
    if (!ts.isIdentifier(o)) return false;
    const sym = this.symbol(o);
    const decl = sym?.valueDeclaration;
    if (!sym || !decl || !ts.isVariableDeclaration(decl) || !(decl.parent.flags & ts.NodeFlags.Const) || !decl.initializer) return false;
    const init = unwrap(decl.initializer);
    // An array is judged with what is pushed or written into it.
    if (ts.isArrayLiteralExpression(init)) return this.arraySafe(o);
    if (!ts.isObjectLiteralExpression(init) || !this.sealedObject(init)) return false;
    return this.cached(`member.${key}`, decl, () => {
      return init.properties.every((p) => {
        if (key !== null && p.name && ts.isIdentifier(p.name) && p.name.text !== key) return true;
        return ts.isPropertyAssignment(p) && this.isSafe(p.initializer);
      });
    });
  }

  /** The unsafe values in HTML templates, HTML concatenations and HTML sinks. */
  scan(): Unsafe[] {
    const out: Unsafe[] = [];
    const seen = new Set<number>();
    const report = (e: ts.Expression) => {
      const at = e.getStart(this.sf);
      if (seen.has(at)) return;
      seen.add(at);
      out.push({ line: this.sf.getLineAndCharacterOfPosition(at).line + 1, expression: e.getText(this.sf).slice(0, 120) });
    };
    const visit = (n: ts.Node) => {
      if (isHtmlTemplate(n)) {
        for (const span of n.templateSpans) if (!this.isSafe(span.expression)) report(span.expression);
      } else if (isHtmlConcat(n)) {
        for (const o of plusOperands(n)) if (!this.isSafe(o)) report(o);
      } else if (ts.isBinaryExpression(n) && ASSIGNMENTS.has(n.operatorToken.kind) && htmlProperty(n.left)) {
        if (!this.isSafe(n.right)) report(n.right);
      } else if (ts.isPropertyAssignment(n) && HTML_PROPERTIES.has(propertyName(n.name) ?? '')) {
        if (!this.isSafe(n.initializer)) report(n.initializer); // Object.assign(el, { innerHTML: … })
      } else if (ts.isShorthandPropertyAssignment(n) && HTML_PROPERTIES.has(n.name.text)) {
        if (!this.isSafe(n.name)) report(n.name);
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && Object.hasOwn(HTML_METHODS, n.expression.name.text)) {
        const arg = n.arguments[HTML_METHODS[n.expression.name.text]!];
        if (arg && !this.isSafe(arg)) report(arg);
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'setAttribute' && n.arguments[0] && literalText(n.arguments[0])?.toLowerCase() === 'srcdoc') {
        if (n.arguments[1] && !this.isSafe(n.arguments[1])) report(n.arguments[1]);
      }
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
    return out.sort((a, b) => a.line - b.line);
  }
}

/** Unsafe values written as HTML in `source`. */
export function findUnescaped(source: string, fileName = 'main.ts'): Unsafe[] {
  const { sf, program, checker } = compile(source, fileName);
  return new Checker(sf, program, checker).scan();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = resolve(process.argv[2] ?? 'src/ui/main.ts');
  const found = findUnescaped(readFileSync(path, 'utf8'), path);
  for (const u of found) console.log(`${path}:${u.line}  ${u.expression}`);
  console.log(found.length ? `${found.length} unescaped value(s) written as HTML.` : 'Every value written as HTML is escaped, numeric or a constant.');
  process.exitCode = found.length ? 1 : 0;
}
