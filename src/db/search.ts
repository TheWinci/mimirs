import { Database } from "bun:sqlite";
import { dirname, basename } from "path";
import { type SearchResult, type ChunkSearchResult, type SymbolResult, type UsageResult, type PathFilter } from "./types";
import { escapeRegex, sanitizeFTS } from "../search/usages";
import { log } from "../utils/log";

/**
 * Convert a stored vector score back to cosine similarity.
 *
 * Embeddings are L2-normalized (src/embeddings/embed.ts) and vec_chunks uses
 * vec0's default L2 (Euclidean) distance, so the stored `score = 1/(1+distance)`
 * is NOT a cosine. For unit vectors L2² = 2(1−cos), hence:
 *   distance = 1/score − 1,   cosine = 1 − distance²/2.
 * Verified empirically (orthogonal unit vectors → distance 1.4142, score 0.4142).
 * The minimum possible score is ≈0.333 (antipode), so a raw-score "< 0.3"
 * heuristic can never fire — analytics must compare cosine instead. Returns null
 * for a missing/non-positive score.
 */
export function vectorScoreToCosine(score: number | null | undefined): number | null {
  if (score == null || score <= 0) return null;
  const distance = 1 / score - 1;
  return 1 - (distance * distance) / 2;
}

/**
 * Build parametrized SQL fragments for a PathFilter. Caller concatenates
 * returned clauses with AND. Returns empty arrays when no filter is active.
 *
 * Extensions are matched against the file path suffix. Dir filters are
 * path-prefix matches — callers should pass absolute paths (or paths already
 * resolved relative to project root) because that's what's stored in the
 * files table. A missing leading dot on an extension is tolerated.
 */
function buildPathFilter(filter?: PathFilter): { clauses: string[]; params: string[]; active: boolean } {
  const clauses: string[] = [];
  const params: string[] = [];
  let active = false;

  if (!filter) return { clauses, params, active };

  if (filter.extensions && filter.extensions.length > 0) {
    active = true;
    const extClauses = filter.extensions.map(() => "f.path LIKE ?");
    clauses.push(`(${extClauses.join(" OR ")})`);
    for (const ext of filter.extensions) {
      const normalized = ext.startsWith(".") ? ext : `.${ext}`;
      params.push(`%${normalized}`);
    }
  }

  if (filter.dirs && filter.dirs.length > 0) {
    active = true;
    const dirClauses = filter.dirs.map(() => "f.path LIKE ?");
    clauses.push(`(${dirClauses.join(" OR ")})`);
    for (const dir of filter.dirs) {
      params.push(`${dir.replace(/\/$/, "")}/%`);
    }
  }

  if (filter.excludeDirs && filter.excludeDirs.length > 0) {
    active = true;
    for (const dir of filter.excludeDirs) {
      clauses.push("f.path NOT LIKE ?");
      params.push(`${dir.replace(/\/$/, "")}/%`);
    }
  }

  return { clauses, params, active };
}

/** How much to over-fetch from the inner vec/FTS query when a filter is active. */
const FILTER_OVERFETCH = 5;

export function vectorSearch(
  db: Database,
  queryEmbedding: Float32Array,
  topK: number = 5,
  filter?: PathFilter,
): SearchResult[] {
  const { clauses, params: filterParams, active } = buildPathFilter(filter);
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const innerLimit = active ? topK * FILTER_OVERFETCH : topK;

  const sql = `SELECT v.chunk_id, v.distance, c.snippet, c.chunk_index, c.entity_name, c.chunk_type, f.path
     FROM (SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
     JOIN chunks c ON c.id = v.chunk_id
     JOIN files f ON f.id = c.file_id
     ${whereClause}
     ORDER BY v.distance
     LIMIT ?`;

  return db
    .query<
      {
        chunk_id: number;
        distance: number;
        snippet: string;
        chunk_index: number;
        entity_name: string | null;
        chunk_type: string | null;
        path: string;
      },
      (Uint8Array | number | string)[]
    >(sql)
    .all(new Uint8Array(queryEmbedding.buffer), innerLimit, ...filterParams, topK)
    .map((row) => ({
      path: row.path,
      score: 1 / (1 + row.distance),
      snippet: row.snippet,
      chunkIndex: row.chunk_index,
      entityName: row.entity_name,
      chunkType: row.chunk_type,
    }));
}

export function textSearch(
  db: Database,
  query: string,
  topK: number = 5,
  filter?: PathFilter,
): SearchResult[] {
  const { clauses, params: filterParams, active } = buildPathFilter(filter);
  const extraWhere = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
  const fetchLimit = active ? topK * FILTER_OVERFETCH : topK;

  const sql = `SELECT c.snippet, c.chunk_index, c.entity_name, c.chunk_type, f.path, rank
     FROM fts_chunks fts
     JOIN chunks c ON c.id = fts.rowid
     JOIN files f ON f.id = c.file_id
     WHERE fts_chunks MATCH ?${extraWhere}
     ORDER BY rank
     LIMIT ?`;

  return db
    .query<
      {
        snippet: string;
        chunk_index: number;
        entity_name: string | null;
        chunk_type: string | null;
        rank: number;
        path: string;
      },
      (string | number)[]
    >(sql)
    .all(sanitizeFTS(query), ...filterParams, fetchLimit)
    .slice(0, topK)
    .map((row) => ({
      path: row.path,
      score: 1 / (1 + Math.abs(row.rank)),
      snippet: row.snippet,
      chunkIndex: row.chunk_index,
      entityName: row.entity_name,
      chunkType: row.chunk_type,
    }));
}

export function vectorSearchChunks(
  db: Database,
  queryEmbedding: Float32Array,
  topK: number = 8,
  filter?: PathFilter,
): ChunkSearchResult[] {
  const { clauses, params: filterParams, active } = buildPathFilter(filter);
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const innerLimit = active ? topK * FILTER_OVERFETCH : topK;

  const sql = `SELECT v.chunk_id, v.distance, c.snippet, c.chunk_index, c.entity_name, c.chunk_type,
            c.start_line, c.end_line, c.parent_id, f.path
     FROM (SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
     JOIN chunks c ON c.id = v.chunk_id
     JOIN files f ON f.id = c.file_id
     ${whereClause}
     ORDER BY v.distance
     LIMIT ?`;

  return db
    .query<
      {
        chunk_id: number;
        distance: number;
        snippet: string;
        chunk_index: number;
        entity_name: string | null;
        chunk_type: string | null;
        start_line: number | null;
        end_line: number | null;
        parent_id: number | null;
        path: string;
      },
      (Uint8Array | number | string)[]
    >(sql)
    .all(new Uint8Array(queryEmbedding.buffer), innerLimit, ...filterParams, topK)
    .map((row) => ({
      path: row.path,
      score: 1 / (1 + row.distance),
      content: row.snippet,
      chunkIndex: row.chunk_index,
      entityName: row.entity_name,
      chunkType: row.chunk_type,
      startLine: row.start_line,
      endLine: row.end_line,
      parentId: row.parent_id,
    }));
}

export function textSearchChunks(
  db: Database,
  query: string,
  topK: number = 8,
  filter?: PathFilter,
): ChunkSearchResult[] {
  const { clauses, params: filterParams, active } = buildPathFilter(filter);
  const extraWhere = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
  const fetchLimit = active ? topK * FILTER_OVERFETCH : topK;

  const sql = `SELECT c.snippet, c.chunk_index, c.entity_name, c.chunk_type, c.start_line, c.end_line,
            c.parent_id, f.path, rank
     FROM fts_chunks fts
     JOIN chunks c ON c.id = fts.rowid
     JOIN files f ON f.id = c.file_id
     WHERE fts_chunks MATCH ?${extraWhere}
     ORDER BY rank
     LIMIT ?`;

  return db
    .query<
      {
        snippet: string;
        chunk_index: number;
        entity_name: string | null;
        chunk_type: string | null;
        start_line: number | null;
        end_line: number | null;
        parent_id: number | null;
        rank: number;
        path: string;
      },
      (string | number)[]
    >(sql)
    .all(sanitizeFTS(query), ...filterParams, fetchLimit)
    .slice(0, topK)
    .map((row) => ({
      path: row.path,
      score: 1 / (1 + Math.abs(row.rank)),
      content: row.snippet,
      chunkIndex: row.chunk_index,
      entityName: row.entity_name,
      chunkType: row.chunk_type,
      startLine: row.start_line,
      endLine: row.end_line,
      parentId: row.parent_id,
    }));
}

export function searchSymbols(
  db: Database,
  query?: string,
  exact: boolean = false,
  type?: string,
  topK?: number
): SymbolResult[] {
  const isListing = !query;
  const effectiveTopK = topK ?? (isListing ? 200 : 20);

  // Step 1: Flat query for base export rows. The old implementation used four
  // correlated subqueries per row (snippet/child_count/reference_count/paths),
  // which turned a listing of ~1k symbols into minutes of work on medium-sized
  // projects. Each subquery also did LOWER(...) comparisons that couldn't use
  // indexes. The fix is to fetch the base rows once, then batch-load the
  // supporting data with plain IN-list queries and join in JS.
  let sql = `
    SELECT fe.file_id, fe.name AS symbol_name, fe.type AS symbol_type, f.path, fe.is_reexport
    FROM file_exports fe
    JOIN files f ON f.id = fe.file_id
  `;
  const params: (string | number)[] = [];

  if (query) {
    const pattern = exact ? query : `%${query}%`;
    sql += " WHERE LOWER(fe.name) LIKE LOWER(?)";
    params.push(pattern);
  } else {
    sql += " WHERE 1=1";
  }

  if (type) {
    sql += " AND fe.type = ?";
    params.push(type);
  }

  sql += " ORDER BY fe.name LIMIT ?";
  params.push(effectiveTopK);

  const baseRows = db
    .query<
      {
        file_id: number;
        symbol_name: string;
        symbol_type: string;
        path: string;
        is_reexport: number;
      },
      any[]
    >(sql)
    .all(...params);

  if (baseRows.length === 0) return [];

  const fileIds = [...new Set(baseRows.map((r) => r.file_id))];
  const loweredNames = [...new Set(baseRows.map((r) => r.symbol_name.toLowerCase()))];

  // Step 2: Load the candidate chunks (first chunk per file+entity_name match).
  // One scan over all chunks in the relevant files — cheap even for large projects.
  const chunkRows = batchIn<
    { id: number; file_id: number; entity_name: string | null; snippet: string; chunk_index: number },
    number
  >(db, fileIds, (ph) =>
    `SELECT id, file_id, entity_name, snippet, chunk_index FROM chunks WHERE file_id IN (${ph})`
  );

  const chunkByFileName = new Map<string, { id: number; snippet: string; chunk_index: number }>();
  for (const c of chunkRows) {
    if (!c.entity_name) continue;
    const key = `${c.file_id}|${c.entity_name.toLowerCase()}`;
    const existing = chunkByFileName.get(key);
    if (!existing || c.chunk_index < existing.chunk_index) {
      chunkByFileName.set(key, { id: c.id, snippet: c.snippet, chunk_index: c.chunk_index });
    }
  }

  // Step 3: Child counts for each candidate parent chunk.
  const parentIds = [...new Set([...chunkByFileName.values()].map((c) => c.id))];
  const childCountByParent = new Map<number, number>();
  if (parentIds.length > 0) {
    const childRows = batchIn<{ parent_id: number; cnt: number }, number>(
      db,
      parentIds,
      (ph) =>
        `SELECT parent_id, COUNT(*) AS cnt FROM chunks WHERE parent_id IN (${ph}) GROUP BY parent_id`
    );
    for (const r of childRows) {
      childCountByParent.set(r.parent_id, r.cnt);
    }
  }

  // Step 4: Transitive reference counting.
  // 4a: all exports sharing a (case-insensitive) name with one of our base rows.
  // This gives the set of files that define/re-export each name.
  const siblingExportRows = batchIn<{ name_lower: string; file_id: number }, string>(
    db,
    loweredNames,
    (ph) => `SELECT LOWER(name) AS name_lower, file_id FROM file_exports WHERE LOWER(name) IN (${ph})`
  );
  const fileIdsByName = new Map<string, Set<number>>();
  for (const r of siblingExportRows) {
    let s = fileIdsByName.get(r.name_lower);
    if (!s) {
      s = new Set();
      fileIdsByName.set(r.name_lower, s);
    }
    s.add(r.file_id);
  }

  // 4b: all resolved imports whose name matches one of our base rows. We filter
  // to (name, resolved_file_id) pairs in JS so each base row only pays for
  // its own name's imports.
  const importRows = batchIn<
    { name_lower: string; importer_id: number; resolved_file_id: number; importer_path: string },
    string
  >(db, loweredNames, (ph) =>
    `SELECT LOWER(fi.names) AS name_lower, fi.file_id AS importer_id, fi.resolved_file_id, f.path AS importer_path
     FROM file_imports fi JOIN files f ON f.id = fi.file_id
     WHERE LOWER(fi.names) IN (${ph}) AND fi.resolved_file_id IS NOT NULL`
  );
  const importsByName = new Map<
    string,
    { importer_id: number; resolved_file_id: number; importer_path: string }[]
  >();
  for (const r of importRows) {
    let arr = importsByName.get(r.name_lower);
    if (!arr) {
      arr = [];
      importsByName.set(r.name_lower, arr);
    }
    arr.push(r);
  }

  // Step 5: compose results.
  return baseRows.map((row) => {
    const lowered = row.symbol_name.toLowerCase();
    const chunkKey = `${row.file_id}|${lowered}`;
    const chunk = chunkByFileName.get(chunkKey);
    const childCount = chunk ? childCountByParent.get(chunk.id) ?? 0 : 0;

    const candidateFileIds = fileIdsByName.get(lowered) ?? new Set<number>();
    const importerIds = new Set<number>();
    const importerPaths = new Set<string>();
    for (const imp of importsByName.get(lowered) ?? []) {
      if (candidateFileIds.has(imp.resolved_file_id)) {
        importerIds.add(imp.importer_id);
        importerPaths.add(imp.importer_path);
      }
    }
    const refDirs = new Set([...importerPaths].map((p) => dirname(p)));
    const referenceModules = [...refDirs]
      .map((d) => basename(d))
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort();

    return {
      path: row.path,
      symbolName: row.symbol_name,
      symbolType: row.symbol_type,
      snippet: chunk?.snippet ?? null,
      chunkIndex: chunk?.chunk_index ?? null,
      hasChildren: childCount > 0,
      childCount,
      referenceCount: importerIds.size,
      referenceModuleCount: refDirs.size,
      referenceModules,
      isReexport: row.is_reexport === 1,
    };
  });
}

/** Run an IN-list query in batches of 499 to stay under SQLite's 999-param limit. */
function batchIn<Row, Id extends number | string>(
  db: Database,
  ids: Id[],
  buildSql: (placeholders: string) => string
): Row[] {
  const BATCH = 499;
  if (ids.length === 0) return [];
  const results: Row[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const ph = batch.map(() => "?").join(",");
    results.push(...db.query<Row, Id[]>(buildSql(ph)).all(...batch));
  }
  return results;
}

export function findUsages(db: Database, symbolName: string, exact: boolean, top: number): UsageResult[] {
  const definingFileIds = new Set(
    db
      .query<{ file_id: number }, [string]>(
        "SELECT file_id FROM file_exports WHERE LOWER(name) = LOWER(?)"
      )
      .all(symbolName)
      .map((r) => r.file_id)
  );

  const seen = new Set<string>();
  const results: UsageResult[] = [];

  // Primary path: bun-chunk-derived symbol_refs index. Precise — call sites
  // and reference sites only, no FTS hits inside comments or strings.
  // Exact match: name = ? (case-insensitive). Prefix match: name LIKE ?%.
  // Also match aliased call sites: a ref whose resolved_export_id points at an
  // export of this name (e.g. `import { getDB as g }; g()` → the `g` ref
  // resolves to getDB's export, so searching "getDB" finds it).
  const refRows = exact
    ? db
        .query<
          { snippet: string; file_id: number; start_line: number | null; ref_line: number; path: string },
          [string, string]
        >(
          `SELECT c.snippet, c.file_id, c.start_line, sr.line AS ref_line, f.path
           FROM symbol_refs sr
           JOIN chunks c ON c.id = sr.chunk_id
           JOIN files f ON f.id = sr.file_id
           WHERE LOWER(sr.name) = LOWER(?)
              OR sr.resolved_export_id IN (
                SELECT id FROM file_exports WHERE LOWER(name) = LOWER(?)
              )`
        )
        .all(symbolName, symbolName)
    : db
        .query<
          { snippet: string; file_id: number; start_line: number | null; ref_line: number; path: string },
          [string, string]
        >(
          `SELECT c.snippet, c.file_id, c.start_line, sr.line AS ref_line, f.path
           FROM symbol_refs sr
           JOIN chunks c ON c.id = sr.chunk_id
           JOIN files f ON f.id = sr.file_id
           WHERE LOWER(sr.name) LIKE LOWER(?) || '%'
              OR sr.resolved_export_id IN (
                SELECT id FROM file_exports WHERE LOWER(name) LIKE LOWER(?) || '%'
              )`
        )
        .all(symbolName, symbolName);

  for (const row of refRows) {
    if (definingFileIds.has(row.file_id)) continue;

    // bun-chunk emits 0-indexed file lines; chunk start_line is 1-indexed.
    // Surface the 1-indexed file line; pull the matching source line as snippet.
    const fileLine1 = row.ref_line + 1;
    const lines = row.snippet.split("\n");
    const lineIdx = row.start_line != null ? fileLine1 - row.start_line : -1;
    const matchSnippet =
      lineIdx >= 0 && lineIdx < lines.length
        ? lines[lineIdx].trim()
        : row.snippet.slice(0, 120).trim();

    const key = `${row.path}:${fileLine1}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ path: row.path, line: fileLine1, snippet: matchSnippet });
    if (results.length >= top) return results;
  }

  // Fallback: FTS + regex on chunk text. Used for files indexed before the
  // symbol_refs migration, languages without a reference query (HTML/CSS/
  // TOML/YAML), or names that don't appear in any extracted reference set
  // (e.g. dynamic dispatch, eval'd identifiers).
  let ftsRows: { id: number; snippet: string; file_id: number; chunk_index: number; start_line: number | null; path: string }[] = [];
  try {
    const ftsQuery = `"${symbolName.replace(/"/g, '""')}"`;
    ftsRows = db
      .query<
        { id: number; snippet: string; file_id: number; chunk_index: number; start_line: number | null; path: string },
        [string, number]
      >(
        `SELECT c.id, c.snippet, c.file_id, c.chunk_index, c.start_line, f.path
         FROM fts_chunks fts
         JOIN chunks c ON c.id = fts.rowid
         JOIN files f ON f.id = c.file_id
         WHERE fts_chunks MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, top * 5);
  } catch (err) {
    // A malformed/corrupt FTS query shouldn't be silent — the symbol_refs
    // results above still stand, but log why the fallback was skipped.
    log.debug(
      `findUsages FTS fallback failed for "${symbolName}": ${err instanceof Error ? err.message : err}`,
      "search",
    );
    return results;
  }

  const pattern = exact
    ? new RegExp(`\\b${escapeRegex(symbolName)}\\b`, "i")
    : new RegExp(`\\b${escapeRegex(symbolName)}`, "i");

  for (const row of ftsRows) {
    if (definingFileIds.has(row.file_id)) continue;

    const lines = row.snippet.split("\n");
    let matchOffset = -1;
    let matchSnippet = row.snippet.slice(0, 120).trim();

    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        matchOffset = i;
        matchSnippet = lines[i].trim();
        break;
      }
    }

    const line =
      row.start_line != null && matchOffset >= 0
        ? row.start_line + matchOffset
        : row.start_line;

    const key = line != null ? `${row.path}:${line}` : `${row.path}:?${results.length}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ path: row.path, line, snippet: matchSnippet });
    if (results.length >= top) break;
  }

  return results;
}
