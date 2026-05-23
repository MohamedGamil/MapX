; Elixir Symbol Extraction Queries

; Module definitions: defmodule MyModule do ... end
(call
  target: (identifier) @_defmodule
  (#eq? @_defmodule "defmodule")
  arguments: (arguments (alias) @symbol.name)) @symbol.kind_module

; Public function definitions: def foo(args) do ... end
(call
  target: (identifier) @_def
  (#eq? @_def "def")
  arguments: (arguments (call target: (identifier) @symbol.name))) @symbol.kind_function

; Private function definitions: defp foo(args) do ... end
(call
  target: (identifier) @_defp
  (#eq? @_defp "defp")
  arguments: (arguments (call target: (identifier) @symbol.name))) @symbol.kind_function

; Macro definitions: defmacro foo(args) do ... end
(call
  target: (identifier) @_defmacro
  (#match? @_defmacro "^defmacrop?$")
  arguments: (arguments (call target: (identifier) @symbol.name))) @symbol.kind_function

; Struct definitions: defstruct [...]
(call
  target: (identifier) @_defstruct
  (#eq? @_defstruct "defstruct")) @symbol.kind_struct

; Protocol definitions: defprotocol MyProtocol do ... end
(call
  target: (identifier) @_defprotocol
  (#eq? @_defprotocol "defprotocol")
  arguments: (arguments (alias) @symbol.name)) @symbol.kind_interface

; Module attribute definitions: @attr value
(unary_operator
  operand: (call
    target: (identifier) @symbol.name)) @symbol.kind_constant
