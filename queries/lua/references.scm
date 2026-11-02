; Lua Reference Extraction Queries

; require('module')
(call
  (variable) @_req
  (_) @ref.target_require
  (#eq? @_req "require")) @ref.type_require

; Function calls: foo(), M.foo(), and method calls obj:m() and self:m(), whose receiver the parser
; turns into its table when the file tells it (self in `function T:x()` targets T:m) (M2-10).
(call
  (variable) @ref.target_call) @ref.type_call
