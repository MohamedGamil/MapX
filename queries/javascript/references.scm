; JavaScript Reference / Dependency Extraction

(import_statement
  source: (string) @ref.target_import) @ref.type_import

(class_declaration
  (class_heritage
    (identifier) @ref.target_extends)) @ref.type_extends

(new_expression
  constructor: (identifier) @ref.target_instantiation) @ref.type_instantiation

(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Track this.method() intra-class calls
(call_expression
  function: (member_expression
    object: (this)
    property: (property_identifier) @ref.target_call)) @ref.type_call

; Calls on an untyped receiver: obj.method(). Resolved by name only, so the parser labels them
; inferred (F01, M0-01-R1); built-in method names are skipped.
(call_expression
  function: (member_expression
    object: (identifier)
    property: (property_identifier) @ref.target_call)) @ref.type_call

(jsx_opening_element
  name: [
    (identifier) @ref.target_render
    (member_expression) @ref.target_render
  ]) @ref.type_render

(jsx_self_closing_element
  name: [
    (identifier) @ref.target_render
    (member_expression) @ref.target_render
  ]) @ref.type_render

