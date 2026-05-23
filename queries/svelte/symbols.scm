; Svelte Symbol Extraction Queries
; Svelte SFC files contain <script> blocks using JavaScript/TypeScript AST

; Functions
(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

; Arrow functions / const declarations (stores, handlers, reactive declarations)
(variable_declarator
  name: (identifier) @symbol.name
  value: (arrow_function)) @symbol.kind_function

; Class declarations
(class_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

; Method definitions (in class or object)
(method_definition
  name: (property_identifier) @symbol.name) @symbol.kind_method

; Exported let declarations (component props in Svelte)
(export_statement
  (lexical_declaration
    (variable_declarator
      name: (identifier) @symbol.name))) @symbol.kind_property

; Top-level const/let declarations (reactive state)
(lexical_declaration
  (variable_declarator
    name: (identifier) @symbol.name)) @symbol.kind_constant
