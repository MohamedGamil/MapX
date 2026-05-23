; Scala Symbol Extraction Queries

; Classes
(class_definition
  name: (identifier) @symbol.name) @symbol.kind_class

; Case classes
; TODO: Add a case-class-specific pattern (the previous query duplicated the generic class_definition capture).
; Objects (singletons)
(object_definition
  name: (identifier) @symbol.name) @symbol.kind_class

; Traits
(trait_definition
  name: (identifier) @symbol.name) @symbol.kind_interface

; Functions/methods
(function_definition
  name: (identifier) @symbol.name) @symbol.kind_function

; Val declarations (immutable)
(val_definition
  pattern: (identifier) @symbol.name) @symbol.kind_constant

; Var declarations (mutable)
(var_definition
  pattern: (identifier) @symbol.name) @symbol.kind_property

; Type aliases
(type_definition
  name: (type_identifier) @symbol.name) @symbol.kind_constant

; Package declarations
(package_clause
  (package_identifier) @symbol.name) @symbol.kind_namespace
