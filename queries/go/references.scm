; Go Reference Extraction Queries

; Import statements
(import_spec path: (_) @ref.target_import) @ref.type_import

; Function calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls: obj.Method()
(call_expression
  function: (selector_expression
    field: (field_identifier) @ref.target_call)) @ref.type_call

; Composite literal instantiation: Type{...}
(composite_literal
  type: (type_identifier) @ref.target_instantiation) @ref.type_instantiation

; Package-qualified composite literal: `domain.Order{...}`. The parser records the imported package,
; and the scanner resolves the type in that project package only (M5-25).
(composite_literal
  type: (qualified_type name: (type_identifier) @ref.target_instantiation)) @ref.type_instantiation

; Interface embedding: `interface { Reader; io.Writer }` (M0-17-R1). A single-type element only,
; so constraint unions such as `int | float64` are not taken for embedded interfaces.
(interface_type
  (type_elem . (type_identifier) @ref.target_extends .)) @ref.type_extends

(interface_type
  (type_elem . (qualified_type name: (type_identifier) @ref.target_extends) .)) @ref.type_extends

; Struct embedding: an unnamed field `struct { Base }`
(field_declaration
  !name
  type: (type_identifier) @ref.target_extends) @ref.type_extends

; Qualified struct embedding: `struct { sync.Mutex }` (M0-17-R2)
(field_declaration
  !name
  type: (qualified_type name: (type_identifier) @ref.target_extends)) @ref.type_extends
