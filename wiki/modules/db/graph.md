# graph

The SQL side of the dependency graph. Holds `file_imports` and `file_exports` writes, exposes the import-resolution fix-up primitives the resolver uses in its second pass, and serves full-graph + subgraph reads for `project_map`, `depends_on`, `depended_on_by`, and the wiki discovery phase.

**Source:** `src/db/graph.ts`

## Key exports

| Function | Shape | Purpose |
|---|---|---|
| `upsertFileGraph(db, fileId, imports, exports)` | `→ void` | One transaction: clears prior `file_imports` + `file_exports` for the file, inserts the new rows. Always writes imports with `resolved_file_id = NULL` — the resolver patches these in a second pass |
| `resolveImport(db, importId, resolvedFileId)` | `→ void` | The patch: set one `file_imports.resolved_file_id`. Called from the resolver's bun-chunk and DB fallback paths |
| `getUnresolvedImports(db)` | `→ { id, fileId, filePath, source }[]` | Returns every row where `resolved_file_id IS NULL` — the resolver's workset |
| `getGraph(db)` | `→ { nodes[], edges[] }` | Full typed graph: every file as a node, every resolved import as a directed edge. Used by `generateProjectMap` at `--zoom file` |
| `getSubgraph(db, fileIds, maxHops)` | `→ { nodes[], edges[] }` | BFS-bounded extract: seed with `fileIds`, expand both incoming and outgoing edges up to `maxHops` |
| `getImportsForFile(db, fileId)` | `→ { id, source, resolvedFileId }[]` | Raw forward edges — resolved or not, including the import-string source |
| `getImportersOf(db, fileId)` | `→ number[]` | Reverse edges as file ids — every file whose `resolved_file_id = fileId`. Powers the hybrid-search graph boost |
| `getDependsOn(db, fileId)` | `→ { path, source }[]` | Forward dependencies as paths (join-on-resolved). Powers the `depends_on` MCP tool |
| `getDependedOnBy(db, fileId)` | `→ { path, source }[]` | Reverse dependencies as paths. Powers the `depended_on_by` MCP tool |

## Usage examples

Writing during indexing — paired with `upsertFile`:

```ts
// src/indexing/indexer.ts
upsertFileGraph(db, fileId, result.imports, result.exports);
// (resolved_file_id is NULL for every import — resolver runs later)
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

`graph.ts` is a pure-SQL leaf — no `./types` import; the caller-facing `types.ts` has no row shape specifically for graph because callers consume `getGraph`'s inline shape directly.

## Internals

- **`upsertFileGraph` deletes + re-inserts.** Kept simple because rewrites are rare (once per `indexDirectory` per file). A merge-on-conflict approach would add complexity for no measurable win.
- **Batch-load exports pattern.** `getGraph` reads every `file_exports` row in one query and bucket-sorts by `file_id` client-side instead of running one `WHERE file_id = ?` per file. At ~160 files and ~600 exports the difference is negligible; at ~5000+ files it's the difference between a hang and a snappy response.
- **Edges only materialise when resolved.** `getGraph`'s edge query joins `file_imports` to `files` twice (`f1` source, `f2` target) with `WHERE resolved_file_id IS NOT NULL`. Unresolved imports (external packages, broken paths) simply don't appear as edges — by design, since every edge would otherwise need a nullable target.
- **`getSubgraph` is BFS by id, not by path.** Seed ids come in pre-resolved; the expansion walks `getImportersOf` + outgoing edges up to `maxHops`. Max node cap is applied by the caller (`generateProjectMap`), not here.
- **Two getter shapes for the same edge data.** `getImportersOf` returns bare ids (hot path in hybrid search, no join needed); `getDependedOnBy` joins to `files.path` for the MCP tools that present human output. Same for `getImportsForFile` vs `getDependsOn`.
- **No FTS or vec integration.** Graph tables are pure relational. The search module's graph boost fetches `getImportersOf` at query time rather than precomputing a score column — cheap given the small row counts and adjusted weights.

## See also

- [db](index.md)
- [types](types.md)
- [files](files.md)
- [git-history](git-history.md)
- [conversation](conversation.md)
- [graph](../graph.md)
- [Architecture](../../architecture.md)
- [Data Flows](../../data-flows.md)
