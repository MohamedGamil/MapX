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

