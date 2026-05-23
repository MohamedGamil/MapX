; Svelte Reference Extraction Queries

; Import statements
(import_statement
  source: (string (string_fragment) @ref.target_import)) @ref.type_import

; Function calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls: obj.method()
(call_expression
  function: (member_expression
    property: (property_identifier) @ref.target_call)) @ref.type_call

; Svelte store subscriptions and lifecycle
(call_expression
  function: (identifier) @_fn
  (#match? @_fn "^(onMount|onDestroy|beforeUpdate|afterUpdate|createEventDispatcher|writable|readable|derived|get|tick)$")
  ) @ref.type_call
