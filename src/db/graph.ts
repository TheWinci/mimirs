import { Database } from "bun:sqlite";

/**
 * Replace all symbol references for a file. Refs come from bun-chunk's
 * `chunk.references` (per-chunk identifier-occurrence map).
 *
 * `resolved_export_id` is left null here; the cross-file resolver
 * (`resolveSymbolRefs`) populates it after `upsertFileGraph` has written
 * the file's imports and any other touched file's exports.
 */
export function upsertSymbolRefs(
  db: Database,
  fileId: number,
  refs: { chunkId: number; name: string; line: number }[]
) {
  const tx = db.transaction(() => {
    db.run("DELETE FROM symbol_refs WHERE file_id = ?", [fileId]);
    for (const ref of refs) {
      db.run(
        "INSERT INTO symbol_refs (chunk_id, file_id, name, line, resolved_export_id) VALUES (?, ?, ?, ?, NULL)",
        [ref.chunkId, fileId, ref.name, ref.line]
      );
    }
  });
  tx();
}

/**
 * Resolve symbol_refs rows for a file against its file_imports scope.
 * For each ref name, look up the import row by alias / name; if the
 * import resolves to another file, find a matching `file_exports` row
 * there and set `resolved_export_id`.
 *
 * Refs that don't match any import (local symbols, unresolved imports,
 * type refs to globals) stay with `resolved_export_id = NULL` —
 * findUsages falls back to FTS for those.
 */
export function resolveSymbolRefs(db: Database, fileId: number) {
  const imports = db
    .query<
      {
        names: string;
        is_namespace: number;
        resolved_file_id: number | null;
      },
      [number]
    >(
      `SELECT names, is_namespace, resolved_file_id
       FROM file_imports
       WHERE file_id = ? AND resolved_file_id IS NOT NULL`
    )
    .all(fileId);

  // Build alias → resolved file id index. For namespace imports
  // (`import * as X`), the alias is the namespace; refs of form `X` get
  // the resolved file but no specific export name. Mark with sentinel.
  const aliasToFile = new Map<string, number>();
  const namespaceAliases = new Set<string>();
  for (const imp of imports) {
    if (imp.resolved_file_id == null) continue;
    aliasToFile.set(imp.names, imp.resolved_file_id);
    if (imp.is_namespace === 1) namespaceAliases.add(imp.names);
  }

  // Pull distinct ref names for this file that haven't been resolved.
  const refNames = db
    .query<{ name: string }, [number]>(
      `SELECT DISTINCT name FROM symbol_refs
       WHERE file_id = ? AND resolved_export_id IS NULL`
    )
    .all(fileId)
    .map((r) => r.name);

  if (refNames.length === 0) return;

  const tx = db.transaction(() => {
    // Same-file exported callables are real inbound edges too. This matters
    // for structural entry discovery: helper exports called by another
    // function in the same module should not look like public library roots.
    db.run(
      `UPDATE symbol_refs
       SET resolved_export_id = (
         SELECT fe.id
         FROM file_exports fe
         WHERE fe.file_id = symbol_refs.file_id
           AND fe.name = symbol_refs.name
         LIMIT 1
       )
       WHERE file_id = ?
         AND resolved_export_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM file_exports fe
           WHERE fe.file_id = symbol_refs.file_id
             AND fe.name = symbol_refs.name
         )`,
      [fileId],
    );

    for (const name of refNames) {
      const resolvedFileId = aliasToFile.get(name);
      if (resolvedFileId == null) continue;
      // Namespace alias ref (the `path` in `import * as path`) — the
      // actual member access (`path.join`) is the separate ref handled
      // in the namespace-member pass below.
      if (namespaceAliases.has(name)) continue;

      const exp = db
        .query<{ id: number }, [number, string]>(
          `SELECT id FROM file_exports
           WHERE file_id = ? AND name = ?
           LIMIT 1`
        )
        .get(resolvedFileId, name);
      if (!exp) continue;

      db.run(
        `UPDATE symbol_refs
         SET resolved_export_id = ?
         WHERE file_id = ? AND name = ? AND resolved_export_id IS NULL`,
        [exp.id, fileId, name]
      );
    }

    // Namespace-member pass. For `import * as ns from "./mod"; ns.foo()`,
    // bun-chunk emits two refs at the same line: `ns` (the namespace
    // alias) and `foo` (the member). The first pass leaves `foo`
    // unresolved because it isn't a directly-imported name. Co-locate by
    // (file_id, line): when an unresolved ref shares a line with a
    // namespace alias whose resolved file exports that ref's name,
    // resolve it there. LIMIT 1 picks deterministically when multiple
    // namespaces at the same line both export the name (rare).
    if (namespaceAliases.size > 0) {
      db.run(
        `UPDATE symbol_refs
         SET resolved_export_id = (
           SELECT fe.id
           FROM symbol_refs ns_ref
           JOIN file_imports fi
             ON fi.file_id = ns_ref.file_id
            AND fi.is_namespace = 1
            AND fi.names = ns_ref.name
            AND fi.resolved_file_id IS NOT NULL
           JOIN file_exports fe
             ON fe.file_id = fi.resolved_file_id
            AND fe.name = symbol_refs.name
           WHERE ns_ref.file_id = symbol_refs.file_id
             AND ns_ref.line = symbol_refs.line
           LIMIT 1
         )
         WHERE file_id = ?
           AND resolved_export_id IS NULL
           AND EXISTS (
             SELECT 1
             FROM symbol_refs ns_ref
             JOIN file_imports fi
               ON fi.file_id = ns_ref.file_id
              AND fi.is_namespace = 1
              AND fi.names = ns_ref.name
              AND fi.resolved_file_id IS NOT NULL
             JOIN file_exports fe
               ON fe.file_id = fi.resolved_file_id
              AND fe.name = symbol_refs.name
             WHERE ns_ref.file_id = symbol_refs.file_id
               AND ns_ref.line = symbol_refs.line
           )`,
        [fileId]
      );
    }
  });
  tx();
}

/**
 * Exported callable + the chunk row that declares it. Used by entry-point
 * discovery — consumers need both `file_exports.id` (for inbound-ref
 * counting via `symbol_refs.resolved_export_id`) and the chunk's
 * `start_line` (for surface-able file:line refs on entry pages).
 *
 * Callable kinds are conservative: function + method only. Class is
 * intentionally excluded — instantiation isn't a "call" in the sense the
 * structural rule cares about. Constants / variables are not callable.
 */
export interface CallableExport {
  exportId: number;
  name: string;
  type: string;
  fileId: number;
  filePath: string;
  /** 1-indexed start_line of the declaring chunk; null when the chunker
   *  could not place it (rare for AST-supported langs). */
  startLine: number | null;
  /** 1-indexed end_line of the coalesced declaring chunks. */
  endLine: number | null;
}

/**
 * One ref recorded by bun-chunk inside an export's body chunks.
 *
 * `resolvedExportId` carries the cross-file resolution result from
 * `resolveSymbolRefs`. Null when the ref points to a symbol the project
 * doesn't export (third-party libs, type refs, dynamic dispatch) — the
 * tracer treats those as leaves.
 *
 * `line` is bun-chunk's 0-indexed file line; surface as +1 to humans.
 */
export interface CalleeRef {
  name: string;
  line: number;
  resolvedExportId: number | null;
}

export interface ChunkRange {
  chunkId: number;
  fileId: number;
  filePath: string;
  entityName: string | null;
  chunkType: string | null;
  startLine: number;
  endLine: number;
}

/**
 * All refs emitted from any chunk whose `entity_name` matches the given
 * export's name (i.e. the body of the function/method). Bun-chunk may
 * split a large symbol into multiple chunks — we union them.
 *
 * Includes refs from child chunks (`parent_id` pointing at the export's
 * own chunk). Bun-chunk emits a parent "bookend" chunk for large
 * functions/classes plus separate child chunks for the body slices and
 * inner declarations; the parent itself carries no refs because its
 * `references` field is empty by design. Walker would see zero callees
 * for any function big enough to split (e.g. `startServer`) without
 * this child fold.
 */
export function getCalleeRefsForExport(db: Database, exportId: number): CalleeRef[] {
  return db
    .query<
      { name: string; line: number; resolved_export_id: number | null },
      [number]
    >(
      `SELECT sr.name, sr.line, sr.resolved_export_id
       FROM symbol_refs sr
       JOIN chunks c ON c.id = sr.chunk_id
       JOIN file_exports fe ON fe.id = ?
       WHERE c.file_id = fe.file_id
         AND (
           c.entity_name = fe.name
           OR c.parent_id IN (
             SELECT id FROM chunks
             WHERE file_id = fe.file_id AND entity_name = fe.name
           )
         )
       ORDER BY sr.line ASC`
    )
    .all(exportId)
    .map((r) => ({
      name: r.name,
      line: r.line,
      resolvedExportId: r.resolved_export_id,
    }));
}

/**
 * A non-exported local callable — module-private functions / methods /
 * classes that bun-chunk emits as standalone chunks but never enter
 * `file_exports`. The trace walker uses these as a fallback when a
 * callee ref doesn't resolve through `file_exports` (which is the
 * common case for module-internal helpers).
 */
export interface LocalCallable {
  name: string;
  fileId: number;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  /** Always `null` — the disambiguator from {@link CallableExport}. Lets
   *  the tracer key on a single union type `{ exportId: number | null }`. */
  exportId: null;
}

/**
 * Look up a non-exported callable in a single file. Used by the trace
 * walker when a callee ref didn't resolve to a `file_exports` row but
 * could still be a same-file private helper.
 *
 * Restricted to callable chunk types so we don't walk into constants,
 * variables, or interfaces.
 */
export function getLocalCallable(
  db: Database,
  fileId: number,
  name: string,
): LocalCallable | null {
  const row = db
    .query<
      { start_line: number | null; end_line: number | null; path: string },
      [number, string]
    >(
      `SELECT MIN(c.start_line) AS start_line, MAX(c.end_line) AS end_line, f.path
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE c.file_id = ?
         AND c.entity_name = ?
         AND c.chunk_type IN ('function', 'method', 'class')`
    )
    .get(fileId, name);
  if (!row || row.path === null || row.path === undefined) return null;
  return {
    name,
    fileId,
    filePath: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    exportId: null,
  };
}

export function getUniqueLocalCallableBySuffix(
  db: Database,
  suffix: string,
): LocalCallable | null {
  const dottedRows = queryLocalCallableByNamePattern(db, `%.${suffix}`);
  if (dottedRows.length === 1) return localCallableFromRow(dottedRows[0]);
  if (dottedRows.length > 1) return null;

  const exactMethodRows = queryExactLocalMethods(db, suffix);
  if (exactMethodRows.length !== 1) return null;
  return localCallableFromRow(exactMethodRows[0]);
}

interface LocalCallableRow {
  entity_name: string;
  file_id: number;
  path: string;
  start_line: number | null;
  end_line: number | null;
}

function queryLocalCallableByNamePattern(db: Database, pattern: string): LocalCallableRow[] {
  return db
    .query<
      LocalCallableRow,
      [string]
    >(
      `SELECT c.entity_name,
              c.file_id,
              f.path,
              MIN(c.start_line) AS start_line,
              MAX(c.end_line) AS end_line
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE c.entity_name LIKE ?
         AND c.chunk_type IN ('function', 'method', 'class')
         AND c.start_line IS NOT NULL
         AND c.end_line IS NOT NULL
       GROUP BY c.file_id, c.entity_name, f.path`,
    )
    .all(pattern);
}

function queryExactLocalMethods(db: Database, name: string): LocalCallableRow[] {
  return db
    .query<
      LocalCallableRow,
      [string]
    >(
      `SELECT c.entity_name,
              c.file_id,
              f.path,
              MIN(c.start_line) AS start_line,
              MAX(c.end_line) AS end_line
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE c.entity_name = ?
         AND c.chunk_type = 'method'
         AND c.start_line IS NOT NULL
         AND c.end_line IS NOT NULL
       GROUP BY c.file_id, c.entity_name, f.path`,
    )
    .all(name);
}

function localCallableFromRow(row: LocalCallableRow): LocalCallable {
  return {
    name: row.entity_name,
    fileId: row.file_id,
    filePath: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    exportId: null,
  };
}

/**
 * Same shape as {@link getCalleeRefsForExport} but for non-exported
 * symbols — joins on `chunks.entity_name` instead of `file_exports`.
 * Lets the tracer walk into module-private functions whose body bun-
 * chunk has chunked but `file_exports` never recorded.
 */
export function getCalleeRefsForLocalSymbol(
  db: Database,
  fileId: number,
  name: string,
): CalleeRef[] {
  return db
    .query<
      { name: string; line: number; resolved_export_id: number | null },
      [number, string, number, string]
    >(
      `SELECT sr.name, sr.line, sr.resolved_export_id
       FROM symbol_refs sr
       JOIN chunks c ON c.id = sr.chunk_id
       WHERE c.file_id = ?
         AND (
           c.entity_name = ?
           OR c.parent_id IN (
             SELECT id FROM chunks
             WHERE file_id = ? AND entity_name = ?
           )
         )
       ORDER BY sr.line ASC`
    )
    .all(fileId, name, fileId, name)
    .map((r) => ({
      name: r.name,
      line: r.line,
      resolvedExportId: r.resolved_export_id,
    }));
}

export function getSymbolRefsInRange(
  db: Database,
  fileId: number,
  startLine: number,
  endLine: number,
): CalleeRef[] {
  return db
    .query<
      { name: string; line: number; resolved_export_id: number | null },
      [number, number, number]
    >(
      `SELECT sr.name, sr.line, sr.resolved_export_id
       FROM symbol_refs sr
       WHERE sr.file_id = ?
         AND sr.line BETWEEN ? AND ?
       ORDER BY sr.line ASC`,
    )
    .all(fileId, startLine - 1, endLine - 1)
    .map((r) => ({
      name: r.name,
      line: r.line,
      resolvedExportId: r.resolved_export_id,
    }));
}

export function getContainingChunk(
  db: Database,
  fileId: number,
  line: number,
): ChunkRange | null {
  const row = db
    .query<
      {
        id: number;
        path: string;
        entity_name: string | null;
        chunk_type: string | null;
        start_line: number | null;
        end_line: number | null;
      },
      [number, number, number]
    >(
      `SELECT c.id, f.path, c.entity_name, c.chunk_type, c.start_line, c.end_line
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE c.file_id = ?
         AND c.start_line IS NOT NULL
         AND c.end_line IS NOT NULL
         AND c.start_line <= ?
         AND c.end_line >= ?
       ORDER BY (c.end_line - c.start_line) ASC, c.start_line DESC
       LIMIT 1`,
    )
    .get(fileId, line, line);
  if (!row || row.start_line == null || row.end_line == null) return null;
  return {
    chunkId: row.id,
    fileId,
    filePath: row.path,
    entityName: row.entity_name,
    chunkType: row.chunk_type,
    startLine: row.start_line,
    endLine: row.end_line,
  };
}

/**
 * Distinct ref-name fan-in counts. A "ref" here = any inbound resolved
 * call to that export. Used by the tracer's ambient-prune heuristic
 * (callees with project-wide high fan-in are cited inline rather than
 * walked into — keeps utility helpers from eating per-branch budget).
 *
 * Returns counts keyed by **export name** (not id) because the prune
 * decision is made before the tracer resolves a callee's specific
 * file/export.
 */
export function getProjectRefFanIn(db: Database): Map<string, number> {
  // Only count refs that resolve to a real export. Without this filter
  // the count includes parameters, locals, type refs, and member-access
  // names — `db`, `path`, `expect`, `r` end up at 400-1200 each because
  // every test/handler names a parameter `db`. The trace walker reads
  // this map for its ambient-prune threshold; counting non-callables
  // makes legitimate callable walks look "ambient" and cuts the trace
  // short at every parameter site.
  const rows = db
    .query<{ name: string; n: number }, []>(
      `SELECT name, COUNT(*) AS n FROM symbol_refs
       WHERE resolved_export_id IS NOT NULL
       GROUP BY name`,
    )
    .all();
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.name, r.n);
  return out;
}

export function getCallableExports(db: Database): CallableExport[] {
  return db
    .query<
      {
        export_id: number;
        name: string;
        type: string;
        file_id: number;
        path: string;
        start_line: number | null;
        end_line: number | null;
      },
      []
    >(
      // GROUP BY export_id so a single export with N body chunks (bun-chunk
      // splits long functions) collapses to one row instead of N. MIN over
      // start_line picks the declaration chunk's line, not whichever body
      // chunk SQLite happens to surface first.
      `SELECT fe.id AS export_id, fe.name, fe.type,
              f.id AS file_id, f.path,
              MIN(c.start_line) AS start_line,
              MAX(c.end_line) AS end_line
       FROM file_exports fe
       JOIN files f ON f.id = fe.file_id
       LEFT JOIN chunks c
         ON c.file_id = fe.file_id
        AND c.entity_name = fe.name
       WHERE fe.type IN ('function', 'method')
       GROUP BY fe.id, fe.name, fe.type, f.id, f.path`
    )
    .all()
    .map((r) => ({
      exportId: r.export_id,
      name: r.name,
      type: r.type,
      fileId: r.file_id,
      filePath: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
    }));
}

export interface CallableRange {
  symbol: string;
  fileId: number;
  filePath: string;
  startLine: number;
  endLine: number;
  chunkType: string | null;
  confidence: "precise" | "heuristic";
}

/**
 * Coalesced range for a named symbol in one file. This is the wiki's
 * language-neutral "step" primitive: bun-chunk normalizes supported
 * languages into named chunks, while heuristic files may have no symbol and
 * therefore naturally degrade to caller-provided line-only steps.
 */
export function getCallableRange(
  db: Database,
  fileId: number,
  symbol: string,
): CallableRange | null {
  const row = db
    .query<
      {
        path: string;
        start_line: number | null;
        end_line: number | null;
        chunk_type: string | null;
      },
      [number, string]
    >(
      `SELECT f.path,
              MIN(c.start_line) AS start_line,
              MAX(c.end_line) AS end_line,
              MIN(c.chunk_type) AS chunk_type
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE c.file_id = ?
         AND c.entity_name = ?
         AND c.start_line IS NOT NULL
         AND c.end_line IS NOT NULL`,
    )
    .get(fileId, symbol);
  if (!row || row.start_line == null || row.end_line == null) return null;
  return {
    symbol,
    fileId,
    filePath: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    chunkType: row.chunk_type,
    confidence: row.chunk_type ? "precise" : "heuristic",
  };
}

export interface SymbolReferenceLocation {
  name: string;
  file: string;
  line: number;
}

export function getSymbolReferencesByName(
  db: Database,
  names: string[],
  filePaths?: string[],
): SymbolReferenceLocation[] {
  const uniqNames = [...new Set(names)].filter(Boolean);
  if (uniqNames.length === 0) return [];
  const namePlaceholders = uniqNames.map(() => "?").join(",");
  const params: (string | number)[] = [...uniqNames];
  let fileClause = "";
  if (filePaths && filePaths.length > 0) {
    const uniqFiles = [...new Set(filePaths)].filter(Boolean);
    if (uniqFiles.length > 0) {
      fileClause = ` AND f.path IN (${uniqFiles.map(() => "?").join(",")})`;
      params.push(...uniqFiles);
    }
  }
  return db
    .query<{ name: string; path: string; line: number }, (string | number)[]>(
      `SELECT sr.name, f.path, sr.line
       FROM symbol_refs sr
       JOIN files f ON f.id = sr.file_id
       WHERE sr.name IN (${namePlaceholders})${fileClause}
       ORDER BY f.path ASC, sr.line ASC`,
    )
    .all(...params)
    .map((r) => ({ name: r.name, file: r.path, line: r.line + 1 }));
}

/**
 * Count inbound refs to each export from non-test files. Returns a map
 * `exportId → count`. Used by the structural rule: a callable with zero
 * inbound refs is a Tier 1 entry candidate.
 *
 * `excludeFileIds` carries the test-path file ids resolved by the entry-
 * point discovery layer — graph.ts doesn't know what counts as "test".
 */
export function countInboundRefsByExport(
  db: Database,
  excludeFileIds: Set<number>,
): Map<number, number> {
  const rows = db
    .query<{ resolved_export_id: number; file_id: number; line: number; name: string }, []>(
      `SELECT resolved_export_id, file_id, line, name FROM symbol_refs
       WHERE resolved_export_id IS NOT NULL`
    )
    .all();
  const exportsById = new Map(getCallableExports(db).map((ex) => [ex.exportId, ex]));

  const counts = new Map<number, number>();
  for (const r of rows) {
    if (excludeFileIds.has(r.file_id)) continue;
    const target = exportsById.get(r.resolved_export_id);
    if (target && r.file_id === target.fileId && r.name === target.name) {
      const line = r.line + 1;
      const start = target.startLine ?? line;
      if (line === start) continue;
    }
    counts.set(r.resolved_export_id, (counts.get(r.resolved_export_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Run {@link resolveSymbolRefs} for every file. Used after the project-wide
 * import-resolution pass, which is when `file_imports.resolved_file_id` is
 * populated for the first time.
 */
export function resolveAllSymbolRefs(db: Database) {
  // One-time cleanup for DBs indexed before the upsertFileGraph stale-id
  // fix shipped: clear resolved_export_id pointing at exports that no
  // longer exist (left over from re-index churn before FK enforcement).
  // Cheap; runs every pass but only does work if orphans exist.
  db.run(
    `UPDATE symbol_refs
     SET resolved_export_id = NULL
     WHERE resolved_export_id IS NOT NULL
       AND resolved_export_id NOT IN (SELECT id FROM file_exports)`,
  );

  const fileIds = db
    .query<{ id: number }, []>("SELECT DISTINCT file_id AS id FROM symbol_refs")
    .all()
    .map((r) => r.id);
  for (const id of fileIds) {
    resolveSymbolRefs(db, id);
  }
}

export function upsertFileGraph(
  db: Database,
  fileId: number,
  imports: { name: string; source: string; isDefault?: boolean; isNamespace?: boolean }[],
  exports: { name: string; type: string; isDefault?: boolean; isReExport?: boolean; reExportSource?: string }[]
) {
  const tx = db.transaction(() => {
    db.run("DELETE FROM file_imports WHERE file_id = ?", [fileId]);
    // Foreign keys aren't enforced (PRAGMA foreign_keys defaults OFF in
    // bun:sqlite), so the schema's `ON DELETE SET NULL` on
    // symbol_refs.resolved_export_id never fires. Without this manual
    // clear, symbol_refs rows keep stale ids pointing at exports that
    // were just deleted; the next resolution pass leaves them as-is
    // (they're not NULL) and the count loses real callers.
    db.run(
      `UPDATE symbol_refs
       SET resolved_export_id = NULL
       WHERE resolved_export_id IN (
         SELECT id FROM file_exports WHERE file_id = ?
       )`,
      [fileId],
    );
    db.run("DELETE FROM file_exports WHERE file_id = ?", [fileId]);

    for (const imp of imports) {
      db.run(
        "INSERT INTO file_imports (file_id, source, names, is_default, is_namespace) VALUES (?, ?, ?, ?, ?)",
        [fileId, imp.source, imp.name, imp.isDefault ? 1 : 0, imp.isNamespace ? 1 : 0]
      );
    }

    for (const exp of exports) {
      db.run(
        "INSERT INTO file_exports (file_id, name, type, is_default, is_reexport, reexport_source) VALUES (?, ?, ?, ?, ?, ?)",
        [fileId, exp.name, exp.type, exp.isDefault ? 1 : 0, exp.isReExport ? 1 : 0, exp.reExportSource ?? null]
      );
    }
  });
  tx();
}

/**
 * Delete every graph row tied to a file that is being removed from the index.
 *
 * Foreign keys aren't enforced (PRAGMA foreign_keys defaults OFF in
 * bun:sqlite), so deleting the `files` row never cascades to file_imports /
 * file_exports / symbol_refs, and the `ON DELETE SET NULL` on the resolved_*
 * pointers in OTHER files never fires. Without this, `removeFile` /
 * `pruneDeleted` leave behind: the file's own orphaned imports/exports/refs,
 * stale `file_imports.resolved_file_id` in files that imported it, and stale
 * `symbol_refs.resolved_export_id` in files that referenced its exports —
 * which corrupts depends_on / depended_on_by / find_usages results.
 *
 * Reindexing a file does this per-table in upsertFileGraph/upsertSymbolRefs;
 * this is the equivalent for outright removal. Caller is expected to wrap this
 * in its own transaction alongside the chunk/file deletes.
 */
export function clearFileGraph(db: Database, fileId: number) {
  // Null cross-file pointers AT this file before deleting the rows they target.
  db.run(
    `UPDATE symbol_refs
       SET resolved_export_id = NULL
       WHERE resolved_export_id IN (
         SELECT id FROM file_exports WHERE file_id = ?
       )`,
    [fileId],
  );
  db.run(
    "UPDATE file_imports SET resolved_file_id = NULL WHERE resolved_file_id = ?",
    [fileId],
  );
  // Delete this file's own graph rows.
  db.run("DELETE FROM symbol_refs WHERE file_id = ?", [fileId]);
  db.run("DELETE FROM file_exports WHERE file_id = ?", [fileId]);
  db.run("DELETE FROM file_imports WHERE file_id = ?", [fileId]);
}

export function resolveImport(db: Database, importId: number, resolvedFileId: number) {
  db.run(
    "UPDATE file_imports SET resolved_file_id = ? WHERE id = ?",
    [resolvedFileId, importId]
  );
}

export function getUnresolvedImports(db: Database): { id: number; fileId: number; filePath: string; source: string }[] {
  return db
    .query<{ id: number; file_id: number; path: string; source: string }, []>(
      `SELECT fi.id, fi.file_id, f.path, fi.source
       FROM file_imports fi
       JOIN files f ON f.id = fi.file_id
       WHERE fi.resolved_file_id IS NULL`
    )
    .all()
    .map((r) => ({ id: r.id, fileId: r.file_id, filePath: r.path, source: r.source }));
}

export function getGraph(db: Database): {
  nodes: { id: number; path: string; exports: { name: string; type: string }[] }[];
  edges: { fromId: number; fromPath: string; toId: number; toPath: string; source: string }[];
} {
  const files = db
    .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
    .all();

  // Batch-load all exports in one query instead of per-file
  const allExports = db
    .query<{ file_id: number; name: string; type: string }, []>(
      "SELECT file_id, name, type FROM file_exports"
    )
    .all();

  const exportsByFile = new Map<number, { name: string; type: string }[]>();
  for (const exp of allExports) {
    let arr = exportsByFile.get(exp.file_id);
    if (!arr) {
      arr = [];
      exportsByFile.set(exp.file_id, arr);
    }
    arr.push({ name: exp.name, type: exp.type });
  }

  const nodes = files.map((f) => ({
    id: f.id,
    path: f.path,
    exports: exportsByFile.get(f.id) || [],
  }));

  const edges = db
    .query<
      { file_id: number; from_path: string; resolved_file_id: number; to_path: string; source: string },
      []
    >(
      `SELECT fi.file_id, f1.path as from_path, fi.resolved_file_id, f2.path as to_path, fi.source
       FROM file_imports fi
       JOIN files f1 ON f1.id = fi.file_id
       JOIN files f2 ON f2.id = fi.resolved_file_id
       WHERE fi.resolved_file_id IS NOT NULL`
    )
    .all()
    .map((r) => ({
      fromId: r.file_id,
      fromPath: r.from_path,
      toId: r.resolved_file_id,
      toPath: r.to_path,
      source: r.source,
    }));

  return { nodes, edges };
}

export function getSubgraph(db: Database, fileIds: number[], maxHops: number = 2): {
  nodes: { id: number; path: string; exports: { name: string; type: string }[] }[];
  edges: { fromId: number; fromPath: string; toId: number; toPath: string; source: string }[];
} {
  // BFS via SQL queries per hop instead of loading the full graph.
  // Batch frontier to stay within SQLite's 999-parameter limit (each query uses 2× frontier).
  const BATCH_LIMIT = 499;
  const visited = new Set<number>(fileIds);
  let frontier = [...fileIds];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const allNeighbors: { file_id: number; resolved_file_id: number }[] = [];

    for (let i = 0; i < frontier.length; i += BATCH_LIMIT) {
      const batch = frontier.slice(i, i + BATCH_LIMIT);
      const placeholders = batch.map(() => "?").join(",");
      const rows = db
        .query<{ file_id: number; resolved_file_id: number }, number[]>(
          `SELECT file_id, resolved_file_id FROM file_imports
           WHERE resolved_file_id IS NOT NULL
           AND (file_id IN (${placeholders}) OR resolved_file_id IN (${placeholders}))`
        )
        .all(...batch, ...batch);
      allNeighbors.push(...rows);
    }

    const nextFrontier: number[] = [];
    for (const row of allNeighbors) {
      if (!visited.has(row.file_id)) {
        visited.add(row.file_id);
        nextFrontier.push(row.file_id);
      }
      if (!visited.has(row.resolved_file_id)) {
        visited.add(row.resolved_file_id);
        nextFrontier.push(row.resolved_file_id);
      }
    }
    frontier = nextFrontier;
  }

  // Load only the nodes and edges for visited file IDs, batched for large sets
  const idList = [...visited];

  function batchQuery<T>(ids: number[], buildSql: (ph: string) => string): T[] {
    const results: T[] = [];
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      const batch = ids.slice(i, i + BATCH_LIMIT);
      const ph = batch.map(() => "?").join(",");
      results.push(...db.query<T, number[]>(buildSql(ph)).all(...batch));
    }
    return results;
  }

  const files = batchQuery<{ id: number; path: string }>(
    idList, (ph) => `SELECT id, path FROM files WHERE id IN (${ph})`
  );

  const allExports = batchQuery<{ file_id: number; name: string; type: string }>(
    idList, (ph) => `SELECT file_id, name, type FROM file_exports WHERE file_id IN (${ph})`
  );

  const exportsByFile = new Map<number, { name: string; type: string }[]>();
  for (const exp of allExports) {
    let arr = exportsByFile.get(exp.file_id);
    if (!arr) { arr = []; exportsByFile.set(exp.file_id, arr); }
    arr.push({ name: exp.name, type: exp.type });
  }

  const nodes = files.map((f) => ({
    id: f.id,
    path: f.path,
    exports: exportsByFile.get(f.id) || [],
  }));

  // Previously this batched `idList` and used the SAME batch for both
  // `file_id IN (…) AND resolved_file_id IN (…)`, which silently dropped any
  // edge whose endpoints fell into different batches. For subgraphs larger than
  // the batch size that meant a neighborhood graph with random missing edges.
  // Now: batch by `file_id` alone (one IN clause → full BATCH_LIMIT available),
  // then filter `resolved_file_id` in JS against the visited set.
  const visitedSet = visited;
  const edges: { fromId: number; fromPath: string; toId: number; toPath: string; source: string }[] = [];
  for (let i = 0; i < idList.length; i += BATCH_LIMIT) {
    const batch = idList.slice(i, i + BATCH_LIMIT);
    const ph = batch.map(() => "?").join(",");
    const rows = db
      .query<
        { file_id: number; from_path: string; resolved_file_id: number; to_path: string; source: string },
        number[]
      >(
        `SELECT fi.file_id, f1.path as from_path, fi.resolved_file_id, f2.path as to_path, fi.source
         FROM file_imports fi
         JOIN files f1 ON f1.id = fi.file_id
         JOIN files f2 ON f2.id = fi.resolved_file_id
         WHERE fi.resolved_file_id IS NOT NULL
         AND fi.file_id IN (${ph})`
      )
      .all(...batch);
    for (const r of rows) {
      if (!visitedSet.has(r.resolved_file_id)) continue;
      edges.push({
        fromId: r.file_id,
        fromPath: r.from_path,
        toId: r.resolved_file_id,
        toPath: r.to_path,
        source: r.source,
      });
    }
  }

  return { nodes, edges };
}

export function getImportsForFile(db: Database, fileId: number): { id: number; source: string; resolvedFileId: number | null }[] {
  return db
    .query<{ id: number; source: string; resolved_file_id: number | null }, [number]>(
      "SELECT id, source, resolved_file_id FROM file_imports WHERE file_id = ?"
    )
    .all(fileId)
    .map((r) => ({ id: r.id, source: r.source, resolvedFileId: r.resolved_file_id }));
}

export function getImportersOf(db: Database, fileId: number): number[] {
  return db
    .query<{ file_id: number }, [number]>(
      "SELECT file_id FROM file_imports WHERE resolved_file_id = ?"
    )
    .all(fileId)
    .map((r) => r.file_id);
}

/** Get resolved dependency paths for a file (what it imports). */
export function getDependsOn(db: Database, fileId: number): { path: string; source: string }[] {
  return db
    .query<{ path: string; source: string }, [number]>(
      `SELECT f.path, fi.source
       FROM file_imports fi
       JOIN files f ON f.id = fi.resolved_file_id
       WHERE fi.file_id = ? AND fi.resolved_file_id IS NOT NULL`
    )
    .all(fileId);
}

/** Get files that import a given file (reverse dependencies). */
export function getDependedOnBy(db: Database, fileId: number): { path: string; source: string }[] {
  return db
    .query<{ path: string; source: string }, [number]>(
      `SELECT f.path, fi.source
       FROM file_imports fi
       JOIN files f ON f.id = fi.file_id
       WHERE fi.resolved_file_id = ?`
    )
    .all(fileId);
}

/**
 * Batch-fetch dependencies for many files in a single SQL pass. Returns
 * `{ fromFileId, toPath }` rows so the caller can group per source file.
 * Used by the wiki bundle builder to avoid N round-trips per community on
 * 1k+ file projects.
 */
export function getDependsOnForFiles(
  db: Database,
  fileIds: number[],
): { fromFileId: number; toPath: string }[] {
  if (fileIds.length === 0) return [];
  const BATCH = 499;
  const out: { fromFileId: number; toPath: string }[] = [];
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const batch = fileIds.slice(i, i + BATCH);
    const ph = batch.map(() => "?").join(",");
    const rows = db
      .query<{ fromFileId: number; toPath: string }, number[]>(
        `SELECT fi.file_id AS fromFileId, f.path AS toPath
         FROM file_imports fi
         JOIN files f ON f.id = fi.resolved_file_id
         WHERE fi.file_id IN (${ph}) AND fi.resolved_file_id IS NOT NULL`,
      )
      .all(...batch);
    out.push(...rows);
  }
  return out;
}

/** Batch reverse-dependency fetch — symmetric to {@link getDependsOnForFiles}. */
export function getDependedOnByForFiles(
  db: Database,
  fileIds: number[],
): { toFileId: number; fromPath: string }[] {
  if (fileIds.length === 0) return [];
  const BATCH = 499;
  const out: { toFileId: number; fromPath: string }[] = [];
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const batch = fileIds.slice(i, i + BATCH);
    const ph = batch.map(() => "?").join(",");
    const rows = db
      .query<{ toFileId: number; fromPath: string }, number[]>(
        `SELECT fi.resolved_file_id AS toFileId, f.path AS fromPath
         FROM file_imports fi
         JOIN files f ON f.id = fi.file_id
         WHERE fi.resolved_file_id IN (${ph})`,
      )
      .all(...batch);
    out.push(...rows);
  }
  return out;
}

export interface SymbolGraphData {
  files: { id: number; path: string }[];
  imports: { fileId: number; names: string; resolvedFileId: number; isNamespace: boolean }[];
  exports: { fileId: number; name: string; type: string }[];
  chunks: { fileId: number; entityName: string; chunkType: string; snippet: string }[];
}

/**
 * Raw data needed to build a symbol-level call graph for community detection.
 * Imports are filtered to resolved ones; chunks are filtered to those with
 * entity_name (so every chunk corresponds to a named symbol).
 */
export function getSymbolGraphData(db: Database): SymbolGraphData {
  const files = db.query<{ id: number; path: string }, []>(`SELECT id, path FROM files`).all();

  const imports = db
    .query<{ file_id: number; names: string; resolved_file_id: number; is_namespace: number }, []>(
      `SELECT file_id, names, resolved_file_id, is_namespace
       FROM file_imports
       WHERE resolved_file_id IS NOT NULL`
    )
    .all()
    .map((r) => ({
      fileId: r.file_id,
      names: r.names,
      resolvedFileId: r.resolved_file_id,
      isNamespace: r.is_namespace === 1,
    }));

  const exports = db
    .query<{ file_id: number; name: string; type: string }, []>(
      `SELECT file_id, name, type FROM file_exports`
    )
    .all()
    .map((r) => ({ fileId: r.file_id, name: r.name, type: r.type }));

  const chunks = db
    .query<{ file_id: number; entity_name: string; chunk_type: string; snippet: string }, []>(
      `SELECT file_id, entity_name, chunk_type, snippet FROM chunks
       WHERE entity_name IS NOT NULL`
    )
    .all()
    .map((r) => ({
      fileId: r.file_id,
      entityName: r.entity_name,
      chunkType: r.chunk_type,
      snippet: r.snippet,
    }));

  return { files, imports, exports, chunks };
}

/**
 * Top-level variable-like declarations visible in the project — the union of
 * exported variables/constants/enums (via `file_exports`) AND file-local
 * declarations picked up by the chunker (via `chunks` where
 * `chunk_type='variable'`). Language-agnostic: bun-chunk emits
 * `chunk_type='variable'` for JS/TS `const`/`let`/`var`, Python module-level
 * assignments, Rust `const`/`static`, Go `const`/`var`, Java `static final`,
 * and equivalents across its 26 supported languages — the semantics of
 * "top-level named value" collapse to one chunk type.
 *
 * The lint previously pulled only from `file_exports`, which caused
 * `constant-missing` false-positives on any prose that correctly cited a
 * real-but-unexported declaration (logged in the Wave 1 review). A citation
 * is valid if the name exists as a declaration *anywhere* in the codebase —
 * export status doesn't change whether the literal is real.
 *
 * No case filter in SQL: lowercase entries are returned too. The consuming
 * lint regex restricts to SCREAMING_SNAKE_CASE on its own (prose only cites
 * literal tunables by upper-case name), so lowercase rows sit in the map
 * unused rather than missing.
 *
 * When a name exists in both sources, the export entry wins (canonical file,
 * value comes from the export-matching chunk).
 */
export function getProjectConstants(
  db: Database,
): Map<string, { name: string; value: string; file: string }> {
  const out = new Map<string, { name: string; value: string; file: string }>();

  const exportRows = db
    .query<
      { name: string; type: string; path: string; snippet: string | null },
      []
    >(
      `SELECT fe.name, fe.type, f.path, c.snippet
         FROM file_exports fe
         JOIN files f ON f.id = fe.file_id
         LEFT JOIN chunks c
           ON c.file_id = fe.file_id
          AND LOWER(c.entity_name) = LOWER(fe.name)
        WHERE fe.type IN ('constant', 'variable', 'enum')`,
    )
    .all();

  for (const r of exportRows) {
    if (!r.snippet) continue;
    if (out.has(r.name)) continue;
    out.set(r.name, { name: r.name, value: r.snippet, file: r.path });
  }

  // Second pass: file-local `const FOO = ...` declarations the chunker picked
  // up but aren't exported. Skip names already present from the export pass
  // so exports remain canonical.
  const localRows = db
    .query<
      { name: string; path: string; snippet: string },
      []
    >(
      `SELECT c.entity_name AS name, f.path, c.snippet
         FROM chunks c
         JOIN files f ON f.id = c.file_id
        WHERE c.chunk_type = 'variable'
          AND c.entity_name IS NOT NULL
          AND c.snippet IS NOT NULL`,
    )
    .all();

  for (const r of localRows) {
    if (out.has(r.name)) continue;
    out.set(r.name, { name: r.name, value: r.snippet, file: r.path });
  }

  return out;
}
