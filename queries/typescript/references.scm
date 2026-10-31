; TypeScript Reference / Dependency Extraction

(import_statement
  source: (string) @ref.target_import) @ref.type_import

(import_clause
  (named_imports
    (import_specifier
      name: (identifier) @ref.target_import_name))) @ref.type_import

(class_declaration
  (class_heritage
    (extends_clause
      (identifier) @ref.target_extends))) @ref.type_extends

; `implements Run<T>` names Run (M0-17-R3). `extends Base<T>` already captures the identifier.
(class_declaration
  (class_heritage
    (implements_clause [
      (type_identifier) @ref.target_implements
      (generic_type name: (type_identifier) @ref.target_implements)
    ]))) @ref.type_implements

(new_expression
  constructor: (identifier) @ref.target_instantiation) @ref.type_instantiation

(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Track this.method() intra-class calls
(call_expression
  function: (member_expression
    object: (this)
    property: (property_identifier) @ref.target_call)) @ref.type_call

; Calls on an untyped receiver: obj.method(). Resolved by name only, so the parser labels them
; inferred (F01, M0-01-R1); built-in method names are skipped.
(call_expression
  function: (member_expression
    object: (identifier)
    property: (property_identifier) @ref.target_call)) @ref.type_call

; Constructor parameter type annotations (for DI)
(method_definition
  name: (property_identifier) @method_name (#eq? @method_name "constructor")
  parameters: (formal_parameters
    [
      (required_parameter
        type: (type_annotation
          [
            (type_identifier) @ref.target_param_type
            (generic_type name: (type_identifier) @ref.target_param_type)
          ]
        )
      )
      (optional_parameter
        type: (type_annotation
          [
            (type_identifier) @ref.target_param_type
            (generic_type name: (type_identifier) @ref.target_param_type)
          ]
        )
      )
    ]
  )
) @ref.type_param_type
