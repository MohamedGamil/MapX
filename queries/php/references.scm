; PHP Reference / Dependency Extraction

(require_once_expression
  (parenthesized_expression
    (string
      (string_content) @ref.target_require))) @ref.type_require

(require_expression
  (parenthesized_expression
    (string
      (string_content) @ref.target_require))) @ref.type_require

(include_once_expression
  (parenthesized_expression
    (string
      (string_content) @ref.target_require))) @ref.type_require

(include_expression
  (parenthesized_expression
    (string
      (string_content) @ref.target_require))) @ref.type_require

; F05: Namespace use clauses
(namespace_use_clause) @ref.target_use_clause

; Inheritance
(class_declaration
  (base_clause
    (name) @ref.target_extends)) @ref.type_extends

(class_declaration
  (class_interface_clause
    (name) @ref.target_implements)) @ref.type_implements

; Instantiation
(object_creation_expression
  (name) @ref.target_instantiation) @ref.type_instantiation

; Scoped calls
(scoped_call_expression
  scope: (name) @ref.target_call) @ref.type_call

; Member calls
(member_call_expression
  name: (name) @ref.target_call) @ref.type_call

; F06: Type-hint dependencies
(property_promotion_parameter) @ref.target_param
(simple_parameter) @ref.target_param
(method_declaration return_type: (_) @ref.target_return_type)
(function_definition return_type: (_) @ref.target_return_type)
(property_declaration) @ref.target_property
