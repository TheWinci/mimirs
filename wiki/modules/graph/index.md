# Graph Module

The Graph module (`src/graph/`) resolves import/export relationships between
files and generates text-based dependency maps. It powers the `project_map`,
`depends_on`, and `depended_on_by` tools.

## Entry Point -- `resolver.ts`

A single file module with three main exports:

### `resolveImports(db, projectDir)`

Resolves import paths for **all** indexed files. Uses a two-pass strategy:

1. **Bun-chunk filesystem resolution** -- attempts to resolve import specifiers
   to actual files on disk using Node/Bun module resolution rules.
2. **DB-based fallback** -- for imports that cannot be resolved on the
   filesystem, searches the database's file index for matches.

Handles TypeScript path aliases by reading `tsconfig.json` `compilerOptions.paths`.

### `resolveImportsForFile(db, fileId, projectDir)`

Same resolution logic as `resolveImports` but scoped to a single file.
Used when you only need the dependency graph for one file rather than the
entire project.

### `generateProjectMap(db, projectDir, opts)`

Builds a text-based dependency graph. Supports two zoom levels:

- **File level** -- shows individual file dependencies.
- **Directory level** -- aggregates file relationships into module-level
  dependencies for a high-level overview.

Accepts a `focus` option to zoom into a specific file's neighborhood,
showing only its direct dependencies and dependents.

## Import Resolution Details

The two-pass approach handles real-world TypeScript/JavaScript projects:

```mermaid
flowchart TD
  importSpec["Import specifier"]
  fsResolve["Pass 1: Filesystem resolution"]
  dbResolve["Pass 2: DB file lookup"]
  tsconfig["tsconfig.json path aliases"]
  resolved["Resolved file_id"]

  importSpec --> fsResolve
  fsResolve -->|found| resolved
  fsResolve -->|not found| dbResolve
  dbResolve --> resolved
  importSpec --> tsconfig
  tsconfig --> fsResolve
```

- **Relative imports** (`./foo`, `../bar`) -- resolved against the importing
  file's directory.
- **Path aliases** (`@/utils/log`) -- mapped via `tsconfig.json` paths.
- **Bare specifiers** (`lodash`) -- skipped (external packages).

## Dependencies and Dependents

```mermaid
flowchart LR
  dbMod["DB"]
  graphMod["Graph"]
  indexingMod["Indexing"]
  toolsMod["Tools"]
  cliMod["CLI"]

  dbMod --> graphMod
  graphMod --> indexingMod
  graphMod --> toolsMod
  graphMod --> cliMod
```

- **Depends on:** DB
- **Depended on by:** Indexing, Tools, CLI

## See Also

- [DB module](../db/) -- stores import/export edges in `file_imports` and
  `file_exports` tables
- [Tools module](../tools/) -- `project_map`, `depends_on`, `depended_on_by`,
  and `find_usages` tools wrap this module
- [Architecture overview](../../architecture.md)
