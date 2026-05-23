; C Symbol Extraction Queries

; Struct definitions
(struct_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_struct

; Enum definitions
(enum_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_enum

; Function definitions
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @symbol.name)) @symbol.kind_function

; Typedef declarations
(type_definition
  declarator: (type_identifier) @symbol.name) @symbol.kind_constant

; Macro definitions (#define FOO)
(preproc_def
  name: (identifier) @symbol.name) @symbol.kind_constant

; Function-like macro definitions (#define FOO(x))
(preproc_function_def
  name: (identifier) @symbol.name) @symbol.kind_constant

; Union definitions
(union_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_struct
