# CLI: serve

`mimirs serve` is the command an editor or coding agent runs to start the long-running MCP server that answers tool calls — search, read_relevant, project_map, and the rest — over stdio. In normal use you never type it by hand. An IDE's MCP client launches the published `mimirs` binary with `serve` as its first argument and then exchanges JSON-RPC messages with the process over its standard input and output. This page covers the thin CLI layer in front of that server: how the subcommand is dispatched, why the server code is loaded the unusual way it is, what gets written to disk when loading fails, and how control is handed off to the real server boot.

The handler itself is deliberately tiny. Its real job is to load and start the server while guaranteeing that a failure to even *load* the server's native dependencies produces a visible, debuggable artifact on disk instead of a silent crash. The full server lifecycle — transport handshake, background indexing, file watchers, shutdown — lives in [Server: MCP stdio start](../server/start.md).

## What runs, end to end

The published binary `mimirs` points at `src/main.ts` (the `bin` field in `package.json`), which immediately calls `main()` from `src/cli/index.ts`. `main` reads `process.argv`; if the first word is missing or is `--help`/`-h`, it prints usage and exits `0` (`src/cli/index.ts:87-90`). Otherwise it runs the dispatcher inside a `try/catch` and forwards to `dispatch()` (`src/cli/index.ts:92-103`).

`dispatch()` is a `switch` on the command word. Almost every subcommand is statically imported at the top of the file, but `serve` is the one exception: its case body does `await import("./commands/serve")` to load the handler on demand, then calls `serveCommand()` (`src/cli/index.ts:107-111`). The handler then loads the server module — again dynamically — writes diagnostics if that load throws, and finally calls `startServer()` to actually run the server (`src/cli/commands/serve.ts:4-53`).

```mermaid
sequenceDiagram
    autonumber
    participant IDE as IDE / MCP client
    participant Main as src/main.ts
    participant Dispatch as dispatch()<br>(cli/index.ts)
    participant Serve as serveCommand()<br>(commands/serve.ts)
    participant ServerMod as server module<br>(src/server)
    IDE->>Main: spawn `mimirs serve`<br>(RAG_PROJECT_DIR set)
    Main->>Dispatch: main() then dispatch()
    Dispatch->>Serve: await import("./commands/serve"); serveCommand()
    Serve->>Serve: dir = RAG_PROJECT_DIR || cwd()
    Serve->>IDE: stderr "Starting MCP server (stdio) for <dir>"
    Serve->>ServerMod: await import("../../server")
    alt module load fails (native deps, top-level await)
        ServerMod-->>Serve: throws at module load
        Serve->>Serve: write .mimirs/server-error.log + status
        Serve->>IDE: stderr "FATAL: server module failed to load"
        Serve-->>Main: rethrow err
        Main->>IDE: crash-level server-error.log + exit 1
    else module loads
        ServerMod-->>Serve: { startServer }
        Serve->>ServerMod: await startServer()
        ServerMod-->>IDE: connect stdio transport, serve tools
        Serve->>IDE: stderr "Server ready — listening on stdin/stdout"
    end
```

1. The MCP client spawns the `mimirs` binary with `serve` as the first argument, typically with the environment variable `RAG_PROJECT_DIR` pointing at the project root. `src/main.ts` runs `main()`.
2. `main()` checks the command word for help/empty, then calls `dispatch()` inside a `try/catch` that is meant only to intercept bad-flag errors (`src/cli/index.ts:92-102`).
3. The `serve` case dynamically imports the handler module and awaits `serveCommand()` (`src/cli/index.ts:107-110`). This is an ordinary lazy import of the handler code, not the fault-isolation import — that one lives inside the handler.
4. `serveCommand()` resolves the target directory from `RAG_PROJECT_DIR`, falling back to `process.cwd()` (`src/cli/commands/serve.ts:5`).
5. It writes a one-line `Starting MCP server (stdio) for <dir>` notice to stderr so the client's log shows the server was at least invoked (`src/cli/commands/serve.ts:6`).
6. It dynamically imports the server module. This is the load isolated behind `try/catch`, because the server transitively pulls in native modules and runs a top-level `await` (`src/cli/commands/serve.ts:13-14`).
7. If that import throws, the catch block writes `.mimirs/server-error.log` and `.mimirs/status`, prints a `FATAL` line to stderr, and rethrows the original error (`src/cli/commands/serve.ts:15-48`).
8. On success it destructures `startServer` from the imported module and awaits it; `startServer` connects the stdio transport and begins serving tool calls (`src/cli/commands/serve.ts:51`, `src/server/index.ts:88`).
9. After `startServer()` returns, the handler writes a final `Server ready — listening on stdin/stdout` line to stderr (`src/cli/commands/serve.ts:52`).

## Why the server module is imported dynamically

This is the single most important design choice in the handler, and the reason it exists as its own file at all. The server module `src/server/index.ts` runs a top-level `await import("../../package.json")` to read the version (`src/server/index.ts:18`) and transitively pulls in native dependencies — `bun:sqlite` and `sqlite-vec` — through `RagDB` and the indexing code (`src/server/index.ts:6,8`).

If the server were imported with a static `import` at the top of `src/cli/index.ts`, those native modules and that top-level await would be resolved while the CLI's own module graph was still loading, *before* any `try/catch` or error handler had a chance to run. A failure there — a missing native library, an incompatible build, a rejecting top-level await — would crash the entire `mimirs` process during module evaluation. That would take down every other subcommand as well, including `doctor`, which is the very tool a user reaches for to diagnose the problem. The comment at `src/cli/index.ts:16-18` records exactly this reasoning, and the matching comment at `src/cli/commands/serve.ts:8-11` explains why the import is deferred into a `try`.

By moving the server import inside `serveCommand()` and wrapping it in `try/catch`, a load failure is caught at runtime, turned into written diagnostics, and rethrown cleanly. The CLI process stays in control long enough to leave a trail. There are effectively two layers of laziness: `dispatch()` lazily imports the handler module (`src/cli/index.ts:108`), and the handler lazily imports the server module (`src/cli/commands/serve.ts:14`). Only the second layer matters for fault isolation. The type annotation `typeof import("../../server").startServer` keeps `startServer` correctly typed without forcing an eager load (`src/cli/commands/serve.ts:12`).

## Diagnostics written on load failure

When the server import throws, the catch block does best-effort reporting in three forms (`src/cli/commands/serve.ts:15-48`):

- A stderr line `[mimirs] FATAL: server module failed to load: <message>`. stderr is not always visible in MCP clients, so it is never relied on alone (`src/cli/commands/serve.ts:18`).
- A file `.mimirs/server-error.log` under the target directory, containing a timestamp, the error message, the full stack trace, and the hint `To diagnose: bunx mimirs doctor` (`src/cli/commands/serve.ts:24-35`).
- A file `.mimirs/status` whose first line is `error`, followed by `phase: module load failed`, a failure timestamp, and the error message (`src/cli/commands/serve.ts:36-44`).

The `.mimirs` directory is created with `mkdirSync(..., { recursive: true })` first so the writes do not fail on a fresh project (`src/cli/commands/serve.ts:22-23`). All of this disk I/O is wrapped in its own inner `try/catch` with an empty catch body: if even writing the diagnostics fails (read-only filesystem, permission denied), the handler does not throw from the reporting code — it silently moves on and still rethrows the original load error (`src/cli/commands/serve.ts:45-48`).

That rethrown error bubbles up through `dispatch()` and `main()`. Because it is not a `CliFlagError`, `main`'s catch re-throws it rather than printing a flag message (`src/cli/index.ts:97-101`), so it reaches the top-level handler in `src/main.ts:5-34`. That handler writes its *own* `.mimirs/server-error.log` — this one labelled as a crash (`mimirs server crashed at ...`, `src/main.ts:19`) — prints `[mimirs] FATAL: <msg>`, and calls `process.exit(1)`. The net effect of a load failure is a non-zero exit plus an overwritten `server-error.log`; the `status` file written by the handler is what `status` and [doctor](doctor.md) read to report the failed phase.

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `RAG_PROJECT_DIR` | environment variable | no | The project directory the server should operate on. `serveCommand()` reads it and falls back to `process.cwd()` when unset (`src/cli/commands/serve.ts:5`). The same variable is read again, independently, inside `startServer()` to locate the index and write status (`src/server/index.ts:91`). MCP clients set it when spawning the server so it targets the open project rather than wherever the process happened to start. |

The `serve` command takes no positional arguments and no flags. `dispatch()` matches the bare word `serve` and calls `serveCommand()` with no arguments (`src/cli/index.ts:107-110`); anything typed after `serve` on the command line is ignored by this handler.

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| stdio MCP server process | On success, control passes to `startServer()`, which connects a `StdioServerTransport` and serves tool calls over the process's stdin/stdout until shutdown (`src/cli/commands/serve.ts:51`, `src/server/index.ts:203-206`). The handler does not return while the server runs. |
| stderr progress lines | Human-readable lines for the client log: the `Starting MCP server (stdio) for <dir>` notice at launch, a `FATAL` line on load failure, and `Server ready — listening on stdin/stdout` after `startServer()` returns (`src/cli/commands/serve.ts:6,18,52`). |
| `.mimirs/server-error.log` | Written only on module-load failure: timestamp, error message, stack, and a `bunx mimirs doctor` hint (`src/cli/commands/serve.ts:24-35`). A second, crash-labelled copy is written by `src/main.ts:16-27` if the error reaches the top level. |
| `.mimirs/status` | Written only on module-load failure: first line `error`, then `phase: module load failed`, a timestamp, and the message (`src/cli/commands/serve.ts:36-44`). All successful-startup status lines (`starting`, phase markers, `done`) are written later by `startServer()` itself, not by this handler (`src/server/index.ts:110,179`). |

## State changes

| change | before | after | why it matters |
| --- | --- | --- | --- |
| `.mimirs/server-error.log` on load failure | absent or stale from a prior run | overwritten with the current failure's timestamp, message, and stack | This is the durable record a developer or `doctor` reads when the server will not start, because stderr is often invisible to MCP clients (`src/cli/commands/serve.ts:24-35`). |
| `.mimirs/status` on load failure | may hold `done`, `interrupted`, or a previous `error` | replaced with an `error` / `phase: module load failed` block | Status readers (`status`, `doctor`) report the precise phase the server died in, distinguishing a load failure from a later runtime crash (`src/cli/commands/serve.ts:36-44`). |

Both writes are best-effort and silently skipped if the filesystem rejects them (`src/cli/commands/serve.ts:45-47`). On the success path this handler changes no state of its own — all further state changes (the `starting`/`done` status sequence, the index lock, the index itself) belong to `startServer()` and are described in [Server: MCP stdio start](../server/start.md).

## Branches and failure cases

| branch | what happens |
| --- | --- |
| Dispatch reaches the `serve` case | The handler module is dynamically imported and `serveCommand()` is awaited (`src/cli/index.ts:107-110`). |
| `RAG_PROJECT_DIR` set vs unset | Set: that directory is the target. Unset: falls back to `process.cwd()` (`src/cli/commands/serve.ts:5`). |
| Server module imports cleanly | `startServer` is destructured from the import and awaited; the server runs (`src/cli/commands/serve.ts:14,51`). |
| Server module throws at load | Caught; stderr `FATAL`, `.mimirs/server-error.log`, and `.mimirs/status` are written, then the error is rethrown (`src/cli/commands/serve.ts:15-48`). |
| Diagnostics write also fails | The inner `try/catch` swallows the write error; the original load error is still rethrown (`src/cli/commands/serve.ts:45-48`). |
| `startServer()` itself throws | Not caught here — it propagates out of `serveCommand()` through `dispatch()` and `main()` to the top-level handler in `src/main.ts:5-34`, which writes a crash log and exits `1`. (Note: `startServer` catches most of its own startup failures internally and writes status without throwing, so reaching this branch is rare — see [Server: MCP stdio start](../server/start.md).) |
| Rethrown error reaches `main()` | Because it is not a `CliFlagError`, `main`'s catch re-throws it rather than printing a flag message and exiting cleanly (`src/cli/index.ts:97-101`). |
| Normal completion | After `startServer()` returns, the `Server ready` line is written; the process stays alive serving over stdio until a shutdown signal or stdin EOF closes it (`src/cli/commands/serve.ts:52`, `src/server/index.ts:154-163`). |

The `serve` case never passes through the numeric flag parsing in `src/cli/flags.ts`, so the `CliFlagError` path in `main`'s catch (`src/cli/index.ts:97-99`) never applies to it — that branch exists for data commands that take `--top`, `--days`, and similar numeric flags.

## Example

A client launches the server roughly like this (the exact spawn is controlled by the IDE's MCP config; the repo also exposes it as the `server` npm script, `bun run src/main.ts serve`):

```bash
RAG_PROJECT_DIR=/path/to/project mimirs serve
```

Stderr on a healthy start (paths are illustrative):

```
[mimirs] Starting MCP server (stdio) for /path/to/project
[mimirs] Server ready — listening on stdin/stdout
```

On a load failure, stderr shows the FATAL line and `.mimirs/server-error.log` is written:

```
[mimirs] Starting MCP server (stdio) for /path/to/project
[mimirs] FATAL: server module failed to load: <native dep error>
```

```
mimirs server module failed to load at <iso-timestamp>

Error: <native dep error>

<stack trace>

To diagnose: bunx mimirs doctor
```

When that happens, the recovery path is the [doctor](doctor.md) command, which inspects `.mimirs/server-error.log` and `.mimirs/status` to explain why startup failed.

## Key source files

| file | role |
| --- | --- |
| `src/main.ts` | Binary entrypoint; calls `main()` and owns the top-level crash handler that writes a crash-labelled `server-error.log` and exits `1` (`src/main.ts:5-34`). |
| `src/cli/index.ts` | CLI dispatcher; the `serve` case lazily imports and runs `serveCommand()` (`src/cli/index.ts:107-111`). |
| `src/cli/commands/serve.ts` | The `serve` handler — dynamically imports the server module, writes diagnostics on load failure, and delegates to `startServer()`. |
| `src/server/index.ts` | Defines `startServer()`, the full server lifecycle this command hands off to. |

## Related pages

- [Server: MCP stdio start](../server/start.md) — what `startServer()` does once `serve` hands off: transport handshake, background indexing, watchers, and shutdown.
- [doctor](doctor.md) — the diagnostic command named in the failure logs.
- [CLI index](index.md) — the dispatcher and the full list of subcommands.
