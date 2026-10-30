; Kotlin Symbol Extraction Queries

; Classes
(class_declaration
  (type_identifier) @symbol.name) @symbol.kind_class

; Interfaces and enum classes are class_declaration nodes too; GenericWasmParser gives them
; kind interface / enum from their `interface` / `enum` keyword (M0-17-R1).
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
