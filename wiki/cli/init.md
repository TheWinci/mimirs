# CLI: init

`mimirs init` is the onboarding command. It prepares a project so that an AI coding agent can use the mimirs RAG tools: it writes the local config, registers the MCP server in the agent's config files, drops tool-usage instructions where the agent will read them, keeps the index out of version control, and then offers to build the search index immediately. It is usually the first command run in a repository, and it is safe to re-run — every step it performs is guarded so that a second run only reports what actually changed.

The command is reached through the top-level dispatcher. When the first argv token is `init`, the dispatcher calls `initCommand`, handing it the raw argument array and a `getFlag` helper that reads the token following a named flag (`src/cli/index.ts:120-122`, `src/cli/index.ts:89-92`). All of the real work lives in `src/cli/commands/init.ts` and the setup helpers in `src/cli/setup.ts`.

## What problem it solves

Wiring an MCP server into an agent by hand means editing several JSON and Markdown files whose formats differ per IDE (Claude Code, Cursor, Windsurf, JetBrains/Junie, GitHub Copilot), getting the server command and the project-directory environment variable exactly right, and remembering to gitignore the index. `init` does all of that in one pass and prints a line for each file it touched, so the user can see exactly what was created or updated.

## Flow

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Dispatch as src/cli/index.ts
    participant Init as initCommand
    participant Setup as runSetup
    participant FS as Project files
    participant Indexer as indexDirectory
    participant DB as index.db

    User->>Dispatch: mimirs init [dir] [--ide ...] [-y] [-v]
    Dispatch->>Init: initCommand(args, getFlag)
    Init->>Init: resolve dir, parse --yes/--verbose/--ide
    Init->>Setup: runSetup(dir, ides)
    Setup->>FS: ensureConfig / ensureAgentInstructions<br>/ ensureMcpJson / ensureGitignore
    Setup-->>Init: { actions, unknownIdes }
    Init->>User: print each action (or "Already set up")
    alt unknown IDE names given
        Init->>User: print MCP JSON snippet to paste manually
    end
    Init->>User: prompt "Index project now? [Y/n]"
    alt user accepts (or -y)
        Init->>Indexer: indexDirectory(dir, db, config, onProgress)
        Indexer->>FS: write .mimirs/status as it walks files
        Indexer->>DB: write file + chunk rows
        Indexer-->>Init: { indexed, skipped, pruned }
        Init->>FS: delete .mimirs/status
        Init->>User: "Done: N indexed, M skipped, P pruned (Ts)"
    end
```

1. The user invokes `mimirs init`, optionally naming a directory and passing flags. The dispatcher matches the `init` case and calls `initCommand` (`src/cli/index.ts:120-122`).
2. `initCommand` resolves the target directory and reads its flags. The directory is the first positional argument if it exists and does not start with `-`, otherwise the current directory; `--yes`/`-y` and `--verbose`/`-v` are detected by membership in the argv array (`src/cli/commands/init.ts:12-13`, `src/cli/flags.ts:63-66`).
3. The `--ide` value (if any) is read with `getFlag` and parsed into a list of IDE names by `parseIdeFlag`; when the flag is absent, `ides` stays `undefined` (`src/cli/commands/init.ts:15-16`).
4. `runSetup` performs the file-writing steps and returns the list of human-readable action strings plus any IDE names it did not recognize (`src/cli/setup.ts:434-450`).
5. `initCommand` prints each action line. If nothing changed and no unknown IDEs were given, it prints `Already set up — nothing to do.` instead (`src/cli/commands/init.ts:18-22`).
6. When the user passed IDE names that mimirs cannot configure automatically, the command prints a header naming those agents and a ready-to-paste MCP JSON snippet (`src/cli/commands/init.ts:24-27`).
7. The command then asks whether to index now. With `-y` it skips the prompt and proceeds; otherwise `confirm` reads a single line from stdin and, since `init` passes `defaultYes = true`, treats a bare Enter (or any answer that is not `n`/`no`) as yes (`src/cli/commands/init.ts:30`, `src/cli/setup.ts:421-432`).
8. If indexing is accepted, the command opens the database and loads config, then runs `indexDirectory`, forwarding progress both to the terminal and to a `.mimirs/status` file (`src/cli/commands/init.ts:31-78`).
9. When indexing finishes, the status file is deleted and a one-line summary of indexed / skipped / pruned counts plus elapsed seconds is printed; the database is closed (`src/cli/commands/init.ts:81-87`).

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `[dir]` | positional path | no | The project directory to set up. Used only if the first argument exists and does not start with `-`; otherwise the current working directory. It is passed through `resolve` to an absolute path (`src/cli/commands/init.ts:12`, `src/cli/flags.ts:63-66`). |
| `--ide` | comma list or `all` | no | Which agents to configure beyond Claude Code. `parseIdeFlag` expands the literal `all` to every known IDE, otherwise splits on commas and trims/lowercases each name (`src/cli/setup.ts:229-232`). Recognized values: `claude`, `cursor`, `windsurf`, `copilot`, `jetbrains` (`src/cli/setup.ts:220-221`). |
| `-y` / `--yes` | flag | no | Skips the indexing prompt and indexes immediately (`src/cli/commands/init.ts:13`, `src/cli/commands/init.ts:30`). |
| `-v` / `--verbose` | flag | no | Switches the indexing output from a single updating progress line to per-file logging (`src/cli/commands/init.ts:14`, `src/cli/commands/init.ts:63-77`). |

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| `.mimirs/config.json` | Written by `ensureConfig` the first time, which calls `loadConfig`; `loadConfig` materializes the defaults on disk when the file is missing (`src/cli/setup.ts:131-137`, `src/config/index.ts:165-168`). |
| Agent instruction blocks | A fenced `## Using mimirs tools` Markdown region written to `CLAUDE.md` (always), plus rule files for any requested or detected IDE: `.cursor/rules/mimirs.mdc`, `.windsurf/rules/mimirs.md`, `.junie/guidelines/mimirs.md`, `.github/copilot-instructions.md` (`src/cli/setup.ts:234-287`). |
| MCP server entries | `mimirs` added under `mcpServers` in `.mcp.json` (always), and in `.cursor/mcp.json`, `.junie/mcp.json`, and the two Windsurf global configs when relevant — each running `bunx mimirs@latest serve` with `RAG_PROJECT_DIR` set to the resolved project path. For GitHub Copilot the entry is written to `.vscode/mcp.json`, which uses a different shape: a top-level `servers` map and a `type: "stdio"` field (`src/cli/setup.ts:352-395`). |
| `.gitignore` entry | `.mimirs/` added (or the file created with that entry) so the local index is not committed (`src/cli/setup.ts:139-151`). |
| Printed action lines | One line per file created or updated, or `Already set up — nothing to do.` (`src/cli/commands/init.ts:18-22`). |
| Manual MCP snippet | Printed only when unknown IDE names were given (`src/cli/commands/init.ts:24-27`). |
| `.mimirs/status` | A short progress string (`scanning files…`, `0/N files`, `12/40 files (30%)`) written during indexing and deleted on completion (`src/cli/commands/init.ts:36-81`). |
| Index rows | File and chunk rows written to the SQLite index under `.mimirs` when indexing runs (`src/cli/commands/init.ts:50-78`). |
| Summary line | `Done: N indexed, M skipped, P pruned (Ts)` after indexing (`src/cli/commands/init.ts:84-86`). |

## What `runSetup` writes

`runSetup` is a small orchestrator that runs four guarded helpers in order and concatenates whatever each reports (`src/cli/setup.ts:434-450`). Each helper checks for an existing marker or path before writing, so a second `init` produces no spurious changes.

- **Config.** `ensureConfig` returns `null` (no action) if `.mimirs/config.json` already exists. Otherwise it calls `loadConfig`, which writes the default config to disk the first time it is read, and reports `Created .mimirs/config.json` (`src/cli/setup.ts:131-137`). On a first read the defaults are materialized verbatim; on later reads missing top-level keys are backfilled from the defaults (`src/config/index.ts:165-210`).

- **Agent instructions.** `ensureAgentInstructions` always injects the tool-usage block into `CLAUDE.md`. For the other IDEs it writes only when that IDE's directory already exists, or when the IDE was explicitly named via `--ide` (in which case the directory is created first) (`src/cli/setup.ts:234-287`). The injected text differs per IDE wrapper: plain Markdown for Claude, Junie, and Copilot; Cursor's `.mdc` is wrapped wholesale with an `alwaysApply: true` frontmatter; Windsurf's `.md` adds a `trigger: always_on` frontmatter (`src/cli/setup.ts:116-124`). The shared block is bounded by a versioned fence — `<!-- mimirs:start v=<hash> -->` … `<!-- mimirs:end -->`, where the version is a 7-char hash of the instruction text (`src/cli/setup.ts:101-108`). Re-running checks for that fence: if the stamped version matches, nothing changes; if it differs, only the fenced region is rewritten in place, leaving the user's surrounding content untouched. An older pre-fence block (just the `## Using mimirs tools` heading) is detected and migrated to the fenced form (`src/cli/setup.ts:157-192`).

- **MCP registration.** `ensureMcpJson` builds one server entry — `bunx mimirs@latest serve` with `RAG_PROJECT_DIR` pointing at the resolved directory — and upserts it into each relevant config file (`src/cli/setup.ts:352-395`). `.mcp.json` is always written for Claude Code, with the entry under `mcpServers`. Cursor (`.cursor/mcp.json`) and Junie (`.junie/mcp.json`) are written when their directory exists or the IDE was requested; Windsurf targets two global paths under `~/.codeium` because it reads its MCP config from the user home, not the project (`src/cli/setup.ts:379-386`). GitHub Copilot is written to `.vscode/mcp.json` through a separate writer, `upsertVscodeMcp`, because VS Code uses a top-level `servers` map and a `type: "stdio"` field instead of `mcpServers` (`src/cli/setup.ts:332-350`, `src/cli/setup.ts:388-392`). Both `upsertMcpJson` and `upsertVscodeMcp` read and merge existing JSON, return `null` if the `mimirs` entry is already present, and report a skip line rather than crashing when the existing file is invalid JSON (`src/cli/setup.ts:308-328`).

- **Gitignore.** `ensureGitignore` creates `.gitignore` with a `.mimirs/` entry (reporting `Created .gitignore with .mimirs/`), or appends the entry if the file exists and does not already ignore the index (reporting `Added .mimirs/ to .gitignore`) (`src/cli/setup.ts:139-151`).

## The `--ide` flag

`--ide` is captured with the `getFlag` helper, which returns the token immediately after the flag (`src/cli/index.ts:89-92`). Its value is passed to `parseIdeFlag`, which normalizes the input (`src/cli/setup.ts:229-232`):

| input | result |
| --- | --- |
| `all` | every known IDE: `claude, cursor, windsurf, copilot, jetbrains` |
| `cursor,windsurf` | `["cursor", "windsurf"]` (trimmed and lowercased) |
| (flag absent) | `undefined` — only auto-detected IDEs plus the always-on Claude files |

When the flag is absent, `ides` is `undefined` and the IDE-specific helpers fall back to filesystem detection: they write Cursor, Windsurf, Junie, or Copilot files only if those tools' directories already exist in the project. (For Copilot the MCP entry is also written when a `.vscode` directory exists, since that is where VS Code reads it from.) Naming an IDE with `--ide` forces its directory to be created and its files written even on a fresh checkout (`src/cli/setup.ts:243-284`, `src/cli/setup.ts:362-392`).

## MCP snippet for unknown IDEs

`parseIdeFlag` accepts any string, so a typo or an unsupported agent name flows through unfiltered. `runSetup` runs the value through `unknownIdes`, which returns every name not in the known set (`src/cli/setup.ts:223-227`). When that list is non-empty, `initCommand` cannot configure those agents automatically, so it prints a header naming them followed by the ready-to-paste `mcpConfigSnippet` (`src/cli/commands/init.ts:24-27`). The snippet is a `mimirs` server object in the `mcpServers` shape — `bunx mimirs@latest serve` with `RAG_PROJECT_DIR` set to the absolute project path — formatted as indented JSON for the user to copy into whatever config their agent uses (`src/cli/setup.ts:289-298`).

## Optional index prompt and indexing

After setup, indexing is offered, not forced. `confirm` opens a readline interface, prints the question, and returns its `defaultYes` value for any answer it does not recognize, after trimming and lowercasing; only `n`/`no` is treated as no and only `y`/`yes` as an explicit yes (`src/cli/setup.ts:421-432`). `init` calls it with `defaultYes = true`, so a bare Enter (or any other unrecognized input) means yes (`src/cli/commands/init.ts:30`). With `-y`, the prompt is skipped entirely (`src/cli/commands/init.ts:13`, `src/cli/commands/init.ts:30`).

If indexing proceeds, the command constructs a `RagDB` for the directory (which opens the SQLite index under `.mimirs`) and loads the config, then calls `indexDirectory` (`src/cli/commands/init.ts:32-33`, `src/cli/commands/init.ts:50`). The progress callback does double duty:

- It maintains a `.mimirs/status` file so other processes (for example the doctor command or a watching editor) can see progress out of band. It writes `scanning files…` (when the engine reports the scan), `0/N files` once the file count is known, then `processed/total (pct%)` after each completed file (`src/cli/commands/init.ts:36-70`).
- It drives terminal output. In the default mode it builds a `createQuietProgress` renderer (a single updating line); with `-v` it forwards every message to `cliProgress` for per-file logging (`src/cli/commands/init.ts:63-77`, `src/cli/progress.ts:28-106`).

`indexDirectory` collects the project's files (preferring git's view so `.gitignore` is respected, falling back to a recursive walk for non-git directories), embeds and stores file and chunk rows, prunes files that no longer exist, resolves imports, and returns an `IndexResult` with `indexed`, `skipped`, and `pruned` counts (`src/indexing/indexer.ts:859-1008`, `src/indexing/indexer.ts:48-55`). On return, the command deletes the status file, prints the summary line with elapsed seconds, and closes the database (`src/cli/commands/init.ts:81-87`). The indexing portion is the same machinery the standalone [index](index.md) command uses, including how it decides which files to scan.

## State changes

- **Setup files: absent → written.** Before `init`, a fresh project has no `.mimirs/config.json`, no MCP registration, and no tool instructions. `runSetup(dir, ides)` writes the config, the agent instruction blocks, the MCP server entries, and the gitignore line, then returns the list of files it touched (`src/cli/commands/init.ts:17`, `src/cli/setup.ts:434-450`). This matters because it is what makes the mimirs tools discoverable by the agent at all. Because every writer is fence- or existence-guarded, a second run leaves the state unchanged unless the instruction block's stamped version has changed, in which case only the fenced region is refreshed.

- **Index rows: empty → indexed.** When the user accepts the index prompt, `indexDirectory` writes file and chunk rows into the SQLite index under `.mimirs` (`src/cli/commands/init.ts:50-78`, `src/indexing/indexer.ts:931-958`). This is the state that makes `search` and `read_relevant` return results. It is optional within `init`; declining the prompt leaves the index empty until [index](index.md) is run later.

## Branches and failure cases

- **Directory argument vs. default.** A first argument that does not start with `-` is treated as the project directory; otherwise the current directory is used (`src/cli/commands/init.ts:12`, `src/cli/flags.ts:63-66`).
- **Nothing to do.** If `runSetup` returns no actions and there are no unknown IDEs, the command prints `Already set up — nothing to do.` and still proceeds to the index prompt (`src/cli/commands/init.ts:18-22`).
- **Unknown IDE names.** Counts as a reason to print output even when no files changed, and triggers the manual MCP snippet (`src/cli/commands/init.ts:18`, `src/cli/commands/init.ts:24-27`).
- **Auto-yes vs. prompt.** `-y` skips the prompt; without it, declining (`n`) skips indexing and the command exits after setup (`src/cli/commands/init.ts:30-31`).
- **Existing MCP config with the entry.** `upsertMcpJson` returns `null` when `mcpServers.mimirs` is already present, so the file is left untouched and no action line is printed (`src/cli/setup.ts:316`). The VS Code writer does the same against its `servers.mimirs` key (`src/cli/setup.ts:341`).
- **Invalid existing MCP JSON.** Rather than throwing, the upsert writers return a `Skipped … (invalid JSON — fix it manually or delete it)` action so the user is told to repair the file (`src/cli/setup.ts:313-315`, `src/cli/setup.ts:338-340`).
- **IDE files when the directory is absent and not forced.** Cursor, Windsurf, Junie, and Copilot files are skipped unless their directory exists or the IDE was requested via `--ide` (`src/cli/setup.ts:243-284`, `src/cli/setup.ts:362-392`).
- **Status-file write failures.** Writing `.mimirs/status` is wrapped in a try/catch and is best-effort; a failure there does not interrupt indexing (`src/cli/commands/init.ts:38-43`).
- **Index lock held by another process.** `indexDirectory` funnels concurrent indexers through a process lock; if another mimirs process owns it, indexing is skipped for this run, the progress callback reports it, and the result carries `locked: true` (`src/indexing/indexer.ts:907-915`). `init` still prints its summary line using the (zero) counts in that case.
- **Per-file indexing errors.** Errors on individual files are collected into `result.errors` and reported through progress without aborting the whole run (`src/indexing/indexer.ts:952-956`).

## Example

```bash
# Set up the current directory for Claude Code and Cursor, then index without prompting
mimirs init . --ide claude,cursor -y
```

Illustrative output:

```
Created .mimirs/config.json
Created CLAUDE.md
Created .cursor/rules/mimirs.mdc
Created .mcp.json with mimirs
Created .cursor/mcp.json with mimirs
Created .gitignore with .mimirs/

Indexing /path/to/project...
Found 158 files to index
Done: 158 indexed, 0 skipped, 0 pruned (12.4s)
```

The summary field names (`indexed`, `skipped`, `pruned`) and the action-line wording match the source; the specific paths, counts, and timing above are synthetic.

## Key source files

- `src/cli/index.ts` — top-level dispatcher; matches the `init` command and provides `getFlag` (`src/cli/index.ts:89-92`, `src/cli/index.ts:120-122`).
- `src/cli/commands/init.ts` — the command handler: flag parsing, setup invocation, the index prompt, and progress wiring (`src/cli/commands/init.ts:11-89`).
- `src/cli/setup.ts` — the guarded setup helpers: config, agent instructions, MCP registration (`.mcp.json`, `.cursor/mcp.json`, `.junie/mcp.json`, Windsurf globals, and VS Code's `.vscode/mcp.json`), gitignore, IDE parsing, the snippet, and `confirm`.
- `src/cli/progress.ts` — the quiet and verbose terminal progress renderers passed to the indexer.
- `src/indexing/indexer.ts` — `indexDirectory`, the shared indexing routine that writes file/chunk rows and returns the summary counts (`src/indexing/indexer.ts:859-1008`).

## Related commands

- [index](index.md) — runs the same indexing routine as a standalone command, for re-indexing after `init`.
- [cleanup](cleanup.md) — the inverse operation; removes the files and index `init` creates.
- [status](status.md) — reports index stats after the index rows exist.
