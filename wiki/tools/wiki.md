# Tool: wiki

The `wiki` MCP tool runs the wiki rebuild workflow: the multi-step pipeline that turns the indexed codebase into a set of Markdown pages under `wiki/`. It is not a single action. It is one entry point that an agent calls many times with different `command` strings, walking through phases — survey the code, draft a plan, validate the plan, write pages, validate links, summarize the diff — one step at a time. Each call returns text: usually the next instruction prompt to follow, a chunk of JSON to read, or a validation report. A few calls also write files to disk.

You reach for this tool when you want to regenerate or extend the project's wiki, or when you need one slice of the workflow — re-reading the dependency map for a single file, checking that the wiki's internal links still resolve, or producing a changelog entry for a pending update. Most of the work lives in the rebuild module; the tool layer is a thin wrapper that resolves the project, calls the workflow, and wraps any thrown error into readable text instead of crashing the MCP connection.

## How a call is dispatched

The tool itself is small. `registerWikiTools` declares one tool named `wiki` with two arguments, `directory` and `command`, where `command` is a free-form string `src/tools/wiki-tools.ts:27-35`. The list of supported command strings is baked into the tool description so the calling agent sees them, but no enum is enforced at the schema level — every value is accepted by the schema and validated inside the workflow.

When invoked, the handler resolves which project it is operating on, then runs the workflow:

1. `resolveProject(directory, getDB)` turns the optional `directory` into an absolute path (falling back to `RAG_PROJECT_DIR` or the current working directory), verifies the directory exists, loads config, and hands back the project's database handle `src/tools/index.ts:22-37`.
2. The handler calls `runWikiRebuild` with a small context object — the database, the resolved project directory, and the mimirs version read from `process.env.npm_package_version` (or `"unknown"`) — plus the raw command string `src/tools/wiki-tools.ts:39-46`.
3. Whatever text the workflow returns is wrapped as a single MCP text content block and returned `src/tools/wiki-tools.ts:47`.
4. If the workflow throws, the handler catches it and returns the message as text — `wiki(<command>) failed: <message>` — so an invalid command or a missing file surfaces as a normal tool result, not a transport error `src/tools/wiki-tools.ts:48-57`.

The command itself is parsed once and then dispatched by its leading word. Because the real interest of this flow is *which* branch a command takes rather than the back-and-forth timing, the diagram below shows the dispatcher as a tree of modes.

```mermaid
flowchart TD
  callIn["wiki(command, directory?)"] --> resolveStep["resolveProject:<br>abs dir + open db"]
  resolveStep --> runStep["runWikiRebuild(ctx, command)"]
  runStep --> parseStep["parseWikiCommand:<br>split on ':' into mode + selectors"]
  parseStep -->|empty or empty segment| failNode["throw → 'wiki(...) failed: ...'"]
  parseStep -->|mode| dispatch{"mode"}

  dispatch -->|shape| shapeNode["build prefetch,<br>write wiki/_prefetch.json,<br>return discovery prompt"]
  dispatch -->|prefetch| prefetchNode["read wiki/_prefetch.json,<br>return selected slice as JSON"]
  dispatch -->|discovery| discoveryNode["read wiki/_discovery.json,<br>return compact view or one entry"]
  dispatch -->|validate-discovery| vdNode["structural + path checks,<br>return report"]
  dispatch -->|write| writeNode["return page prompt;<br>write:page:slug adds the packet"]
  dispatch -->|validate-pages| vpNode["walk wiki/*.md links,<br>report broken ones"]
  dispatch -->|changelog| changelogNode["diff pending wiki changes,<br>return changelog prompt + signal"]
  dispatch -->|eject| ejectNode["copy instruction .md<br>into .mimirs/wiki/"]
  dispatch -->|other| unknownNode["throw → lists valid commands"]

  shapeNode --> textOut["text content block back to caller"]
  prefetchNode --> textOut
  discoveryNode --> textOut
  vdNode --> textOut
  writeNode --> textOut
  vpNode --> textOut
  changelogNode --> textOut
  ejectNode --> textOut
  unknownNode --> failNode
  failNode --> textOut
```

1. The agent calls `wiki` with a command string and an optional directory.
2. The handler resolves the project directory and opens the matching database handle before doing anything else.
3. It builds a context object carrying the database, the absolute project directory, and the version string, and passes that plus the raw command into `runWikiRebuild`.
4. `parseWikiCommand` splits the command on `:` into a leading `mode` and a list of `selectors`. An empty command, or one with an empty segment such as `prefetch::map`, throws here.
5. The dispatcher branches on `mode`. `shape` is the only branch that always writes `wiki/_prefetch.json`; `eject` writes under `.mimirs/wiki/`; every other branch is read-only and returns text.
6. An unrecognized mode falls through to a final `throw` that lists the valid commands.
7. Any throw — from parsing, an unknown mode, a missing file, or a bad selector — is caught by the handler and returned as a `failed:` text block, so the MCP session keeps running.

## The command grammar

`parseWikiCommand` does the splitting. It trims the input, rejects an empty string with a hint to try `shape`, splits on `:`, and rejects any empty segment (so a stray double colon or a trailing colon is an error) `src/wiki/rebuild.ts:144-152`. The first segment becomes `mode`; the rest become `selectors`. `runWikiRebuild` then branches on `mode` and reads `selectors[0]`, `selectors[1]`, and so on for sub-commands `src/wiki/rebuild.ts:800-863`.

Several modes guard their selectors with `assertSafeSelector`, which rejects a missing value or a value that itself contains a `:` — that character is reserved purely as the segment separator, so a file path or slug passed as a selector must not contain one `src/wiki/rebuild.ts:170-174`.

Each `mode` maps to one phase of the workflow:

| Command | What it does | Writes files? |
| --- | --- | --- |
| `shape` | Builds prefetch data, writes `wiki/_prefetch.json`, and returns the discovery-drafting prompt | Yes — `wiki/_prefetch.json` |
| `prefetch` | Reads back `wiki/_prefetch.json`; selectors narrow to `metadata`, `map`, `map:<path>`, `annotations`, or `annotations:<path>` | No |
| `validate-discovery` | Structurally checks `wiki/_discovery.json` and reports errors or a go-ahead | No |
| `discovery` | Returns a compact view of the plan; `discovery:flow:<id>` and `discovery:page:<slug>` return one entry | No |
| `write` | Returns the page-writing prompt; `write:page:<slug>` returns the prompt plus that page's data bundle | No |
| `validate-pages` | Checks every relative `.md` link under `wiki/` resolves to a real file | No |
| `changelog` | Diffs pending `wiki/` changes against HEAD and returns the changelog prompt plus a signal describing what changed | No |
| `eject` | Copies the packaged instruction Markdown into `.mimirs/wiki/` so a project can customize it; `eject:force` overwrites | Yes — `.mimirs/wiki/*.md` |

Any other leading word falls through to a final `throw` that lists the valid commands, which the handler turns into a `failed:` string `src/wiki/rebuild.ts:957`.

### `shape` — survey and draft prompt

`shape` is the starting point. It calls `buildPrefetch`, which assembles a snapshot of the indexed project: metadata (project root, current git HEAD via `git rev-parse HEAD`, the mimirs version, and index counts from `db.getStatus()`), a dependency map of every file with its imports, importers, fan-in, fan-out, a computed PageRank score, and exported symbols with line numbers, plus all stored annotations grouped by file `src/wiki/rebuild.ts:329-342`. It creates `wiki/` if needed, writes that snapshot to `wiki/_prefetch.json`, and returns the discovery-drafting instructions `src/wiki/rebuild.ts:803-816`.

If the index is empty — `index.totalFiles` is `0` — `shape` prepends a "Stop: index is empty" notice telling the caller to run [index_files](index-files.md) first and then re-run `shape`, so the plan is built from real evidence rather than guesses `src/wiki/rebuild.ts:366-375`.

### `prefetch` — read the snapshot back

`prefetch` reads `wiki/_prefetch.json` from disk and returns part of it as pretty-printed JSON. `readSelector` decides which part: no selector returns the whole object, `metadata` returns just the header, `map` returns the full dependency map, `map:<path>` returns one file's entry (throwing if that path is not in the map), `annotations` returns all grouped annotations, and `annotations:<path>` returns one file's notes (or an empty list) `src/wiki/rebuild.ts:778-797`. The `<path>` selectors run through `assertSafeSelector` and are normalized before lookup.

### `discovery` — read the plan

The plan a human or agent drafts after `shape` lives in `wiki/_discovery.json`: a list of flows (one per entry point) and a list of pages (one Markdown file each). Bare `discovery` returns a compact summary — for each flow just its id, title, kind, confidence, and state-change count; for each page its slug, title, kind, linked flows, and input/output counts — so the reader can scan the whole plan without pulling every detail `src/wiki/rebuild.ts:392-411`. `discovery:flow:<id>` and `discovery:page:<slug>` return one full entry, throwing a clear error if the id or slug is missing or not found `src/wiki/rebuild.ts:842-862`.

### `validate-discovery` — structural check

Before pages are written, `validate-discovery` reads `wiki/_discovery.json` and runs two passes. `validateDiscoveryShape` checks the JSON shape: top-level `metadata`, `flows`, and `pages` must exist; flow ids must be unique and free of `:`; each non-overview page must name exactly one flow id, that id must exist and be assigned to only one page, and slugs must be unique, not reserved for an overview, and not too broad; overview pages must use one of the fixed overview kinds, the matching slug, and at least three primary files `src/wiki/rebuild.ts:553-650`. `validateDiscoveryPaths` then checks that every file path referenced anywhere in the plan actually exists on disk `src/wiki/rebuild.ts:491-501`. If the file cannot even be parsed as JSON, that failure is caught and reported as a single error rather than thrown `src/wiki/rebuild.ts:832-834`. The response either confirms the checks passed and tells the caller to ask the human before running `write`, or lists every error to fix `src/wiki/rebuild.ts:652-667`.

### `write` — page-writing prompts

Bare `write` returns the top-level page-writing instructions. `write:page:<slug>` does the real assembly: it reads the prefetch snapshot (falling back to an empty one if `wiki/_prefetch.json` is absent), reads the plan, and calls `buildPagePacket` to bundle everything needed to write that one page — the page entry, its resolved flows, the dependency-map entries and annotations for its primary files, and all flow evidence `src/wiki/rebuild.ts:865-886`. It returns the kind-specific writing prompt — flow, screen, or one of the overview prompts, chosen by `writePagePrompt` `src/wiki/rebuild.ts:377-390` — followed by that bundle as a fenced JSON block.

### `validate-pages` — link check

`validate-pages` walks every `.md` file under `wiki/`, extracts each relative Markdown link, resolves it against the file's own directory, and records any that point at a missing file `src/wiki/rebuild.ts:698-713`. It skips absolute URLs, anchors, and links with a scheme such as `http:` `src/wiki/rebuild.ts:684-696`. The response either confirms all links resolve or lists each broken link `src/wiki/rebuild.ts:715-726`.

### `changelog` — summarize a pending update

`changelog` is the step you run after rewriting pages but before committing. It reads the current git HEAD (shortened to seven characters, or `"unknown"`), takes today's date, and calls `pendingWikiChanges` to inspect the working tree against HEAD `src/wiki/rebuild.ts:926-930`. That helper parses `git status --porcelain` for `wiki/`, classifies each changed `.md` page as added, modified, or deleted, and — for an incremental update — gathers the actual `git diff` of the modified pages plus the full text of any new ones; it excludes the JSON state files and `CHANGELOG.md` itself `src/wiki/rebuild.ts:206-244`. If at least 60% of pages changed, it is treated as a full regeneration and the diff is skipped, because at that scale the diff is mostly LLM rewording and a one-line entry is more useful `src/wiki/rebuild.ts:195,226`. The command returns the changelog-writing prompt followed by a "Changelog signal" block: the commit stamp, the update type, the list of changed pages, and (for incremental updates) the diff to summarize `src/wiki/rebuild.ts:932-954`.

### `eject` — customize the instructions

The prose that drives generation lives in packaged Markdown files, not in code. `eject` copies all nine of them — `README`, `discovery`, `write`, `writing-contract`, `self-check`, `page-flow`, `page-overview`, `page-screen`, and `changelog` — into `.mimirs/wiki/`, where a project-local copy overrides the packaged default on future runs `src/wiki/rebuild.ts:888-924`. By default it skips any file already present and lists what it skipped; `eject:force` overwrites them all `src/wiki/rebuild.ts:889,907-913`. The override is read by `loadWikiInstruction`, which prefers `.mimirs/wiki/<name>.md` over the packaged default `src/wiki/rebuild.ts:13-23`.

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `command` | string | yes | The workflow step to run, written as colon-separated segments. The leading segment is the mode (`shape`, `prefetch`, `validate-discovery`, `discovery`, `write`, `validate-pages`, `changelog`, `eject`); later segments are selectors such as a file path, flow id, or page slug. Validated inside the workflow, not by the tool schema `src/tools/wiki-tools.ts:32-34`. |
| `directory` | string | no | Project directory to operate on. Defaults to `RAG_PROJECT_DIR` or the current working directory, resolved to an absolute path and checked for existence by `resolveProject` `src/tools/index.ts:26-32`. |

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| Workflow text | The MCP result: a single text content block. Depending on the mode it is an instruction prompt to follow next, pretty-printed JSON (`prefetch`, `discovery`), or a report (`validate-discovery`, `validate-pages`, `changelog`) `src/tools/wiki-tools.ts:47`. |
| `wiki/_prefetch.json` | Written by `shape`. The dependency map, index metadata, and grouped annotations used as evidence for the rest of the workflow `src/wiki/rebuild.ts:806`. |
| `wiki/_discovery.json` | Read by `discovery`, `validate-discovery`, and `write`. Not written by the tool — it is authored by the caller between `shape` and `write`. |
| Generated wiki pages | Written by the caller while following the `write:page:<slug>` prompt; the tool supplies the prompt and data bundle but does not write the `.md` page itself. |
| `.mimirs/wiki/*.md` | Written by `eject` / `eject:force` — copies of the nine packaged instruction files for per-project customization `src/wiki/rebuild.ts:911-913`. |
| Failure text | When the workflow throws, the message is returned as `wiki(<command>) failed: <message>` instead of an exception `src/tools/wiki-tools.ts:53`. |

## State changes

| Item | Before | After | Why it matters |
| --- | --- | --- | --- |
| `wiki/_prefetch.json` | Absent or stale | Rewritten with a fresh snapshot of the index, dependency map, git HEAD, and annotations | This is the evidence base for the whole workflow. `shape` always overwrites it, so later steps read a current snapshot `src/wiki/rebuild.ts:804-806`. |
| `.mimirs/wiki/*.md` | Packaged defaults only | Project-local override copies present | Once these exist, `loadWikiInstruction` prefers them over the packaged prose, so generation prompts can be customized per project `src/wiki/rebuild.ts:13-23,911-913`. |

`shape` calls `mkdir(wikiDir, { recursive: true })` before writing, so the `wiki/` directory is created if missing; `eject` does the same for `.mimirs/wiki/` `src/wiki/rebuild.ts:805,891`. No other mode mutates disk — `prefetch`, `discovery`, `validate-discovery`, `validate-pages`, and `changelog` are read-only (the page `.md` files and `CHANGELOG.md` are written by the caller, not by the tool).

## Branches and failure cases

- **Empty or malformed command** — an empty string, or any command with an empty segment (a leading, trailing, or double colon), throws in `parseWikiCommand` and is reported as a `failed:` string `src/wiki/rebuild.ts:144-150`.
- **Unknown mode** — any leading word not handled by a branch hits the final `throw` listing the valid commands `src/wiki/rebuild.ts:957`.
- **Reserved-character selector** — a selector that contains `:` (or is missing where required) is rejected by `assertSafeSelector` for `prefetch:map:<path>`, `prefetch:annotations:<path>`, `discovery:flow:<id>`, `discovery:page:<slug>`, and `write:page:<slug>` `src/wiki/rebuild.ts:170-174`.
- **Empty index on `shape`** — when the index reports zero files, `shape` still writes the snapshot but prepends a stop notice pointing at [index_files](index-files.md) `src/wiki/rebuild.ts:366-375`.
- **Missing `wiki/_prefetch.json`** — `prefetch` reads it directly and throws if absent; `write:page` instead falls back to an empty prefetch snapshot so a page can still be drafted `src/wiki/rebuild.ts:872-874`.
- **Missing or unparseable `wiki/_discovery.json`** — `validate-discovery` catches a JSON parse failure and reports it as one error `src/wiki/rebuild.ts:832-834`; `discovery` and `write` let the read error propagate to the handler's catch block.
- **Unknown flow id or page slug** — `discovery:flow:<id>`, `discovery:page:<slug>`, and `write:page:<slug>` each throw a specific "No flow/page found" error `src/wiki/rebuild.ts:851,859,752`.
- **Unknown sub-selector** — an unrecognized selector under `prefetch`, `discovery`, or `write` throws (for example `Unknown prefetch selector '...'`) `src/wiki/rebuild.ts:797,862,868`.
- **No pending wiki changes on `changelog`** — when nothing under `wiki/` has changed, the update type is reported as `none (no pending wiki changes)` and no diff block is appended `src/wiki/rebuild.ts:932-951`.
- **Full regeneration on `changelog`** — when 60% or more of pages changed, the diff is skipped and the update is labeled a full regeneration with a page count `src/wiki/rebuild.ts:226,932-937`.
- **`eject` collision** — without `force`, files already present in `.mimirs/wiki/` are skipped and listed; `eject:force` overwrites them `src/wiki/rebuild.ts:907-913`.
- **All errors are non-fatal to the connection** — every throw above is caught by the tool handler and returned as text, so the MCP session continues `src/tools/wiki-tools.ts:48-57`.

## Example

A typical regeneration runs the modes in order. Each call is a separate tool invocation:

```json
{ "command": "shape" }
```

```json
{ "command": "validate-discovery" }
```

```json
{ "command": "write:page:tools/search" }
```

```json
{ "command": "changelog" }
```

Targeted reads scope to one file or entry:

```json
{ "command": "prefetch:map:src/server.ts", "directory": "/abs/path/to/project" }
```

```json
{ "command": "discovery:page:tools/search" }
```

## Key source files

- `src/tools/wiki-tools.ts` — the MCP tool registration; resolves the project, calls the workflow, wraps errors into text.
- `src/wiki/rebuild.ts` — the entire workflow: command parsing (`parseWikiCommand`), the mode dispatcher (`runWikiRebuild`), prefetch building, discovery validation, per-page data assembly (`buildPagePacket`), link checking, changelog diffing, and eject.
- `src/tools/index.ts` — `resolveProject`, which maps the optional `directory` argument to an absolute path and database handle.
- `src/wiki/instructions/*.md` — the packaged generation prompts that `shape`, `write`, `changelog`, and `eject` read and that a project can override under `.mimirs/wiki/`.
