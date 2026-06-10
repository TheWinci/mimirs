# Tool: create_checkpoint

`create_checkpoint` is the MCP tool an agent calls to leave a durable note for
future sessions: what it decided, what it shipped, what blocked it, or where it
handed off. A Claude session starts with no memory of past sessions, so unless
something is written down, nothing carries over. This tool persists a short,
typed, searchable record into the project's local index so a later session can
recall it with [list_checkpoints](list-checkpoints.md) or
[search_checkpoints](search-checkpoints.md).

The tool is registered alongside its two read-side siblings in
`registerCheckpointTools`, which wires `create_checkpoint`, `list_checkpoints`,
and `search_checkpoints` onto the MCP server in one call
(`src/tools/checkpoint-tools.ts:9-10`). The write handler itself is small:
resolve the project, figure out which session and turn this checkpoint belongs
to, embed the title and summary, stamp the current commit, insert one row plus
its vector, and return a confirmation string
(`src/tools/checkpoint-tools.ts:36-85`).

## When to use it

The tool description tells the agent to call it as the final step after
finishing any user-requested task, and also when hitting a blocker or changing
direction mid-task (`src/tools/checkpoint-tools.ts:12`). The required `type`
names which of those situations the note records:

| `type` | Records |
| --- | --- |
| `decision` | A choice and the reasoning behind it. |
| `milestone` | A unit of completed work. |
| `blocker` | Something that stopped progress. |
| `direction_change` | A pivot away from the previous plan. |
| `handoff` | State left for the next session to pick up. |

The enum is enforced by the argument schema, so any other value is rejected
before the handler runs (`src/tools/checkpoint-tools.ts:14-16`).

## What the flow does

```mermaid
sequenceDiagram
    autonumber
    participant Agent
    participant Handler as create_checkpoint handler
    participant Sessions as discoverSessions
    participant DB as RagDB
    participant Embed as embed()
    participant Git as getHeadSha
    participant SQLite

    Agent->>Handler: type, title, summary,<br>filesInvolved?, tags?, directory?
    Handler->>Handler: resolveProject(directory)
    Handler->>Sessions: discoverSessions(projectDir)
    Sessions-->>Handler: sessions sorted by mtime desc
    Handler->>DB: getMaxTurnIndex(sessionId)
    DB-->>Handler: maxTurnIndex (or null)
    Note over Handler: turnIndex = maxTurnIndex ?? 0
    Handler->>Embed: embed("title. summary")
    Embed-->>Handler: normalized vector
    Handler->>Git: getHeadSha(projectDir)
    Git-->>Handler: commitHash (or null off-git)
    Handler->>DB: createCheckpoint(...)
    DB->>SQLite: INSERT conversation_checkpoints
    DB->>SQLite: INSERT vec_checkpoints
    SQLite-->>DB: new row id
    DB-->>Handler: id
    Handler-->>Agent: "Checkpoint #id created" (+ annotate hint)
```

1. The agent calls the tool with a `type`, `title`, and `summary`, optionally a
   list of `filesInvolved`, freeform `tags`, and a project `directory`
   (`src/tools/checkpoint-tools.ts:36`).
2. `resolveProject` turns the optional `directory` into an absolute path,
   falling back to `RAG_PROJECT_DIR` or the current working directory, checks it
   exists, loads the project config, applies its embedding settings, and returns
   the open `RagDB` for that project (`src/tools/checkpoint-tools.ts:37`,
   `src/tools/index.ts:33-47`).
3. The handler discovers the project's conversation transcripts to find which
   session is current. `discoverSessions` globs the Claude Code transcript
   directory for the project and returns the sessions sorted by file
   modification time, most recent first
   (`src/conversation/parser.ts:402-432`).
4. The most recently modified transcript is taken as the current session; its id
   becomes the checkpoint's `session_id`. If no transcripts exist, the id falls
   back to the literal string `"unknown"`
   (`src/tools/checkpoint-tools.ts:40-41`).
5. The turn index is read from the database, not the transcript file:
   `getMaxTurnIndex` returns the highest stored `turn_index` for that session
   (`src/tools/checkpoint-tools.ts:46`, `src/db/conversation.ts:230-237`).
6. The turn index is set to `maxTurnIndex ?? 0`, i.e. the index of the last
   indexed turn, or `0` when the session has no indexed turns yet
   (`src/tools/checkpoint-tools.ts:46`).
7. The title and summary are joined as `"${title}. ${summary}"` and embedded
   into one normalized vector by the local embedding model
   (`src/tools/checkpoint-tools.ts:49-50`, `src/embeddings/embed.ts:274-282`).
8. The current `HEAD` commit is stamped onto the checkpoint via `getHeadSha`, so
   a later recall can tell whether the involved files have changed since; off
   git this is `null` (`src/tools/checkpoint-tools.ts:54`,
   `src/git/exec.ts:46-50`).
9. `RagDB.createCheckpoint` writes the base row and its vector inside a single
   transaction and returns the new id
   (`src/tools/checkpoint-tools.ts:56-67`, `src/db/checkpoints.ts:5-52`).
10. If `filesInvolved` was non-empty, a hint is appended telling the agent to
    call `annotate()` for any caveats it noticed in those files
    (`src/tools/checkpoint-tools.ts:69-74`).
11. The handler returns a single text block: `Checkpoint #<id> created:
    [<type>] <title>`, plus the optional hint
    (`src/tools/checkpoint-tools.ts:76-84`).

## Resolving the session and turn index

The checkpoint is anchored to a session and a turn so a later reader knows
roughly where in the conversation it was written. Both values are derived inside
the handler, not supplied by the caller.

The session id comes from the file system, not the database. `discoverSessions`
builds the transcript directory path with `getTranscriptsDir`, which encodes the
absolute project path by replacing `/` with `-` and looking under
`~/.claude/projects/<encoded-path>/`, with a fallback that flattens every
non-alphanumeric character when the exact encoding is absent on disk
(`src/conversation/parser.ts:378-396`). It globs every `*.jsonl` file there,
stats each one, and sorts the results by `mtime` descending so the freshest
transcript is first (`src/conversation/parser.ts:402-432`). The handler takes
`sessions[0]`, which is the session whose transcript was written to most
recently — in practice the live session
(`src/tools/checkpoint-tools.ts:40-41`).

The turn index comes from the database. `getMaxTurnIndex` runs
`SELECT MAX(turn_index)` over `conversation_turns` for that session id
(`src/db/conversation.ts:230-237`). The maximum index — not `COUNT(*) - 1` — is
deliberate: stored turn indices can have gaps, and counting them pointed the
checkpoint at an older turn on a gapped session. This still reflects the turns
that have already been *indexed*, which can lag the live transcript. If the
current conversation has not been indexed since its latest turns were written,
the stored `turnIndex` points at an earlier turn. The index is only an
approximate anchor; nothing in the create or read path requires it to be exact.

## Embedding the title and summary

The checkpoint is made semantically searchable up front by embedding it at write
time. The handler concatenates the title and summary into a single string and
passes it to `embed`, which loads the configured local feature-extraction model
and returns one mean-pooled, L2-normalized vector
(`src/tools/checkpoint-tools.ts:49-50`, `src/embeddings/embed.ts:274-282`). With
the default model (`Xenova/all-MiniLM-L6-v2`) that vector is 384 dimensions
(`src/embeddings/embed.ts:53-54`); a project configured for a different model
produces a vector of that model's dimension instead. Because the vector is
computed here, [search_checkpoints](search-checkpoints.md) only has to embed the
query at read time and compare it against vectors that already exist.

## Stamping the commit

After embedding, the handler records the code state the checkpoint was written
against by reading the repository's current `HEAD` sha with `getHeadSha`, which
finds the git root for the project and runs `git rev-parse HEAD`
(`src/tools/checkpoint-tools.ts:54`, `src/git/exec.ts:46-50`). When the project
is not inside a git repository the call returns `null`, so an off-git project
still checkpoints normally — it just stores no commit signal. The sha is passed
through to the store and saved in the `commit_hash` column, which a later recall
uses to flag whether a checkpoint's files have drifted since it was written. The
column is added by a one-time migration on older databases, so pre-staleness
indexes keep working without a rebuild
(`src/db/index.ts:577-584`, `src/db/types.ts:84-86`).

## Inserting the checkpoint row

`RagDB.createCheckpoint` is a thin wrapper that forwards to the store function in
`src/db/checkpoints.ts` (`src/db/index.ts:1150-1160`). That function performs
both writes inside one transaction so the row and its vector always land together
(`src/db/checkpoints.ts:18-52`). It first inserts into `conversation_checkpoints`
with the session id, turn index, ISO timestamp, type, title, summary, the
`filesInvolved` and `tags` arrays serialized to JSON text, and the commit hash
(`src/db/checkpoints.ts:23-38`). It then reads `last_insert_rowid()` to capture
the new id (`src/db/checkpoints.ts:40-42`) and inserts the embedding into the
`vec_checkpoints` virtual table keyed by that id, passing the `Float32Array` as a
raw byte buffer (`src/db/checkpoints.ts:44-47`).

The split between the two tables is deliberate. The base table holds the
human-readable columns and the `vec0` virtual table holds the vector, mirroring
how code chunks are stored as `chunks` plus `vec_chunks`. Both tables are created
once in the schema: `conversation_checkpoints` has an `AUTOINCREMENT` primary key
plus indexes on `session_id` and `type`, and `vec_checkpoints` is a `vec0` table
sized to the configured embedding dimension (`src/db/index.ts:462-480`). The
transaction wrapper means a failure midway — for example a dimension mismatch on
the vector insert — rolls back the base-table row too, so you never get a
checkpoint with no vector.

## Inputs

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | enum: `decision`, `milestone`, `blocker`, `direction_change`, `handoff` | yes | The kind of checkpoint, stored verbatim in the `type` column and echoed in the confirmation (`src/tools/checkpoint-tools.ts:14-16`). |
| `title` | string, 1–200 chars | yes | Short label, e.g. `Chose JWT over session cookies`. Stored and used as the first part of the embedded text (`src/tools/checkpoint-tools.ts:17`). |
| `summary` | string, 1–2000 chars | yes | Two-to-three sentence description of what happened and why. Stored and embedded after the title (`src/tools/checkpoint-tools.ts:18-22`). |
| `filesInvolved` | string[] | no | Files relevant to this checkpoint. Stored as JSON; when non-empty it also triggers the annotate hint (`src/tools/checkpoint-tools.ts:23-26`, `:70-74`). |
| `tags` | string[] | no | Freeform tags for later filtering. Stored as JSON text (`src/tools/checkpoint-tools.ts:27-30`). |
| `directory` | string | no | Project directory; defaults to `RAG_PROJECT_DIR` or the current working directory (`src/tools/checkpoint-tools.ts:31-34`, `src/tools/index.ts:38`). |

The tool does not accept a `sessionId` or `turnIndex` from the caller — both are
derived inside the handler as described above.

## Outputs

| Output | Where it lands / shape / description |
| --- | --- |
| New checkpoint row | One row in `conversation_checkpoints` plus one matching vector in `vec_checkpoints`, written in a single transaction (`src/db/checkpoints.ts:23-47`). |
| Checkpoint id confirmation | A single MCP text block: `Checkpoint #<id> created: [<type>] <title>`, where `<id>` is the new row id (`src/tools/checkpoint-tools.ts:76-84`). |
| Annotate hint (conditional) | When `filesInvolved` is non-empty, an extra paragraph is appended suggesting the agent call `annotate()` for caveats in those files (`src/tools/checkpoint-tools.ts:69-74`). |

## State changes

| Item | Before | After | Why it matters |
| --- | --- | --- | --- |
| Checkpoint record | No row for this note | One new `conversation_checkpoints` row and one `vec_checkpoints` entry sharing the same id | This is the only persistent effect. It is what makes the note visible to `list_checkpoints` and findable by `search_checkpoints` in later sessions. |

The change is performed by `RagDB.createCheckpoint`, which wraps both inserts in
a transaction (`src/tools/checkpoint-tools.ts:56-67`, `src/db/checkpoints.ts:20-50`).
Before the call there is no record of the note anywhere; after a successful call
there is exactly one base row and exactly one vector, and the handler holds the
returned id. Nothing else in the database is touched — no session row, no turn
row, and no annotation are created or updated by this tool.

## Branches and failure cases

- **Project resolution fails.** If the resolved `directory` does not exist on
  disk, `resolveProject` throws `Directory does not exist: <path>` before any
  write happens (`src/tools/index.ts:45-47`). Opening the `RagDB` can also throw
  up front on an embedding-dimension mismatch between the project config and the
  existing index, before any checkpoint write.
- **No transcripts found.** When `discoverSessions` finds no `*.jsonl` files —
  the transcript directory does not exist or is empty — it returns an empty
  array, and the handler stores the session id as the literal `"unknown"`
  (`src/tools/checkpoint-tools.ts:40-41`, `src/conversation/parser.ts:425-432`).
  The checkpoint is still written; it just is not tied to a real session id.
- **Session not yet indexed.** If the current session has no indexed turns,
  `getMaxTurnIndex` returns `null` and the turn index falls back to `0` via
  `?? 0` (`src/tools/checkpoint-tools.ts:46`). The checkpoint is written normally
  with `turnIndex = 0`.
- **Off git.** When the project is not in a git repository, `getHeadSha` returns
  `null` and the checkpoint is stored with no `commit_hash` — it works, just
  without a staleness signal (`src/tools/checkpoint-tools.ts:54`,
  `src/git/exec.ts:46-50`).
- **filesInvolved omitted or empty.** The annotate hint is appended only when
  `filesInvolved` exists and has at least one entry; otherwise the confirmation
  is just the single `Checkpoint #<id> created` line
  (`src/tools/checkpoint-tools.ts:69-74`).
- **Optional arrays defaulted.** When `filesInvolved` or `tags` are not supplied,
  the handler passes empty arrays to the store function, which serializes them as
  `"[]"` (`src/tools/checkpoint-tools.ts:63-64`, `src/db/checkpoints.ts:34-35`).
- **Input validation.** The argument schema enforces the `type` enum, the title
  length (1–200) and the summary length (1–2000); out-of-range or invalid values
  are rejected by the MCP layer before the handler runs
  (`src/tools/checkpoint-tools.ts:14-22`).
- **Vector insert failure.** If inserting into `vec_checkpoints` throws, the
  surrounding transaction rolls back the base-table insert as well, so a partial
  checkpoint is never persisted (`src/db/checkpoints.ts:20-50`).

## Example

Example arguments for a decision checkpoint with two involved files:

```json
{
  "type": "decision",
  "title": "Store checkpoint vectors in a separate vec0 table",
  "summary": "Kept conversation_checkpoints holding the readable columns and put the embedding in vec_checkpoints, mirroring chunks/vec_chunks. Both writes share one transaction so they can't drift.",
  "filesInvolved": ["src/db/checkpoints.ts", "src/tools/checkpoint-tools.ts"],
  "tags": ["schema", "checkpoints"]
}
```

A possible confirmation, with a synthetic id:

```
Checkpoint #42 created: [decision] Store checkpoint vectors in a separate vec0 table

If you noticed any caveats, known issues, or "don't touch" conditions in the files above, call annotate() now to attach them.
```

Because `filesInvolved` here is non-empty, the annotate hint is included; with no
files it would be just the first line.

## Related tools

- [list_checkpoints](list-checkpoints.md) and
  [search_checkpoints](search-checkpoints.md) read back what this tool writes;
  all three are registered together in `registerCheckpointTools`
  (`src/tools/checkpoint-tools.ts:9-175`).
- The [checkpoint CLI command](../cli/checkpoint.md) performs the same insert
  from the terminal instead of over MCP.
- [annotate](annotate.md) is the tool the post-write hint points the agent
  toward when files were involved.

## Key source files

- `src/tools/checkpoint-tools.ts` — registers `create_checkpoint` and its
  handler; the orchestration described on this page.
- `src/db/checkpoints.ts` — the `createCheckpoint` store function and the
  two-table transactional insert.
- `src/db/index.ts` — the `RagDB.createCheckpoint` wrapper, the schema for
  `conversation_checkpoints` and `vec_checkpoints`, and the `commit_hash`
  migration.
- `src/conversation/parser.ts` — `discoverSessions` and `getTranscriptsDir`,
  which resolve the current session id.
- `src/db/conversation.ts` — `getMaxTurnIndex`, which supplies the turn index.
- `src/embeddings/embed.ts` — `embed`, which turns the title and summary into a
  vector.
- `src/git/exec.ts` — `getHeadSha`, which stamps the checkpoint's commit hash.
