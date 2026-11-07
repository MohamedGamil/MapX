; JavaScript Symbol Extraction Queries

(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

(class_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

(method_definition
  name: (property_identifier) @symbol.name) @symbol.kind_method

(generator_function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

(lexical_declaration
  (variable_declarator
    name: (identifier) @symbol.name
    value: [(arrow_function) (function_expression)])) @symbol.kind_function

(variable_declaration
  (variable_declarator
    name: (identifier) @symbol.name
    value: [(arrow_function) (function_expression)])) @symbol.kind_function

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
