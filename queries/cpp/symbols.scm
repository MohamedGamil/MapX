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
      (qualified_identifier
        name: (identifier) @symbol.name)
      (qualified_identifier
        name: (destructor_name (identifier) @symbol.name))
    ])) @symbol.kind_function

; Template class declarations
(template_declaration
  (class_specifier
    name: (type_identifier) @symbol.name)) @symbol.kind_class

; Template function declarations
(template_declaration
  (function_definition
    declarator: (function_declarator
      declarator: [(identifier) (field_identifier)] @symbol.name))) @symbol.kind_function

; Type alias using declarations
(alias_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_constant
