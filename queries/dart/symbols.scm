; Dart / Flutter Symbol Extraction Queries

; ─── Classes (including abstract, sealed, base, final, interface) ────────────
(class_definition
  name: (identifier) @symbol.name) @symbol.kind_class

; ─── Enums ───────────────────────────────────────────────────────────────────
(enum_declaration
  name: (identifier) @symbol.name) @symbol.kind_enum

; ─── Mixins ──────────────────────────────────────────────────────────────────
(mixin_declaration
  (identifier) @symbol.name) @symbol.kind_trait

; ─── Extensions ──────────────────────────────────────────────────────────────
(extension_declaration
  name: (identifier) @symbol.name) @symbol.kind_class

; ─── Top-level Functions & Methods ───────────────────────────────────────────
(function_signature
  name: (identifier) @symbol.name) @symbol.kind_function

; ─── Getters ─────────────────────────────────────────────────────────────────
(getter_signature
  name: (identifier) @symbol.name) @symbol.kind_property

; ─── Setters ─────────────────────────────────────────────────────────────────
(setter_signature
  name: (identifier) @symbol.name) @symbol.kind_property

; ─── Constructors ────────────────────────────────────────────────────────────
(constructor_signature
  name: (identifier) @symbol.name) @symbol.kind_method

(factory_constructor_signature
  (identifier) @symbol.name) @symbol.kind_method

; ─── Typedefs (Dart type alias) ─────────────────────────────────────────────
(type_alias
  (type_identifier) @symbol.name) @symbol.kind_constant

; ─── Enum member constants ───────────────────────────────────────────────────
(enum_constant
  (identifier) @symbol.name) @symbol.kind_constant

; ─── Library / Namespace ──────────────────────────────────────────────────────
(library_name
  (dotted_identifier_list
    (identifier) @symbol.name)) @symbol.kind_namespace
