; Kotlin Reference Extraction Queries

; Import statements
(import_header
  (identifier) @ref.target_import) @ref.type_import

; Function/method calls
(call_expression
  (simple_identifier) @ref.target_call) @ref.type_call

; Method calls on receiver: obj.method()
(call_expression
  (navigation_expression
    (navigation_suffix
      (simple_identifier) @ref.target_call))) @ref.type_call

; Class inheritance: class Foo : Bar()
(delegation_specifier
  (constructor_invocation
    (user_type
      (type_identifier) @ref.target_extends))) @ref.type_extends

; Interface implementation: class Foo : Interface
(delegation_specifier
  (user_type
    (type_identifier) @ref.target_implements)) @ref.type_implements

; Object instantiation: ClassName()
(constructor_invocation
  (user_type
    (type_identifier) @ref.target_instantiation)) @ref.type_instantiation
