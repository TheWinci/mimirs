# Tool: project_map

`project_map` turns the stored import graph of a codebase into a readable
dependency map. Instead of opening dozens of files and tracing `import`
statements by hand, an agent (or a person) calls this tool once and gets a
single document describing which files exist, what each one exports, what it
depends on, and what depends on it. It answers questions like "what is the
shape of this project?", "what does this file pull in?", and "which files have
no importers (likely entry points or dead code)?".

The tool reads only what indexing already stored — it does not parse source on
demand. The graph is built earlier, when files are indexed: the indexer
extracts each file's imports and exports, then resolves each import specifier
to a concrete indexed file. So `project_map` is fast (a few SQL reads plus
in-memory formatting) but only as complete as the last index run. The handler
lives in `src/tools/graph-tools.ts:8`, the formatting in
`src/graph/resolver.ts:181`, and the graph reads in `src/db/graph.ts`.

## How a call flows

```mermaid
sequenceDiagram
    autonumber
    participant Agent
    participant Tool as project_map handler
    participant Resolver as generateProjectMap
    participant DB as RagDB (SQLite)

    Agent->>Tool: { directory?, focus?, zoom?, format? }
    Tool->>Tool: resolveProject(directory) → projectDir + db
    Tool->>Resolver: generateProjectMap(db, { projectDir, focus, zoom, format })
    alt focus given
        Resolver->>DB: getFileByPath(resolve(projectDir, focus))
        DB-->>Resolver: file record or undefined
        Resolver->>DB: getSubgraph([file.id], maxHops=2)
        DB-->>Resolver: nodes + edges near that file
    else no focus
        Resolver->>DB: getGraph()
        DB-->>Resolver: every file + every resolved edge
    end
    Resolver->>Resolver: format as text or JSON, by zoom level
    Resolver-->>Tool: map string
    Tool-->>Agent: text (+ tip footer) or raw JSON
```

1. The agent calls `project_map` with four optional arguments. None are
   required; with no arguments the tool maps the whole indexed project at file
   level as readable text.
2. The handler calls `resolveProject(directory, getDB)`, which resolves the
   directory to an absolute path (falling back to `RAG_PROJECT_DIR` or the
   current working directory), confirms it exists, loads config, and opens the
   matching database `src/tools/index.ts:22`. A non-existent directory throws
   here before any map work begins.
3. The handler calls `generateProjectMap` with the resolved project directory
   and the caller's options, defaulting `zoom` to `"file"` and `format` to
   `"text"` `src/tools/graph-tools.ts:32`.
4. If `focus` is set, the resolver looks up that file by absolute path. If found,
   it pulls only the neighborhood around it; if not found, it produces an empty
   graph rather than erroring `src/graph/resolver.ts:195`.
5. `getSubgraph` runs a breadth-first walk over the import edges starting at the
   focus file, up to `maxHops` (fixed at 2) in both directions — importers and
   dependencies `src/db/graph.ts:870`.
6. With no `focus`, `getGraph` loads every file, every export, and every
   resolved edge in three batched SQL queries `src/db/graph.ts:816`.
7. The resolver picks one of four formatters based on `zoom` and `format`, then
   builds the output string `src/graph/resolver.ts:213-224`.
8. The string returns to the handler. For `format: "json"` it is returned
   verbatim. For text, the handler appends a one-line tip footer pointing the
   caller at `search`, `depends_on`, and `depended_on_by` for follow-up
   `src/tools/graph-tools.ts:39-49`.

## Where the graph data comes from

`project_map` never parses source files itself. The nodes and edges it renders
are rows in the `files`, `file_exports`, and `file_imports` tables, populated
during indexing. After a file is chunked and its raw imports stored, the
indexer calls `resolveImports`, which matches each import specifier (for
example `../db`) to a concrete indexed file id and writes that id into
`file_imports.resolved_file_id` `src/indexing/indexer.ts:784-786`. An edge only
appears in the map once it has been resolved this way — every graph query
filters on `resolved_file_id IS NOT NULL` `src/db/graph.ts:856`.

Two consequences follow. First, imports of third-party packages (bare
specifiers like `zod`) are never resolved to a node, so they do not appear as
edges — the map shows internal structure only. Second, if the index is stale or
a file was added but not yet indexed, its edges are missing from the map even
though they exist in source.

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `directory` | string | no | Project directory to map. Defaults to `RAG_PROJECT_DIR` or the current working directory. Resolved to an absolute path; must exist or the call throws `src/tools/index.ts:26-32`. |
| `focus` | string | no | A file path relative to the project root. When set, the map is limited to that file's neighborhood (its importers and dependencies, up to 2 hops) instead of the whole project `src/graph/resolver.ts:195-201`. |
| `zoom` | `"file"` \| `"directory"` | no | Granularity. `"file"` (default) lists individual files; `"directory"` groups files by folder and shows folder-to-folder dependencies `src/graph/resolver.ts:220-224`. |
| `format` | `"text"` \| `"json"` | no | Output shape. `"text"` (default) is a human-readable outline; `"json"` is a structured object that adds fan-in/fan-out counts `src/graph/resolver.ts:213-218`. |

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| dependency map | A single text block returned as the tool's `content`. The tool only reads the graph — it writes nothing to the database and changes no state. |

The map shape depends on `zoom` and `format`. The four combinations are below.

### Text, file zoom (the default)

`generateFileMap` builds adjacency maps from the edges, then splits files into
two groups: those with no indexed importers and the rest
`src/graph/resolver.ts:253-264`. Output starts with a header line counting the
files, then a `### Files With No Importers` section (likely entry points or
unreferenced files) and a `### Files` section. Each file lists up to its first 8
exports (with a `+N more` suffix beyond that), its `depends_on` list, and its
`depended_on_by` list `src/graph/resolver.ts:269-291`.

```text
## Project Map (file-level, 3 files)

### Files With No Importers
  src/tools/graph-tools.ts
    exports: registerGraphTools (function)
    depends_on: src/graph/resolver.ts, src/tools/index.ts

### Files
  src/graph/resolver.ts
    exports: resolveImports (function), generateProjectMap (function), +4 more
    depends_on: src/db/index.ts
    depended_on_by: src/tools/graph-tools.ts, src/cli/commands/map.ts
```

### Text, directory zoom

`generateDirectoryMap` groups files by their parent directory and counts how
many import edges cross from one directory to another (edges within the same
directory are ignored). Output is a `### Directories` section listing each
folder, its file count, and its file names, followed by a `### Dependencies`
section showing `dirA -> dirB (N imports)` for each cross-directory pair
`src/graph/resolver.ts:311-355`.

### JSON, file zoom

`generateFileMapJson` computes per-file fan-in and fan-out by counting incoming
and outgoing edges, then serializes `{ level: "file", nodes, edges }`. Each node
carries its relative path, full export list (name and type, not truncated), and
its `fanIn` and `fanOut` counts. Each edge carries `from`, `to`, and the raw
import `source` string `src/graph/resolver.ts:358-390`.

```json
{
  "level": "file",
  "nodes": [
    { "path": "src/graph/resolver.ts", "exports": [{ "name": "generateProjectMap", "type": "function" }], "fanIn": 10, "fanOut": 1 }
  ],
  "edges": [
    { "from": "src/tools/graph-tools.ts", "to": "src/graph/resolver.ts", "source": "../graph/resolver" }
  ]
}
```

### JSON, directory zoom

`generateDirectoryMapJson` aggregates per directory: file count, file names,
total export count, and directory-level fan-in/fan-out (counted as the number of
distinct other directories it imports from or is imported by, using sets so a
directory pair counts once regardless of how many files cross). It serializes
`{ level: "directory", directories, edges }`, where each edge carries `from`,
`to`, and an `importCount` `src/graph/resolver.ts:393-448`.

## Text vs JSON, and file vs directory

| dimension | option | what it gives you |
| --- | --- | --- |
| format | `text` | Readable outline grouped by importer status; exports truncated to 8 per file; a tip footer is appended. Best for a person or an agent reading prose. |
| format | `json` | Machine-parseable object; adds numeric `fanIn`/`fanOut`; full untruncated exports; no footer. Best for ranking files by connectivity or feeding another tool. |
| zoom | `file` | One node per file with its exports and direct dependencies. |
| zoom | `directory` | One node per folder; intra-folder edges collapsed; cross-folder edges counted. Best for a large project where a file-level map would be too big. |

## State changes

None. `project_map` is read-only. The handler opens the database, runs `SELECT`
queries through `getGraph` or `getSubgraph`, formats the result in memory, and
returns it. It performs no inserts, updates, or deletes, and starts no
background work. The graph it renders was written earlier by indexing; this tool
only reads it.

## Branches and failure cases

- Non-existent `directory`: `resolveProject` throws `Directory does not exist`
  before any map is built `src/tools/index.ts:30-32`.
- `focus` names a file that is not indexed: `getFileByPath` returns nothing, the
  resolver substitutes an empty graph, and the next branch reports nothing found
  rather than throwing `src/graph/resolver.ts:196-201`.
- Empty graph (no files indexed, no resolved edges, or an unmatched `focus`):
  for text, the resolver returns the literal string
  `No files indexed or no dependencies found.`; for JSON, it returns
  `{ "level": <zoom>, "nodes": [], "edges": [], "directories": [] }`
  `src/graph/resolver.ts:206-211`.
- `focus` set and found: only the 2-hop neighborhood is mapped via
  `getSubgraph`. The hop count is hard-coded to 2 in the resolver's defaults and
  is not exposed as a tool argument `src/graph/resolver.ts:188`.
- Large focus neighborhoods: `getSubgraph` batches its SQL by 499 ids to stay
  under SQLite's parameter limit. A prior version reused the same batch for both
  endpoints of an edge and silently dropped edges that spanned batches; it now
  batches by `file_id` alone and filters the other endpoint in JS against the
  visited set `src/db/graph.ts:944-978`.
- `format: "json"` skips the tip footer; text output always appends it
  `src/tools/graph-tools.ts:39-45`.
- Bare/external imports are never edges: only imports whose `resolved_file_id`
  is set appear, so third-party packages and unresolved relative imports are
  absent `src/db/graph.ts:856`.

## Example

Map a single file's neighborhood as JSON to rank its connections:

```json
{
  "focus": "src/graph/resolver.ts",
  "format": "json"
}
```

Map an entire large project grouped by folder:

```json
{
  "zoom": "directory"
}
```

The same engine backs the `mimirs map` CLI command, which calls
`generateProjectMap` directly with `--focus` and `--zoom` flags but always emits
text `src/cli/commands/map.ts:12-18`.

## Key source files

- `src/tools/graph-tools.ts` — registers the `project_map` MCP tool, validates
  the four arguments, resolves the project, calls the map engine, and appends
  the text footer.
- `src/graph/resolver.ts` — `generateProjectMap` and its four formatters
  (`generateFileMap`, `generateDirectoryMap`, `generateFileMapJson`,
  `generateDirectoryMapJson`); also holds `resolveImports`, which builds the
  edges this tool reads.
- `src/db/graph.ts` — `getGraph` (whole-project nodes and edges) and
  `getSubgraph` (BFS neighborhood around a focus file), plus the per-file
  `getDependsOn`/`getDependedOnBy` helpers.
- `src/indexing/indexer.ts` — calls `resolveImports` after indexing so the map's
  edges exist.

## Related tools

- [depends_on](depends-on.md) — list one file's direct dependencies.
- [depended_on_by](depended-on-by.md) — list one file's importers (reverse
  dependencies).
- [mimirs map](../cli/map.md) — the CLI command over the same map engine.
