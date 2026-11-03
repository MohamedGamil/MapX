; JavaScript Reference / Dependency Extraction

(import_statement
  source: (string) @ref.target_import) @ref.type_import

; `export { x } from './m'` and `export * from './m'`: a barrel depends on the modules it re-exports (M2-08-R1).
(export_statement
  source: (string) @ref.target_import) @ref.type_import

; `require('./m')`: a CommonJS module depends on the modules it requires, as on those it imports
; (M2-20). A computed specifier (`require(name)`, `require('./' + x)`) names no module.
(call_expression
  function: (identifier) @_require
  arguments: (arguments . (string) @ref.target_import .)
  (#eq? @_require "require")) @ref.type_import

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

; A method called on a new instance: `new Order().total()`, `(new Order()).total()`. The parser
; records the class for the scanner, which links the method that class declares (M2-12).
(call_expression
  function: (member_expression
    object: [
      (new_expression)
      (parenthesized_expression (new_expression))
    ]
    property: (property_identifier) @ref.target_call)) @ref.type_call

; A function of a module called where it is required: `require('./m').f()`. The parser records the
; specifier, and the scanner links the module's export f (M2-20).
(call_expression
  function: (member_expression
    object: (call_expression
      function: (identifier) @_require
      arguments: (arguments . (string) .))
    property: (property_identifier) @ref.target_call)
  (#eq? @_require "require")) @ref.type_call

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

