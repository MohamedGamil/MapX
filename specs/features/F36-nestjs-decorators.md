# F36 — NestJS Decorators & DI Parsing

> **Iteration**: [I20](../iterations/I20.md) · **Status**: `done` · **Priority**: 🔴 CRITICAL
> **Origin**: MCP Feedback Sections 1.3, 1.4, & 4.3 — `mapx_routes` and `mapx_hooks` empty for NestJS

---

## Problem

NestJS relies heavily on decorators for routing (`@Controller`, `@Get`, `@Post`), GraphQL resolvers (`@Resolver`, `@Query`, `@Mutation`), and lifecycle/middleware interfaces (`OnModuleInit`, `CanActivate`, etc.). None of these are parsed or resolved by the current code graph engine, leaving backend endpoints and dependency injection pathways completely unmapped.

## Solution

1. **NestJS Route & Resolver Support**:
   - Create a NestJS framework parser that extracts routes from decorator calls on classes and methods.
   - Map `@Get('path')`, `@Post('path')` etc. along with class-level `@Controller('prefix')` to produce route edges with path and method metadata.
   - Extract GraphQL resolvers from `@Resolver`, `@Query`, `@Mutation` decorators.
2. **Lifecycle & DI Hook Tracking**:
   - Detect class declarations implementing lifecycle interfaces (`OnModuleInit`, `OnApplicationBootstrap`, etc.).
   - Extract class constructors and resolve type annotations of parameters (e.g. `constructor(private readonly userService: UserService)`) to create DI dependency edges.
   - Parse implemented guards (`CanActivate`), interceptors (`NestInterceptor`), and pipes (`PipeTransform`).

## Files Changed

| File | Change |
|------|--------|
| `src/core/frameworks/nestjs.ts` | Implement/extend NestJS framework detector and route/hook parser |
| `src/types.ts` | Ensure routing metadata support is schema-aligned |

## Acceptance Criteria

- [x] `mapx routes` extracts NestJS API endpoints with path, method, and handler details
- [x] GraphQL query/mutation decorators generate resolver metadata in the graph
- [x] Constructor parameters resolve to target classes as dependency injection edges
- [x] Lifecycle hooks and guards are cataloged and queryable via `mapx hooks`
- [x] TypeScript compiles with 0 errors
