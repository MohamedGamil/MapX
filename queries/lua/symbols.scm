; Lua Symbol Extraction Queries

; Named function definitions: function foo() end or function Class.foo() end
(function_definition_statement
  (variable) @symbol.name) @symbol.kind_function

; Global function definitions: function run() end (M2-10)
(function_definition_statement
  name: (identifier) @symbol.name) @symbol.kind_function

; Local function definitions: local function foo() end
(local_function_definition_statement
  (identifier) @symbol.name) @symbol.kind_function

; Module-level variable assignments (tables as classes/modules, `M.VERSION = 1`). Only top-level
; statements: `self.balance = …` and locals inside a function are not module constants, and a call
; on their line belongs to the function (M2-11, folded into M2-10).
(chunk
  (variable_assignment
    (variable_list
      (variable (identifier) @symbol.name))) @symbol.kind_constant)

; Module-level local variable declarations
(chunk
  (local_variable_declaration
    (variable_list
      (variable (identifier) @symbol.name))) @symbol.kind_constant)

; A function value inside a function is a local function, like `local function f()`
(local_variable_declaration
  (variable_list
    (variable name: (identifier) @symbol.name))
  (expression_list value: (function_definition))) @symbol.kind_constant
