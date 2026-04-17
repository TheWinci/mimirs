# conversation

Persistence for indexed Claude Code transcripts. Seven functions cover the lifecycle: `upsertSession` / `updateSessionStats` track each session by Claude Code session-uuid; `insertTurn` atomically writes one `conversation_turns` row plus N `vec_conversation` + N `fts_conversation` rows in a single transaction; `searchConversation` and `textSearchConversation` are the read paths exposed through `RagDB`.

**Source:** `src/db/conversation.ts`

## Key exports

| Function | Shape | Purpose |
|---|---|---|
| `upsertSession(db, sessionId, jsonlPath, startedAt, mtime, readOffset)` | `→ void` | Creates or updates the `conversation_sessions` row; `readOffset` is the byte offset in the JSONL file at which the next tail should resume |
| `getSession(db, sessionId)` | `→ { jsonlPath, turnCount, totalTokens, readOffset, mtime } \| null` | Lookup used by `startConversationTail` to decide the offset to resume from |
| `updateSessionStats(db, sessionId, turnCount, totalTokens, readOffset)` | `→ void` | Post-index roll-up — single write after each tail tick |
| `getTurnCount(db, sessionId)` | `→ number` | Fast count for `mimirs conversation sessions` |
| `insertTurn(db, sessionId, turnIndex, timestamp, userText, assistantText, toolsUsed, filesReferenced, tokenCost, summary, chunks)` | `→ turnId (0 if duplicate)` | One transaction: `conversation_turns` row + `conversation_turn_chunks` rows + `vec_conversation` embeddings. Returns 0 if a row with the same `(sessionId, turnIndex)` already exists — idempotent by design |
| `searchConversation(db, queryEmbedding, topK=5, sessionId?)` | `→ ConversationSearchResult[]` | Vector search against `vec_conversation`; optional `sessionId` filter applied via SQL `WHERE` |
| `textSearchConversation(db, query, topK=5, sessionId?)` | `→ ConversationSearchResult[]` | FTS5 `MATCH` on `fts_conversation` |

## Usage examples

Writing — the tail-and-index loop:

```ts
// src/conversation/indexer.ts
const { entries, newOffset } = readJSONL(path, fromOffset);
for (const turn of parseTurns(entries, sessionId, startTurnIndex)) {
  const text = buildTurnText(turn);
  const { chunks } = await chunkText(text, ".md", 512, 50);
  const embeddings = await embedBatch(chunks.map(c => c.text));
  db.insertTurn(turn.sessionId, turn.turnIndex, turn.timestamp, turn.userText,
    turn.assistantText, turn.toolsUsed, turn.filesReferenced, turn.tokenCost,
    turn.summary, chunks.map((c, i) => ({ snippet: c.text, embedding: embeddings[i] })));
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

## Internals

- **`insertTurn` is idempotent by `(sessionId, turnIndex)`.** A duplicate insert returns `0` rather than throwing. The caller (`indexer.ts`) treats `0` as "already indexed, skip" so tail re-reads that overlap a previously processed range are safe.
- **Every embedding write is one transaction.** Chunks + vec rows live in the same `db.transaction(() => ...)` as the turn row — a partial index that crashes mid-batch rolls back entirely.
- **`readOffset` is a byte offset, not a turn count.** Storing bytes keeps incremental reads O(append-size) rather than O(history-length). The cost is that file rewrites (vs appends) leave the offset stale — see the [conversation module](../conversation.md) for how the tail handles that.
- **FTS is kept in sync by triggers.** `fts_conversation` has the standard `*_ai` / `*_ad` / `*_au` triggers; inserts/deletes/updates on `conversation_turn_chunks` propagate automatically.
- **`vec_conversation.embedding` dim matches `vec_chunks`.** The facade reads `getEmbeddingDim()` at schema-init time; all four vec-backed tables share the same dimension column.

## See also

- [db](index.md)
- [types](types.md)
- [files](files.md)
- [git-history](git-history.md)
- [graph](graph.md)
- [conversation](../conversation.md)
- [Architecture](../../architecture.md)
- [Data Flows](../../data-flows.md)
