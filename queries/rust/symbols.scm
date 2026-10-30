; Rust Symbol Extraction Queries

; Structs
(struct_item name: (type_identifier) @symbol.name) @symbol.kind_struct

; Traits (Rust's interface equivalent)
(trait_item name: (type_identifier) @symbol.name) @symbol.kind_interface

; Enums
(enum_item name: (type_identifier) @symbol.name) @symbol.kind_enum

; Functions
(function_item name: (identifier) @symbol.name) @symbol.kind_function

; Impl blocks are not symbols of their own: `impl Point` and `impl Clone for Point` each produced
; another `Point` next to the struct. Methods inside them still take the impl type as their
; scope (GenericWasmParser) (M0-17-R1).

; Const items
(const_item name: (identifier) @symbol.name) @symbol.kind_constant

; Static items
(static_item name: (identifier) @symbol.name) @symbol.kind_constant

; Type alias
(type_item name: (type_identifier) @symbol.name) @symbol.kind_constant

; Module declarations
(mod_item name: (identifier) @symbol.name) @symbol.kind_module

; Macro definitions
(macro_definition name: (identifier) @symbol.name) @symbol.kind_function

; Enum variants
(enum_variant name: (identifier) @symbol.name) @symbol.kind_constant
