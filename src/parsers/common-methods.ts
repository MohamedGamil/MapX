export const COMMON_FRAMEWORK_METHODS = new Set([
  // Laravel / PHP
  'save', 'delete', 'find', 'findOrFail', 'create', 'update', 'get', 'all',
  'toArray', 'toJson', 'rules', 'handle', 'boot', 'register',
  // JavaScript / Node
  'on', 'off', 'emit', 'once', 'then', 'catch', 'finally',
  'toString', 'valueOf', 'call', 'apply', 'bind',
]);

export const BUILTIN_GLOBALS = new Set([
  'Date', 'Error', 'Map', 'Set', 'Promise', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Function', 'RegExp', 'Symbol', 'JSON', 'Math', 'console', 'Console',
  'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError'
]);


/**
 * Built-in method names of JS values (arrays, strings, promises, maps, objects). Calls such as
 * `items.map()` on an untyped receiver are not references to user code (M0-01-R1).
 */
export const JS_BUILTIN_METHODS = new Set([
  'map', 'filter', 'reduce', 'reduceRight', 'forEach', 'find', 'findIndex', 'findLast', 'some', 'every',
  'includes', 'indexOf', 'lastIndexOf', 'join', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice',
  'concat', 'sort', 'reverse', 'flat', 'flatMap', 'fill', 'keys', 'values', 'entries', 'at',
  'split', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll', 'match', 'matchAll', 'startsWith',
  'endsWith', 'toLowerCase', 'toUpperCase', 'padStart', 'padEnd', 'substring', 'substr', 'charAt', 'charCodeAt',
  'test', 'exec', 'set', 'has', 'add', 'clear', 'get', 'delete', 'then', 'catch', 'finally',
  'toString', 'toFixed', 'valueOf', 'call', 'apply', 'bind', 'assign', 'freeze', 'stringify', 'parse',
  'log', 'warn', 'error', 'info', 'debug', 'resolve', 'reject', 'all', 'allSettled', 'race', 'any',
]);
