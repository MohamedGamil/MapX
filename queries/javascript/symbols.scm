; JavaScript Symbol Extraction Queries

(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

(class_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

(method_definition
  name: (property_identifier) @symbol.name) @symbol.kind_method

(generator_function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

; The kind sits on the declarator, like the const/let/var patterns below, so the name binds to
; the same node whichever pattern claims it (M0-17-R1).
(lexical_declaration
  (variable_declarator
    name: (identifier) @symbol.name
    value: [(arrow_function) (function_expression)]) @symbol.kind_function)

(variable_declaration
  (variable_declarator
    name: (identifier) @symbol.name
    value: [(arrow_function) (function_expression)]) @symbol.kind_function)

(export_statement
  [
    (function_declaration)
    (function_expression)
    (arrow_function)
  ] @symbol.kind_function)

(export_statement
  [
    (class_declaration)
    (class)
  ] @symbol.kind_class)

; Top-level `const` / `let` / `var` bindings that are not functions (M0-17-R1). The kind sits on the
; declarator; GenericWasmParser drops declarators whose value is a function or class, which the
; function patterns above already capture.
(program
  (lexical_declaration
    kind: "const"
    (variable_declarator name: (identifier) @symbol.name) @symbol.kind_constant))

(program
  (export_statement
    declaration: (lexical_declaration
      kind: "const"
      (variable_declarator name: (identifier) @symbol.name) @symbol.kind_constant)))

(program
  (lexical_declaration
    kind: "let"
    (variable_declarator name: (identifier) @symbol.name) @symbol.kind_variable))

(program
  (variable_declaration
    (variable_declarator name: (identifier) @symbol.name) @symbol.kind_variable))

; `export let x` / `export var x` (M0-17-R3)
(program
  (export_statement
    declaration: (lexical_declaration
      kind: "let"
      (variable_declarator name: (identifier) @symbol.name) @symbol.kind_variable)))

(program
  (export_statement
    declaration: (variable_declaration
      (variable_declarator name: (identifier) @symbol.name) @symbol.kind_variable)))

; Class fields: `bar = 1;`, `static baz = 2;`
(field_definition
  property: (property_identifier) @symbol.name) @symbol.kind_property

; Functions assigned to members (M2-09). `obj.m = function () {}` / `obj.m = () => …` at module level
; is a method `m` of `obj`; `Foo.prototype.bar = function () {}`, at any depth (prototype code is
; often wrapped in an IIFE), is a method `bar` of `Foo`; `exports.f = …` and `module.exports.f = …`
; are the module's function `f`, with scope `exports`: reached through the module, never as a
; lexical `f`. The parser marks all of them `assigned`. A member assigned any other value, `this.x = …`, `module.exports = …`,
; a deeper or computed receiver, and a member of a local object are not symbols.
(program
  (expression_statement
    (assignment_expression
      left: (member_expression
        object: (identifier) @symbol.scope
        property: (property_identifier) @symbol.name)
      right: [(function_expression) (arrow_function) (generator_function)]) @symbol.kind_method)
  (#not-match? @symbol.scope "^(exports|module)$"))

(assignment_expression
  left: (member_expression
    object: (member_expression
      object: (identifier) @symbol.scope
      property: (property_identifier) @_prototype)
    property: (property_identifier) @symbol.name)
  right: [(function_expression) (arrow_function) (generator_function)]
  (#eq? @_prototype "prototype")) @symbol.kind_method

(program
  (expression_statement
    (assignment_expression
      left: (member_expression
        object: (identifier) @symbol.scope
        property: (property_identifier) @symbol.name)
      right: [(function_expression) (arrow_function) (generator_function)]) @symbol.kind_function)
  (#eq? @symbol.scope "exports"))

(program
  (expression_statement
    (assignment_expression
      left: (member_expression
        object: (member_expression
          object: (identifier) @_module
          property: (property_identifier) @symbol.scope)
        property: (property_identifier) @symbol.name)
      right: [(function_expression) (arrow_function) (generator_function)]) @symbol.kind_function)
  (#eq? @_module "module")
  (#eq? @symbol.scope "exports"))
