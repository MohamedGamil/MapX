; C# Reference Extraction Queries

; Using directives
(using_directive name: [(identifier) (qualified_name)] @ref.target_import) @ref.type_import

; Class/struct inheritance: class Foo : Bar
(base_list
  (_) @ref.target_extends) @ref.type_extends

; Method calls
(invocation_expression
  function: [
    (identifier) @ref.target_call
    (member_access_expression name: (identifier) @ref.target_call)
  ]) @ref.type_call

; Object instantiation: new ClassName()
(object_creation_expression
  type: (_) @ref.target_instantiation) @ref.type_instantiation

; Attribute references: [Attribute]
(attribute
  name: (identifier) @ref.target_call) @ref.type_call
