; Bash Symbol Extraction Queries

; Function definitions: function foo() { } or foo() { }
(function_definition
  name: (word) @symbol.name) @symbol.kind_function

; Variable assignments (exported or not): FOO=bar, export FOO=bar
(variable_assignment
  name: (variable_name) @symbol.name) @symbol.kind_constant

; Alias definitions: alias foo='bar'
(command
  name: (command_name) @_alias
  argument: (word) @symbol.name
  (#eq? @_alias "alias")) @symbol.kind_constant
