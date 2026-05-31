; Pascal Reference Extraction Queries

; Uses clause (imports): uses SysUtils;
;(uses_clause
;  (identifier) @ref.target_import) @ref.type_import

; Call expressions
(exprCall
  entity: (identifier) @ref.target_call) @ref.type_call
