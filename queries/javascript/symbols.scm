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
