# Tool: wiki

The `wiki` tool drives the workflow that rebuilds this very documentation set.
It is a single MCP tool whose behavior is selected by a string `command` using
colon-separated selectors — `shape`, `prefetch:map:src/server.ts`,
`discovery:page:tools/search`, `write:page:tools/search`, and so on. Each
command does one step: gather structural facts about the codebase, hand the
agent a prompt describing what to produce next, validate what the agent
produced, or emit the inputs for writing a single page. The tool itself never
writes finished documentation pages; it scaffolds the process and checks the
intermediate artifacts so a human-plus-agent loop can produce them reliably.

## How it works

The handler is registered as the MCP tool `wiki` in `registerWikiTools`
(`src/tools/wiki-tools.ts:23-32`). It accepts an optional `directory` and a
required `command` string, resolves the project and database with
`resolveProject`, and delegates the whole command to `runWikiRebuild`,
catching any thrown error and returning it as `wiki(<command>) failed: ...`
text (`src/tools/wiki-tools.ts:33-54`).

`runWikiRebuild` first parses the command with `parseWikiCommand`, which splits
on `:` into a `mode` (the first segment) and `selectors` (the rest), rejecting
empty input and empty selector parts (`src/wiki/rebuild.ts:104-112`). It then
dispatches on `mode`: `shape`, `prefetch`, `validate-discovery`,
`validate-pages`, `discovery`, and `write`, throwing on anything else
(`src/wiki/rebuild.ts:1009-1094`).

```mermaid
sequenceDiagram
    autonumber
    participant Agent
    participant Tool as wiki
    participant Driver as runWikiRebuild
    participant FS as wiki/ files
    participant DB as RagDB
    Agent->>Tool: command, directory?
    Tool->>Driver: resolveProject -> ctx; runWikiRebuild(ctx, command)
    Driver->>Driver: parseWikiCommand -> mode, selectors
    alt shape
        Driver->>DB: getGraph, chunk ranges, annotations
        Driver->>FS: write wiki/_prefetch.json
        Driver-->>Agent: confirmation + discovery prompt
    else prefetch
        Driver->>FS: read wiki/_prefetch.json
        Driver-->>Agent: selected JSON slice
    else validate-discovery
        Driver->>FS: read wiki/_discovery.json
        Driver->>Driver: shape + path checks
        Driver-->>Agent: pass / list of errors
    else discovery
        Driver->>FS: read wiki/_discovery.json
        Driver-->>Agent: whole-file or one flow/page JSON
    else write
        Driver->>FS: read prefetch + discovery
        Driver-->>Agent: page-writing prompt + inputs JSON
    else validate-pages
        Driver->>FS: scan wiki/*.md links
        Driver-->>Agent: broken-link report
    end
```

1. The agent calls the tool with a `command` and optional `directory`
   (`src/tools/wiki-tools.ts:27-32`).
2. The handler resolves the project context (database + project dir + version)
   and calls `runWikiRebuild` (`src/tools/wiki-tools.ts:34-43`).
3. `parseWikiCommand` turns the string into a mode plus selectors
   (`src/wiki/rebuild.ts:104-112`).
4. `shape` builds the structural snapshot from the index graph and writes it to
   `wiki/_prefetch.json`, then returns the next-step prompt
   (`src/wiki/rebuild.ts:1012-1023`).
5. `prefetch` reads that file back and returns the requested slice as JSON
   (`src/wiki/rebuild.ts:1025-1028`).
6. `validate-discovery` reads `wiki/_discovery.json` and runs shape and
   referenced-path checks (`src/wiki/rebuild.ts:1030-1041`).
7. `discovery` returns the discovery file, or one flow/page from it
   (`src/wiki/rebuild.ts:1048-1069`).
8. `write` assembles and returns the inputs and prompt for writing one page
   (`src/wiki/rebuild.ts:1071-1092`).
9. `validate-pages` scans the written Markdown for broken relative links
   (`src/wiki/rebuild.ts:1043-1046`).

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `command` | string | yes | The workflow step plus selectors, joined by `:`. The first segment is the mode; later segments are selectors such as a file path, flow id, or page slug (`src/tools/wiki-tools.ts:29-31`, `src/wiki/rebuild.ts:104-112`). |
| `directory` | string | no | Project directory. Falls back to `RAG_PROJECT_DIR`, then cwd, via `resolveProject` (`src/tools/wiki-tools.ts:28`, `src/tools/wiki-tools.ts:34`). |

Beyond the call arguments, several commands read files the workflow itself
produced: `wiki/_prefetch.json` and `wiki/_discovery.json`
(`src/wiki/rebuild.ts:7-8`, `src/wiki/rebuild.ts:118-124`).

## Supported commands

| command | what it does | source |
| --- | --- | --- |
| `shape` | Build the structural snapshot and write `wiki/_prefetch.json`; return a prompt telling the agent to author discovery | `src/wiki/rebuild.ts:1012-1023` |
| `prefetch` | Read `wiki/_prefetch.json` and return the whole object | `src/wiki/rebuild.ts:1025-1028`, `src/wiki/rebuild.ts:990` |
| `prefetch:metadata` | Return just the prefetch `metadata` block | `src/wiki/rebuild.ts:991` |
| `prefetch:map` | Return the whole file map | `src/wiki/rebuild.ts:992-994` |
| `prefetch:map:<path>` | Return one file's map entry; errors if that path is not in the map | `src/wiki/rebuild.ts:995-998` |
| `prefetch:annotations` | Return all grouped annotations | `src/wiki/rebuild.ts:1000-1002` |
| `prefetch:annotations:<path>` | Return annotations for one file (empty array if none) | `src/wiki/rebuild.ts:1003-1004` |
| `validate-discovery` | Read `wiki/_discovery.json`; run shape + path checks | `src/wiki/rebuild.ts:1030-1041` |
| `discovery` | Return a compacted view of the whole discovery file | `src/wiki/rebuild.ts:1048-1051` |
| `discovery:flow:<id>` | Return one flow object by id | `src/wiki/rebuild.ts:1052-1059` |
| `discovery:page:<slug>` | Return one page object by slug | `src/wiki/rebuild.ts:1060-1067` |
| `write` | Return the coordinator prompt for the writing phase | `src/wiki/rebuild.ts:1071-1073` |
| `write:page:<slug>` | Return the page-writing prompt plus that page's inputs | `src/wiki/rebuild.ts:1074-1091` |
| `validate-pages` | Scan `wiki/*.md` for broken relative links | `src/wiki/rebuild.ts:1043-1046` |

The list of supported commands is also surfaced in the tool description itself
(`src/tools/wiki-tools.ts:6-21`). The `:` character is reserved as the
selector separator, and selectors that themselves contain `:` are rejected by
`assertSafeSelector` (`src/wiki/rebuild.ts:130-134`).

## Workflow order

The commands are meant to run in sequence, each producing what the next
consumes:

1. **`shape`** — builds `wiki/_prefetch.json` from the index and prints a
   prompt instructing the agent to write `wiki/_discovery.json`
   (`src/wiki/rebuild.ts:1012-1023`, `src/wiki/rebuild.ts:266-270`).
2. **`prefetch:*`** — lets the agent read slices of the snapshot (a file's
   imports, its annotations, the metadata) while authoring discovery
   (`src/wiki/rebuild.ts:987-1006`).
3. The agent authors **`wiki/_discovery.json`** by hand following the prompt;
   the tool does not write this file.
4. **`validate-discovery`** — checks the discovery file's structure and that
   every referenced source path exists; on success it tells the agent to ask
   the human before proceeding to `write`
   (`src/wiki/rebuild.ts:1030-1041`, `src/wiki/rebuild.ts:861-876`).
5. **`write`** and **`write:page:<slug>`** — emit the prompt and inputs for
   writing each page; the agent writes the actual `wiki/<slug>.md`
   (`src/wiki/rebuild.ts:1071-1092`).
6. **`validate-pages`** — after pages exist, verifies their internal links
   resolve (`src/wiki/rebuild.ts:1043-1046`,
   `src/wiki/rebuild.ts:907-922`).

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| `wiki/_prefetch.json` | Written only by `shape`. Holds project metadata, a per-file map (imports, importers, fan-in/out, PageRank, exports with line numbers), and annotations grouped by file (`src/wiki/rebuild.ts:1013-1015`, `src/wiki/rebuild.ts:174-242`). |
| Step prompts | Most commands return prompt text guiding the next action — the discovery-authoring prompt after `shape`, the writing prompt for a page, and so on (`src/wiki/rebuild.ts:266-270`, `src/wiki/rebuild.ts:1083-1091`). |
| JSON slices | `prefetch:*` and `discovery:*` return pretty-printed JSON of the requested portion (`src/wiki/rebuild.ts:262-264`). |
| Validation reports | `validate-discovery` and `validate-pages` return either a pass message or a bulleted list of problems (`src/wiki/rebuild.ts:861-876`, `src/wiki/rebuild.ts:924-935`). |
| `wiki/<slug>.md` | Produced by the agent during the writing phase, not by the tool. |

`wiki/_discovery.json` is read by `validate-discovery`, `discovery`, and
`write`, but it is authored by the agent rather than written by the tool
(`src/wiki/rebuild.ts:258-260`).

## State changes

### `wiki/_prefetch.json` regenerated by `shape`

- **Before:** a previous prefetch file, or none.
- **After:** a fresh snapshot reflecting the current index graph.
- **Why it matters:** every later step reads from this file, so it pins the
  structural facts (imports, exports, PageRank, annotations) the rest of the
  workflow builds on. `shape` calls `buildPrefetch`, which walks the dependency
  graph and per-file chunk ranges, then `writeJSON` persists it
  (`src/wiki/rebuild.ts:1013-1015`, `src/wiki/rebuild.ts:229-242`,
  `src/wiki/rebuild.ts:244-247`).

### `wiki/_discovery.json` validated, not written, by the tool

- **Before:** discovery JSON authored by the agent.
- **After:** unchanged on disk; the tool reports whether its shape and
  referenced paths are valid.
- **Why it matters:** validation gates the writing phase. `validate-discovery`
  reads the file and runs `validateDiscoveryShape` and
  `validateDiscoveryPaths`; a clean run prompts the agent to confirm with the
  human before writing pages (`src/wiki/rebuild.ts:1030-1041`,
  `src/wiki/rebuild.ts:762-859`, `src/wiki/rebuild.ts:726-736`).

## Validation

`validate-discovery` runs two independent checks and concatenates their errors
(`src/wiki/rebuild.ts:1033-1036`):

- **Shape checks** (`validateDiscoveryShape`, `src/wiki/rebuild.ts:762-859`):
  requires top-level `metadata`, a `flows` array, and a `pages` array; flow ids
  must be present, unique, and free of `:`; page slugs must be present, unique,
  and free of `:`; each non-overview page must list exactly one flow id, and
  that id must exist and not be shared with another page; `inputs` and
  `outputs` must each have at least one non-empty string; certain broad slugs
  (`api`, `entities`, `glossary`, `routes`, and others) are rejected as too
  broad in favor of one page per concrete flow
  (`src/wiki/rebuild.ts:775-789`, `src/wiki/rebuild.ts:830-832`).
- **Path checks** (`validateDiscoveryPaths`, `src/wiki/rebuild.ts:726-736`):
  collects every source path referenced anywhere in the discovery file — flow
  files, evidence, state-change files and evidence, and page `primaryFiles`
  (`src/wiki/rebuild.ts:693-723`) — and reports any that do not exist under the
  project directory.

`validate-pages` is a separate, later check over the finished Markdown. It
reads every `.md` file under `wiki/`, extracts relative `.md` links (skipping
absolute paths and external `scheme:` URLs), resolves each against its file's
directory, and reports any that point at a missing file
(`src/wiki/rebuild.ts:885-922`, `src/wiki/rebuild.ts:878`).

## Branches and failure cases

- **Empty or malformed command.** `parseWikiCommand` throws on empty input or
  any empty selector segment; the handler turns the throw into a
  `wiki(<command>) failed: ...` message (`src/wiki/rebuild.ts:106-110`,
  `src/tools/wiki-tools.ts:45-53`).
- **Unknown mode or selector.** Any mode outside the known set, or an
  unrecognized selector under `prefetch`/`discovery`/`write`, throws a
  descriptive error (`src/wiki/rebuild.ts:1094`,
  `src/wiki/rebuild.ts:1006`, `src/wiki/rebuild.ts:1068`,
  `src/wiki/rebuild.ts:1074`).
- **Missing prefetch/discovery file.** `prefetch`, `discovery`,
  `validate-discovery`, and `write` read JSON from disk; a missing or invalid
  file surfaces as a thrown read/parse error (for `validate-discovery` it is
  caught and reported as `Could not read valid JSON`)
  (`src/wiki/rebuild.ts:254-260`, `src/wiki/rebuild.ts:1038-1040`).
- **`prefetch:map:<path>` not found.** If the path is not present in the map,
  the command throws `No prefetch map entry found for '<path>'`
  (`src/wiki/rebuild.ts:996-997`).
- **`prefetch:annotations:<path>` with no notes.** Returns an empty array
  rather than erroring (`src/wiki/rebuild.ts:1004`).
- **Missing flow id / page slug.** `discovery:flow`, `discovery:page`, and
  `write:page` throw a usage hint when their selector is absent, and a
  not-found error when the id/slug does not match
  (`src/wiki/rebuild.ts:1052-1066`, `src/wiki/rebuild.ts:1075-1077`,
  `src/wiki/rebuild.ts:959-961`).
- **Empty index at `shape` time.** `prefetchReadiness` adds a warning to the
  `shape` response when the index reports zero files, since discovery should
  not be drafted from raw source-tree guesses
  (`src/wiki/rebuild.ts:399-405`, `src/wiki/rebuild.ts:1016-1019`).
- **Selector containing a reserved `:`.** Path, flow-id, and slug selectors are
  guarded by `assertSafeSelector`, which rejects values containing `:`
  (`src/wiki/rebuild.ts:130-134`).

## Example

Start the workflow:

```json
{ "command": "shape" }
```

Inspect one file's structure while drafting discovery:

```json
{ "command": "prefetch:map:src/server/index.ts" }
```

Validate the authored discovery file:

```json
{ "command": "validate-discovery" }
```

Get the inputs to write a single page:

```json
{ "command": "write:page:tools/search" }
```

Check links after pages are written:

```json
{ "command": "validate-pages" }
```

## Key source files

- `src/tools/wiki-tools.ts` — the thin MCP handler: command schema, the
  supported-command list, and error wrapping.
- `src/wiki/rebuild.ts` — the whole workflow: command parsing
  (`parseWikiCommand`), the prefetch builder (`buildPrefetch`), the dispatcher
  (`runWikiRebuild`), and the shape and link validators.
- `src/db/index.ts` — `RagDB` supplies the dependency graph, chunk ranges, and
  annotations that `shape` turns into the prefetch snapshot.
