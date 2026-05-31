# CLI: map

`mimirs map` prints the project's import/export dependency graph as plain,
information-dense text. It reads the graph that indexing already stored in the
local database and renders it — it does not parse source or recompute anything.
Reach for it when you want a quick, whole-project (or one-file-neighborhood)
picture of what depends on what, without opening import statements across many
files.

The command is registered in the CLI dispatcher and forwards straight to its
handler `src/cli/index.ts:133-135`. The handler opens the database, calls the
shared graph renderer `generateProjectMap`, prints the result, and closes the
database `src/cli/commands/map.ts:6-20`.

## What it produces

Despite older help text describing a structured-text "graph", the renderer emits
an indented text report, not Mermaid. The header line states the level and a
count, for example `## Project Map (file-level, 142 files)`, followed by
per-node blocks listing each file's exports, what it depends on, and what
depends on it `src/graph/resolver.ts:266-309`. See
[Branches and failure cases](#branches-and-failure-cases) for the stale help
string.

## How the flow runs

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Dispatch as src/cli/index.ts
    participant Handler as mapCommand
    participant DB as RagDB
    participant Renderer as generateProjectMap
    User->>Dispatch: mimirs map [dir] [--focus F] [--zoom file|directory]
    Dispatch->>Handler: mapCommand(args, getFlag)
    Handler->>Handler: resolve [dir] arg, read --focus and --zoom
    Handler->>DB: new RagDB(dir) opens .mimirs index
    Handler->>Renderer: generateProjectMap(db, { projectDir, focus, zoom })
    alt --focus given
        Renderer->>DB: getFileByPath(resolve(dir, focus))
        Renderer->>DB: getSubgraph([fileId], maxHops=2)
    else no focus
        Renderer->>DB: getGraph()
    end
    DB-->>Renderer: { nodes, edges }
    Renderer->>Renderer: render file-level or directory-level text
    Renderer-->>Handler: map string
    Handler->>User: print to stdout
    Handler->>DB: db.close()
```

1. The user runs `mimirs map`, optionally with a directory, `--focus`, and
   `--zoom`. The first positional word after `map` is the directory; flags can
   appear in any order.
2. The dispatcher matches the `map` command and calls the handler with the raw
   argument list and a `getFlag` lookup `src/cli/index.ts:133-135`.
3. The handler resolves the target directory: it uses `args[1]` only when that
   word exists and does not start with `--`, otherwise it defaults to the
   current directory `.` `src/cli/commands/map.ts:7`. It then reads `--focus`
   and `--zoom`, defaulting zoom to `"file"` `src/cli/commands/map.ts:9-10`.
4. It opens the database for that directory by constructing `RagDB(dir)`
   `src/cli/commands/map.ts:8`. This is the same on-disk index that `mimirs
   index` populates.
5. It calls `generateProjectMap` with the resolved directory, the focus value
   (or `undefined`), and the zoom level `src/cli/commands/map.ts:12-16`.
6. Inside the renderer, the presence of `--focus` selects which graph to load.
   With a focus file, it looks the file up by absolute path and pulls a
   bounded neighborhood; without one, it loads the entire graph
   `src/graph/resolver.ts:195-204`.
7. The database returns plain node and edge arrays. Nodes carry each file's id,
   path, and its exported symbols; edges carry resolved import relationships
   `src/db/graph.ts:816-868`.
8. The renderer turns that graph into text — file-level by default, or
   directory-level when `--zoom directory` was given
   `src/graph/resolver.ts:220-224`.
9. The handler prints the returned string to stdout via the CLI logger and
   closes the database `src/cli/commands/map.ts:18-19`.

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `[dir]` | positional string | no | Project directory whose index to read. Taken from the first non-flag word after `map`; defaults to the current working directory when absent `src/cli/commands/map.ts:7`. |
| `--focus F` | string | no | A file path (relative to `dir`) to center the graph on. When set, only that file's neighborhood within two import hops is shown `src/cli/commands/map.ts:9`, `src/graph/resolver.ts:195-204`. |
| `--zoom file\|directory` | string | no | Rendering granularity. `file` (default) lists individual files; `directory` collapses files into folders and shows folder-to-folder edge counts `src/cli/commands/map.ts:10`, `src/graph/resolver.ts:220-224`. |

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| Dependency map text | Printed to stdout. A header line with the level and a count, then indented per-node (or per-directory) blocks. Nothing is written to disk and no database state changes `src/cli/commands/map.ts:18`, `src/graph/resolver.ts:266-309`. |

The command is read-only. It opens the index, queries it, prints, and closes —
no rows are inserted or updated, so there is no state-change section for this
flow.

## File-level output (default)

When zoom is `file`, the renderer builds two adjacency maps from the edges —
what each node depends on, and what depends on each node — keyed by file id and
stored as project-relative paths `src/graph/resolver.ts:232-251`. It then
splits nodes into two groups: files that nothing else in the index imports, and
everything else `src/graph/resolver.ts:255-264`.

The "no importers" group is printed first under a `### Files With No Importers`
heading, then the rest under `### Files` `src/graph/resolver.ts:293-306`. For
each file the renderer prints, in order, its relative path, up to eight exports
as `name (type)` with a `, +N more` suffix when there are more, its
`depends_on` list, and its `depended_on_by` list — each list omitted when empty
`src/graph/resolver.ts:269-291`. The comment in source is explicit that "no
importers" is structural fan-in inside the indexed set, not a guarantee that
the file is a real application entry point `src/graph/resolver.ts:253-254`.

## Directory-level output (`--zoom directory`)

When zoom is `directory`, the renderer groups every node by the directory of
its relative path (falling back to `.` for root files) and records the file's
basename under that directory `src/graph/resolver.ts:319-325`. Edges are
collapsed to directory-to-directory pairs, skipping edges that stay inside one
directory, and counted `src/graph/resolver.ts:329-336`.

The output lists each directory with its file count and the files it contains,
then a `### Dependencies` section with one line per cross-directory pair and its
import count, pluralized as `import`/`imports`
`src/graph/resolver.ts:338-353`.

## `--focus` neighborhood

A focus value scopes the graph to one file plus its near neighbors instead of
the whole project. The renderer resolves the focus path against the project
directory and looks the file up in the index by its absolute path
`src/graph/resolver.ts:195-196`. If found, it asks the database for a subgraph
seeded by that file id, expanded by the default two hops
`src/graph/resolver.ts:198`.

The subgraph walk is a breadth-first expansion run directly in SQL. It starts
from the focus file and, per hop, pulls every import edge where the focus side
appears as either importer or importee, then folds the newly seen files into
the next frontier until two hops are done `src/db/graph.ts:880-908`. After the
walk it loads nodes and edges only for the visited file ids, batching queries to
stay under SQLite's parameter limit `src/db/graph.ts:910-981`. A prior version
batched both edge endpoints with the same slice and silently dropped edges whose
ends fell in different batches; the current code batches by `file_id` alone and
filters the other end in JS against the visited set
`src/db/graph.ts:944-978`. The resulting neighborhood is then rendered with the
same file-level or directory-level formatter as a full graph.

## Branches and failure cases

| condition | behavior |
| --- | --- |
| No `[dir]` arg | Defaults to the current working directory `src/cli/commands/map.ts:7`. |
| `--focus` set, file found | Renders the two-hop neighborhood of that file `src/graph/resolver.ts:197-198`. |
| `--focus` set, file not in index | The lookup returns nothing, the graph is set to empty, and the command prints `No files indexed or no dependencies found.` `src/graph/resolver.ts:199-210`. |
| No `--focus` | Loads and renders the whole stored graph `src/graph/resolver.ts:202-203`. |
| Empty index / no resolved edges | Same empty message as above; the graph has zero nodes so the renderer returns the message before any formatting `src/graph/resolver.ts:206-211`. |
| `--zoom directory` | Renders the directory-level report `src/graph/resolver.ts:220-221`. |
| Any other `--zoom` value (including the default `file`) | Falls through to the file-level report. The handler casts the flag string directly to the zoom type without validation, so an unrecognized value such as `--zoom foo` does not error — it simply takes the file-level branch `src/cli/commands/map.ts:10`, `src/graph/resolver.ts:220-224`. |

Two further points matter when reading the output:

- The graph only reflects imports that indexing managed to resolve to another
  indexed file. Edges come exclusively from `file_imports` rows whose
  `resolved_file_id` is set `src/db/graph.ts:847-857`. Bare/external packages
  and imports to files outside the index never appear as edges, so a file can
  show an empty `depends_on` even though its source imports third-party
  modules.
- "Files With No Importers" counts only importers inside the index. A file
  imported solely by something that was excluded from indexing (tests,
  benchmarks, or a path outside the patterns) will appear here even though it
  is used.

## Example

```bash
# Whole project, file level (default)
mimirs map

# A different project directory
mimirs map ./packages/core

# One file's two-hop neighborhood
mimirs map --focus src/server.ts

# Collapse to folder-to-folder dependencies
mimirs map --zoom directory
```

Illustrative file-level output (paths and counts are synthetic):

```
## Project Map (file-level, 3 files)

### Files With No Importers
  src/main.ts
    depends_on: src/cli/index.ts

### Files
  src/cli/index.ts
    exports: main (function)
    depends_on: src/cli/commands/map.ts
    depended_on_by: src/main.ts
  src/cli/commands/map.ts
    exports: mapCommand (function)
    depended_on_by: src/cli/index.ts
```

## Open questions

The built-in usage text advertises `mimirs map` as generating a "project
dependency graph (structured text)" `src/cli/index.ts:48-49`. That phrasing is
current, but the doc comment on `generateProjectMap` still records that the
format replaced an older Mermaid output `src/graph/resolver.ts:176-179` — worth
knowing if you grep for "Mermaid" expecting this command to emit it. It does
not; it emits indented text.

## Related

The `project_map` MCP tool is the in-server counterpart to this command. It
calls the same `generateProjectMap` renderer with the same `focus`/`zoom`
options, and additionally exposes a `format` argument that can return the graph
as JSON `src/tools/graph-tools.ts:4`, `src/tools/graph-tools.ts:29-39`. The CLI
command never passes `format`, so it always uses the default text rendering. See
[project_map](../tools/project-map.md).

## Key source files

| path | role |
| --- | --- |
| `src/cli/index.ts` | Registers the `map` command and dispatches to the handler `src/cli/index.ts:133-135`. |
| `src/cli/commands/map.ts` | Handler: resolves args, opens the index, calls the renderer, prints, closes `src/cli/commands/map.ts:6-20`. |
| `src/graph/resolver.ts` | Hosts `generateProjectMap` and the file-level and directory-level text formatters `src/graph/resolver.ts:180-356`. |
| `src/db/graph.ts` | Backs the renderer with `getGraph` (full graph) and `getSubgraph` (focused neighborhood) `src/db/graph.ts:816-981`. |
