; C++ Reference Extraction Queries

; #include "file.h" or #include <file.h>
(preproc_include
  path: [(string_literal) (system_lib_string)] @ref.target_import) @ref.type_import

; Function/method calls
(call_expression
  function: [
    (identifier) @ref.target_call
    (field_expression field: (field_identifier) @ref.target_call)
    (qualified_identifier name: (identifier) @ref.target_call)
  ]) @ref.type_call

; Class inheritance: class Foo : public Bar
(base_class_clause
  (type_identifier) @ref.target_extends) @ref.type_extends

; new ClassName()
(new_expression
  type: (type_identifier) @ref.target_instantiation) @ref.type_instantiation
