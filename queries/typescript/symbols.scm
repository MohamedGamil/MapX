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
