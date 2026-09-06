CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE
);

CREATE TABLE index_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

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

CREATE TABLE retrieval_documents (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES source_snapshots(file_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    owner INTEGER,
    source_chunk INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('entity', 'file')),
    part INTEGER NOT NULL CHECK (part >= 0),
    policy TEXT NOT NULL,
    text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    evidence TEXT NOT NULL,
    UNIQUE (file_id, ordinal),
    FOREIGN KEY (file_id, owner) REFERENCES entities(file_id, ordinal),
    FOREIGN KEY (file_id, source_chunk) REFERENCES source_chunks(file_id, ordinal)
);

CREATE VIRTUAL TABLE document_embeddings USING vec0(
    document_id INTEGER PRIMARY KEY,
    embedding FLOAT[384] distance_metric=cosine
);

CREATE TABLE retrieval_processing (
    file_id INTEGER PRIMARY KEY REFERENCES source_snapshots(file_id) ON DELETE CASCADE,
    policy TEXT NOT NULL,
    document_count INTEGER NOT NULL CHECK (document_count >= 0)
);

CREATE VIRTUAL TABLE document_fts USING fts5(
    path,
    chunk_name,
    text,
    content = '',
    contentless_delete = 1,
    tokenize = 'unicode61'
);

CREATE TRIGGER delete_document_fts AFTER DELETE ON retrieval_documents BEGIN
    DELETE FROM document_fts WHERE rowid = old.id;
END;

CREATE TABLE source_chunks (
    file_id INTEGER NOT NULL REFERENCES source_snapshots(file_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL,
    name TEXT,
    byte_start INTEGER NOT NULL,
    byte_end INTEGER NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    parent INTEGER,
    owner INTEGER,
    PRIMARY KEY (file_id, ordinal),
    FOREIGN KEY (file_id, parent) REFERENCES source_chunks(file_id, ordinal)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (file_id, owner) REFERENCES entities(file_id, ordinal)
);
