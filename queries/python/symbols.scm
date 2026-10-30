; Python Symbol Extraction Queries

; Classes
(class_definition
  name: (identifier) @symbol.name) @symbol.kind_class

; Functions (top-level)
(function_definition
  name: (identifier) @symbol.name) @symbol.kind_function

; Decorators (captured as metadata, not a separate symbol kind)
; Decorator names are captured via references

; Module-level constants (UPPER_CASE assignments)
(expression_statement
  (assignment
    left: (identifier) @symbol.name
    (#match? @symbol.name "^[A-Z][A-Z0-9_]*$"))) @symbol.kind_constant

; Module-level variables (other assignments at the top level) (M0-17-R1)
(module
  (expression_statement
    (assignment
      left: (identifier) @symbol.name
      (#not-match? @symbol.name "^[A-Z][A-Z0-9_]*$"))) @symbol.kind_variable)

; Methods decorated with @property / @cached_property become kind property in
; GenericWasmParser (M0-17-R1)
