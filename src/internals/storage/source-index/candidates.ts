import type { Database } from "bun:sqlite";

import type { EmbeddingIdentity } from "../../embeddings/embedder.ts";
import { SOURCE_VECTOR_TABLE } from "../schema.ts";
import type {
  NativeCandidateRow,
  NativeScoreRow,
  NativeVectorRow,
  SemanticCandidateRow,
  VectorMatchRow,
} from "../rows.ts";
import type {
  NativeCandidateOptions,
  NativeCandidateRead,
  NativeWindowCandidate,
  SemanticCandidateDiagnostics,
  SemanticCandidateRead,
  SemanticWindowCandidate,
} from "../types.ts";
import {
  cosineScore,
  embeddingBytes,
  embeddingVector,
  ftsQuery,
  nativeWindowCandidate,
  validEmbeddingIdentity,
} from "../encoding.ts";
import { tableExists } from "./database.ts";
import type { EmbeddingRepository } from "./embeddings.ts";
import type { IndexCounts } from "./counts.ts";

export class CandidateRepository {
  constructor(
    private readonly database: Database,
    private readonly embeddings: EmbeddingRepository,
    private readonly counts: IndexCounts,
  ) {}

  readSemantic(identity: EmbeddingIdentity): SemanticCandidateRead {
    validEmbeddingIdentity(identity);
    const dimensions = this.embeddings.dimensions();
    const hasVectors = dimensions !== null &&
      tableExists(this.database, SOURCE_VECTOR_TABLE);
    const diagnostics: SemanticCandidateDiagnostics = {
      total: 0,
      compatible: 0,
      missingEmbedding: 0,
      incompleteEmbedding: 0,
      incompatibleEmbedding: 0,
      malformedEmbedding: 0,
      orphaned: 0,
    };
    const rows = this.database.query<SemanticCandidateRow, []>(
      `SELECT
         w.id AS window_id,
         w.start_offset AS window_start_offset,
         w.end_offset AS window_end_offset,
         w.start_line AS window_start_line,
         w.end_line AS window_end_line,
         w.text AS window_text,
         w.text_hash AS window_text_hash,
         ${hasVectors ? "v.embedding" : "NULL"} AS embedding,
         f.path,
         c.id AS chunk_id,
         c.kind AS chunk_kind,
         c.name AS chunk_name,
         c.start_offset AS chunk_start_offset,
         c.end_offset AS chunk_end_offset,
         c.start_line AS chunk_start_line,
         c.end_line AS chunk_end_line
       FROM source_windows w
       ${hasVectors ? `LEFT JOIN ${SOURCE_VECTOR_TABLE} v ON v.window_id = w.id` : ""}
       LEFT JOIN source_chunks c ON c.id = w.source_chunk_id
       LEFT JOIN files f ON f.id = c.file_id
       ORDER BY f.path, w.start_offset, w.id`,
    ).all();
    const candidates: SemanticWindowCandidate[] = [];

    for (const row of rows) {
      if (
        row.path === null || row.chunk_id === null || row.chunk_kind === null ||
        row.chunk_start_offset === null || row.chunk_end_offset === null ||
        row.chunk_start_line === null || row.chunk_end_line === null
      ) {
        diagnostics.total++;
        diagnostics.orphaned++;
        continue;
      }
      diagnostics.total++;
      if (row.embedding === null) {
        diagnostics.missingEmbedding++;
        continue;
      }
      if (dimensions !== identity.dimensions) {
        diagnostics.incompatibleEmbedding++;
        continue;
      }

      let vector: Float32Array;
      try {
        vector = embeddingVector(row.embedding, dimensions);
      } catch {
        diagnostics.malformedEmbedding++;
        continue;
      }
      if (vector.some((value) => !Number.isFinite(value))) {
        diagnostics.malformedEmbedding++;
        continue;
      }

      candidates.push({
        id: row.window_id,
        path: row.path,
        text: row.window_text,
        textHash: row.window_text_hash,
        startOffset: row.window_start_offset,
        endOffset: row.window_end_offset,
        startLine: row.window_start_line,
        endLine: row.window_end_line,
        sourceChunk: {
          id: row.chunk_id,
          kind: row.chunk_kind,
          name: row.chunk_name,
          startOffset: row.chunk_start_offset,
          endOffset: row.chunk_end_offset,
          startLine: row.chunk_start_line,
          endLine: row.chunk_end_line,
        },
        vector,
      });
      diagnostics.compatible++;
    }
    return { candidates, diagnostics };
  }

  readNative(
    identity: EmbeddingIdentity,
    queryVector: Float32Array | null,
    query: string,
    limit: number,
    options: NativeCandidateOptions = {},
  ): NativeCandidateRead {
    validEmbeddingIdentity(identity);
    validateNativeRequest(identity, queryVector, limit, options);
    const semanticLimit = options.semanticLimit ?? limit;
    const vector = queryVector === null ? null : embeddingBytes(queryVector);
    const citation = `
      w.id AS window_id,
      f.path,
      w.text AS window_text,
      w.start_offset AS window_start_offset,
      w.end_offset AS window_end_offset,
      w.start_line AS window_start_line,
      w.end_line AS window_end_line,
      c.id AS chunk_id,
      c.kind AS chunk_kind,
      c.name AS chunk_name,
      c.start_offset AS chunk_start_offset,
      c.end_offset AS chunk_end_offset,
      c.start_line AS chunk_start_line,
      c.end_line AS chunk_end_line`;
    let semantic: NativeWindowCandidate[] = [];
    let unscorableCandidates = 0;
    const dimensions = this.embeddings.dimensions();
    const hasVectorTable = dimensions !== null &&
      tableExists(this.database, SOURCE_VECTOR_TABLE);
    const vectorCount = hasVectorTable
      ? this.embeddings.countVectors()
      : 0;
    const total = this.counts.windows();
    const diagnostics: SemanticCandidateDiagnostics = {
      total,
      compatible: vectorCount,
      missingEmbedding: Math.max(0, total - vectorCount),
      incompleteEmbedding: 0,
      incompatibleEmbedding: 0,
      malformedEmbedding: 0,
      orphaned: 0,
    };
    if (vector !== null && vectorCount > 0 && hasVectorTable) {
      const nearestRows = this.database.query<VectorMatchRow, [Uint8Array, number]>(
        `SELECT window_id, distance
         FROM ${SOURCE_VECTOR_TABLE}
         WHERE embedding MATCH ? AND k = ?`,
      ).all(vector, semanticLimit);
      unscorableCandidates = nearestRows.filter((row) => row.distance === null).length;
      const nearest = nearestRows.filter((row) => row.distance !== null);
      const distances = new Map(
        nearest.map((row) => [row.window_id, row.distance!]),
      );
      if (nearest.length > 0) {
        semantic = this.database.query<NativeCandidateRow, [string]>(
          `SELECT ${citation}, 0.0 AS semantic_score, 0.0 AS lexical_score
           FROM source_windows w
           JOIN source_chunks c ON c.id = w.source_chunk_id
           JOIN files f ON f.id = c.file_id
           WHERE w.id IN (SELECT value FROM json_each(?))`,
        ).all(JSON.stringify(nearest.map((row) => row.window_id))).map((row) => ({
          ...nativeWindowCandidate(row),
          semanticScore: 1 - distances.get(row.window_id)!,
        })).sort(compareSemantic);
      }
    }

    const lexicalMode = options.lexicalMode ?? "current";
    const baseMatch = ftsQuery(query, lexicalMode);
    const match = baseMatch !== null && lexicalMode === "text-only"
      ? `text : (${baseMatch})`
      : baseMatch;
    let lexical: NativeWindowCandidate[] = [];
    if (match !== null) {
      const table = lexicalMode === "v1-like"
        ? "source_windows_fts_v1"
        : "source_windows_fts";
      const weights = lexicalMode === "current"
        ? ", 2.0, 3.0, 1.0"
        : lexicalMode === "text-only" ? ", 0.0, 0.0, 1.0" : "";
      lexical = this.database.query<NativeCandidateRow, any[]>(
        `SELECT ${citation}, 0.0 AS semantic_score,
                -bm25(${table}${weights}) AS lexical_score
         FROM ${table}
         JOIN source_windows w ON w.id = ${table}.rowid
         JOIN source_chunks c ON c.id = w.source_chunk_id
         JOIN files f ON f.id = c.file_id
         WHERE ${table} MATCH ?
         ORDER BY bm25(${table}${weights}), f.path, w.start_offset, w.id
         LIMIT ?`,
      ).all(match, limit).map(nativeWindowCandidate);
    }
    const baselineSemantic = semantic;
    const baselineLexical = lexical;
    const completed = this.completeMissingScores(
      identity,
      queryVector,
      match,
      lexicalMode,
      semantic,
      lexical,
      options,
    );
    semantic = completed.semantic;
    lexical = completed.lexical;
    return {
      diagnostics,
      baselineSemantic,
      baselineLexical,
      semantic,
      lexical,
      unscorableCandidates,
      lexicalCandidates: lexical.length,
    };
  }

  uniqueNamedChunkIds(names: readonly string[]): Set<number> {
    const normalizedNames = [...new Set(names)].filter(Boolean);
    if (normalizedNames.length === 0) return new Set();
    const rows = this.database.query<{
      chunk_id: number;
      name: string;
      path: string;
    }, [string]>(
      `SELECT c.id AS chunk_id, lower(c.name) AS name, f.path
       FROM source_chunks c
       JOIN files f ON f.id = c.file_id
       WHERE c.name IS NOT NULL
         AND c.name COLLATE NOCASE IN (SELECT value FROM json_each(?))
       ORDER BY c.name COLLATE NOCASE, f.path, c.start_offset, c.id`,
    ).all(JSON.stringify(normalizedNames));
    const pathsByName = new Map<string, Set<string>>();
    for (const row of rows) {
      const paths = pathsByName.get(row.name) ?? new Set<string>();
      paths.add(row.path);
      pathsByName.set(row.name, paths);
    }
    return new Set(rows.filter((row) =>
      pathsByName.get(row.name)?.size === 1
    ).map((row) => row.chunk_id));
  }

  private completeMissingScores(
    identity: EmbeddingIdentity,
    queryVector: Float32Array | null,
    match: string | null,
    lexicalMode: NativeCandidateOptions["lexicalMode"],
    semantic: NativeWindowCandidate[],
    lexical: NativeWindowCandidate[],
    options: NativeCandidateOptions,
  ): { semantic: NativeWindowCandidate[]; lexical: NativeWindowCandidate[] } {
    const completeSemantic = options.completeMissingScores === true ||
      options.completeMissingSemanticScores === true;
    const completeLexical = options.completeMissingScores === true ||
      options.completeMissingLexicalScores === true;
    if ((!completeSemantic && !completeLexical) || queryVector === null) {
      return { semantic, lexical };
    }
    const candidates = new Map<number, NativeWindowCandidate>();
    const semanticScores = new Map<number, number>();
    const lexicalScores = new Map<number, number>();
    for (const candidate of semantic) {
      candidates.set(candidate.id, candidate);
      semanticScores.set(candidate.id, candidate.semanticScore);
    }
    for (const candidate of lexical) {
      const existing = candidates.get(candidate.id);
      candidates.set(candidate.id, existing
        ? { ...existing, lexicalScore: candidate.lexicalScore }
        : candidate);
      lexicalScores.set(candidate.id, candidate.lexicalScore);
    }

    const missingSemantic = completeSemantic
      ? [...lexicalScores.keys()].filter((id) => !semanticScores.has(id))
      : [];
    if (missingSemantic.length > 0) {
      const readVector = this.database.query<NativeVectorRow, [number]>(
        `SELECT window_id, embedding
         FROM ${SOURCE_VECTOR_TABLE}
         WHERE window_id = ?`,
      );
      for (const id of missingSemantic) {
        const row = readVector.get(id);
        if (row === null) continue;
        const score = cosineScore(
          queryVector,
          embeddingVector(row.embedding, identity.dimensions),
        );
        if (score !== null && Number.isFinite(score)) {
          semanticScores.set(row.window_id, score);
        }
      }
    }

    const missingLexical = completeLexical
      ? [...semanticScores.keys()].filter((id) => !lexicalScores.has(id))
      : [];
    if (match !== null && missingLexical.length > 0) {
      const table = lexicalMode === "v1-like"
        ? "source_windows_fts_v1"
        : "source_windows_fts";
      const weights = lexicalMode === "current"
        ? ", 2.0, 3.0, 1.0"
        : lexicalMode === "text-only" ? ", 0.0, 0.0, 1.0" : "";
      const rows = this.database.query<NativeScoreRow, [string, string]>(
        `SELECT rowid AS window_id, -bm25(${table}${weights}) AS score
         FROM ${table}
         WHERE ${table} MATCH ?
           AND rowid IN (SELECT value FROM json_each(?))`,
      ).all(match, JSON.stringify(missingLexical));
      for (const row of rows) {
        if (row.score !== null && Number.isFinite(row.score)) {
          lexicalScores.set(row.window_id, row.score);
        }
      }
    }

    semantic = [...semanticScores.keys()].map((id) => ({
      ...candidates.get(id)!,
      semanticScore: semanticScores.get(id)!,
      lexicalScore: lexicalScores.get(id) ?? 0,
    })).sort((left, right) =>
      semanticScores.get(right.id)! - semanticScores.get(left.id)! ||
      comparePosition(left, right)
    );
    lexical = [...lexicalScores.keys()].map((id) => ({
      ...candidates.get(id)!,
      semanticScore: semanticScores.get(id) ?? 0,
      lexicalScore: lexicalScores.get(id)!,
    })).sort((left, right) =>
      lexicalScores.get(right.id)! - lexicalScores.get(left.id)! ||
      comparePosition(left, right)
    );
    return { semantic, lexical };
  }
}

function validateNativeRequest(
  identity: EmbeddingIdentity,
  queryVector: Float32Array | null,
  limit: number,
  options: NativeCandidateOptions,
): void {
  if (queryVector !== null && !(queryVector instanceof Float32Array)) {
    throw new TypeError("native query vector is not a Float32Array");
  }
  if (queryVector !== null && queryVector.length !== identity.dimensions) {
    throw new Error(
      `native query vector has ${queryVector.length} dimensions; ` +
        `expected ${identity.dimensions}`,
    );
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("native candidate limit must be a positive integer");
  }
  const semanticLimit = options.semanticLimit ?? limit;
  if (!Number.isSafeInteger(semanticLimit) || semanticLimit <= 0) {
    throw new RangeError(
      "native semantic candidate limit must be a positive integer",
    );
  }
}

function compareSemantic(
  left: NativeWindowCandidate,
  right: NativeWindowCandidate,
): number {
  return right.semanticScore - left.semanticScore ||
    comparePosition(left, right);
}

function comparePosition(
  left: NativeWindowCandidate,
  right: NativeWindowCandidate,
): number {
  return left.path.localeCompare(right.path) ||
    left.startOffset - right.startOffset ||
    left.id - right.id;
}
