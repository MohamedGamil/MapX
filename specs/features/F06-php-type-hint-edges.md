# F06 — Constructor Injection + Type-Hint Edges

| Field | Value |
|-------|-------|
| ID | F06 |
| Status | `planned` |
| Iteration | I04 |
| Branch | `feat/i04-php-fundamentals` |
| Depends on | F05 (use-import table for FQN resolution) |
| Blocked by | F05 must be implemented first |

---

## Problem

Laravel's primary dependency mechanism is constructor injection. In a mid-size application, constructor injection accounts for the majority of real architectural dependencies:

```php
class OrderController extends Controller
{
    public function __construct(
        private readonly OrderService   $orderService,
        private readonly PaymentService $paymentService,
        private readonly PdfExporter    $pdfExporter,
    ) {}
}
```

None of these three dependencies create any edges in the current graph. The controller appears isolated from the services it directly depends on.

Similarly, method parameter type hints and return type declarations are first-class dependency signals that are entirely absent:

```php
public function process(Order $order, User $user): InvoiceResource
```

---

## Goal

Extract the following PHP 8.x type-hint patterns as dependency edges with type `param_type` or `return_type`, resolved to FQNs using the use-import table from F05, and labelled `verified`:

- Constructor parameter type hints (all visibility forms: plain, `public`, `protected`, `private`, `readonly`, promoted)
- Method and function parameter type hints (non-scalar, non-nullable-primitive)
- Method and function return type declarations (non-scalar)
- Property type declarations (PHP 7.4+)

---

## Tree-sitter query additions (`queries/php/references.scm`)

```scheme
; Constructor parameter type hints (standard form)
; public function __construct(UserService $userService)
(method_declaration
  name: (name) @_ctor (#eq? @_ctor "__construct")
  parameters: (formal_parameters
    (simple_parameter
      type: (named_type (name) @ref.target_param_type)))) @ref.type_param_type

; Constructor parameter type hints (promoted property form)
; public function __construct(private UserService $userService)
(method_declaration
  name: (name) @_ctor (#eq? @_ctor "__construct")
  parameters: (formal_parameters
    (promoted_property_parameter
      type: (named_type (name) @ref.target_param_type)))) @ref.type_param_type

; General method parameter type hints (non-constructor)
(method_declaration
  parameters: (formal_parameters
    (simple_parameter
      type: (named_type (name) @ref.target_param_type)))) @ref.type_param_type

; Return type declarations
(method_declaration
  return_type: (named_type (name) @ref.target_return_type)) @ref.type_return_type

; Function parameter type hints
(function_definition
  parameters: (formal_parameters
    (simple_parameter
      type: (named_type (name) @ref.target_param_type)))) @ref.type_param_type

; Function return types
(function_definition
  return_type: (named_type (name) @ref.target_return_type)) @ref.type_return_type

; Typed property declarations (PHP 7.4+)
(property_declaration
  type: (named_type (name) @ref.target_param_type)) @ref.type_param_type
```

---

## Scalar type filter

The following types produce no meaningful edges and must be filtered out before emitting a reference:

```typescript
const SCALAR_TYPES = new Set([
  'string', 'int', 'integer', 'float', 'double', 'bool', 'boolean',
  'array', 'object', 'callable', 'iterable', 'void', 'null', 'never',
  'mixed', 'self', 'static', 'parent',
  // Common PHP/Laravel collection types that don't map to a single class
  'Collection', 'Builder', 'Request', 'Response',
]);
```

Only type names not in `SCALAR_TYPES` (and not starting with `\Illuminate\`) are emitted as edges by default. The `\Illuminate\` filter is configurable.

---

## Verifiability

All type-hint edges emitted by F06 are labelled `verified` — they are statically declared and require no runtime resolution.

---

## `ReferenceType` additions

F06 uses `param_type` and `return_type` which already exist in the `ReferenceType` union in `src/types.ts`. No type changes needed.

---

## Source symbol tracking

Unlike current `call` references (which set `sourceSymbol: null`), F06 edges should record the **enclosing method or class** as `sourceSymbol`:

```typescript
references.push({
  sourceSymbol: currentMethod ?? currentClass,   // e.g. "__construct" or "OrderController"
  targetName: resolveToFqn(typeName, useTable),
  referenceType: 'param_type',
  startLine,
  verifiability: 'verified',   // F01 field
});
```

This enables queries like "what does `OrderController::__construct` depend on" to return a meaningful answer.

---

## Nullable and union type handling

- `?UserService` (nullable) — strip the `?`, emit the underlying type
- `UserService|null` (PHP 8.0 union) — emit `UserService` only; skip `null`
- `UserService&AdminService` (intersection, PHP 8.1) — emit both types as separate edges
- `UserService|AnotherService` (genuine union) — emit both; mark both as `inferred` since the exact resolved type is unknown at call sites

Tree-sitter nodes for these are `nullable_type`, `union_type`, `intersection_type` — the query must capture inner `named_type` nodes from each.

---

## PHP 8.x promoted properties

Constructor promotion (`private readonly UserService $service`) is common in modern Laravel. The tree-sitter node is `promoted_property_parameter`. This is already covered in the query above.

---

## Acceptance Criteria

- [ ] Constructor `private readonly UserService $userService` → `param_type` edge to `App\Services\UserService` (FQN via F05)
- [ ] Promoted property `private UserService $service` → same
- [ ] Method parameter `public function store(CreateOrderRequest $request)` → `param_type` edge to `App\Http\Requests\CreateOrderRequest`
- [ ] Return type `public function index(): UserResource` → `return_type` edge to `App\Http\Resources\UserResource`
- [ ] Scalar types (`string`, `int`, `bool`, etc.) produce no edges
- [ ] `?UserService` nullable type → edge emitted for `UserService`
- [ ] `UserService|null` union → edge emitted for `UserService`
- [ ] `sourceSymbol` is set to the enclosing method name
- [ ] All F06 edges carry `verifiability: 'verified'`
- [ ] TypeScript type-check passes
- [ ] A Laravel controller with 3 constructor-injected services shows 3 `param_type` edges in `mapx export --format=json`

---

## Out of Scope for F06

- Interface type hints resolving to concrete implementations via service container (requires F09)
- Closure / callable type hints
- Docblock `@param` / `@return` type inference (lower priority, deferred)
