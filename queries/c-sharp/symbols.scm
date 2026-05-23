; C# Symbol Extraction Queries

; Classes
(class_declaration name: (identifier) @symbol.name) @symbol.kind_class

; Interfaces
(interface_declaration name: (identifier) @symbol.name) @symbol.kind_interface

; Enums
(enum_declaration name: (identifier) @symbol.name) @symbol.kind_enum

; Structs
(struct_declaration name: (identifier) @symbol.name) @symbol.kind_struct

; Methods
(method_declaration name: (identifier) @symbol.name) @symbol.kind_method

; Constructors
(constructor_declaration name: (identifier) @symbol.name) @symbol.kind_method

; Property declarations
(property_declaration
  name: (identifier) @symbol.name) @symbol.kind_property

; Field declarations
(field_declaration
  (variable_declaration
    (variable_declarator
      (identifier) @symbol.name))) @symbol.kind_property

; Constant declarations (const fields)
(field_declaration
  (modifier) @_const
  (variable_declaration
    (variable_declarator
      (identifier) @symbol.name))
  (#eq? @_const "const")) @symbol.kind_constant

; Namespace declarations
(namespace_declaration
  name: [(identifier) (qualified_name)] @symbol.name) @symbol.kind_namespace

; Record declarations
(record_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

; Delegate declarations
(delegate_declaration
  name: (identifier) @symbol.name) @symbol.kind_interface

; Event declarations
(event_declaration
  name: (identifier) @symbol.name) @symbol.kind_property

; Enum member declarations
(enum_member_declaration
  name: (identifier) @symbol.name) @symbol.kind_constant
