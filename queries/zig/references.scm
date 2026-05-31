; Zig Reference Extraction Queries

; @import("module")
(build_in_call_expr
  function: (identifier) @_import
  (#eq? @_import "@import")
  (arguments (string_literal) @ref.target_import)) @ref.type_import

; Function calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Field access / Method calls
(field_expression
  field: (field_identifier) @ref.target_call) @ref.type_call

(field_expression
  field: (call_expression
    function: (identifier) @ref.target_call)) @ref.type_call
