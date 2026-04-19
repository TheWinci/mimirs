# graph

The SQL side of the dependency graph. Holds `file_imports` and `file_exports` writes, exposes the import-resolution fix-up primitives the resolver uses in its second pass, and serves full-graph + subgraph reads for `project_map`, `depends_on`, `depended_on_by`, and the wiki discovery phase.

**Source:** `src/db/graph.ts`

## Public API

```ts
function upsertFileGraph(
  db: Database,
  fileId: number,
  imports: {
    name: string;
    source: string;
    isDefault?: boolean;
    isNamespace?: boolean;
  }[],
  exports: {
    name: string;
    type: string;
    isDefault?: boolean;
    isReExport?: boolean;
    reExportSource?: string;
  }[]
): void;

function resolveImport(
  db: Database,
  importId: number,
  resolvedFileId: number
): void;

function getUnresolvedImports(
  db: Database
): { id: number; fileId: number; filePath: string; source: string }[];

function getGraph(db: Database): {
  nodes: { id: number; path: string; exports: { name: string; type: string }[] }[];
  edges: {
    fromId: number;
    fromPath: string;
    toId: number;
    toPath: string;
    source: string;
  }[];
};

function getSubgraph(
  db: Database,
  fileIds: number[],
  maxHops?: number
): {
  nodes: { id: number; path: string; exports: { name: string; type: string }[] }[];
  edges: {
    fromId: number;
    fromPath: string;
    toId: number;
    toPath: string;
    source: string;
  }[];
};

function getImportsForFile(
  db: Database,
  fileId: number
): { id: number; source: string; resolvedFileId: number | null }[];

function getImportersOf(db: Database, fileId: number): number[];

function getDependsOn(
  db: Database,
  fileId: number
): { path: string; source: string }[];

function getDependedOnBy(
  db: Database,
  fileId: number
): { path: string; source: string }[];
```

## Row shapes touched

- **`file_imports(id, file_id, source, names, is_default, is_namespace, resolved_file_id)`** — one row per import statement. `source` is the raw import string (e.g. `"./db"` or `"bun:sqlite"`); `resolved_file_id` is `NULL` until the resolver patches it via `resolveImport`. Nullable target is the key design choice — unresolved imports to external packages just never become edges.
- **`file_exports(id, file_id, name, type, is_default, is_reexport, reexport_source)`** — one row per declared export. `type` is the syntactic kind (`function`, `class`, `interface`, `const`, etc.); `reexport_source` is non-null only for `export { x } from "./y"` forms.

## Usage

Writing during indexing — paired with `upsertFile`:

```ts
// src/indexing/indexer.ts
upsertFileGraph(db, fileId, result.imports, result.exports);
// Every import is inserted with resolved_file_id = NULL — resolver runs later.
```

The resolver's two-pass pattern — read unresolved, patch, move on:

```ts
// src/graph/resolver.ts
for (const u of getUnresolvedImports(db)) {
  const resolvedPath = resolveImportPath(u.source, u.filePath, projectDir);
  const target = byPath.get(resolvedPath);
  if (target) resolveImport(db, u.id, target);
}
```

Reading from tools and search:

```ts
// src/tools/graph-tools.ts — depended_on_by
const file = db.getFileByPath(path);
const importers = db.getDependedOnBy(file.id); // [{ path, source }]

// src/search/hybrid.ts — graph boost
const importerIds = db.getImportersOf(file.id);
const boost = 0.05 * Math.log2(importerIds.length + 1);
```

## Dependencies

| Direction | Target | Notes |
|---|---|---|
| Imports | `bun:sqlite` | `Database` parameter from the facade |

`graph.ts` is a pure-SQL leaf — no `./types` import. Callers consume `getGraph`'s inline object shape directly rather than a named interface in `types.ts`.

## Internals

- **`upsertFileGraph` deletes + re-inserts.** Inside a single transaction, it clears prior `file_imports` + `file_exports` for the file and writes the new rows. Simpler than merge-on-conflict and cheap because rewrites happen at most once per `indexDirectory` per file.
- **Imports are inserted with `resolved_file_id = NULL`.** By design — `upsertFileGraph` can run before target files are indexed. `src/graph/resolver.ts` runs after the full walk and patches the ids, keeping the write path file-order-independent.
- **Batch-load exports pattern.** `getGraph` reads every `file_exports` row in one query and bucket-sorts by `file_id` client-side rather than running one `WHERE file_id = ?` per file. At ~5000+ files this is the difference between a hang and a snappy response.
- **Edges only materialise when resolved.** `getGraph`'s edge query joins `file_imports` to `files` twice (`f1` source, `f2` target) with `WHERE resolved_file_id IS NOT NULL`. Unresolved imports (external packages, broken paths) never appear as edges.
- **`getSubgraph` is BFS by SQL per hop.** Seed ids come in pre-resolved; each hop queries `file_imports` in both directions (`file_id IN (...) OR resolved_file_id IN (...)`). Frontier expansion is batched at `BATCH_LIMIT = 499` to stay below SQLite's 999-parameter limit (each query uses 2× frontier). Node-cap enforcement is the caller's job (`generateProjectMap`), not this function's.
- **Two getter shapes for the same edge data.** `getImportersOf` returns bare ids (hot path in hybrid search, no join needed); `getDependedOnBy` joins to `files.path` for the MCP tools that present human output. Same for `getImportsForFile` (bare) vs `getDependsOn` (joined).
- **No FTS or vec integration.** Graph tables are pure relational. The search module's graph boost fetches `getImportersOf` at query time rather than precomputing a score column — cheap given the small row counts.

## See also

- [db](index.md)
- [types](types.md)
- [files](files.md)
- [git-history](git-history.md)
- [conversation](conversation.md)
- [graph](../graph.md)
- [Architecture](../../architecture.md)
- [Data Flows](../../data-flows.md)
