; Ruby Reference Extraction Queries

; require 'foo'
(call
  method: (identifier) @_req
  arguments: (argument_list (string (string_content) @ref.target_require))
  (#eq? @_req "require")) @ref.type_require

; require_relative 'foo'
(call
  method: (identifier) @_reqr
  arguments: (argument_list (string (string_content) @ref.target_require))
  (#eq? @_reqr "require_relative")) @ref.type_require

; Class inheritance: class Foo < Bar
(class
  superclass: (scope_resolution name: (constant) @ref.target_extends)) @ref.type_extends

(class
  superclass: (constant) @ref.target_extends) @ref.type_extends

; include Module
(call
  method: (identifier) @_include
  arguments: (argument_list (constant) @ref.target_extends)
  (#eq? @_include "include")) @ref.type_extends

; extend Module
(call
  method: (identifier) @_extend
  arguments: (argument_list (constant) @ref.target_extends)
  (#eq? @_extend "extend")) @ref.type_extends

; prepend Module
(call
  method: (identifier) @_prepend
  arguments: (argument_list (constant) @ref.target_extends)
  (#eq? @_prepend "prepend")) @ref.type_extends

; Method calls: foo(), self.foo(), obj.foo()
(call
  method: (identifier) @ref.target_call) @ref.type_call

; Instantiation: ClassName.new
(call
  method: (identifier) @_new
  receiver: (constant) @ref.target_instantiation
  (#eq? @_new "new")) @ref.type_instantiation
