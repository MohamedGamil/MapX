; Zig Symbol Extraction Queries

; Function declarations: fn foo() void { }
(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

; Struct declarations: const MyStruct = struct { ... }
(assignment_statement
  name: (identifier) @symbol.name
  expression: (struct_expression)) @symbol.kind_struct

; Const/variable declarations: const FOO = value
(assignment_statement
  name: (identifier) @symbol.name) @symbol.kind_constant

; Test declarations: test "name" { ... }
;(test_declaration) @symbol.kind_function
