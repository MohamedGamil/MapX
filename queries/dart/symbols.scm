; Dart / Flutter Symbol Extraction Queries

; ─── Classes (including abstract, sealed, base, final, interface) ────────────
(class_definition
  name: (type_identifier) @symbol.name) @symbol.kind_class

; ─── Enums ───────────────────────────────────────────────────────────────────
(enum_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_enum

; ─── Mixins ──────────────────────────────────────────────────────────────────
(mixin_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_trait

; ─── Extensions (named) ──────────────────────────────────────────────────────
(extension_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_class

; ─── Extension Types (Dart 3.3+) ─────────────────────────────────────────────
(extension_type_declaration
  name: (type_identifier) @symbol.name) @symbol.kind_class

; ─── Top-level Functions (concrete, with body) ───────────────────────────────
; function_declaration wraps function_signature + function_body
(function_declaration
  (function_signature
    name: (identifier) @symbol.name)) @symbol.kind_function

; ─── Abstract / Interface Function Signatures (no body) ─────────────────────
(function_signature
  name: (identifier) @symbol.name) @symbol.kind_function

; ─── Methods (concrete, with body) ───────────────────────────────────────────
(method_declaration
  name: (identifier) @symbol.name) @symbol.kind_method

; ─── Abstract Method Signatures ──────────────────────────────────────────────
(method_signature
  name: (identifier) @symbol.name) @symbol.kind_method

; ─── Getters (concrete) ──────────────────────────────────────────────────────
(getter_declaration
  name: (identifier) @symbol.name) @symbol.kind_property

; ─── Setters (concrete) ──────────────────────────────────────────────────────
(setter_declaration
  name: (identifier) @symbol.name) @symbol.kind_property

; ─── Abstract Getter / Setter Signatures ─────────────────────────────────────
(getter_signature
  name: (identifier) @symbol.name) @symbol.kind_property

(setter_signature
  name: (identifier) @symbol.name) @symbol.kind_property

; ─── Constructors (unnamed, with body) ───────────────────────────────────────
(constructor_declaration
  (constructor_signature
    name: (identifier) @symbol.name)) @symbol.kind_method

; ─── Named Constructors ──────────────────────────────────────────────────────
(named_constructor_declaration
  (constructor_signature
    name: (identifier) @symbol.name)) @symbol.kind_method

; ─── Constructor Signatures (abstract / interface constructors) ───────────────
(constructor_signature
  name: (identifier) @symbol.name) @symbol.kind_method

; ─── Factory Constructors ────────────────────────────────────────────────────
(factory_constructor_declaration
  (constructor_signature
    name: (identifier) @symbol.name)) @symbol.kind_method

; ─── Typedefs (Dart 2.13+ type alias syntax) ─────────────────────────────────
(type_alias
  name: (type_identifier) @symbol.name) @symbol.kind_constant

; ─── Legacy typedefs (function_type_alias) ───────────────────────────────────
(function_type_alias
  name: (type_identifier) @symbol.name) @symbol.kind_constant

; ─── Top-level const / final declarations ────────────────────────────────────
(top_level_definition
  (final_builtin_declaration
    (identifier) @symbol.name)) @symbol.kind_constant

(top_level_definition
  (const_builtin_declaration
    (identifier) @symbol.name)) @symbol.kind_constant

; ─── Enum member constants ───────────────────────────────────────────────────
(enum_constant
  (identifier) @symbol.name) @symbol.kind_constant

; ─── Library declarations (namespace) ────────────────────────────────────────
(library_declaration
  (dotted_identifier_list
    (identifier) @symbol.name)) @symbol.kind_namespace
