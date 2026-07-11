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

(class_declaration
  (class_heritage
    (implements_clause
      (type_identifier) @ref.target_implements))) @ref.type_implements

(new_expression
  constructor: (identifier) @ref.target_instantiation) @ref.type_instantiation

(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

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
