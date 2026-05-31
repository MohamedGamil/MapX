; Lua Symbol Extraction Queries

; Named function definitions: function foo() end or function Class.foo() end
(function_definition_statement
  (variable) @symbol.name) @symbol.kind_function

; Local function definitions: local function foo() end
(local_function_definition_statement
  (identifier) @symbol.name) @symbol.kind_function

; Variable assignments (module-level tables as classes/modules)
(variable_assignment
  (variable_list
    (variable (identifier) @symbol.name))) @symbol.kind_constant

; Local variable declarations
(local_variable_declaration
  (variable_list
    (variable (identifier) @symbol.name))) @symbol.kind_constant
