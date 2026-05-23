; Pascal Reference Extraction Queries

; Uses clause (imports): uses SysUtils, Classes;
(uses_clause
  (identifier) @ref.target_import) @ref.type_import

; Procedure/function calls
(call_expression
  name: (identifier) @ref.target_call) @ref.type_call

; Method calls: obj.Method()
(call_expression
  name: (member_expression
    (identifier) @ref.target_call)) @ref.type_call

; Class inheritance: TFoo = class(TBar)
(class_declaration
  (class_heritage
    (identifier) @ref.target_extends)) @ref.type_extends

; Interface implementation
(class_declaration
  (class_heritage
    (identifier) @ref.target_implements)) @ref.type_implements

; Constructor calls: TFoo.Create
(call_expression
  name: (member_expression
    object: (identifier) @ref.target_instantiation)) @ref.type_instantiation
