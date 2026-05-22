# F23 — Node.js/TypeScript Framework Routes (Express, NestJS)

| Field | Value |
|-------|-------|
| ID | F23 |
| Status | `planned` |
| Iteration | I13 |
| Branch | `feat/i13-framework-routes` |
| Depends on | F21 (infrastructure) |
| Blocked by | F21 must be merged |

---

## Overview

Express and NestJS are the dominant Node.js/TypeScript backend frameworks. Express uses a procedural routing API; NestJS uses decorators for HTTP, GraphQL, Microservices, and WebSocket routing. Both produce `route` edges (and NestJS additionally produces `graphql_resolver`, `message_handler`, `websocket_handler` edges).

---

## Express

### Detection

File: `src/frameworks/detectors/express.ts`

Detection signals:
- `express` in `package.json` `dependencies` or `devDependencies`

File match: any `.js` or `.ts` file containing `app.get(`, `app.post(`, `router.get(`, `router.post(`, `Router(`, or `express.Router()`

### Route patterns extracted

#### Direct app routes

```typescript
const app = express();

app.get('/users', listUsers);
app.post('/users', authenticate, createUser);
app.get('/users/:id', findUser);
app.put('/users/:id', authenticate, authorize, updateUser);
app.delete('/users/:id', deleteUser);
app.all('/health', healthCheck);
```

Each `app.METHOD(path, ...handlers)` emits:
- `route` edge from the file → the **last** argument (final handler, not middleware)
- `middleware` edge from the file → each intermediate argument

Confidence: `verified` when handler is a direct function reference; `inferred` when passed as a variable.

**Middleware chain handling:**
```typescript
app.post('/orders', authenticate, validate(orderSchema), rateLimiter, createOrder);
// route edge:      → createOrder
// middleware edges: → authenticate, → validate(...), → rateLimiter
```

The final handler receives the `route` edge; all preceding arguments receive `middleware` edges.

#### Express Router

```typescript
const router = express.Router();

router.get('/', listUsers);
router.post('/', createUser);
router.get('/:id', findUser);

// Mounted in another file:
app.use('/users', userRouter);
```

Router routes are emitted with their relative paths. When `app.use(prefix, router)` is found in the same file or imported file, the prefix is prepended.

If the router is defined in a separate file and mounted elsewhere, the routes are emitted with relative paths and an `import` edge links the mount point to the router file.

#### Chained route handlers

```typescript
router.route('/users/:id')
  .get(findUser)
  .put(updateUser)
  .delete(deleteUser);
```

Each `.METHOD(handler)` in a chain emits a separate route edge.

#### `app.use()` middleware

```typescript
app.use('/api', apiRouter);
app.use(cors());
app.use('/admin', adminCheck, adminRouter);
```

`app.use(path, router)` emits an `import`-style edge to the mounted router file (if resolvable). `app.use(middleware)` without a path emits a `middleware` edge if the middleware is a named reference.

### Implementation strategy

```typescript
// Match: app.get('/path', ...handlers) or router.post('/path', handler)
const EXPRESS_ROUTE = /(\w+)\.(get|post|put|patch|delete|head|options|all)\(\s*['"`]([^'"`]+)['"`]\s*,([^)]+)\)/g;

// Match: .route('/path').get(h).post(h)
const CHAINED_ROUTE = /\.route\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const CHAINED_METHOD = /\.(get|post|put|patch|delete|head|options)\((\w+)\)/g;

// Match: app.use('/prefix', routerVar)
const APP_USE = /(\w+)\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)\)/g;
```

---

## NestJS

### Detection

File: `src/frameworks/detectors/nestjs.ts`

Detection signals:
- `@nestjs/core` in `package.json` dependencies

File match: any `.ts` file containing `@Controller`, `@Resolver`, `@MessagePattern`, `@SubscribeMessage`

### HTTP routing — `@Controller` + HTTP method decorators

```typescript
@Controller('users')
export class UserController {

  @Get()
  findAll(): User[] { ... }

  @Get(':id')
  findOne(@Param('id') id: string): User { ... }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateUserDto): User { ... }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto): User { ... }

  @Delete(':id')
  remove(@Param('id') id: string): void { ... }
}
```

**Extraction logic:**
1. Find `@Controller('prefix')` decorator on a class → note the prefix string
2. For each method with an HTTP method decorator (`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All`):
   - Emit `route` edge from the controller file → the method symbol
   - Path = `controllerPrefix + methodPath` (e.g. `users/:id`)
   - Edge metadata: `{ httpMethod: "GET", path: "users/:id", controllerClass: "UserController", confidence: "verified", framework: "nestjs" }`

**Route guards and interceptors:**
```typescript
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  @Get()
  @UseGuards(SuperAdminGuard)
  listAdmins() { ... }
}
```
`@UseGuards(...)` arguments emit `middleware` edges (guards = middleware in NestJS context).

### GraphQL — `@Resolver` + `@Query` / `@Mutation` / `@Subscription`

```typescript
@Resolver(() => User)
export class UserResolver {

  @Query(() => [User], { name: 'users' })
  async getUsers(): Promise<User[]> { ... }

  @Query(() => User, { name: 'user' })
  async getUser(@Args('id') id: string): Promise<User> { ... }

  @Mutation(() => User)
  async createUser(@Args('data') data: CreateUserInput): Promise<User> { ... }

  @ResolveField(() => [Post])
  async posts(@Parent() user: User): Promise<Post[]> { ... }
}
```

**Extraction logic:**
- `@Resolver()` on a class → note the class as a GraphQL resolver
- `@Query()` → emit `graphql_resolver` edge with metadata `{ operationType: "query", operationName: "users" }`
- `@Mutation()` → emit `graphql_resolver` edge with metadata `{ operationType: "mutation" }`
- `@Subscription()` → emit `graphql_resolver` edge with metadata `{ operationType: "subscription" }`
- `@ResolveField()` → emit `graphql_resolver` edge with metadata `{ operationType: "field_resolver" }`

Edge type: `graphql_resolver`

### Microservices — `@MessagePattern` / `@EventPattern`

```typescript
@Controller()
export class AppController {

  @MessagePattern({ cmd: 'get_user' })
  async getUser(data: GetUserDto): Promise<User> { ... }

  @EventPattern('user_created')
  async handleUserCreated(data: UserCreatedEvent): void { ... }
}
```

**Extraction logic:**
- `@MessagePattern(pattern)` → emit `message_handler` edge
  - Edge metadata: `{ pattern: '{ cmd: "get_user" }', patternType: "message", framework: "nestjs" }`
- `@EventPattern(event)` → emit `message_handler` edge
  - Edge metadata: `{ pattern: "user_created", patternType: "event", framework: "nestjs" }`

Edge type: `message_handler`

### WebSockets — `@WebSocketGateway` + `@SubscribeMessage`

```typescript
@WebSocketGateway(80, { namespace: 'chat' })
export class ChatGateway {

  @SubscribeMessage('message')
  handleMessage(client: Socket, payload: MessageDto): void { ... }

  @SubscribeMessage('join_room')
  handleJoinRoom(client: Socket, room: string): void { ... }
}
```

**Extraction logic:**
- `@WebSocketGateway()` on a class → note namespace
- `@SubscribeMessage('event')` → emit `websocket_handler` edge
  - Edge metadata: `{ event: "message", namespace: "chat", framework: "nestjs" }`

Edge type: `websocket_handler`

### Module routing (`@Module` imports)

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UserController],
  providers: [UserService, UserResolver],
})
export class UserModule {}
```

`controllers: [UserController]` and `providers: [UserService, UserResolver]` emit `binding` edges (reusing F09's edge type) from the module file to each registered class.

### Implementation strategy

```typescript
// Match: @Controller('prefix') or @Controller()
const CONTROLLER = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g;

// Match: @Get(':id') or @Post() etc.
const HTTP_METHOD_DECO = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g;

// Match: @Resolver(() => Type) or @Resolver()
const RESOLVER = /@Resolver\(/g;

// Match: @Query(() => Type, { name: 'opName' })
const GRAPHQL_OP = /@(Query|Mutation|Subscription|ResolveField)\(/g;

// Match: @MessagePattern({ cmd: '...' }) or @MessagePattern('...')
const MESSAGE_PATTERN = /@(Message|Event)Pattern\(([^)]+)\)/g;

// Match: @SubscribeMessage('event')
const WS_SUBSCRIBE = /@SubscribeMessage\(\s*['"]([^'"]+)['"]\s*\)/g;
```

---

## `mapx routes` output for Express + NestJS

```
Routes in /path/to/project

  Method  Path                     Handler                          Framework  File
  ──────────────────────────────────────────────────────────────────────────────────
  GET     /users                   listUsers                        express    src/routes/users.ts
  POST    /users                   createUser                       express    src/routes/users.ts
  GET     /users/:id               findUser                         express    src/routes/users.ts
  GET     users                    UserController::findAll          nestjs     src/users/user.controller.ts
  POST    users                    UserController::create           nestjs     src/users/user.controller.ts
  GQL     query:users              UserResolver::getUsers           nestjs     src/users/user.resolver.ts
  GQL     mutation:createUser      UserResolver::createUser         nestjs     src/users/user.resolver.ts
  MSG     { cmd: "get_user" }      AppController::getUser           nestjs     src/app.controller.ts
  WS      message (ns: chat)       ChatGateway::handleMessage       nestjs     src/chat/chat.gateway.ts
```

---

## Acceptance Criteria

### Express
- [ ] `app.get('/path', handler)` emits `route` edge to `handler`
- [ ] `app.post('/path', middleware1, middleware2, handler)` emits `route` edge to last arg, `middleware` edges to others
- [ ] `router.get()` with `app.use('/prefix', router)` prepends prefix to routes
- [ ] `router.route('/path').get(h).post(h)` emits separate route edges per method
- [ ] Handler as arrow function: edge points to containing function scope

### NestJS HTTP
- [ ] `@Controller('users')` + `@Get(':id')` = route edge `GET users/:id → findOne`
- [ ] `@Controller()` (no prefix) = routes use only method path
- [ ] `@UseGuards(Guard)` emits `middleware` edge to Guard class
- [ ] All 8 HTTP method decorators recognized

### NestJS GraphQL
- [ ] `@Query()` emits `graphql_resolver` edge with `operationType: "query"`
- [ ] `@Mutation()` emits `graphql_resolver` edge with `operationType: "mutation"`
- [ ] `@Subscription()` emits `graphql_resolver` edge with `operationType: "subscription"`
- [ ] `@ResolveField()` emits `graphql_resolver` edge with `operationType: "field_resolver"`
- [ ] Operation name from decorator argument captured in metadata

### NestJS Microservices
- [ ] `@MessagePattern({ cmd: 'x' })` emits `message_handler` edge
- [ ] `@EventPattern('event')` emits `message_handler` edge
- [ ] Pattern string stored in edge metadata

### NestJS WebSockets
- [ ] `@SubscribeMessage('event')` emits `websocket_handler` edge
- [ ] Namespace from `@WebSocketGateway(port, { namespace })` in metadata

### Common
- [ ] `mapx routes --framework=express` shows only Express routes
- [ ] `mapx routes --framework=nestjs` shows Express + NestJS (or just nestjs, with filter)
- [ ] `npx tsc --noEmit` passes
