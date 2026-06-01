; Java Symbol Extraction Queries

; Classes
(class_declaration name: (identifier) @symbol.name) @symbol.kind_class

; Interfaces
(interface_declaration name: (identifier) @symbol.name) @symbol.kind_interface

; Enums
(enum_declaration name: (identifier) @symbol.name) @symbol.kind_enum

; Methods
(method_declaration name: (identifier) @symbol.name) @symbol.kind_method

; Constructors
(constructor_declaration name: (identifier) @symbol.name) @symbol.kind_method

; Field declarations
(field_declaration
  declarator: (variable_declarator
    name: (identifier) @symbol.name)) @symbol.kind_property

; Constant declarations (static final)
(field_declaration
  (modifiers) @_mods
  declarator: (variable_declarator
    name: (identifier) @symbol.name)
  (#match? @_mods "static")
  (#match? @_mods "final")) @symbol.kind_constant

; Annotation type declarations
(annotation_type_declaration
  name: (identifier) @symbol.name) @symbol.kind_interface

; Enum constants
(enum_constant
  name: (identifier) @symbol.name) @symbol.kind_constant

; Package declaration (namespace)
(package_declaration
  (scoped_identifier) @symbol.name) @symbol.kind_namespace
