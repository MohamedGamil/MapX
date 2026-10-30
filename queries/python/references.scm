; Python Reference Extraction Queries

; import statements: import foo, import foo.bar
(import_statement
  [(dotted_name) (identifier)] @ref.target_import) @ref.type_import

; from ... import: from foo import bar
; The whole statement is the target: the resolver needs the module (with relative dots) and
; the imported names to tell a submodule (from pkg import mod) from a name in pkg/__init__.py.
((import_from_statement) @ref.target_import) @ref.type_import

; Class inheritance: class Foo(Base, Mixin)
(class_definition
  superclasses: (argument_list
    (identifier) @ref.target_extends)) @ref.type_extends

; Class inheritance with dotted name: class Foo(module.Base)
(class_definition
  superclasses: (argument_list
    (attribute
      attribute: (identifier) @ref.target_extends))) @ref.type_extends

; Function calls: foo()
(call
  function: (identifier) @ref.target_call
  (#not-match? @ref.target_call "^[A-Z]")) @ref.type_call

; Instantiation: Bar() — PEP 8 names classes in CapWords (M0-17-R1)
(call
  function: (identifier) @ref.target_instantiation
  (#match? @ref.target_instantiation "^[A-Z]")) @ref.type_instantiation

; Method calls: obj.method()
(call
  function: (attribute
    attribute: (identifier) @ref.target_call)) @ref.type_call

; Decorator references: @decorator
(decorator
  (identifier) @ref.target_call) @ref.type_call

; Decorator with dotted name: @module.decorator
(decorator
  (attribute
    attribute: (identifier) @ref.target_call)) @ref.type_call

; Decorator with arguments: @decorator(args)
(decorator
  (call
    function: (identifier) @ref.target_call)) @ref.type_call

; Type annotations in function params (when available)
(type
  (identifier) @ref.target_call) @ref.type_call
