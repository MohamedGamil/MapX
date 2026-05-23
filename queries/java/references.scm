; Java Reference Extraction Queries

; Import declarations
(import_declaration (scoped_identifier) @ref.target_import) @ref.type_import

; Class inheritance: class Foo extends Bar
(superclass (type_identifier) @ref.target_extends) @ref.type_extends

; Interface implementation: class Foo implements Bar, Baz
(super_interfaces
  (type_list
    (type_identifier) @ref.target_implements)) @ref.type_implements

; Interface extension: interface Foo extends Bar
(extends_interfaces
  (type_list
    (type_identifier) @ref.target_extends)) @ref.type_extends

; Method calls
(method_invocation
  name: (identifier) @ref.target_call) @ref.type_call

; Object instantiation: new ClassName()
(object_creation_expression
  type: (type_identifier) @ref.target_instantiation) @ref.type_instantiation

; Annotation references: @Annotation
(marker_annotation
  name: (identifier) @ref.target_call) @ref.type_call

(annotation
  name: (identifier) @ref.target_call) @ref.type_call
