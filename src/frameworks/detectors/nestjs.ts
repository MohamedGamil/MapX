import type { FrameworkDetector, RouteBinding, HookBinding, ScanContext } from '../../types.js';
import { hasPackageJsonDependency } from '../utils.js';

/** Words after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_WORD = /^(return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new|instanceof)$/;
/** Keywords whose parenthesised head is followed by a statement, so a `/` after its `)` starts a regex. */
const STATEMENT_HEAD = /^(if|while|for|with)$/;

/**
 * `text` with comments and string, template and regex-literal contents blanked to spaces. Same length,
 * newlines and quote delimiters kept, so offsets map 1:1 back to `text` and structure (class headers,
 * braces, decorators) can be scanned without a quote or brace in a comment or string counting.
 */
export function maskCode(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < text.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Code from `i`; inside a template `${…}` returns the index of its closing `}`.
  const code = (i: number, inTemplate: boolean): number => {
    let depth = 0;
    let prev = '';
    let prevWord = '';
    // One entry per open `(`: true when it opens an `if`/`while`/`for`/`with` head.
    const parens: boolean[] = [];
    for (; i < text.length; i++) {
      const c = text[i]!;
      const n = text[i + 1];
      if (/\s/.test(c)) continue;
      if (c === '/' && (n === '/' || n === '*')) {
        const e = n === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
        const end = e < 0 ? text.length : n === '/' ? e : e + 2;
        blank(i, end);
        i = end - 1;
        continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1;
        for (; j < text.length && text[j] !== c && text[j] !== '\n'; j++) if (text[j] === '\\') j++;
        blank(i + 1, j);
        i = j;
        prev = c;
        continue;
      }
      if (c === '`') {
        let j = i + 1;
        for (; j < text.length && text[j] !== '`'; j++) {
          if (text[j] === '\\') j++;
          else if (text[j] === '$' && text[j + 1] === '{') j = code(j + 2, true);
        }
        blank(i + 1, j);
        i = j;
        prev = c;
        continue;
      }
      if (c === '/' && (prev === '' || '([{,;:=!&|?+-*%<>~^'.includes(prev) || (prev === 'w' && REGEX_AFTER_WORD.test(prevWord)))) {
        let j = i + 1;
        for (let cls = false; j < text.length && text[j] !== '\n' && (cls || text[j] !== '/'); j++) {
          if (text[j] === '\\') j++;
          else if (text[j] === '[') cls = true;
          else if (text[j] === ']') cls = false;
        }
        if (text[j] === '/') {
          blank(i + 1, j);
          i = j;
          prev = ')'; // a regex literal is an operand
          continue;
        }
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < text.length && /[A-Za-z0-9_$]/.test(text[j]!)) j++;
        prevWord = text.slice(i, j);
        prev = 'w';
        i = j - 1;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        if (inTemplate && depth === 0) return i;
        depth--;
      } else if (c === '(') parens.push(prev === 'w' && STATEMENT_HEAD.test(prevWord));
      else if (c === ')' && parens.pop()) {
        prev = ';'; // `if (…)` ends a statement head: what follows starts an expression
        continue;
      }
      prev = c;
    }
    return text.length;
  };
  code(0, false);
  return out.join('');
}

/** Index of the bracket closing the one at `open`, in masked text (no strings or comments left). */
function closingBracket(masked: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]!;
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1] && (stack.pop(), stack.length === 0)) return i;
  }
  return -1;
}

/** Index of the `{` opening a class body, scanning from the end of its name past generics, `extends` calls and object types. */
function classBodyOpen(masked: string, from: number): number {
  let angle = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === '<') angle++;
    else if (c === '>' && masked[i - 1] !== '=') angle--;
    else if (c === '(' || c === '[' || (c === '{' && angle > 0)) {
      i = closingBracket(masked, i);
      if (i < 0) return -1;
    } else if (c === '{') return i;
    else if (c === ';' || c === '}' || c === ')') return -1;
  }
  return -1;
}

/** Index just past the `>` closing the type parameters opened at `open` (an `=>` inside does not close them). */
function typeParamsEnd(masked: string, open: number): number {
  let angle = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === '<') angle++;
    else if (c === '>' && masked[i - 1] !== '=' && --angle === 0) return i + 1;
    else if (c === '(' || c === '[' || c === '{') {
      i = closingBracket(masked, i);
      if (i < 0) break;
    } else if (c === ';' || c === '}' || c === ')') break;
  }
  return masked.length;
}

/** Original text and its masked twin, at the same offsets. */
export interface Source {
  text: string;
  masked: string;
}

const slice = (src: Source, from: number, to?: number): Source => ({ text: src.text.slice(from, to), masked: src.masked.slice(from, to) });

interface ClassSegment {
  name: string;
  /** Text between the previous class's closing brace and this class header: its decorators. */
  decorators: Source;
  /** `class Name<…> extends … implements …`, up to the body's `{`. */
  header: Source;
  /** The class, header and braces included. */
  body: Source;
}

/** Classes with their own decorator zone, so one class's decorators never leak into the next. */
export function classSegments(content: string): ClassSegment[] {
  const src = { text: content, masked: maskCode(content) };
  const segments: ClassSegment[] = [];
  let zoneStart = 0;
  const header = /\bclass\s+([A-Za-z0-9_$]+)/g;
  let m: RegExpExecArray | null;
  while ((m = header.exec(src.masked))) {
    const open = classBodyOpen(src.masked, m.index + m[0].length);
    if (open < 0) continue;
    const close = closingBracket(src.masked, open);
    const end = close < 0 ? content.length : close + 1;
    segments.push({
      name: m[1]!,
      decorators: slice(src, zoneStart, m.index),
      header: slice(src, m.index, open),
      body: slice(src, m.index, end),
    });
    zoneStart = end;
    header.lastIndex = end;
  }
  return segments;
}

interface DecoratorCall {
  name: string;
  /** Trimmed argument text, original and masked. */
  args: Source;
  /** Offset just past the closing parenthesis. */
  end: number;
}

/** `@Name(args)` decorators in `src` (comments and strings ignored), with balanced-bracket argument text. */
export function decoratorCalls(src: Source, names: string): DecoratorCall[] {
  const out: DecoratorCall[] = [];
  const re = new RegExp(`@(${names})\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src.masked))) {
    const open = m.index + m[0].length - 1;
    const close = closingBracket(src.masked, open);
    if (close < 0) continue;
    const args = slice(src, open + 1, close);
    const lead = args.masked.length - args.masked.trimStart().length;
    // Prettier's trailing comma (`@Get(\n  ':id',\n)`) is not part of the argument.
    const trail = args.masked.trimEnd().replace(/,\s*$/, '').length;
    out.push({ name: m[1]!, args: slice(args, lead, trail), end: close + 1 });
    re.lastIndex = close + 1;
  }
  return out;
}

/** Value of `key: 'literal'` in decorator arguments; a `key:` inside a string does not count. */
function stringProp(args: Source, key: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])`).exec(args.masked);
  if (!m) return undefined;
  const from = m.index + m[0].length;
  const to = args.masked.indexOf(m[1]!, from);
  return to < 0 ? undefined : args.text.slice(from, to);
}

/** Path argument of `@Controller` / `@Get`…: `'path'`, `{ path: 'path' }`, or the raw text with quotes stripped. */
function pathArg(args: Source): string {
  if (!args.text) return '';
  if (args.masked.startsWith('{')) return stringProp(args, 'path') ?? '';
  return args.text.replace(/^['"`]|['"`]$/g, '');
}

/** Comma-separated names in decorator arguments (`@UseGuards(A, B)`). */
const nameList = (args: Source): string[] => args.text.split(',').map((s) => s.trim()).filter(Boolean);

const INTERFACE_HOOKS: Record<string, [hookType: string, method: string]> = {
  CanActivate: ['guard', 'canActivate'],
  NestInterceptor: ['interceptor', 'intercept'],
  PipeTransform: ['pipe', 'transform'],
  OnModuleInit: ['lifecycle', 'onModuleInit'],
  OnApplicationBootstrap: ['lifecycle', 'onApplicationBootstrap'],
  OnModuleDestroy: ['lifecycle', 'onModuleDestroy'],
  BeforeApplicationShutdown: ['lifecycle', 'beforeApplicationShutdown'],
  OnApplicationShutdown: ['lifecycle', 'onApplicationShutdown'],
};

export class NestJSDetector implements FrameworkDetector {
  readonly name = 'nestjs';
  readonly language = 'typescript';
  readonly filePattern = /\.(ts|js)$/;
  readonly manifestDependencies = { manifest: 'package.json' as const, names: ['@nestjs/core', '@nestjs/common'] };

  async detect(projectRoot: string, files: string[]): Promise<boolean> {
    return hasPackageJsonDependency(projectRoot, files, this.manifestDependencies.names);
  }

  async extractRoutes(filePath: string, content: string, ctx: ScanContext): Promise<RouteBinding[]> {
    const routes: RouteBinding[] = [];

    if (!content.includes('@Controller') && !content.includes('@Get') && !content.includes('@Post')) {
      return [];
    }

    for (const { name: className, decorators, body } of classSegments(content)) {
      const controller = decoratorCalls(decorators, 'Controller')[0];
      if (!controller) continue;
      const cleanPrefix = pathArg(controller.args).replace(/^\/|\/$/g, '');

      for (const route of decoratorCalls(body, 'Get|Post|Put|Delete|Patch|Options|All|Head')) {
        const methodName = this.findMethodNameAfter(body.masked, route.end);
        if (!methodName) continue;
        const cleanRoute = pathArg(route.args).replace(/^\/|\/$/g, '');
        routes.push({
          framework: this.name,
          method: route.name.toUpperCase(),
          path: '/' + [cleanPrefix, cleanRoute].filter(Boolean).join('/'),
          handlerFile: ctx.resolveSymbolToFile(className) || filePath,
          handlerSymbol: `${className}@${methodName}`,
          metadata: {
            confidence: 'inferred',
          },
        });
      }
    }

    return routes;
  }

  async extractHooks(filePath: string, content: string, ctx: ScanContext): Promise<HookBinding[]> {
    const hooks: HookBinding[] = [];

    for (const { name: className, decorators, header, body } of classSegments(content)) {
      const resolvedFile = ctx.resolveSymbolToFile(className) || filePath;

      // 1. Class-level guards / interceptors / pipes / filters
      for (const dec of decoratorCalls(decorators, 'UseGuards|UseInterceptors|UsePipes|UseFilters')) {
        for (const item of nameList(dec.args)) {
          hooks.push({
            framework: this.name,
            hookName: `${dec.name}:${item}`,
            hookType: 'middleware',
            handlerFile: ctx.resolveSymbolToFile(item) || filePath,
            handlerSymbol: className,
          });
        }
      }

      // 2. Class interfaces implementation (Guards, Interceptors, Pipes, Lifecycle Hooks)
      const implementsMatch = header.masked.match(/\bimplements\s+([\s\S]+)$/);
      if (implementsMatch) {
        let list = implementsMatch[1]!;
        while (/<[^<>]*>/.test(list)) list = list.replace(/<[^<>]*>/g, ''); // remove generics
        for (const iface of list.split(',').map((s) => s.trim())) {
          const known = INTERFACE_HOOKS[iface];
          if (!known) continue;
          const [hookType, targetMethod] = known;
          const handlerSymbol = new RegExp(`\\b${targetMethod}\\s*\\(`).test(body.masked) ? `${className}@${targetMethod}` : className;
          hooks.push({
            framework: this.name,
            hookName: iface,
            hookType,
            handlerFile: resolvedFile,
            handlerSymbol,
          });
        }
      }

      // 3. Method-level guards / interceptors / pipes / filters
      for (const dec of decoratorCalls(body, 'UseGuards|UseInterceptors|UsePipes|UseFilters')) {
        const methodName = this.findMethodNameAfter(body.masked, dec.end);
        if (!methodName) continue;
        for (const item of nameList(dec.args)) {
          hooks.push({
            framework: this.name,
            hookName: `${dec.name}:${item}`,
            hookType: 'middleware',
            handlerFile: ctx.resolveSymbolToFile(item) || filePath,
            handlerSymbol: `${className}@${methodName}`,
            metadata: {
              middlewareClass: item,
            }
          });
        }
      }

      // 4. GraphQL Resolvers
      if (decoratorCalls(decorators, 'Resolver').length) {
        for (const gql of decoratorCalls(body, 'Query|Mutation|Subscription')) {
          const methodName = this.findMethodNameAfter(body.masked, gql.end);
          if (!methodName) continue;
          // @Query(() => [User], { name: 'users' }) / @Query('users') / @Query()
          const literal = gql.args.text.match(/^['"`]([^'"`]*)['"`]$/);
          hooks.push({
            framework: this.name,
            hookName: stringProp(gql.args, 'name') || literal?.[1] || methodName,
            hookType: 'graphql_resolver',
            handlerFile: resolvedFile,
            handlerSymbol: `${className}@${methodName}`,
            metadata: {
              operationType: gql.name.toLowerCase(),
            },
          });
        }
      }

      // 5. Message/Event Handlers
      for (const msg of decoratorCalls(body, 'MessagePattern|EventPattern')) {
        const methodName = this.findMethodNameAfter(body.masked, msg.end);
        if (!methodName) continue;
        hooks.push({
          framework: this.name,
          hookName: msg.args.text.replace(/['"`{} ]/g, '') || methodName,
          hookType: 'message_handler',
          handlerFile: resolvedFile,
          handlerSymbol: `${className}@${methodName}`,
          metadata: {
            patternType: msg.name === 'MessagePattern' ? 'request-response' : 'event-driven',
          },
        });
      }

      // 6. WebSocket Subscriptions
      for (const ws of decoratorCalls(body, 'SubscribeMessage')) {
        const methodName = this.findMethodNameAfter(body.masked, ws.end);
        if (!methodName) continue;
        hooks.push({
          framework: this.name,
          hookName: ws.args.text.replace(/^['"`]|['"`]$/g, '') || methodName,
          hookType: 'websocket_handler',
          handlerFile: resolvedFile,
          handlerSymbol: `${className}@${methodName}`,
        });
      }
    }

    return hooks;
  }

  /** Name of the method a decorator ending at `startIndex` applies to; `text` is masked (no comments or strings). */
  private findMethodNameAfter(text: string, startIndex: number): string | null {
    const modifiers = new Set(['public', 'private', 'protected', 'readonly', 'static', 'async', 'get', 'set']);
    let i = startIndex;
    const len = text.length;

    while (i < len) {
      const char = text[i]!;

      // Skip other decorators, with balanced arguments
      if (char === '@') {
        i++;
        while (i < len && /[a-zA-Z0-9_$.]/.test(text[i]!)) i++;
        while (i < len && /\s/.test(text[i]!)) i++;
        if (text[i] === '(') {
          const close = closingBracket(text, i);
          i = close < 0 ? len : close + 1;
        }
        continue;
      }

      // Read identifier/word
      if (/[a-zA-Z0-9_$]/.test(char)) {
        let word = '';
        while (i < len && /[a-zA-Z0-9_$]/.test(text[i]!)) {
          word += text[i];
          i++;
        }
        if (modifiers.has(word)) continue;

        // Verify the next non-whitespace char is '(' to confirm it's a method name,
        // past type parameters (`list<T>(`, `save<K extends () => void>(`)
        let j = i;
        while (j < len && /\s/.test(text[j]!)) j++;
        if (text[j] === '<') j = typeParamsEnd(text, j);
        while (j < len && /\s/.test(text[j]!)) j++;
        if (text[j] === '(') return word;
        continue;
      }

      // Whitespace and any other character
      i++;
    }
    return null;
  }
}
