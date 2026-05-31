; Bash Reference Extraction Queries

; source / . includes
(command
  name: (command_name) @_source
  argument: (word) @ref.target_import
  (#match? @_source "^(source|\\.)$")) @ref.type_import

; Command invocations
(command
  name: (command_name) @ref.target_call) @ref.type_call

; Command substitution calls
(command_substitution
  (command
    name: (command_name) @ref.target_call)) @ref.type_call

; Function calls (same as commands in bash)
(function_definition
  body: (compound_statement
    (command
      name: (command_name) @ref.target_call))) @ref.type_call
