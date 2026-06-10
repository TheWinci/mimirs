# CLI: conversation

The `conversation` command turns past Claude Code transcripts into something you can search from the terminal. Claude Code records every session as a JSONL file under your home directory. This command finds those files for the current project, splits each one into "turns" (one user message plus everything the assistant did in response), stores each turn in the project database, and then lets you search across them by meaning and by keyword.

It exists so that work done in an earlier session is not lost. If a previous session decided how a tricky function should behave, or ran a command that produced an important result, you can find it again without re-reading whole transcripts. The same stored turns also back the MCP [search_conversation](../tools/search-conversation.md) tool used inside an agent session.

The command has three subcommands, selected by the second positional argument:

| Subcommand | What it does |
| --- | --- |
| `search <query>` | Indexes any new or changed transcripts first, then runs a hybrid (vector + keyword) search over indexed turns and prints the best matches. |
| `sessions` | Lists every transcript found for this project and how many turns of each are already indexed. |
| `index [--rebuild]` | Indexes every found transcript into the database without searching; `--rebuild` drops each session's stored turns first. |

## How a transcript is found

Claude Code stores transcripts in `~/.claude/projects/<encoded-path>/`, where the encoded path is the project's absolute directory with every `/` replaced by `-`. `getTranscriptsDir` builds that path from the project directory and `homedir()` — deliberately not `$HOME`, which is typically unset on Windows and silently disabled indexing (`src/conversation/parser.ts:378-383`). Claude Code's folder encoding flattens more than `/` in some versions, so when the exact path is missing on disk, `getTranscriptsDir` falls back to a folder that matches after flattening every non-alphanumeric character (`src/conversation/parser.ts:388-395`). `discoverSessions` then globs that folder for `*.jsonl` files, `stat`s each one for its modification time and byte size, and returns them sorted newest-first; the session id is the file name with `.jsonl` stripped off (`src/conversation/parser.ts:402-432`). If the transcripts folder does not exist yet, the glob throws and is caught, so the lookup returns an empty list rather than failing.

All three subcommands start from this same step, so they only ever touch the current project's transcripts — never another project's history. A deeper guard runs inside the indexer: because the `/`→`-` encoding is lossy, two real project paths can collide into one transcript folder, so `classifyTranscript` inspects the `cwd` each line recorded and skips a transcript whose every line belongs to a sibling project (`src/conversation/parser.ts:352-366`, `src/conversation/indexer.ts:44-46`).

## Dispatch and branching

`mimirs conversation ...` enters through the shared CLI dispatcher. The top-level command string is matched in a switch, and `conversation` routes to `conversationCommand(args, getFlag)` (`src/cli/index.ts:156-158`). That handler reads the second positional argument as the subcommand, resolves the working directory from `--dir` (defaulting to `.`), opens the project database, and branches (`src/cli/commands/conversation.ts:11-14`). Because the value of the command is in which branch runs, the flow is best read as a dispatch tree.

```mermaid
flowchart TD
  startNode["mimirs conversation &lt;sub&gt; [args]"] --> open["resolve --dir<br>open RagDB"]
  open --> sub{subcommand?}

  sub -->|search| q{query given<br>and not a flag?}
  q -->|no| usageErr["print usage, exit 1"]
  q -->|yes| reindex["discoverSessions<br>re-index new or stale ones"]
  reindex --> emb["embed query"]
  emb --> vec["searchConversation (vector)"]
  emb --> bm25["textSearchConversation (keyword)"]
  vec --> fuse["rrfFuse by turnId<br>sort, slice top"]
  bm25 --> fuse
  fuse --> empty{any results?}
  empty -->|no| none["print<br>No conversation results found."]
  empty -->|yes| printR["print each turn:<br>header, snippet, files"]

  sub -->|sessions| lst["discoverSessions"]
  lst --> lstEmpty{any sessions?}
  lstEmpty -->|no| noSess["print<br>No conversation sessions found."]
  lstEmpty -->|yes| printL["print one line per transcript:<br>id, date, indexed status, size"]

  sub -->|index| idx["discoverSessions"]
  idx --> idxEmpty{any sessions?}
  idxEmpty -->|no| noSess
  idxEmpty -->|yes| idxLoop["optionally drop turns (--rebuild)<br>indexConversation each<br>sum turns, print per-session + total"]

  sub -->|other| usage2["print usage, exit 1"]

  usageErr --> closeNode["db.close()"]
  none --> closeNode
  printR --> closeNode
  noSess --> closeNode
  printL --> closeNode
  idxLoop --> closeNode
  usage2 --> closeNode
```

1. The handler resolves the directory from `--dir` and opens `RagDB` before any branch runs, so the database is always available to close at the end (`src/cli/commands/conversation.ts:13-14`).
2. `search` first checks that a query string is present and is not itself a flag; a missing query, or one that starts with `--`, prints usage and exits `1` (`src/cli/commands/conversation.ts:20-23`).
3. With a query, `search` walks every found transcript and re-indexes only the new or stale ones, then embeds the query.
4. Two searches run against the stored turns — a vector search and a keyword search — and their results are fused by rank, sorted, and trimmed to the top count.
5. An empty fused list prints `No conversation results found.`; otherwise each surviving turn is printed.
6. `sessions` lists every transcript with its indexed status, or prints a "none found" message when the folder is empty.
7. `index` indexes every transcript (after optionally dropping its stored turns when `--rebuild` is passed) and prints per-session and total turn counts, or the same "none found" message.
8. Any other subcommand (or none) prints the usage line and exits `1`.
9. Every branch falls through to `db.close()` (`src/cli/commands/conversation.ts:101`).

## `search`: index-on-demand, then rank fusion

`search` is the only subcommand that both writes and reads. Before searching it makes sure the index is current: it walks every found transcript, compares the on-disk modification time against the `mtime` stored in the session row, and calls `indexConversation` for anything that has never been indexed or whose file has grown since (`src/cli/commands/conversation.ts:29-35`). This is why a fresh search picks up turns from a session you just finished without a separate `index` run, while unchanged transcripts are skipped.

Once the index is current the handler embeds the query with `embed`, then runs two searches over the stored turn chunks (`src/cli/commands/conversation.ts:38-43`):

- A vector search, `searchConversation`, matches the query embedding against the `vec_conversation` virtual table and turns the L2 distance into a similarity via `1 / (1 + distance)` (`src/db/conversation.ts:326`, `src/db/conversation.ts:350`).
- A keyword search, `textSearchConversation`, runs an FTS5 `MATCH` against `fts_conversation` and converts the BM25 `rank` into a score via `1 / (1 + abs(rank))` (`src/db/conversation.ts:385`, `src/db/conversation.ts:409`).

Both searches return at most one row per turn. The DB layer over-fetches (three times the requested top count when searching across the whole project) and de-duplicates by `turn_id`, so a turn split into several chunks does not crowd out other turns (`src/db/conversation.ts:330`, `src/db/conversation.ts:335-337`).

The two lists are then combined by **reciprocal-rank fusion** rather than by blending the raw scores. The handler calls `rrfFuse(vecResults, bm25Results, config.hybridWeight, (r) => r.turnId)`, sorts the fused list by score descending, and slices it to the top count (`src/cli/commands/conversation.ts:46-48`). This matters because cosine/L2 similarity and the BM25-derived `1/(1+|rank|)` score live on different, non-comparable scales — adding them directly would let whichever has the larger magnitude dominate and make the weight nearly inert. Fusing by *position* avoids that.

Inside `rrfFuse` each list is scored only by where a turn lands in it: a turn at rank `i` contributes `RRF_K / (RRF_K + i)` with `RRF_K = 60`, which is `1` at the top and decays smoothly down the list (`src/search/hybrid.ts:83-88`). A turn's final score is `weight * vectorRankScore + (1 - weight) * keywordRankScore`, where the vector list is the primary (weight) side and the keyword list is the secondary; a turn missing from one list contributes `0` from that side (`src/search/hybrid.ts:99-102`). The `weight` is `config.hybridWeight`, whose default is `0.5` — equal pull from semantic and keyword rank — so neither signal dominates and an exact keyword hit can still surface a turn the vector search ranked lower (`src/search/hybrid.ts:63`). The same `rrfFuse` is the single fusion path for ordinary chunk search too, so conversation search and code search rank by the same rule.

Each printed result shows `Turn <turnIndex> (<timestamp>)`, an optional `[tool, tool]` list when the turn used tools, the first 200 characters of the matching snippet, and up to five referenced files when present (`src/cli/commands/conversation.ts:53-59`). When nothing matches it prints `No conversation results found.`

## `sessions`: what exists and what is indexed

`sessions` is read-only. It calls `discoverSessions` and, for each transcript, looks up the stored session row with `getSession`. If a row exists it reports the stored `turnCount` as `<n> turns indexed`; otherwise it reports `not indexed` (`src/cli/commands/conversation.ts:68-72`). Each line shows the first eight characters of the session id, the file modification time as an ISO timestamp trimmed to seconds, the indexed status, and the file size in kilobytes. With no transcripts at all it prints `No conversation sessions found for this project.`

This is the quickest way to see whether a recent session has made it into the index, and how large each transcript is.

## `index`: index everything now

`index` indexes every found transcript and reports per-session and total turn counts. It reads whether `--rebuild` was passed, prints a `Found N sessions, <indexing|rebuilding>...` header, then loops over the sessions (`src/cli/commands/conversation.ts:75-94`). For each session it optionally drops the stored turns first (only with `--rebuild`), calls `indexConversation`, accumulates `turnsIndexed`, prints a line for every session that produced new turns, and finishes with a total. Unlike `search`, it does not check `mtime` first — it calls `indexConversation` unconditionally. That is safe because indexing is idempotent at the turn level (see below): a session that is already fully indexed and unchanged contributes zero new turns and prints nothing.

The `--rebuild` flag exists to recover indexes written before the turn-cursor fix, where some turns lost their tails (assistant text missing) and turn indices drifted. For those, an incremental upsert alone cannot fully repair the damage, so `--rebuild` calls `deleteSessionTurns` to clear the session's turns, chunks, and cursor before re-indexing from scratch (`src/cli/commands/conversation.ts:84-87`, `src/db/conversation.ts:208-222`).

## Inside `indexConversation`

`indexConversation` is the shared worker for both `index` and the on-demand path in `search` (`src/conversation/indexer.ts:25-33`). The CLI always passes the default byte offset of `0`, so the whole file is re-read each time and turn numbering starts from zero. It reads the JSONL with `readJSONL`, drops any lines belonging to a colliding sibling project, parses the kept entries into turns, indexes each turn, reconciles stale stored turns, and finally updates the session row (`src/conversation/indexer.ts:34-134`).

`readJSONL` only consumes bytes up to the last newline in the slice it reads and reports that position as the new offset (`src/conversation/parser.ts:109-142`). A transcript that is being live-tailed often ends in a partial line that is still mid-write; advancing the saved offset past it would leave the cursor mid-line, so the rest of that line would read back as corrupt JSON on the next pass and the turn would be lost. By stopping at the last complete line and operating on raw bytes (so a multibyte UTF-8 sequence never straddles the boundary), an incomplete final turn is simply re-read once it is fully written. If the slice contains no newline at all, the function advances nothing and returns no entries (`src/conversation/parser.ts:114-118`). This matters most to the background watcher, which reads from a stored offset; the CLI re-reads from zero each run and relies on the turn-level dedupe instead.

Parsing is done by `parseTurns`, which keeps only `user` and `assistant` messages and groups them into turns (`src/conversation/parser.ts:152-162`). A new turn begins at a real user text message; tool-result messages and assistant messages are folded into the current turn (`src/conversation/parser.ts:204-294`). While building a turn it records which files were referenced (from `toolUseResult.filenames` metadata, `src/conversation/parser.ts:253-256`), which tools were used (from `tool_use` blocks, `src/conversation/parser.ts:280-283`), and the running token cost (counting only `output_tokens`, since `input_tokens` repeats the whole context on every assistant message and would overcount, `src/conversation/parser.ts:287-293`). To keep the index lean, the content of `Read`, `Glob`, `Write`, `Edit`, and `NotebookEdit` tool results is dropped unless it is short (500 characters or less), since that output is already covered by the code index (`src/conversation/parser.ts:72-75`, `src/conversation/parser.ts:258-264`).

Each turn is then handed to `indexTurn`, which builds the indexable text with `buildTurnText` (user text, then assistant text, then selected tool results), splits it into chunks of up to 512 tokens with 50 tokens of overlap using `chunkText` with a `.md` extension for paragraph-style splitting, embeds all chunks in one `embedBatch` call, and stores the turn with `upsertTurn` (`src/conversation/indexer.ts:147-187`). A turn whose text is empty after trimming is skipped and counts as `skipped-empty` (`src/conversation/indexer.ts:151-152`). Before embedding — the expensive step — `indexTurn` compares the freshly chunked text against the stored chunk text from `getTurnChunkText`; if they are identical the turn is `unchanged` and no embed or write happens, so re-running on a steady-state session costs no model time (`src/conversation/indexer.ts:161-164`).

Because the CLI always starts from offset 0, after the loop `indexConversation` calls `deleteTurnsAbove` to drop any stale stored turns above the last parsed index — a full from-zero re-parse is authoritative for the whole session, so gapped or drifted legacy rows that would survive the upserts are reconciled away (`src/conversation/indexer.ts:118-120`, `src/db/conversation.ts:180-190`). Finally `persistCursor` updates session tracking: it reads the highest stored turn index, sums the stored token costs, then calls `upsertSession` and `updateSessionStats` with the file's current `mtimeMs` and the persisted offset (`src/conversation/indexer.ts:96-102`, `src/conversation/indexer.ts:131-135`). The stored `file_mtime` is exactly what `search` compares against next time to decide whether to re-index.

> Known issue: the rewind probe used on the incremental (offset > 0) path can mis-bind when an old-format offset is paired with a new turn whose user text equals the stored last turn's (for example a repeated `continue`), replacing the stored turn instead of appending and losing one turn. The CLI is not affected because it always reads from offset 0, where a full re-parse plus `deleteTurnsAbove` recovers cleanly; the risk is on the background watcher path (`src/conversation/indexer.ts:60-78`).

## State changes

| Name | Before | After | Why it matters |
| --- | --- | --- | --- |
| Turn row | No row (or a stale one) for `(session_id, turn_index)` | One row in `conversation_turns` | Makes the turn discoverable; the replace-on-conflict behavior repairs a turn re-read after its tail arrived. |
| Chunk + embedding rows | No chunks for the turn | Rows in `conversation_chunks` and `vec_conversation`, mirrored into `fts_conversation` by trigger | Provide the vector and keyword search surfaces. |
| Session row | Missing or stale | Upserted with new `file_mtime`, `read_offset`, `turn_count`, `total_tokens` | Lets later runs skip unchanged files and report indexed counts. |

The turn write is an insert-or-replace, not an insert-or-ignore. `upsertTurn` runs inside one transaction: it deletes any existing version of the turn at `(session_id, turn_index)` (and its chunks), then inserts the fresh turn and its chunks (`src/db/conversation.ts:66-134`). Replace — not ignore — is load-bearing: the incremental cursor is held back to a turn's start, so the turn is re-read with whatever continuation arrived since; an ignore would keep the truncated first version and silently drop the completed text (`src/db/conversation.ts:57-65`). Each chunk inserts a snippet into `conversation_chunks`, then its embedding into `vec_conversation`; an `AFTER INSERT` trigger (`conv_chunks_ai`) mirrors the snippet into the `fts_conversation` full-text index, and the matching `conv_chunks_ad` / `conv_chunks_vec_ad` delete triggers clear the FTS and vector rows when a turn's chunks are dropped (`src/db/index.ts:442-458`). Because the whole turn — row, chunks, embeddings — is written in one transaction, a failure cannot leave a turn with partial chunks.

Session bookkeeping happens after the turns. `upsertSession` inserts or updates the session row with the latest `file_mtime` and `read_offset`, and `updateSessionStats` writes the turn count and token total — both derived from the stored turns (highest turn index plus one, and the sum of stored token costs) rather than a per-pass tally, so an overlapping run can never clobber the totals (`src/db/conversation.ts:6-23`, `src/db/conversation.ts:50-55`).

## Branches and failure cases

- **Missing or flag-shaped query for `search`.** With no query argument — or one that begins with `--`, such as `conversation search --top 5 "real query"` where the parser would otherwise treat `--top` as the query and embed the literal string — the handler prints `Usage: mimirs conversation search <query> [--dir D] [--top N]` and exits `1` (`src/cli/commands/conversation.ts:20-23`).
- **Unknown or missing subcommand.** Anything other than `search`, `sessions`, or `index` prints `Usage: mimirs conversation <search|sessions|index [--rebuild]>` and exits `1` (`src/cli/commands/conversation.ts:96-98`).
- **No transcripts found.** `sessions` and `index` print `No conversation sessions found for this project.` and do nothing further; the transcripts folder simply may not exist yet (`src/cli/commands/conversation.ts:65-66`, `src/cli/commands/conversation.ts:78-79`).
- **No search matches.** When the fused result list is empty, `search` prints `No conversation results found.` (`src/cli/commands/conversation.ts:50-51`).
- **Full-text search errors.** FTS5 can throw on queries with special characters. The keyword search is wrapped in a `try/catch` that swallows the error and leaves the keyword list empty, so `search` still returns its vector results (`src/cli/commands/conversation.ts:40-43`). The DB layer also passes the query through `sanitizeFTS` before matching (`src/db/conversation.ts:389`).
- **Foreign transcript.** If `classifyTranscript` finds every line of a transcript belongs to a sibling project that collided into the same folder, `indexConversation` returns early with zero turns and leaves the cursor untouched, so it never claims another project's turns (`src/conversation/indexer.ts:44-46`).
- **Empty transcript.** If `readJSONL` returns no entries (an empty file, or an offset already at end-of-file), `indexConversation` returns early with zero turns indexed (`src/conversation/indexer.ts:36-38`).
- **Empty turn text.** A turn whose combined text is blank after trimming is skipped by `indexTurn` and never reaches the database (`src/conversation/indexer.ts:151-152`).
- **Already-indexed, unchanged turn.** Re-running `index` on an unchanged session is a no-op at the model level: each turn's chunk text matches the stored version, so `indexTurn` returns `unchanged`, `turnsIndexed` stays `0`, and no per-session line prints (`src/conversation/indexer.ts:161-164`).
- **`--rebuild`.** Passing `--rebuild` to `index` drops each session's stored turns, chunks, and cursor before re-indexing, recovering indexes damaged by the pre-cursor-fix turn splitting (`src/cli/commands/conversation.ts:84-87`).
- **Stale-only re-index in `search`.** A session is re-indexed only when it has no row or its `mtime` grew; an unchanged session is skipped entirely on the search path (`src/cli/commands/conversation.ts:31-34`).
- **Bad `--top` value.** `--top` is parsed by `intFlag`, which rejects non-integers and values below `1` by throwing `CliFlagError`; the dispatcher catches it, prints the message, and exits `1` (`src/cli/flags.ts:40-53`, `src/cli/index.ts:102-108`).
- **Always closes the DB.** Every branch falls through to `db.close()` at the end of the handler (`src/cli/commands/conversation.ts:101`).

## Inputs

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| subcommand | `search` \| `sessions` \| `index` | yes | Second positional argument; selects the branch. Anything else prints usage and exits `1`. |
| `<query>` | string | for `search` only | Third positional argument; the natural-language or keyword search query. A missing query on `search` exits `1`. |
| `--dir D` | path | no | Project directory whose transcripts and database are used. Resolved to an absolute path; defaults to the current directory. |
| `--top N` | integer ≥ 1 | no | Maximum results for `search`. Defaults to the config `searchTopK` (8). Validated by `intFlag`. |
| `--rebuild` | boolean flag | no | For `index` only. Drops each session's stored turns before re-indexing. |

## Outputs

| Output | Where it lands / shape / description |
| --- | --- |
| Search results | Printed to stdout for `search`: per turn, `Turn <index> (<timestamp>)` with an optional `[tool, ...]` list, a snippet capped at 200 chars, and up to 5 referenced files. Empty case prints `No conversation results found.` |
| Session list | Printed to stdout for `sessions`: one line per transcript with short session id, ISO timestamp, indexed-turn count or `not indexed`, and file size in KB. |
| Index summary | Printed to stdout for `index`: a `Found N sessions, indexing...` (or `rebuilding...`) header, a per-session line for sessions with new turns, and a final `Done: <total> turns indexed across N sessions`. |
| Persisted rows | Both `index` and the `search` on-demand path write session, turn, chunk, embedding, and FTS rows into the project database (see State changes). |

## Example

```
$ mimirs conversation sessions
  3f9a1c20...  2026-05-30T14:22:07  142 turns indexed  (318KB)
  a18b7e44...  2026-05-29T09:11:50  not indexed        (44KB)

$ mimirs conversation index
Found 2 sessions, indexing...
  a18b7e44...: 18 turns
Done: 18 turns indexed across 2 sessions

$ mimirs conversation search "how did we handle FTS special chars" --top 3
Turn 57 (2026-05-29T10:02:13) [search, read_relevant]
  Wrapped the keyword search in try/catch so FTS5 errors on special chars fall
  Files: src/cli/commands/conversation.ts, src/db/conversation.ts
```

Values such as session ids, timestamps, and turn indices above are illustrative.

## Background indexing

The CLI is the manual way to fill the conversation index. When the MCP server is running it indexes transcripts automatically: `startConversationFolderWatch` backfills every existing session on startup and then watches the transcripts folder, draining both the backfill and live file-change events through a single serial queue so two index runs never overlap on the same file (`src/conversation/indexer.ts:267-339`). That background path reads from the byte offset stored in each session row rather than re-reading whole files (`src/conversation/indexer.ts:197-221`), and is described under [server start](../server/start.md). Because both paths funnel into the same idempotent `indexConversation`, running the CLI `index` while the server watches is safe — already-indexed turns are simply left unchanged.

## Key source files

- `src/cli/index.ts` — top-level CLI dispatcher; routes `conversation` to its handler and catches `CliFlagError`.
- `src/cli/commands/conversation.ts` — the handler implementing `search`, `sessions`, and `index`.
- `src/conversation/parser.ts` — transcript lookup (`discoverSessions`, `getTranscriptsDir`), JSONL reading (`readJSONL`), turn parsing (`parseTurns`, `buildTurnText`), and project classification (`classifyTranscript`, `belongsToProject`).
- `src/conversation/indexer.ts` — the `indexConversation` worker, `indexTurn`, and the server's folder watcher.
- `src/db/conversation.ts` — the SQL behind session upserts, the insert-or-replace turn write, change detection, and the vector/keyword searches.
- `src/db/index.ts` — the conversation table schema, the `UNIQUE(session_id, turn_index)` dedupe key, the FTS sync triggers, and the `RagDB` method wrappers.
- `src/search/hybrid.ts` — `rrfFuse`, the shared reciprocal-rank fusion used by both conversation search and code search.
- `src/cli/flags.ts` — `intFlag` validation for `--top`.
- `src/config/index.ts` — defaults for `searchTopK` (8) and `hybridWeight` (0.5).
