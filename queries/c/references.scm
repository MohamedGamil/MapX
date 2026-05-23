; C Reference Extraction Queries

; #include "file.h" or #include <file.h>
(preproc_include
  path: [(string_literal) (system_lib_string)] @ref.target_import) @ref.type_import

; Function calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Function pointer calls
(call_expression
  function: (field_expression
    field: (field_identifier) @ref.target_call)) @ref.type_call
