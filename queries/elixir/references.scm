; Elixir Reference Extraction Queries

; Alias references (module imports): alias MyApp.Module
(call
  target: (identifier) @_alias
  (#eq? @_alias "alias")
  (arguments (alias) @ref.target_import)) @ref.type_import

; Import references: import MyApp.Module
(call
  target: (identifier) @_import
  (#eq? @_import "import")
  (arguments (alias) @ref.target_import)) @ref.type_import

; Use references: use GenServer
(call
  target: (identifier) @_use
  (#eq? @_use "use")
  (arguments (alias) @ref.target_extends)) @ref.type_extends

; Require references: require Logger
(call
  target: (identifier) @_require
  (#eq? @_require "require")
  (arguments (alias) @ref.target_import)) @ref.type_import

; Function calls
(call
  target: (identifier) @ref.target_call) @ref.type_call

; Remote function calls: Module.function()
(call
  target: (dot
    right: (identifier) @ref.target_call)) @ref.type_call

; Pipe operator calls: value |> function()
(binary_operator
  operator: "|>"
  right: (identifier) @ref.target_call) @ref.type_call

; Protocol implementation: defimpl Protocol, for: Type
(call
  target: (identifier) @_defimpl
  (#eq? @_defimpl "defimpl")
  (arguments (alias) @ref.target_implements)) @ref.type_implements
