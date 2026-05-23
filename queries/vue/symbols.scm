; Vue Symbol Extraction Queries
; Vue SFC files contain <script> blocks that use JavaScript/TypeScript AST

; Functions (from <script> block)
(function_declaration
  name: (identifier) @symbol.name) @symbol.kind_function

; Arrow functions assigned to const (composables, handlers)
(variable_declarator
  name: (identifier) @symbol.name
  value: (arrow_function)) @symbol.kind_function

; Method definitions in export default options API
(method_definition
  name: (property_identifier) @symbol.name) @symbol.kind_method

; Property definitions in data/computed/props
(pair
  key: (property_identifier) @symbol.name
  value: (function)) @symbol.kind_property

(pair
  key: (property_identifier) @symbol.name
  value: (arrow_function)) @symbol.kind_property

; Class declarations (Class API components)
(class_declaration
  name: (identifier) @symbol.name) @symbol.kind_class
