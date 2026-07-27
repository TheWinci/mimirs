import type { Database } from "bun:sqlite";

/**
 * This version also governs the global embedding space. Any change to the
 * model, revision, projection, normalization, or dimensions must bump it and
 * add a migration that drops the vector table.
 */
export const SOURCE_INDEX_SCHEMA_VERSION = 12;
export const SOURCE_VECTOR_TABLE = "source_window_vectors";
export const SOURCE_PROJECTION_VERSION_TABLE = "source_projection_versions";
export const SOURCE_EMBEDDING_INPUT_TABLE = "source_window_embedding_inputs";
export const SOURCE_EMBEDDING_DIRTY_GROUP_TABLE =
  "source_embedding_dirty_groups";
export const SOURCE_EMBEDDING_POLICY_TABLE = "source_embedding_input_policy";

const SOURCE_STRUCTURE_SCHEMA = `
  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    language TEXT,
    strategy TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    analysis_version INTEGER NOT NULL CHECK (analysis_version >= 1),
    window_target INTEGER NOT NULL CHECK (window_target >= 1),
    opaque TEXT
  );

  CREATE TABLE source_chunks (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES source_chunks(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind <> 'gap'),
    name TEXT,
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
    start_line INTEGER NOT NULL CHECK (start_line >= 1),
    end_line INTEGER NOT NULL CHECK (end_line >= start_line)
  );

  CREATE UNIQUE INDEX source_chunks_root_order
    ON source_chunks(file_id, ordinal)
    WHERE parent_id IS NULL;

  CREATE UNIQUE INDEX source_chunks_child_order
    ON source_chunks(parent_id, ordinal)
    WHERE parent_id IS NOT NULL;

  CREATE INDEX source_chunks_file_range
    ON source_chunks(file_id, start_offset, end_offset);

  CREATE TABLE source_windows (
    id INTEGER PRIMARY KEY,
    source_chunk_id INTEGER NOT NULL
      REFERENCES source_chunks(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
    start_line INTEGER NOT NULL CHECK (start_line >= 1),
    end_line INTEGER NOT NULL CHECK (end_line >= start_line),
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    UNIQUE(source_chunk_id, ordinal)
  );

  CREATE INDEX source_windows_range
    ON source_windows(source_chunk_id, start_offset, end_offset);
`;

const SOURCE_FACTS_SCHEMA = `
  CREATE TABLE source_facts (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    owner_chunk_id INTEGER REFERENCES source_chunks(id) ON DELETE CASCADE,
    target_chunk_id INTEGER REFERENCES source_chunks(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('import', 'export', 'call')),
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
    start_line INTEGER NOT NULL CHECK (start_line >= 1),
    end_line INTEGER NOT NULL CHECK (end_line >= start_line),
    source TEXT,
    imported TEXT,
    local TEXT,
    type_only INTEGER CHECK (type_only IN (0, 1)),
    static INTEGER CHECK (static IN (0, 1)),
    global INTEGER CHECK (global IN (0, 1)),
    exported TEXT,
    callee TEXT,
    binding TEXT CHECK (
      binding IN ('source-chunk', 'import', 'local', 'unknown')
    ),
    UNIQUE(file_id, ordinal)
  );

  CREATE INDEX source_facts_file_kind
    ON source_facts(file_id, kind, start_offset);

  CREATE INDEX source_facts_owner
    ON source_facts(owner_chunk_id)
    WHERE owner_chunk_id IS NOT NULL;
`;

const SOURCE_EMBEDDING_COLUMNS = [
  ["embedding_model", "TEXT"],
  ["embedding_revision", "TEXT"],
  ["embedding_variant", "TEXT"],
  [
    "embedding_dimensions",
    "INTEGER CHECK (embedding_dimensions IS NULL OR embedding_dimensions >= 1)",
  ],
  ["embedding", "BLOB"],
] as const;

const SOURCE_SEARCH_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS source_windows_fts USING fts5(
    path,
    chunk_name,
    text,
    content = '',
    contentless_delete = 1,
    tokenize = 'unicode61'
  );
`;

const SOURCE_PROJECTION_VERSION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${SOURCE_PROJECTION_VERSION_TABLE} (
    name TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1)
  );
`;

const SOURCE_CHUNK_NAME_SCHEMA = `
  CREATE INDEX IF NOT EXISTS source_chunks_name_nocase
    ON source_chunks(name COLLATE NOCASE)
    WHERE name IS NOT NULL;
`;

const SOURCE_VECTOR_SPACE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS source_vector_space (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    dimensions INTEGER NOT NULL CHECK (dimensions >= 1)
  );
`;

const SOURCE_EMBEDDING_INPUT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${SOURCE_EMBEDDING_INPUT_TABLE} (
    window_id INTEGER PRIMARY KEY
      REFERENCES source_windows(id) ON DELETE CASCADE,
    base_input_hash TEXT NOT NULL,
    effective_input_hash TEXT NOT NULL,
    path_disambiguated INTEGER NOT NULL
      CHECK (path_disambiguated IN (0, 1))
  );

  CREATE INDEX IF NOT EXISTS source_embedding_inputs_base_hash
    ON ${SOURCE_EMBEDDING_INPUT_TABLE}(base_input_hash);

  CREATE TABLE IF NOT EXISTS ${SOURCE_EMBEDDING_DIRTY_GROUP_TABLE} (
    base_input_hash TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS ${SOURCE_EMBEDDING_POLICY_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    identity TEXT NOT NULL
  );
`;

const SOURCE_WINDOWS_WITHOUT_INLINE_EMBEDDINGS = `
  CREATE TABLE source_windows_v5 (
    id INTEGER PRIMARY KEY,
    source_chunk_id INTEGER NOT NULL
      REFERENCES source_chunks(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
    start_line INTEGER NOT NULL CHECK (start_line >= 1),
    end_line INTEGER NOT NULL CHECK (end_line >= start_line),
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    UNIQUE(source_chunk_id, ordinal)
  );
`;

interface UserVersionRow {
  user_version: number;
}

interface TableColumnRow {
  name: string;
}

interface EmbeddingDimensionRow {
  dimensions: number;
}

interface InlineEmbeddingRow {
  window_id: number;
  embedding: Uint8Array;
}

function migrateSourceEmbeddings(database: Database): void {
  const existing = new Set(
    database.query<TableColumnRow, []>("PRAGMA table_info(source_windows)")
      .all().map((column) => column.name),
  );
  for (const [name, type] of SOURCE_EMBEDDING_COLUMNS) {
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE source_windows ADD COLUMN ${name} ${type}`);
    }
  }
}

function embeddingBytesAreFinite(bytes: Uint8Array, dimensions: number): boolean {
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    return false;
  }
  const copy = bytes.slice();
  const vector = new Float32Array(copy.buffer, copy.byteOffset, dimensions);
  return !vector.some((value) => !Number.isFinite(value));
}

/** Create the sole persisted vector store for one fixed-dimensional space. */
export function createSourceVectorTable(
  database: Database,
  dimensions: number,
): void {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new RangeError("source vector dimensions must be a positive integer");
  }
  database.exec(`
    CREATE VIRTUAL TABLE ${SOURCE_VECTOR_TABLE} USING vec0(
      window_id INTEGER PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine
    );
  `);
  database.query(
    `INSERT INTO source_vector_space(id, dimensions) VALUES (1, ?)`,
  ).run(dimensions);
}

function migrateSourceVectors(database: Database): void {
  database.exec(SOURCE_VECTOR_SPACE_SCHEMA);
  const existing = new Set(
    database.query<TableColumnRow, []>("PRAGMA table_info(source_windows)")
      .all().map((column) => column.name),
  );
  if (!existing.has("embedding")) return;

  const selected = database.query<EmbeddingDimensionRow, []>(
    `SELECT embedding_dimensions AS dimensions
     FROM source_windows
     WHERE embedding IS NOT NULL
       AND embedding_model IS NOT NULL
       AND embedding_revision IS NOT NULL
       AND embedding_variant IS NOT NULL
       AND embedding_dimensions IS NOT NULL
       AND embedding_dimensions >= 1
       AND length(embedding) = embedding_dimensions * 4
     GROUP BY embedding_dimensions
     ORDER BY count(*) DESC, embedding_dimensions DESC
     LIMIT 1`,
  ).get();
  const inline = selected
    ? database.query<InlineEmbeddingRow, [number]>(
        `SELECT w.id AS window_id, w.embedding
         FROM source_windows w
         WHERE w.embedding_dimensions = ?
           AND w.embedding IS NOT NULL
           AND w.embedding_model IS NOT NULL
           AND w.embedding_revision IS NOT NULL
           AND w.embedding_variant IS NOT NULL
           AND length(w.embedding) = w.embedding_dimensions * 4
         ORDER BY w.id`,
      ).all(selected.dimensions)
    : [];

  database.exec(SOURCE_WINDOWS_WITHOUT_INLINE_EMBEDDINGS);
  database.exec(`
    INSERT INTO source_windows_v5
      (id, source_chunk_id, ordinal, start_offset, end_offset,
       start_line, end_line, text, text_hash)
    SELECT id, source_chunk_id, ordinal, start_offset, end_offset,
           start_line, end_line, text, text_hash
    FROM source_windows;
    DROP TABLE source_windows;
    ALTER TABLE source_windows_v5 RENAME TO source_windows;
    CREATE INDEX source_windows_range
      ON source_windows(source_chunk_id, start_offset, end_offset);
  `);

  if (!selected) return;
  createSourceVectorTable(database, selected.dimensions);
  const insert = database.query(
    `INSERT INTO ${SOURCE_VECTOR_TABLE}
       (window_id, embedding)
     VALUES (?, ?)`,
  );
  for (const row of inline) {
    if (!embeddingBytesAreFinite(row.embedding, selected.dimensions)) continue;
    insert.run(
      row.window_id,
      row.embedding,
    );
  }
}

/** Convert a published v7/v8 path view into the v9 physical file boundary. */
function retireActivePathProjection(database: Database): void {
  const activeTable = database.query<{ present: number }, []>(
    `SELECT 1 AS present FROM sqlite_master
     WHERE type = 'table' AND name = 'source_active_paths'`,
  ).get();
  if (!activeTable) return;

  const activePaths = database.query<{ count: number }, []>(
    "SELECT count(*) AS count FROM source_active_paths",
  ).get()?.count ?? 0;
  const vectorTable = database.query<{ present: number }, [string]>(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(SOURCE_VECTOR_TABLE) !== null;
  const vectorColumns = vectorTable
    ? new Set(database.query<TableColumnRow, []>(
        `PRAGMA table_info(${SOURCE_VECTOR_TABLE})`,
      ).all().map((column) => column.name))
    : new Set<string>();
  const hasInactiveVectors = vectorColumns.has("active") &&
    (database.query<{ count: number }, []>(
      `SELECT count(*) AS count FROM ${SOURCE_VECTOR_TABLE} WHERE active = 0`,
    ).get()?.count ?? 0) > 0;

  // An empty projection is ambiguous for programmatic v8 indexes that never
  // completed a project refresh. Preserve those unless inactive vectors prove
  // that the empty set was deliberately published.
  if (activePaths > 0 || hasInactiveVectors) {
    database.exec(`
      DELETE FROM source_windows_fts
      WHERE rowid IN (
        SELECT w.id
        FROM source_windows w
        JOIN source_chunks c ON c.id = w.source_chunk_id
        JOIN files f ON f.id = c.file_id
        WHERE f.path NOT IN (SELECT path FROM source_active_paths)
      );
    `);
    if (vectorTable) {
      database.exec(`
        DELETE FROM ${SOURCE_VECTOR_TABLE}
        WHERE window_id IN (
          SELECT w.id
          FROM source_windows w
          JOIN source_chunks c ON c.id = w.source_chunk_id
          JOIN files f ON f.id = c.file_id
          WHERE f.path NOT IN (SELECT path FROM source_active_paths)
        );
      `);
    }
    database.exec(`
      DELETE FROM files
      WHERE path NOT IN (SELECT path FROM source_active_paths);
    `);
  }
  database.exec("DROP TABLE source_active_paths");
}

/** Rebuild legacy vec0 storage without repeated global/path metadata. */
function migrateMinimalVectorTable(database: Database): void {
  const vectorTable = database.query<{ present: number }, [string]>(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(SOURCE_VECTOR_TABLE);
  if (!vectorTable) return;
  const columns = database.query<TableColumnRow, []>(
    `PRAGMA table_info(${SOURCE_VECTOR_TABLE})`,
  ).all().map((column) => column.name);
  if (columns.length === 2 && columns.includes("window_id") &&
    columns.includes("embedding")) return;
  const dimensions = database.query<EmbeddingDimensionRow, []>(
    "SELECT dimensions FROM source_vector_space WHERE id = 1",
  ).get()?.dimensions;
  if (!dimensions) throw new Error("source vector table has no dimensional metadata");
  const rows = database.query<{ window_id: number; embedding: Uint8Array }, []>(
    `SELECT window_id, embedding FROM ${SOURCE_VECTOR_TABLE} ORDER BY window_id`,
  ).all();
  database.exec(`DROP TABLE ${SOURCE_VECTOR_TABLE}`);
  database.exec("DELETE FROM source_vector_space");
  createSourceVectorTable(database, dimensions);
  const insert = database.query(
    `INSERT INTO ${SOURCE_VECTOR_TABLE}(window_id, embedding) VALUES (?, ?)`,
  );
  for (const row of rows) insert.run(row.window_id, row.embedding);
}

/** Initialize the source index and reject databases created by newer code. */
export function migrateSourceIndex(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  const row = database.query<UserVersionRow, []>("PRAGMA user_version").get();
  const version = row?.user_version ?? 0;

  if (version > SOURCE_INDEX_SCHEMA_VERSION) {
    throw new Error(
      `source index schema ${version} is newer than supported version ` +
        SOURCE_INDEX_SCHEMA_VERSION,
    );
  }
  if (version === SOURCE_INDEX_SCHEMA_VERSION) return;

  database.transaction(() => {
    if (version < 1) database.exec(SOURCE_STRUCTURE_SCHEMA);
    if (version < 2) database.exec(SOURCE_FACTS_SCHEMA);
    if (version < 3) migrateSourceEmbeddings(database);
    if (version < 4) database.exec(SOURCE_SEARCH_SCHEMA);
    if (version < 5) migrateSourceVectors(database);
    if (version < 8) database.exec(SOURCE_CHUNK_NAME_SCHEMA);
    if (version < 9) retireActivePathProjection(database);
    if (version < 10) migrateMinimalVectorTable(database);
    if (version < 11) database.exec(SOURCE_EMBEDDING_INPUT_SCHEMA);
    database.exec(SOURCE_PROJECTION_VERSION_SCHEMA);
    database.exec(`DELETE FROM ${SOURCE_PROJECTION_VERSION_TABLE}`);
    database.exec(`PRAGMA user_version = ${SOURCE_INDEX_SCHEMA_VERSION}`);
  }).immediate();
}
