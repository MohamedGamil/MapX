; Scala Reference Extraction Queries

; Import declarations
(import_declaration) @ref.target_import @ref.type_import

; Class extends: class Foo extends Bar
(extends_clause
  (type_identifier) @ref.target_extends) @ref.type_extends

; Trait with: class Foo extends Bar with Trait
(extends_clause
  (type_identifier) @ref.target_extends) @ref.type_extends

; Function/method calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls on receiver: obj.method()
(call_expression
  function: (field_expression
    field: (identifier) @ref.target_call)) @ref.type_call

; new ClassName()
(instance_expression
  (type_identifier) @ref.target_instantiation) @ref.type_instantiation
