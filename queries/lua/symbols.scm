; Lua Symbol Extraction Queries

; Named function definitions: function foo() end
(function_definition
  name: [
    (identifier) @symbol.name
    (dot_index_expression (identifier) @symbol.name)
  ]) @symbol.kind_function

; Method definitions: function Class:method() end
(function_definition
  name: (method_index_expression
    method: (identifier) @symbol.name)) @symbol.kind_method

; Local function definitions: local function foo() end
(local_function
  name: (identifier) @symbol.name) @symbol.kind_function

; Variable assignments (module-level tables as classes/modules)
(variable_assignment
  (variable_list
    (variable (identifier) @symbol.name))) @symbol.kind_constant

; Local variable declarations
(local_variable_declaration
  (variable_list
    (variable (identifier) @symbol.name))) @symbol.kind_constant

; Table constructors used as "classes" — captured via assignment above
