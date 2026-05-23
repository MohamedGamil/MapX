# F12 — Event, Job, and Notification Dispatch Edges

| Field | Value |
|-------|-------|
| ID | F12 |
| Status | `implemented` |
| Iteration | I06 |
| Branch | `feat/i06-laravel-advanced` |
| Depends on | F05 (FQN resolution) |
| Blocked by | I05 must be merged |

---

## Problem

Laravel applications dispatch events, queue jobs, and send notifications to decouple units of work. The coupling is real — a controller or service **depends** on the event/job/notification class it dispatches — but this dependency is invisible in the graph today.

Current output for dispatch code:

```
OrderController  —[call]→  event          (function call to global helper)
OrderController  —[call]→  ProcessOrder   (method call with ::dispatch())
OrderController  —[call]→  Notification   (static facade call)
```

These edges carry no information about what is being dispatched. The classes `OrderPlaced`, `ProcessOrder`, and `InvoiceReady` appear to be leaf nodes with zero in-edges, making them look unused.

---

## Goal

1. Detect event dispatch (`event(new X())`, `Event::dispatch(new X())`, `$this->dispatch()`)
2. Detect job dispatch (`X::dispatch()`, `dispatch(new X())`, `ProcessPendingX::dispatchSync()`)
3. Detect notification sending (`Notification::send($users, new X())`, `$user->notify(new X())`)
4. Emit typed edges (`dispatch` / `notify`) from the dispatching class to the event/job/notification class
5. Mark event, job, and notification classes with `laravelRole` metadata
6. Mark listener classes with `laravelRole = 'listener'`

---

## New `ReferenceType` values

```typescript
export type ReferenceType =
  | 'import' | 'require' | 'extends' | 'implements'
  | 'call' | 'instantiation' | 'return_type' | 'param_type'
  | 'relation'    // F07
  | 'route'       // F08
  | 'middleware'  // F08
  | 'binding'     // F09
  | 'dispatch'    // NEW — event/job dispatch
  | 'notify';     // NEW — notification send
```

---

## Dispatch patterns

### Event dispatch

```php
// Helper function form — most common
event(new UserRegistered($user));

// Facade form
Event::dispatch(new OrderPlaced($order));

// Dispatchable trait (trait imported by event class itself — dispatches self)
UserRegistered::dispatch($user);
```

### Job dispatch

```php
// Static method — most common
ProcessOrder::dispatch($order);
ProcessOrder::dispatchSync($order);    // synchronous
ProcessOrder::dispatchIf($cond, $order);
ProcessOrder::dispatchUnless($cond, $order);

// Helper function form
dispatch(new ProcessOrder($order));
dispatch_sync(new ProcessOrder($order));

// Queue::push() / Bus::dispatch()
Queue::push(new ProcessOrder($order));
Bus::dispatch(new ProcessOrder($order));
```

### Notification dispatch

```php
// User model notifiable
$user->notify(new InvoiceReady($invoice));
$user->notifyNow(new InvoiceReady($invoice));

// Facade form (bulk send)
Notification::send($users, new InvoiceReady($invoice));
Notification::sendNow($users, new InvoiceReady($invoice));

// Anonymous notification (no class — out of scope)
Notification::route('mail', 'user@example.com')
    ->notify(new InvoiceReady($invoice));
```

---

## Role detection

### Events

```typescript
const isEvent = (
  classImplements.includes('ShouldBroadcast') ||
  classImplements.includes('ShouldBroadcastNow') ||
  classUsesTrait('Dispatchable') ||  // event::dispatch() trait
  filePath.includes('/Events/')
);
```

When detected: `metadata.laravelRole = 'event'`

### Jobs

```typescript
const isJob = (
  classImplements.includes('ShouldQueue') ||
  classImplements.includes('ShouldBeUnique') ||
  classUsesTrait('Dispatchable') ||   // job::dispatch() trait
  classUsesTrait('Queueable') ||
  classUsesTrait('InteractsWithQueue') ||
  filePath.includes('/Jobs/')
);
```

When detected: `metadata.laravelRole = 'job'`

### Notifications

```typescript
const isNotification = (
  classExtends === 'Notification' ||
  classExtends === '\\Illuminate\\Notifications\\Notification' ||
  filePath.includes('/Notifications/')
);
```

When detected: `metadata.laravelRole = 'notification'`

### Listeners

```typescript
const isListener = (
  hasHandleMethod && (
    classImplements.includes('ShouldQueue') ||
    filePath.includes('/Listeners/')
  )
);
```

When detected: `metadata.laravelRole = 'listener'`

---

## Tree-sitter query additions (`queries/php/references.scm`)

```scheme
; event(new OrderPlaced(...))
(function_call_expression
  function: (name) @_fn (#match? @_fn "^(event|dispatch|dispatch_sync)$")
  arguments: (arguments
    (argument
      (object_creation_expression
        class_name: (name) @ref.target_dispatch)))) @ref.type_dispatch

; OrderPlaced::dispatch(...) / ProcessOrder::dispatchSync(...)
(scoped_call_expression
  scope: (name) @ref.target_dispatch2
  name: (name) @_dispatch_method
  (#match? @_dispatch_method "^(dispatch|dispatchSync|dispatchIf|dispatchUnless|dispatchAfterResponse)$")) @ref.type_dispatch_static

; $user->notify(new InvoiceReady(...))
(member_call_expression
  name: (name) @_notify_method (#match? @_notify_method "^(notify|notifyNow)$")
  arguments: (arguments
    (argument
      (object_creation_expression
        class_name: (name) @ref.target_notify)))) @ref.type_notify

; Notification::send($users, new InvoiceReady(...))
(scoped_call_expression
  scope: (name) @_notif_facade (#eq? @_notif_facade "Notification")
  name: (name) @_send (#match? @_send "^(send|sendNow)$")
  arguments: (arguments
    _
    (argument
      (object_creation_expression
        class_name: (name) @ref.target_notify)))) @ref.type_notify_facade
```

---

## Edge metadata

### Dispatch edge

```typescript
{
  sourceSymbol: currentClass,      // the dispatching class
  targetName:   resolveToFqn(dispatchedClass, useTable),
  referenceType: 'dispatch',
  startLine,
  verifiability: 'verified',       // new X() is always static
  metadata: {
    dispatchMethod: 'dispatch',    // dispatch | dispatchSync | event() | ...
    dispatchedRole: 'job',         // 'job' | 'event' | null (resolved from laravelRole)
  }
}
```

### Notify edge

```typescript
{
  sourceSymbol: currentClass,
  targetName:   resolveToFqn(notificationClass, useTable),
  referenceType: 'notify',
  startLine,
  verifiability: 'verified',
  metadata: {
    sendMethod: 'notify',          // notify | notifyNow | Notification::send
  }
}
```

---

## EventServiceProvider listener registration

Service providers often contain `$listen` arrays that map events to listeners:

```php
protected $listen = [
    UserRegistered::class => [
        SendWelcomeEmail::class,
        CreateUserProfile::class,
    ],
];
```

This is a `binding` edge (F09) from event class to listener class — but the `$listen` array is a PHP class property, not a `bind()` call. A dedicated pattern is required:

```scheme
; Array property: [EventClass::class => [ListenerA::class, ListenerB::class]]
; This is complex to capture generically in tree-sitter.
; Fallback: detect $listen property declaration, parse value as PHP expression
```

Given the complexity of parsing array-literal properties in tree-sitter, the `$listen` array is handled as a **post-parse step** in the PHP parser's `extractListenerBindings()` function using the tree's `property_declaration` nodes.

This is a stretch goal within I06 — if tree-sitter queries prove too complex, defer to I07.

---

## Export rendering

### LLM exporter

```
OrderController  —[dispatch:ProcessOrder]→  ProcessOrder (job)
OrderController  —[dispatch:OrderPlaced]→   OrderPlaced (event)
OrderController  —[notify]→                 InvoiceReady (notification)
```

### DOT/SVG exporter

`dispatch` edges rendered as dashed arrows (async by nature). `notify` edges rendered as dotted arrows.

---

## Acceptance Criteria

- [x] `event(new UserRegistered($user))` → `dispatch` edge from enclosing class to `UserRegistered`
- [x] `ProcessOrder::dispatch($order)` → `dispatch` edge, `metadata.dispatchMethod = 'dispatch'`
- [x] `dispatch(new ProcessOrder($order))` → `dispatch` edge
- [x] `$user->notify(new InvoiceReady($invoice))` → `notify` edge
- [x] `Notification::send($users, new InvoiceReady(...))` → `notify` edge
- [x] Event classes receive `laravelRole = 'event'`
- [x] Job classes receive `laravelRole = 'job'`
- [x] Notification classes receive `laravelRole = 'notification'`
- [x] Listener classes receive `laravelRole = 'listener'`
- [x] FQN resolution via F05 use-import table
- [x] `dispatch` edges rendered as dashed in DOT exporter
- [x] TypeScript type-check passes
- [x] Verified on a real Laravel project with events and jobs

---

## Out of Scope for F12

- `$listen` array parsing in EventServiceProvider (stretch goal, may slip to I07)
- `$schedule->command()` dispatch in `app/Console/Kernel.php` — deferred
- Horizon job queues, priority metadata — out of scope
- Broadcasting channels (`BroadcastServiceProvider`) — out of scope
- Mail dispatch (`Mail::to($user)->send(new InvoiceEmail())`) — deferred (would add `mail` edge type)
