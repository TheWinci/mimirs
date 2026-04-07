# Conventions

## Language and Runtime

- **TypeScript** on the **Bun** runtime
- **Package manager**: Bun — never use npm or pnpm

## Naming

| Scope | Convention | Example |
|---|---|---|
| Files | kebab-case | `hybrid-search.ts` |
| Functions / variables | camelCase | `searchChunks()` |
| Types / classes / interfaces | PascalCase | `ChunkResult`, `RagDB` |

## Error Handling

- Errors are **thrown directly** — the project does not use Result types.
- Errors are **caught at boundaries**: CLI commands and MCP tool handlers.
- Warnings go to stderr via `log.warn`.

## Module Pattern

Each subdirectory under `src/` acts as a self-contained module:

- Every module has an `index.ts` **barrel export** that re-exports its public API.
- Within a module, use **relative paths** for imports (`./foo`).
- Across modules, use **barrel imports** (`from "../db"`).

### DB Delegate Pattern

Database sub-modules are **delegates** — standalone functions that receive the `Database` handle as their first parameter rather than living as methods on a class. The [RagDB](../glossary.md#ragdb) facade coordinates these delegates.

## Configuration

- All configuration uses **Zod schemas** for validation.
- Defaults are auto-written to disk (`.mimirs/config.json`) so users can inspect and override them.
- See [RagConfig](../glossary.md#ragconfig) in the glossary.

## Imports

```ts
// Within the same module — relative path
import { buildQuery } from "./query-builder";

// Across modules — barrel import
import { searchChunks } from "../search";
```

## Tests

- Run with `bun run test` (not `bun test`, which also runs benchmarks).
- Test files live in `tests/` mirroring the `src/` structure.
- See the [Testing guide](testing.md) for details.

## See Also

- [Getting Started](getting-started.md) — project setup and structure
- [Testing](testing.md) — test runner, helpers, and fixtures
- [Architecture](../architecture.md) — system design overview
- [Glossary](../glossary.md) — terminology reference
