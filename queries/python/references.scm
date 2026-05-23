; Python Reference Extraction Queries

; import statements: import foo, import foo.bar
(import_statement
  [(dotted_name) (identifier)] @ref.target_import) @ref.type_import

; from ... import: from foo import bar
(import_from_statement
  [(dotted_name) (identifier)] @ref.target_import) @ref.type_import

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
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls: obj.method()
(call
  function: (attribute
    attribute: (identifier) @ref.target_call)) @ref.type_call

; Instantiation: ClassName() — uppercase identifiers in call position
; (handled as call — GenericWasmParser treats PascalCase calls as instantiation when needed)

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
