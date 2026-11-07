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

; Class inheritance: class Foo < Bar (the superclass node's text includes the `<`)
(class
  superclass: (superclass [(constant) (scope_resolution)] @ref.target_extends)) @ref.type_extends

; include Module: a mixin, recorded like an implemented interface (M0-17-R1)
(call
  method: (identifier) @_include
  arguments: (argument_list [(constant) (scope_resolution)] @ref.target_implements)
  (#eq? @_include "include")) @ref.type_implements

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

; Method calls: foo(), self.foo(), obj.foo() — not the class-body keywords captured above
(call
  method: (identifier) @ref.target_call
  (#not-match? @ref.target_call "^(include|extend|prepend|require|require_relative|attr_accessor|attr_reader|attr_writer)$")) @ref.type_call

; Instantiation: ClassName.new
(call
  (constant) @ref.target_instantiation
  (identifier) @_new
  (#eq? @_new "new")) @ref.type_instantiation

(call
  (scope_resolution) @ref.target_instantiation
  (identifier) @_new
  (#eq? @_new "new")) @ref.type_instantiation
