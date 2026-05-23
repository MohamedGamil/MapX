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

; Property definitions via @property decorator are auto-promoted from function
; to method by GenericWasmParser when inside a class scope
