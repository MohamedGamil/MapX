; Pascal Symbol Extraction Queries

; Procedure/Function declarations
(declProc
  name: (identifier) @symbol.name) @symbol.kind_function

; Unit (module) declarations
(unit
  (moduleName (identifier) @symbol.name)) @symbol.kind_module
