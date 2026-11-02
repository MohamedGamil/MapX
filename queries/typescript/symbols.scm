; TypeScript Symbol Extraction Queries

(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

(interface_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_interface

(type_alias_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_constant

(class_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_class

(method_definition
  name: (property_identifier) @symbol.name) @symbol.kind_method

(method_signature
  name: (property_identifier) @symbol.name) @symbol.kind_method

(public_field_definition
  name: (property_identifier) @symbol.name) @symbol.kind_property

(enum_declaration
  name: (identifier) @symbol.name) @symbol.kind_enum

; The kind sits on the declarator, as in JavaScript, so the name binds to the same node whichever
; pattern claims it (M0-17-R3).
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

; Top-level `const` / `let` / `var` bindings that are not functions, exported or not, as in
; JavaScript (M0-17-R3). GenericWasmParser drops declarators whose value is a function or class.
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
  (export_statement
    declaration: (lexical_declaration
      kind: "let"
      (variable_declarator name: (identifier) @symbol.name) @symbol.kind_variable)))

(program
  (variable_declaration
    (variable_declarator name: (identifier) @symbol.name) @symbol.kind_variable))

(program
  (export_statement
    declaration: (variable_declaration
      (variable_declarator name: (identifier) @symbol.name) @symbol.kind_variable)))

; Functions assigned to members, as in JavaScript (M2-09): `obj.m = function () {}` / `obj.m = () => …`
; at module level is a method `m` of `obj`; `Foo.prototype.bar = function () {}`, at any depth, a method
; `bar` of `Foo`; `exports.f = …` and `module.exports.f = …` the module's function `f`, scope
; `exports`. Members assigned other values, `this.x = …`, `module.exports = …`, deeper or computed
; receivers and members of local objects are not symbols.
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
