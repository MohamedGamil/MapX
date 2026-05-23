; Zig Reference Extraction Queries

; @import("module")
(builtin_call_expression
  function: (identifier) @_import
  (#eq? @_import "@import")
  arguments: (arguments (string_literal) @ref.target_import)) @ref.type_import

; Function calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls: obj.method()
(call_expression
  function: (field_expression
    member: (identifier) @ref.target_call)) @ref.type_call

; Field access (struct member access)
(field_expression
  member: (identifier) @ref.target_call) @ref.type_call
