; Rust Reference Extraction Queries

; Use declarations
(use_declaration
  argument: (_) @ref.target_import) @ref.type_import

; Function calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls: obj.method()
(call_expression
  function: (field_expression
    field: (field_identifier) @ref.target_call)) @ref.type_call

; Struct instantiation: StructName { ... }
(struct_expression
  name: (type_identifier) @ref.target_instantiation) @ref.type_instantiation

; Trait implementation: impl Trait for Type
(impl_item
  trait: (type_identifier) @ref.target_implements) @ref.type_implements

; Path-based calls: Module::function()
(call_expression
  function: (scoped_identifier
    name: (identifier) @ref.target_call)) @ref.type_call

; Macro invocations: macro_name!(...)
(macro_invocation
  macro: (identifier) @ref.target_call) @ref.type_call
