CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE
);

CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    text TEXT NOT NULL,
    byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
    byte_end INTEGER NOT NULL CHECK (byte_end >= byte_start),
    line_start INTEGER NOT NULL CHECK (line_start >= 1),
    line_end INTEGER NOT NULL CHECK (line_end >= line_start),
    UNIQUE (file_id, ordinal)
);

CREATE TABLE windows (
    id INTEGER PRIMARY KEY,
    chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    text TEXT NOT NULL,
    UNIQUE (chunk_id, ordinal)
);

CREATE TABLE index_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE VIRTUAL TABLE window_embeddings USING vec0(
    window_id INTEGER PRIMARY KEY,
    embedding FLOAT[384] distance_metric=cosine
);

CREATE TABLE source_snapshots (
    file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    analysis_version TEXT NOT NULL,
    source TEXT NOT NULL
);

CREATE TABLE entities (
    file_id INTEGER NOT NULL REFERENCES source_snapshots(file_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL,
    name TEXT,
    byte_start INTEGER NOT NULL,
    byte_end INTEGER NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    parent INTEGER,
    PRIMARY KEY (file_id, ordinal),
    FOREIGN KEY (file_id, parent) REFERENCES entities(file_id, ordinal)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE analysis_records (
    file_id INTEGER PRIMARY KEY REFERENCES source_snapshots(file_id) ON DELETE CASCADE,
    payload TEXT NOT NULL
);
