; Fish Reference Extraction Queries

; source / . includes
(command
  name: (word) @_source
  argument: (word) @ref.target_import
  (#match? @_source "^(source|\\.)$")) @ref.type_import

; Command invocations, including command substitutions: build, (helper arg)
(command
  name: (word) @ref.target_call) @ref.type_call
