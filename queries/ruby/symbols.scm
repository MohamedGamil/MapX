; Ruby Symbol Extraction Queries

; Classes
(class name: (constant) @symbol.name) @symbol.kind_class

; Modules
(module name: (constant) @symbol.name) @symbol.kind_module

; Instance methods
(method name: (identifier) @symbol.name) @symbol.kind_method

; Class/singleton methods
(singleton_method name: (identifier) @symbol.name) @symbol.kind_method

; Constants (UPPER_CASE = value)
(assignment
  left: (constant) @symbol.name) @symbol.kind_constant

; Attribute accessors (attr_reader, attr_writer, attr_accessor generate properties)
(call
  method: (identifier) @_attr_method
  arguments: (argument_list
    (simple_symbol) @symbol.name)
  (#match? @_attr_method "^attr_(reader|writer|accessor)$")) @symbol.kind_property
