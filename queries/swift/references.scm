; Swift Reference Extraction Queries

; Import statements
(import_declaration
  (identifier) @ref.target_import) @ref.type_import

; Function/method calls
(call_expression
  (simple_identifier) @ref.target_call) @ref.type_call

; Method calls on receiver: obj.method()
(call_expression
  (navigation_expression
    (navigation_suffix (simple_identifier) @ref.target_call))) @ref.type_call

; Protocol conformance / inheritance: class Foo: Bar, Protocol
(inheritance_specifier
  (type_identifier) @ref.target_extends) @ref.type_extends

; Instantiation: ClassName()
(call_expression
  (type_identifier) @ref.target_instantiation) @ref.type_instantiation
