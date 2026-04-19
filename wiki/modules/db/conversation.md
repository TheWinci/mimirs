# conversation

Persistence for indexed Claude Code transcripts. Seven functions cover the lifecycle: `upsertSession` / `getSession` / `updateSessionStats` / `getTurnCount` track each session by Claude Code session-uuid; `insertTurn` atomically writes one `conversation_turns` row plus N `conversation_chunks` + N `vec_conversation` rows in a single transaction; `searchConversation` and `textSearchConversation` are the read paths exposed through `RagDB`.

**Source:** `src/db/conversation.ts`

## Public API

```ts
function upsertSession(
  db: Database,
  sessionId: string,
  jsonlPath: string,
  startedAt: string,
  mtime: number,
  readOffset: number
): void;

function getSession(
  db: Database,
  sessionId: string
): {
  id: number;
  sessionId: string;
  jsonlPath: string;
  mtime: number;
  readOffset: number;
  turnCount: number;
} | null;

function updateSessionStats(
  db: Database,
  sessionId: string,
  turnCount: number,
  totalTokens: number,
  readOffset: number
): void;

function getTurnCount(db: Database, sessionId: string): number;

function insertTurn(
  db: Database,
  sessionId: string,
  turnIndex: number,
  timestamp: string,
  userText: string,
  assistantText: string,
  toolsUsed: string[],
  filesReferenced: string[],
  tokenCost: number,
  summary: string,
  chunks: { snippet: string; embedding: Float32Array }[]
): number; // 0 if (sessionId, turnIndex) already existed

function searchConversation(
  db: Database,
  queryEmbedding: Float32Array,
  topK?: number,
  sessionId?: string
): ConversationSearchResult[];

function textSearchConversation(
  db: Database,
  query: string,
  topK?: number,
  sessionId?: string
): ConversationSearchResult[];
```

## Row shapes

Four tables back these functions:

- **`conversation_sessions(id, session_id, jsonl_path, started_at, indexed_at, file_mtime, read_offset, turn_count, total_tokens)`** — unique on `session_id`. `read_offset` is the byte offset in the JSONL file at which the next tail should resume; `file_mtime` lets the watcher detect truncation/rewrite.
- **`conversation_turns(id, session_id, turn_index, timestamp, user_text, assistant_text, tools_used, files_referenced, token_cost, summary)`** — one row per parsed turn. Unique on `(session_id, turn_index)` — that's what makes `insertTurn` idempotent via `INSERT OR IGNORE`. `tools_used` and `files_referenced` are JSON arrays.
- **`conversation_chunks(id, turn_id, chunk_index, snippet)`** — chunked transcript text. One row per embeddable segment; multiple per turn.
- **`vec_conversation(chunk_id, embedding)`** — vec0 table, `embedding FLOAT[getEmbeddingDim()]`, matched against query embeddings.
- **`fts_conversation`** — FTS5 mirror of `conversation_chunks.snippet`; kept in sync via triggers.

## Usage

Writing — the tail-and-index loop:

```ts
// src/conversation/indexer.ts
const { entries, newOffset } = readJSONL(path, fromOffset);
for (const turn of parseTurns(entries, sessionId, startTurnIndex)) {
  const text = buildTurnText(turn);
  const { chunks } = await chunkText(text, ".md", 512, 50);
  const embeddings = await embedBatch(chunks.map((c) => c.text));
  const turnId = db.insertTurn(
    turn.sessionId,
    turn.turnIndex,
    turn.timestamp,
    turn.userText,
    turn.assistantText,
    turn.toolsUsed,
    turn.filesReferenced,
    turn.tokenCost,
    turn.summary,
    chunks.map((c, i) => ({ snippet: c.text, embedding: embeddings[i] }))
  );
  if (turnId === 0) continue; // already indexed
}
db.upsertSession(sessionId, path, firstTimestamp, stat.mtimeMs, newOffset);
db.updateSessionStats(sessionId, totalTurns, totalTokens, newOffset);
```

Reading — the MCP `search_conversation` tool:

```ts
// src/tools/conversation-tools.ts
const queryEmbedding = await embed(query);
const hits = db.searchConversation(queryEmbedding, topK, sessionId);
```

## Dependencies

| Direction | Target | Notes |
|---|---|---|
| Imports | `bun:sqlite` | `Database` parameter from the facade |
| Imports | `./types.ConversationSearchResult` | Read-side row shape |
| Imports | `../search/usages.sanitizeFTS` | FTS5 token quoting for `textSearchConversation` |

## Internals

- **`insertTurn` is idempotent by `(sessionId, turnIndex)`.** A duplicate insert returns `0` rather than throwing. The caller (`src/conversation/indexer.ts`) treats `0` as "already indexed, skip" so tail re-reads that overlap a previously processed range are safe.
- **Every embedding write is one transaction.** The turn row, N `conversation_chunks` rows, and N `vec_conversation` rows live in the same `db.transaction(() => ...)` — a partial index that crashes mid-batch rolls back entirely. Nothing is written if `INSERT OR IGNORE` skipped the turn.
- **`readOffset` is a byte offset, not a turn count.** Storing bytes keeps incremental reads O(append-size) rather than O(history-length). The cost is that file rewrites (vs appends) leave the offset stale — see the [conversation module](../conversation.md) for how the tail handles that.
- **Search results are per-turn, not per-chunk.** Both `searchConversation` and `textSearchConversation` track `seenTurns` and skip duplicates so a turn whose chunks all match highly shows once, with its highest-scoring chunk's snippet. The initial fetch over-samples (`topK * 3` normally, `topK * 10` when `sessionId` is set) to survive the per-turn dedupe and the session filter.
- **Session filter is applied in JS, not SQL.** The inner vec/FTS query doesn't know about the session; the consumer loop checks `row.session_id !== sessionId` after dedupe. This is why the oversample factor is higher with a session filter.
- **`upsertSession` uses `ON CONFLICT(session_id) DO UPDATE`.** Only `file_mtime`, `indexed_at`, and `read_offset` are refreshed on conflict — `started_at` and `jsonl_path` stay put.
- **FTS stays in sync by triggers.** `fts_conversation` has the standard `*_ai` / `*_ad` / `*_au` triggers on `conversation_chunks`; no code path writes to FTS directly.
- **`vec_conversation.embedding` dim matches `vec_chunks`.** The facade reads `getEmbeddingDim()` at schema-init time; all vec-backed tables share the same dimension column.

## See also

- [db](index.md)
- [types](types.md)
- [files](files.md)
- [git-history](git-history.md)
- [graph](graph.md)
- [conversation](../conversation.md)
- [Architecture](../../architecture.md)
- [Data Flows](../../data-flows.md)
