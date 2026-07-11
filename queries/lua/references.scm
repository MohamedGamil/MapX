; Lua Reference Extraction Queries

; require('module')
(call
  (variable) @_req
  (_) @ref.target_require
  (#eq? @_req "require")) @ref.type_require

; Function calls
(call
  (variable) @ref.target_call) @ref.type_call
