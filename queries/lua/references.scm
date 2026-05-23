; Lua Reference Extraction Queries

; require('module')
(function_call
  prefix: (identifier) @_req
  arguments: (arguments (string) @ref.target_require)
  (#eq? @_req "require")) @ref.type_require

; Function calls
(function_call
  prefix: [
    (identifier) @ref.target_call
    (dot_index_expression (identifier) @ref.target_call)
  ]) @ref.type_call

; Method calls: obj:method()
(function_call
  prefix: (method_index_expression
    method: (identifier) @ref.target_call)) @ref.type_call
