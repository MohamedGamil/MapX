; Pascal Symbol Extraction Queries

; Procedure declarations
(procedure_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

; Function declarations
(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

; Class/object type declarations
(class_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

; Record type declarations
(record_declaration
  name: (identifier) @symbol.name) @symbol.kind_struct

; Interface declarations
(interface_declaration
  name: (identifier) @symbol.name) @symbol.kind_interface

; Method declarations (procedures/functions inside a class)
(method_declaration
  name: (identifier) @symbol.name) @symbol.kind_method

; Constant declarations
(constant_declaration
  name: (identifier) @symbol.name) @symbol.kind_constant

; Type alias declarations
(type_declaration
  name: (identifier) @symbol.name) @symbol.kind_constant

; Unit declaration (module equivalent)
(unit_declaration
  name: (identifier) @symbol.name) @symbol.kind_module

; Variable declarations
(variable_declaration
  name: (identifier) @symbol.name) @symbol.kind_property

; Enum type declarations
(enum_type
  (identifier) @symbol.name) @symbol.kind_enum
