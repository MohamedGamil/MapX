; PHP Reference / Dependency Extraction

; The whole path expression ("x.php", ('x.php'), __DIR__ . '/x.php'); php.ts evaluates it (M0-04-R5).
(require_once_expression (_) @ref.target_require) @ref.type_require
(require_expression (_) @ref.target_require) @ref.type_require
(include_once_expression (_) @ref.target_require) @ref.type_require
(include_expression (_) @ref.target_require) @ref.type_require

; Function calls: helper(), \App\fmt(), Sub\fmt(), namespace\fmt(); not $callable() (M0-04-R5)
(function_call_expression
  function: [(name) (qualified_name) (relative_name)] @ref.target_function_call) @ref.type_function_call

; F05: Namespace use clauses
(namespace_use_clause) @ref.target_use_clause

; Inheritance
(class_declaration
  (base_clause
    [(name) (qualified_name)] @ref.target_extends)) @ref.type_extends

(class_declaration
  (class_interface_clause
    [(name) (qualified_name)] @ref.target_implements)) @ref.type_implements

; Instantiation
(object_creation_expression
  [(name) (qualified_name)] @ref.target_instantiation) @ref.type_instantiation

; Scoped calls
(scoped_call_expression
  scope: [(name) (qualified_name)] @ref.target_call) @ref.type_call

; Member calls
(member_call_expression
  name: (name) @ref.target_call) @ref.type_call

; F06: Type-hint dependencies
(property_promotion_parameter) @ref.target_param
(simple_parameter) @ref.target_param
(method_declaration return_type: (_) @ref.target_return_type)
(function_definition return_type: (_) @ref.target_return_type)
(property_declaration) @ref.target_property

; F07: Eloquent relationships
(member_call_expression
  name: (name) @ref.relation_method_name
  (#match? @ref.relation_method_name "^(hasOne|hasMany|hasOneThrough|hasManyThrough|belongsTo|belongsToMany|morphTo|morphOne|morphMany|morphToMany|morphedByMany|hasOneOfMany)$")
  arguments: (arguments) @ref.relation_arguments
) @ref.type_relation_call

; F08: Route controller binding (statically matched)
(scoped_call_expression
  scope: (name) @_route_class (#eq? @_route_class "Route")
  name: (name) @ref.route_method_name
  arguments: (arguments) @ref.route_arguments
) @ref.type_route_call

; F08: Middleware chaining
(member_call_expression
  name: (name) @_mw_name (#eq? @_mw_name "middleware")
  arguments: (arguments) @ref.middleware_arguments
) @ref.type_middleware_call

; F09: Container Bindings
(member_call_expression
  name: (name) @ref.binding_method_name
  (#match? @ref.binding_method_name "^(bind|singleton|scoped|instance|alias)$")
  arguments: (arguments) @ref.binding_arguments
) @ref.type_binding_call

; F12: Event, Job, and Notification dispatch; qualified names too: event(new \App\X), \Event::dispatch (M0-04-R2)
(function_call_expression
  function: (name) @_fn (#match? @_fn "^(event|dispatch|dispatch_sync)$")
  arguments: (arguments
    (argument
      (object_creation_expression
        [(name) (qualified_name)] @ref.target_dispatch)))) @ref.type_dispatch

(scoped_call_expression
  scope: [(name) (qualified_name)] @ref.target_dispatch_static
  name: (name) @_dispatch_method (#match? @_dispatch_method "^(dispatch|dispatchSync|dispatchIf|dispatchUnless|dispatchAfterResponse)$")
) @ref.type_dispatch_static_call

(member_call_expression
  name: (name) @_notify_method (#match? @_notify_method "^(notify|notifyNow)$")
  arguments: (arguments
    (argument
      (object_creation_expression
        [(name) (qualified_name)] @ref.target_notify)))) @ref.type_notify

(scoped_call_expression
  scope: (name) @_notif_facade (#eq? @_notif_facade "Notification")
  name: (name) @_send (#match? @_send "^(send|sendNow)$")
  arguments: (arguments
    (argument)
    (argument
      (object_creation_expression
        [(name) (qualified_name)] @ref.target_notify)))) @ref.type_notify_facade

