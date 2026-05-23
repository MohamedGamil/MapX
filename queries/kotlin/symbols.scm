; Kotlin Symbol Extraction Queries

; Classes
(class_declaration
  (type_identifier) @symbol.name) @symbol.kind_class

; Interfaces
; TODO: Add an interface-specific pattern for tree-sitter-kotlin. The previous query matched all class_declaration nodes and produced duplicates.
; Object declarations (singletons)
(object_declaration
  (type_identifier) @symbol.name) @symbol.kind_class

; Functions
(function_declaration
  (simple_identifier) @symbol.name) @symbol.kind_function

; Property declarations
(property_declaration
  (variable_declaration
    (simple_identifier) @symbol.name)) @symbol.kind_property

; Enum entries
(enum_entry
  (simple_identifier) @symbol.name) @symbol.kind_constant
