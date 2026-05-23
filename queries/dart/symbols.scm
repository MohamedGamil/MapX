; Dart Symbol Extraction Queries

; Classes
(class_definition
  name: (type_identifier) @symbol.name) @symbol.kind_class

; Enums
(enum_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_enum

; Mixins
(mixin_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_trait

; Extensions
(extension_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_class

; Functions
(function_signature
  name: (identifier) @symbol.name) @symbol.kind_function

; Methods
(method_signature
  name: (identifier) @symbol.name) @symbol.kind_method

; Constructor declarations
(constructor_signature
  name: (identifier) @symbol.name) @symbol.kind_method

; Top-level constant/variable declarations
(top_level_definition
  (final_builtin_declaration
    (identifier) @symbol.name)) @symbol.kind_constant

(top_level_definition
  (const_builtin_declaration
    (identifier) @symbol.name)) @symbol.kind_constant
