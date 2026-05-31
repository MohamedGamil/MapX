; Swift Symbol Extraction Queries

; Classes, Structs, Enums
(class_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_class

; Protocols (Swift's interface equivalent)
(protocol_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_interface

; Functions (using simple_identifier for name)
(function_declaration
  name: (simple_identifier) @symbol.name) @symbol.kind_function

; Initializers
(init_declaration) @symbol.kind_method

; Property declarations
(property_declaration
  (pattern
    (simple_identifier) @symbol.name)) @symbol.kind_property

; Type aliases
(typealias_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_constant

; Extensions
;(extension_declaration
;  (type_identifier) @symbol.name) @symbol.kind_class
