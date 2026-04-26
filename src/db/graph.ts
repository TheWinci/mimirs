import { Database } from "bun:sqlite";

export function upsertFileGraph(
  db: Database,
  fileId: number,
  imports: { name: string; source: string; isDefault?: boolean; isNamespace?: boolean }[],
  exports: { name: string; type: string; isDefault?: boolean; isReExport?: boolean; reExportSource?: string }[]
) {
  const tx = db.transaction(() => {
    db.run("DELETE FROM file_imports WHERE file_id = ?", [fileId]);
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
