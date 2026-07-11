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

; Interface embedding: embedding a type inside an interface
;(type_spec
;  type: (interface_type
;    (type_identifier) @ref.target_extends)) @ref.type_extends
