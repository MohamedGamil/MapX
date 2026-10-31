; C++ Symbol Extraction Queries

; Class definitions
(class_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_class

; Struct definitions
(struct_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_struct

; Namespace definitions
(namespace_definition
  name: (namespace_identifier) @symbol.name) @symbol.kind_namespace

; Enum definitions
(enum_specifier
  name: (type_identifier) @symbol.name) @symbol.kind_enum

; Function definitions (free functions and method definitions)
(function_definition
  declarator: (function_declarator
    declarator: [
      (identifier) @symbol.name
      (field_identifier) @symbol.name
      ; Out-of-line definitions qualified at any depth: `void Foo::run()`, `void ns::K::a()`,
      ; `void a::b::c::D::g()`, `ns::K::~K()`. GenericWasmParser names the method by the innermost
      ; name (`~K` for a destructor) and scopes it by the innermost qualifier (M0-17-R2, M0-17-R5).
      (qualified_identifier) @symbol.name
    ])) @symbol.kind_function

; Template classes and functions need no pattern of their own: the class_specifier and
; function_definition inside a template_declaration match the patterns above. A separate
; template_declaration capture had no name and was stored under its whole source text (M0-17-R1).

; Type alias using declarations
(alias_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_constant
