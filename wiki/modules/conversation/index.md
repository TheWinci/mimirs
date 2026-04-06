# Conversation Module

The Conversation module (`src/conversation/`) parses and indexes Claude Code
conversation history from JSONL log files. It enables semantic search over
past sessions, allowing the AI agent to recall previous discussions and
decisions.

## Structure

```mermaid
flowchart TD
  parser["parser.ts — JSONL parsing"]
  indexer["indexer.ts — embedding & storage"]

  parser -->|ParsedTurn| indexer
  indexer -->|chunks + embeddings| dbMod["DB"]
```

## Files

### `parser.ts` -- JSONL Log Parsing

Parses Claude Code's JSONL conversation logs into structured data. Exports:

- **`readJSONL(path, fromOffset)`** -- Reads a JSONL file, optionally starting
  from a byte offset for incremental reads.
- **`parseTurns(entries, sessionId, startIndex)`** -- Converts raw journal
  entries into `ParsedTurn` objects, grouping by conversation turn.
- **`buildTurnText(turn)`** -- Renders a `ParsedTurn` into plain text suitable
  for embedding.
- **`discoverSessions(projectDir)`** -- Scans the Claude Code data directory
  to find all available session JSONL files.

#### Types

| Type | Description |
|------|-------------|
| `JournalEntry` | Raw JSONL log entry |
| `ContentBlock` | Individual content block within an entry |
| `ParsedTurn` | A complete conversation turn (user or assistant) |
| `ToolResultInfo` | Metadata about a tool call within a turn |
| `SessionInfo` | Session discovery metadata (path, id, timestamps) |

### `indexer.ts` -- Conversation Indexing

Indexes parsed conversation turns into the database for semantic search.
Exports:

- **`indexConversation(jsonlPath, sessionId, db, fromOffset?, startTurnIndex?, onProgress?)`**
  -- Main entry point. Reads, parses, chunks, embeds, and stores conversation
  data. Supports incremental indexing via `fromOffset` and `startTurnIndex`.
- **`startConversationTail(jsonlPath, sessionId, db, onEvent?)`** -- Watches a
  JSONL file for new entries and indexes them in real time. Used by the MCP
  server to keep conversation search up to date during a session.

> **Note:** `indexTurn` is a private function internal to `indexer.ts`. It is
> **not exported** and should not be called directly.

## Dependencies and Dependents

```mermaid
flowchart LR
  indexingMod["Indexing — chunkText"]
  embeddingsMod["Embeddings — embedBatch"]
  convMod["Conversation"]
  toolsMod["Tools"]
  serverMod["Server"]
  cliMod["CLI"]

  indexingMod -->|chunkText| convMod
  embeddingsMod -->|embedBatch| convMod
  convMod --> toolsMod
  convMod --> serverMod
  convMod --> cliMod
```

- **Depends on:** Indexing (`chunkText`), Embeddings (`embedBatch`)
- **Depended on by:** Tools, Server, CLI

## See Also

- [Embeddings module](../embeddings/) -- generates embeddings for conversation chunks
- [Tools module](../tools/) -- `search_conversation` tool wraps this module
- [Server module](../server/) -- uses `startConversationTail` for live indexing
- [DB module](../db/) -- conversation tables that store the indexed data
- [Architecture overview](../../architecture.md)
