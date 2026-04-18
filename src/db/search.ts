import { Database } from "bun:sqlite";
import { dirname, basename } from "path";
import { type SearchResult, type ChunkSearchResult, type SymbolResult, type UsageResult, type PathFilter } from "./types";
import { escapeRegex, sanitizeFTS } from "../search/usages";

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

  // Transitive reference counting: count imports targeting this file OR any
  // file that re-exports the same symbol name. This handles barrel files
  // (e.g., index.ts re-exporting types.ts symbols) correctly.
  let sql = `
    SELECT fe.name AS symbol_name, fe.type AS symbol_type, f.path,
      fe.is_reexport,
      (SELECT snippet FROM chunks
       WHERE file_id = fe.file_id AND LOWER(entity_name) = LOWER(fe.name)
       ORDER BY chunk_index LIMIT 1) AS snippet,
      (SELECT chunk_index FROM chunks
       WHERE file_id = fe.file_id AND LOWER(entity_name) = LOWER(fe.name)
       ORDER BY chunk_index LIMIT 1) AS chunk_index,
      (SELECT COUNT(*) FROM chunks c2
       WHERE c2.parent_id = (
         SELECT c1.id FROM chunks c1
         WHERE c1.file_id = fe.file_id AND LOWER(c1.entity_name) = LOWER(fe.name)
         ORDER BY c1.chunk_index LIMIT 1
       )) AS child_count,
      (SELECT COUNT(DISTINCT fi.file_id) FROM file_imports fi
       WHERE LOWER(fi.names) = LOWER(fe.name)
       AND fi.resolved_file_id IN (
         SELECT fe2.file_id FROM file_exports fe2
         WHERE LOWER(fe2.name) = LOWER(fe.name)
       )) AS reference_count,
      (SELECT GROUP_CONCAT(DISTINCT f2.path) FROM file_imports fi
       JOIN files f2 ON f2.id = fi.file_id
       WHERE LOWER(fi.names) = LOWER(fe.name)
       AND fi.resolved_file_id IN (
         SELECT fe2.file_id FROM file_exports fe2
         WHERE LOWER(fe2.name) = LOWER(fe.name)
       )) AS reference_paths
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

  return db
    .query<{
      symbol_name: string;
      symbol_type: string;
      path: string;
      snippet: string | null;
      chunk_index: number | null;
      is_reexport: number;
      child_count: number;
      reference_count: number;
      reference_paths: string | null;
    }, any[]>(sql)
    .all(...params)
    .map((r) => {
      // Compute referenceModuleCount from reference paths using directory as module proxy
      const refPaths = r.reference_paths ? r.reference_paths.split(",") : [];
      const refDirs = new Set(refPaths.map((p) => dirname(p)));
      const referenceModules = [...refDirs]
        .map((d) => basename(d))
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort();
      return {
        path: r.path,
        symbolName: r.symbol_name,
        symbolType: r.symbol_type,
        snippet: r.snippet,
        chunkIndex: r.chunk_index,
        hasChildren: r.child_count > 0,
        childCount: r.child_count,
        referenceCount: r.reference_count,
        referenceModuleCount: refDirs.size,
        referenceModules,
        isReexport: r.is_reexport === 1,
      };
    });
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

  let rows: { id: number; snippet: string; file_id: number; chunk_index: number; start_line: number | null; path: string }[] = [];
  try {
    const ftsQuery = `"${symbolName.replace(/"/g, '""')}"`;
    rows = db
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
  } catch {
    return [];
  }

  const pattern = exact
    ? new RegExp(`\\b${escapeRegex(symbolName)}\\b`, "i")
    : new RegExp(`\\b${escapeRegex(symbolName)}`, "i");

  const results: UsageResult[] = [];

  for (const row of rows) {
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

    results.push({ path: row.path, line, snippet: matchSnippet });
    if (results.length >= top) break;
  }

  return results;
}
