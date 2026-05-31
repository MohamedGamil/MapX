; Dart / Flutter Reference Extraction Queries

; ─── Import statements ───────────────────────────────────────────────────────
(import_specification
  (string_literal) @ref.target_import) @ref.type_import

; ─── Export statements ───────────────────────────────────────────────────────
(export_specification
  (string_literal) @ref.target_import) @ref.type_import

; ─── Part directives: `part 'filename.dart'` ─────────────────────────────────
; Creates a strong dependency edge from the library file to its part files
(part_directive
  (string_literal) @ref.target_part) @ref.type_part

; ─── Part-of directives: `part of 'filename.dart'` ──────────────────────────
; Creates a reverse dependency from the part back to the library
(part_of_directive
  (string_literal) @ref.target_part_of) @ref.type_part_of

; ─── Class extends: `class Foo extends Bar` ──────────────────────────────────
(superclass
  (type_identifier) @ref.target_extends) @ref.type_extends

; ─── Class implements: `class Foo implements Bar, Baz` ───────────────────────
(interfaces
  (type_identifier) @ref.target_implements) @ref.type_implements

; ─── Mixin with: `class Foo with MixinA, MixinB` ────────────────────────────
(mixins
  (type_identifier) @ref.target_extends) @ref.type_extends

; ─── Mixin on: `mixin Foo on Bar` ────────────────────────────────────────────
(mixin_on_clause
  (type_identifier) @ref.target_extends) @ref.type_extends

; ─── Method calls: `obj.method(args)` ────────────────────────────────────────
(method_invocation
  name: (identifier) @ref.target_call) @ref.type_call

; ─── Direct function calls: `foo(args)` ──────────────────────────────────────
; function_invocation represents a plain call to a function by name
(function_invocation
  function: (identifier) @ref.target_call) @ref.type_call

; ─── Constructor invocation / instantiation: `new Foo(...)` or `Foo(...)` ────
(constructor_invocation
  (type_identifier) @ref.target_instantiation) @ref.type_instantiation

; ─── Named constructor invocation: `Foo.fromJson(...)` ──────────────────────
(named_constructor_invocation
  (type_identifier) @ref.target_instantiation) @ref.type_instantiation

; ─── Type annotations / use in generics ──────────────────────────────────────
; Captures typed references such as `List<MyClass>`, `Future<AuthResult>`, etc.
(type_arguments
  (type_identifier) @ref.target_instantiation) @ref.type_instantiation
