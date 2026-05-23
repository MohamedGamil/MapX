; Zig Symbol Extraction Queries

; Function declarations: fn foo() void { }
(fn_proto
  name: (identifier) @symbol.name) @symbol.kind_function

; Struct declarations: const MyStruct = struct { ... }
(variable_declaration
  name: (identifier) @symbol.name
  value: (container_declaration)) @symbol.kind_struct

; Const declarations: const FOO = value
(variable_declaration
  name: (identifier) @symbol.name) @symbol.kind_constant

; Enum declarations are also container_declarations
; Test declarations: test "name" { ... }
(test_declaration) @symbol.kind_function

; Error set declarations
(error_set_declaration
  (identifier) @symbol.name) @symbol.kind_enum
