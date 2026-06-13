# Start the MCP server

The `serve` command boots the long-lived process that an editor or agent talks to over stdio. It is the one entry point that turns a project directory into a live MCP endpoint: it registers every tool, answers the MCP handshake, opens the project's SQLite index, then keeps that index fresh in the background by re-scanning the project and tailing conversation transcripts.

The boot is deliberately ordered so the slow, fallible work — opening native SQLite, scanning the whole project, loading the embedding model — happens *after* the client is already connected. A boot that crashes still leaves a readable trail: a `.mimirs/status` file recording the phase it reached, and a `.mimirs/server-error.log` holding the stack. This page walks the path from `mimirs serve` to a running watcher and names every branch that can change the outcome.

## When you would use it

This is what your MCP client (an IDE extension, an agent runtime) actually launches; you rarely run `mimirs serve` by hand. But when the index looks stale, tools return errors, or the client reports "Connection closed", the boot order and the status file are the first things to read.

The command itself is intentionally thin. `serveCommand` resolves the project directory from `RAG_PROJECT_DIR` (falling back to the current working directory), prints one line to stderr, then dynamically imports `../../server` and calls `startServer()` `src/cli/commands/serve.ts:4-53`. The import is dynamic on purpose: `src/server/index.ts` has a top-level `await` and pulls in native dependencies (`bun:sqlite`, `sqlite-vec`). A static import that failed at module-load time would crash the whole CLI before any handler ran, leaving no status file. By wrapping the `import()` in a `try/catch`, a load failure instead writes both `.mimirs/server-error.log` and a `.mimirs/status` file whose first line is `error` and whose phase is `module load failed`, then rethrows `src/cli/commands/serve.ts:13-49`.

## The boot sequence

The value here is in the forks, not the call order: each phase either advances or drops the server into a terminal error, a degraded query-only mode, or an idle no-index mode. A flowchart shows those branches directly.

```mermaid
flowchart TD
  startNode([mimirs serve]) --> resolveDir[Resolve startupDir<br>from RAG_PROJECT_DIR or cwd]
  resolveDir --> loadMod{Server module<br>loads?}
  loadMod -- no --> modFail[Write server-error.log<br>+ status: error / module load failed<br>rethrow]
  loadMod -- yes --> guard{checkIndexDir safe?}
  guard -- no, home/root trap --> noStatus[statusPath = null<br>skip auto-index + watchers]
  guard -- yes --> writeStart[writeStatus: starting<br>register signal + stdin handlers]
  noStatus --> register
  writeStart --> register{registerAllTools<br>succeeds?}
  register -- no --> regFail[server-error.log<br>+ status: error / tool registration failed<br>throw]
  register -- yes --> connect{Connect stdio<br>transport?}
  connect -- no --> connFail[server-error.log<br>+ status: error / transport failed<br>throw]
  connect -- yes --> preflight{Open RagDB<br>preflight}
  preflight -- permanent error --> permFail[Cache permanentError<br>status: error + fix hint<br>return]
  preflight -- transient lock --> transFail[status: starting / will retry<br>return, no background work]
  preflight -- ok --> homeCheck{Home-dir trap?}
  homeCheck -- yes --> idleEnd([Idle: tools answer,<br>no indexing])
  homeCheck -- no --> lock{tryAcquireIndexLock?}
  lock -- no, another owner --> queryOnly([status: done / query-only<br>serves reads only])
  lock -- yes --> bgIndex[Background indexDirectory<br>writes file/chunk rows + progress status]
  bgIndex --> watchers[On completion: start file watcher;<br>conversation watcher starts alongside]
  watchers --> runningNode([status: done<br>watchers live])
```

1. **Resolve the directory.** `serveCommand` reads `RAG_PROJECT_DIR`, falling back to `process.cwd()`, and hands off to `startServer()` `src/cli/commands/serve.ts:4-51`.
2. **Module-load gate.** If importing the server module throws (missing native SQLite, broken `sqlite-vec`), the catch block writes diagnostics and an `error` status, then rethrows `src/cli/commands/serve.ts:13-49`.
3. **Directory guard.** `checkIndexDir` rejects system-level directories (`~`, `/`, `/home`, `/Users`, `/tmp`, `/var`, and more). When the directory is unsafe, the server still starts and serves tools, but `statusPath` is set to `null` and all indexing and watching are skipped `src/server/index.ts:126-129`, `src/utils/dir-guard.ts:10-63`.
4. **First status + handlers.** The server writes `starting` to `.mimirs/status` and registers signal/stdin shutdown handlers *before* any slow work, so even a crash mid-boot records `interrupted` `src/server/index.ts:144-214`.
5. **Tool registration.** `registerAllTools` wires every MCP tool onto the server. A failure here writes `error` with phase `tool registration failed` and rethrows `src/server/index.ts:246-254`.
6. **Connect transport.** The stdio transport connects so the client's `initialize` handshake is answered before config I/O or indexing. A failure writes `error` / `transport failed` `src/server/index.ts:260-269`.
7. **DB preflight.** The server opens the project's SQLite DB once up front to surface native/permission problems early, classifying any error as permanent or transient `src/server/index.ts:272-313`.
8. **Index lock.** Only the instance that acquires the per-project lock indexes and watches; others write a `done` / query-only status and serve reads `src/server/index.ts:418-444`.
9. **Background work.** The lock holder runs a full index in the background, then starts the file watcher; the conversation folder watcher starts alongside it `src/server/index.ts:332-412`. The lock holder is also the only instance that starts the command-channel consumer (`startCommandDropbox`), wiring `ping`, `index.git`, `index.conversation`, and `index.files` executors so sessionless CLI processes can delegate work to this server `src/server/index.ts:460-485`. That transport is the [drop-box command channel](../mechanisms/control-channel.md); a query-only instance never consumes commands.

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `RAG_PROJECT_DIR` | env var | no | Absolute path of the project to index and serve. Read in both `serveCommand` and `startServer`; when unset it falls back to the process working directory, which can hit the home/root guard `src/cli/commands/serve.ts:5`, `src/server/index.ts:125`. |
| `RAG_DB_DIR` | env var | no | Directory where `index.db` lives. When unset, the index is stored in `<project>/.mimirs/`. Pointing it at a writable path is the documented fix for read-only or permission errors `src/db/index.ts:116-132`. |
| stdin EOF | process event | n/a | When stdin closes (the IDE window goes away), `stdin.on("end")` treats it as a shutdown and cleans up `src/server/index.ts:193-196`. |
| `SIGINT` / `SIGTERM` / `SIGHUP` | OS signal | n/a | Each triggers the same `cleanup` path — closing watchers, releasing the lock, closing DBs, and exiting `src/server/index.ts:200-202`. |

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| `.mimirs/status` | A small text file rewritten at every phase. First line is one of `starting`, `done`, `error`, or `interrupted`; following lines carry version, phase, progress, or a fix hint. The instance's `pid:<n>` is appended so a second instance does not clobber the first one's status `src/server/index.ts:134-144`. |
| Registered MCP tools over stdio | The full set of 29 tools (search, indexing, graph, conversation, checkpoints, annotations, analytics, git, git history, server info, wiki) bound to the server and reachable over the stdio transport `src/tools/index.ts:130-148`. |
| Background index of files/chunks | File and chunk rows (plus vector and full-text entries) written to `index.db`; deleted files pruned; imports and symbol references resolved `src/server/index.ts:332-379`, `src/indexing/indexer.ts:919-1004`. |
| `.mimirs/server-error.log` | On a startup failure, a timestamped log with the error message, stack, and a pointer to `mimirs doctor`. Written so the failure is visible outside stderr, which the client may have already closed `src/server/index.ts:94-117`. |

## Tool registration

`registerAllTools` is a thin fan-out: it wraps the server in a friendly-error proxy, then calls one `registerXTools(server, getDB, ...)` per group — search, indexing, graph, conversation, checkpoints, annotations, analytics, git, git history, server info, and wiki `src/tools/index.ts:130-148`. Those eleven groups register 29 individual tools in total. Two callbacks are threaded through so tools can reach process state without importing the server: `getDB`, which lazily opens and caches one `RagDB` per project directory `src/server/index.ts:43-82`, and `writeStatus`, which lets the indexing group push its own progress into the same status file the boot phases use (only `registerIndexTools` receives it) `src/tools/index.ts:138`. The connected-DB accessor is passed to the server-info group so it can report open connections `src/tools/index.ts:146`. Registration is wrapped so any throw becomes an `error` status before the transport ever connects `src/server/index.ts:246-254`.

The 29 tools split across groups as follows:

| Group | Registrar | Tools |
| --- | --- | --- |
| Search | `registerSearchTools` | `search`, `read_relevant`, `search_symbols`, `write_relevant` |
| Indexing | `registerIndexTools` | `index_files`, `index_status`, `remove_file` |
| Graph | `registerGraphTools` | `project_map`, `usages`, `depends_on`, `dependents`, `impact`, `trace`, `callees`, `affected` |
| Conversation | `registerConversationTools` | `search_conversation`, `read_conversation` |
| Checkpoints | `registerCheckpointTools` | `create_checkpoint`, `list_checkpoints`, `search_checkpoints` |
| Annotations | `registerAnnotationTools` | `annotate`, `get_annotations`, `delete_annotation` |
| Analytics | `registerAnalyticsTools` | `search_analytics` |
| Git | `registerGitTools` | `git_context` |
| Git history | `registerGitHistoryTools` | `search_commits`, `file_history` |
| Server info | `registerServerInfoTools` | `server_info` |
| Wiki | `registerWikiTools` | `wiki` |

The newest entries are `callees` and `affected` in the graph group and `read_conversation` in the conversation group; the names are declared at the top of each `server.tool(...)` call, for example `src/tools/graph-tools.ts:313`, `src/tools/graph-tools.ts:352`, and `src/tools/conversation-tools.ts:87`.

## Transport before slow work

Connecting `StdioServerTransport` is the last thing that happens before the DB preflight, and it happens before config loading and indexing `src/server/index.ts:260-264`. The reason is in the source comment: if the client's `initialize` handshake is not answered before slow startup work, the client may time out, close the pipes, and the server's later stderr writes hit `EPIPE`. Answering the handshake first means the client sees a live server immediately while the heavy indexing runs in the background without blocking any tool call.

## DB preflight: permanent vs transient

After the transport is up, the server opens the database once by calling `getDB(startupDir)` `src/server/index.ts:272-274`. This surfaces a broken native SQLite (for example, missing Homebrew SQLite on macOS) or an unwritable index directory early, with a clear message, instead of letting the first tool call fail cryptically. The handling splits on whether the failure can be retried:

| Error class | Detection | What happens | Status written |
| --- | --- | --- | --- |
| Transient | message contains `database is locked` or `SQLITE_BUSY` | Not cached; the next tool call re-runs `getDB`, which may succeed | `starting` + `Will retry on next tool call` |
| Permanent | anything else (permission failure, missing native lib) | Cached in `permanentError`; every later tool call hits the guard at the top of `getDB` and gets the same message | `error` + a targeted fix hint |

The fix hint is chosen from the message: `brew install sqlite` for the macOS case, "set `RAG_DB_DIR` to a writable directory" for `EROFS`/`EACCES`, or a generic README pointer otherwise `src/server/index.ts:278-282`. In both error cases the function `return`s early, so startup indexing is skipped — it needs an open DB `src/server/index.ts:311-312`. The transient path keeps the server connected so a retry can recover; the permanent path keeps it connected too, but every tool call throws the cached error until the environment is fixed `src/server/index.ts:43-46`.

## State changes

### `.mimirs/status` — none → written, at every phase

Before boot there may be a stale `interrupted` line from a previous instance. The first thing `startServer` does is overwrite it with `starting` `src/server/index.ts:119-144`. `writeStatus` then rewrites the file at every phase boundary — `creating server`, `tools registered`, `connecting transport`, `transport connected` — and again on each indexing progress tick (`0/N files`, `processedFiles/totalFiles (pct%)`) `src/server/index.ts:236-368`. On clean completion it becomes `done` with index counts; on failure it becomes `error`; on shutdown it becomes `interrupted`. The write appends `pid:<n>` and no-ops once shutdown begins, so a late progress callback can never overwrite the final line `src/server/index.ts:134-142`. This is the single source of truth an IDE polls to show "indexing 30%" or "ready", and it is what the [index_status](../tools/index-status.md) tool reports.

### `.mimirs/index.lock` — none → acquired (one instance only) `src/server/index.ts:418-444`

Before background work, the server calls `tryAcquireIndexLock(startupDir)`. The lock is a file containing the owner PID, written with the exclusive `wx` flag. If a live process already holds it, the call returns `null` and this instance runs query-only; a lock left by a dead PID is reclaimed automatically `src/server/index.ts:418-422`, `src/utils/index-lock.ts:28-86`. The lock is reentrant within one process via a refcount, so `indexDirectory` can also acquire it during the same lifetime without unlinking it out from under the server `src/utils/index-lock.ts:34-38`, `src/indexing/indexer.ts:907-914`. It is released in `cleanup` on shutdown, which unlinks the file only if it still holds this process's PID `src/server/index.ts:185`, `src/utils/index-lock.ts:88-110`. This is the boundary between "this server keeps the index fresh" and "this server only reads" — get it wrong and two processes double-insert into the chunk table.

### `index.db` file/chunk rows — none/stale → indexed

The lock holder calls `indexDirectory(startupDir, startupDb, startupConfig, ...)` in the background. That re-checks the directory is safe, acquires the reentrant lock, collects matching files (git's view of the project when available, so `.gitignore` is honored, otherwise a recursive walk), eagerly loads the embedding model, and for each file inserts or updates its `files` row and `chunks` — with vector (`vec_chunks`) and full-text (`fts_chunks`) entries kept in sync by triggers `src/indexing/indexer.ts:919-957`. Files that no longer exist on disk are pruned (guarded so an empty scan never wipes the index), then imports and symbol references are resolved across the project `src/indexing/indexer.ts:962-1002`. The result counts (`indexed`, `skipped`, `pruned`) and the post-run totals from `getStatus` go into the `done` status line `src/server/index.ts:369-378`. The same engine powers the [index_files](../tools/index-files.md) tool and the [index command](../cli/index.md).

## Background full index, then watchers

When the lock is acquired, the server kicks off `indexDirectory(...)` **without awaiting it** — the boot returns and the index builds in the background `src/server/index.ts:332`. The progress callback translates indexer messages into status lines: it counts `file:done` events into a `processed/total` percentage, surfaces `scanning files` and `Loading embedding model` messages verbatim, and parses `Found N files to index` to seed the total `src/server/index.ts:332-368`.

When the index promise resolves, the server reads the DB totals, writes the `done` block, and starts the **file watcher** `src/server/index.ts:369-400`. The watcher is started in the `.finally` block, so it comes up whether or not the initial index succeeded — a transient startup failure (model download, `SQLITE_BUSY`) used to leave the server watch-less for its whole lifetime, silently dropping every edit until restart `src/server/index.ts:383-399`. `startWatcher` does a recursive `fs.watch` on the project, filters events through the configured include/exclude globs, debounces each path by two seconds (`DEBOUNCE_MS = 2000`), and funnels indexing through a serial queue so re-index and graph-resolution never interleave. Each settled event either re-indexes the file (re-resolving imports and symbol refs for it and its importers) or removes a deleted file `src/indexing/watcher.ts:10-149`.

The **conversation folder watcher** is started inside the same lock block but outside the index promise's `.then`, so it does not wait for the code index to finish `src/server/index.ts:407-412`. `startConversationFolderWatch` watches the project's transcript folder — `~/.claude/projects/<encoded-path>/`, where the encoded path is the absolute project dir with `/` replaced by `-` `src/conversation/parser.ts:378-396`. On startup it backfills every existing `*.jsonl` transcript through a serial queue, then watches the folder so the live session and any session that changes later get indexed from their stored byte offset as they grow `src/conversation/indexer.ts:275-347`, `src/conversation/indexer.ts:305-314`. Indexing is idempotent: each pass re-reads the offset from the session row, so overlapping or repeated runs can never desync `turn_count` `src/conversation/indexer.ts:189-221`. This is what lets one agent's findings become searchable to another in near real time; the same data backs the [conversation search command](../cli/conversation.md).

The lock holder also starts the **command-channel consumer** in the same block, `startCommandDropbox(startupDir, executors)`, with executors for `ping`, `index.git`, `index.conversation`, and `index.files` `src/server/index.ts:460-485`. This is the server side of the [drop-box command channel](../mechanisms/control-channel.md): a sessionless CLI process (`mimirs index`, `mimirs conversation index`, `mimirs ping`) drops a request file that this consumer picks up and answers, so the CLI can hand indexing work to the live writer instead of racing it. Only the lock holder consumes — a query-only instance never starts it — which is why the consumer comes up here, alongside the watchers, rather than at general startup.

A known correctness caveat lives in this path: the legacy-offset upgrade probe in `indexConversation` compares only the user text of a turn, so a new turn whose user text matches the stored last turn (a plain "continue", for example) can replace that turn instead of appending — losing one turn and undercounting session tokens until a from-zero re-parse recovers it `src/conversation/indexer.ts:24`. It only triggers when a legacy EOF-semantics offset and a duplicate user text line up, so it is rare, but worth knowing when conversation counts look off.

## Branches and failure cases

| Branch | Trigger | What happens |
| --- | --- | --- |
| Module load failure | Dynamic `import("../../server")` throws | `server-error.log` written, status `error` / `module load failed`, error rethrown — no server starts `src/cli/commands/serve.ts:13-49`. |
| Home/root directory trap | `checkIndexDir` finds a dangerous dir | `statusPath` becomes `null` (no status writes), and auto-index + both watchers are skipped; the server still registers tools and serves queries `src/server/index.ts:126-129`, `src/server/index.ts:232-234`, `src/server/index.ts:317`. |
| Tool registration failure | `registerAllTools` throws | `server-error.log` written, status `error` / `tool registration failed`, error rethrown before the transport connects `src/server/index.ts:248-254`. |
| Transport connect failure | `server.connect(transport)` rejects | `server-error.log` written, status `error` / `transport failed`, error rethrown `src/server/index.ts:265-269`. |
| Permanent DB error | `getDB` throws a non-retryable message (`EROFS`, `EACCES`, missing Homebrew SQLite) | `permanentError` cached so every later tool call gets the same message; status `error` with a targeted fix hint; `startServer` returns without indexing `src/server/index.ts:275-313`. |
| Transient DB error | `getDB` throws `database is locked` or `SQLITE_BUSY` | Error *not* cached; status stays `starting` with "Will retry on next tool call"; background indexing skipped this boot, but the next tool call retries `getDB()` `src/server/index.ts:277-313`. |
| Query-only mode | `tryAcquireIndexLock` returns `null` (another live owner) | Status `done`; this instance serves reads but never indexes or tails transcripts, and a 30-second timer keeps retrying the lock so it can take over if the owner dies `src/server/index.ts:421-444`. |
| Indexing failure | The background `indexDirectory(...)` promise rejects | The `.catch` writes status `error` with the message and logs a warning, but the file watcher still starts in the `.finally`, so edits are still picked up; tools keep working against what was already indexed `src/server/index.ts:380-400`. |
| Conversations folder missing | Transcript directory does not exist yet | The backfill scan and `fs.watch` are wrapped; a missing folder is tolerated, and the watch (when creatable) picks it up once it appears `src/conversation/indexer.ts:299-305`, `src/conversation/indexer.ts:327-329`. |
| Orphaned parent | IDE hard-restart reparents the server (ppid changes) without closing stdin | A 5-second `ppidWatchdog` detects the changed parent PID and runs `cleanup("parent exited")`, releasing the lock so the fresh server can index `src/server/index.ts:222-230`. |
| Shutdown | stdin EOF/error, `SIGINT`/`SIGTERM`/`SIGHUP`, parent exit, uncaught exception, or unhandled rejection | `cleanup` sets `shuttingDown`, writes `interrupted` (only if this PID still owns the file and it is not already `done`/`error`), clears the timers, closes both watchers, releases the lock, closes all DBs, and exits — exit code 1 for crashes, 0 otherwise `src/server/index.ts:155-189`, `src/server/index.ts:205-214`. |

## Example: lifecycle phases

A clean boot that acquires the lock rewrites `.mimirs/status` through roughly this sequence (the `<...>` placeholders stand in for real values; each entry is actually one file write of `<status>\n<details>\npid:<n>`):

```
starting / version: <v> / started: <iso>
starting / phase: creating server
starting / phase: tools registered
starting / phase: connecting transport
starting / phase: transport connected
0/<N> files
<k>/<N> files (<pct>%)
done / finished: <iso> / indexed: <i>, skipped: <s>, pruned: <p> / total files: <f>, total chunks: <c>
```

A second server on the same project instead acquires no lock and lands on a single terminal `done` line carrying only the current totals, then runs query-only `src/server/index.ts:423-428`:

```
done / version: <v> / total files: <f>, total chunks: <c>
```

## Open questions

- When the background index rejects, the `.catch` writes an `error` status but the file watcher still starts in the `.finally`, and the conversation folder watcher is started independently (outside the index promise's `.then`) `src/server/index.ts:380-412`. Whether tailing transcripts and watching files while the initial code index is broken is the intended degraded behavior is worth confirming before reordering this block.
- The legacy-offset upgrade probe in `indexConversation` can drop a turn when a new turn's user text duplicates the stored last turn's `src/conversation/indexer.ts:24`. The recorded fix direction is to strengthen the probe (also require the stored assistant text to be a prefix of the re-parsed turn's, or persist and compare the last turn's start byte offset); until then a from-zero re-parse is the recovery path.

## Key source files

| Path | Role |
| --- | --- |
| `src/cli/commands/serve.ts` | CLI entry point; resolves the directory and dynamically imports/starts the server. |
| `src/server/index.ts` | The boot orchestrator: status writes, handler registration, tool registration, transport, DB preflight, lock, background index, watchers, shutdown. |
| `src/tools/index.ts` | `registerAllTools` — binds all 29 MCP tools to the server. |
| `src/indexing/indexer.ts` | `indexDirectory` — the full-project scan that writes file/chunk rows and resolves graph edges. |
| `src/indexing/watcher.ts` | `startWatcher` — the debounced, serialized file watcher. |
| `src/conversation/indexer.ts` | `startConversationFolderWatch` — backfills and tails conversation transcripts. |
| `src/utils/index-lock.ts` | Per-project, reentrant indexing lock used to elect the single indexing instance. |
| `src/utils/dir-guard.ts` | `checkIndexDir` — rejects system-level directories. |
| `src/db/index.ts` | `RagDB` — opens `index.db` (honoring `RAG_DB_DIR`) and owns the schema. |

## Related

- [index command](../cli/index.md) — the same indexing engine run as a one-shot CLI command.
- [index_files](../tools/index-files.md) and [index_status](../tools/index-status.md) — the MCP tools that re-index and report status while the server runs.
- [conversation search](../cli/conversation.md) — uses the transcripts this boot keeps current.
- [drop-box command channel](../mechanisms/control-channel.md) — the consumer this boot starts so the CLI can delegate indexing to the live server.
- [doctor](../cli/doctor.md) — the diagnostic the startup error log points users toward.
