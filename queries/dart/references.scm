; Dart Reference Extraction Queries

; Import statements
(import_specification
  (string_literal) @ref.target_import) @ref.type_import

; Export statements
(export_specification
  (string_literal) @ref.target_import) @ref.type_import

; Class extends: class Foo extends Bar
(superclass
  (type_identifier) @ref.target_extends) @ref.type_extends

; Class implements: class Foo implements Bar, Baz
(interfaces
  (type_identifier) @ref.target_implements) @ref.type_implements

; Mixin with: class Foo with MixinA, MixinB
(mixins
  (type_identifier) @ref.target_extends) @ref.type_extends

; Method calls
(method_invocation
  name: (identifier) @ref.target_call) @ref.type_call

; Function calls
(function_expression_body
  (identifier) @ref.target_call) @ref.type_call

; Constructor invocation / instantiation
(constructor_invocation
  (type_identifier) @ref.target_instantiation) @ref.type_instantiation
