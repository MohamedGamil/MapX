; Go Symbol Extraction Queries

; Struct type declarations
(type_spec
  name: (type_identifier) @symbol.name
  type: (struct_type)) @symbol.kind_struct

; Interface type declarations
(type_spec
  name: (type_identifier) @symbol.name
  type: (interface_type)) @symbol.kind_interface

; Type alias declarations (non-struct, non-interface)
(type_spec
  name: (type_identifier) @symbol.name
  type: [
    (type_identifier)
    (pointer_type)
    (slice_type)
    (map_type)
    (channel_type)
    (function_type)
    (array_type)
  ]) @symbol.kind_constant

; Function declarations
(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

; Method declarations (with receiver)
(method_declaration
  receiver: (parameter_list
    (parameter_declaration
      type: [
        (pointer_type (type_identifier) @symbol.scope)
        (type_identifier) @symbol.scope
      ]
    )
  )
  name: (field_identifier) @symbol.name
) @symbol.kind_method

; Constant declarations
(const_spec
  name: (identifier) @symbol.name) @symbol.kind_constant

; Package declaration
(package_clause
  (package_identifier) @symbol.name) @symbol.kind_namespace

; Variable declarations (package-level)
(var_spec
  name: (identifier) @symbol.name) @symbol.kind_property
