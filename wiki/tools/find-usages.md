# Tool: find_usages

`find_usages` reports every call site or reference to a symbol across the
indexed project. It is the right tool to reach for before renaming a
function, changing a signature, or removing an export — it answers "who
calls this?" with file paths and exact line numbers.

It is more reliable than grep because it reads the parser-derived
`symbol_refs` table, which captures identifier occurrences from
bun-chunk. That index sees through aliased imports (`import { foo as bar }`)
and re-exports, both of which a plain text search misses or over-matches.

## Flow

```mermaid
sequenceDiagram
    autonumber
    participant Caller as MCP caller
    participant Handler as find_usages handler
    participant DB as RagDB
    participant Refs as symbol_refs index
    participant FTS as fts_chunks fallback
    Caller->>Handler: { symbol, exact?, top?, directory? }
    Handler->>Handler: resolveProject(directory)
    Handler->>DB: findUsages(symbol, exact ?? true, top ?? 30)
    DB->>DB: collect defining file_ids from file_exports (excluded from results)
    DB->>Refs: SELECT joined chunk + file where LOWER(name) = ? (or LIKE ?)
    Refs-->>DB: rows
    DB->>DB: emit (path, line, snippet); stop at `top`
    opt fewer than `top` hits
        DB->>FTS: MATCH "symbol" on chunks
        FTS-->>DB: candidate chunk rows
        DB->>DB: regex line-scan with \\b boundaries; emit unique (path:line)
    end
    DB-->>Handler: UsageResult[]
    alt zero hits
        Handler-->>Caller: "No usages of \"...\" found"
    else hits found
        Handler->>Handler: group by file path
        Handler-->>Caller: "Found N usages... :" + per-file block + tip footer
    end
```

1. Caller passes `symbol` (required, 1–200 chars) plus optional `exact`,
   `top`, and `directory` (`src/tools/graph-tools.ts:53-67`).
2. The handler defaults `exact` to `true` and `top` to `30`, then calls
   `ragDb.findUsages` (`src/tools/graph-tools.ts:71`).
3. `findUsages` first collects the symbol's defining file ids from
   `file_exports` so the function's own definition is not counted as a usage
   (`src/db/search.ts:425-433`).
4. The primary pass queries `symbol_refs` joined to `chunks` and `files`.
   `exact` uses `LOWER(sr.name) = LOWER(?)`; non-exact uses `LIKE ? || '%'`
   for prefix matching (`src/db/search.ts:441-465`).
5. For each ref row, the handler converts bun-chunk's 0-indexed `ref_line`
   to a 1-indexed file line and slices the matching source line out of the
   chunk's snippet (`src/db/search.ts:467-486`). Results are deduplicated on
   `path:line`.
6. If fewer than `top` results came back, the function falls back to an FTS
   query against `fts_chunks` with a regex line-scan. The regex uses `\\b`
   word boundaries when `exact` is on, and a left-anchored `\\b` prefix
   otherwise (`src/db/search.ts:488-543`). This branch catches files indexed
   before the `symbol_refs` migration and languages without a reference
   query.
7. Zero results returns a single-line "No usages" message
   (`src/tools/graph-tools.ts:73-77`).
8. With results, the handler groups by file path and prints each file with
   its matches, prefixed by line and snippet. A footer points at
   `depended_on_by` for follow-up navigation (`src/tools/graph-tools.ts:80-105`).

## Inputs

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `symbol` | string (1–200) | yes | Symbol name to look up. Case-insensitive. |
| `exact` | boolean | no | Default `true`. When `false`, the primary pass uses `LIKE name%` (prefix) and the FTS fallback uses a left-anchored `\\b` regex (`src/db/search.ts:454-465`, `src/db/search.ts:516-518`). |
| `top` | integer ≥ 1 | no | Max usages returned. Defaults to `30`. |
| `directory` | string | no | Project directory. Defaults to `RAG_PROJECT_DIR` or cwd. |

## Outputs

| Output | Shape |
| --- | --- |
| `UsageResult[]` returned by `findUsages` | `{ path, line, snippet }` per match (`src/db/search.ts:484`). |
| Text response | Header `Found N usage(s) of "X" across M file(s):` followed by one block per file with each match printed as `  :LINE  snippet`. Empty hits get the "No usages" message (`src/tools/graph-tools.ts:87-105`). |

## Exact vs substring matching

- `exact: true` (default) uses case-insensitive equality on `symbol_refs.name`
  and `\\b` regex boundaries in the FTS fallback. This is what you want for
  exact symbol lookup like "find every `RagDB`".
- `exact: false` switches to prefix match — `LIKE 'symbol%'` on
  `symbol_refs.name`, left-anchored `\\b` regex on the FTS fallback. Use this
  to find call sites for a family of names ("anything starting with `get`")
  or when you do not have the full symbol name.

The two passes use different match modes deliberately: `symbol_refs` already
holds parsed identifiers, so `LIKE name%` is enough; the FTS pass scans raw
chunk text, so it needs word-boundary regex to avoid matching inside other
identifiers.

## Why it is more reliable than grep

The `symbol_refs` table is populated from bun-chunk's per-chunk
`references` map — a parser-derived list of identifier occurrences in each
chunk. That gives three advantages over a text search:

- **Aliased imports.** `import { foo as bar } from "./mod"` registers both
  the import row and a reference under the bound name; the cross-file
  resolver pairs them up (`src/db/graph.ts:37-96`). Grep on `foo` would miss
  the usages that go through `bar`; mimirs picks them up.
- **Re-exports.** `file_exports.is_reexport` captures `export { foo } from
  "./other"` so an indirect import still maps back to the original
  definition.
- **Skips comments and strings.** The primary `symbol_refs` pass only sees
  parser-emitted identifiers. The FTS fallback can hit comments, which is
  why exact-mode applies a `\\b` regex on top — to avoid `myFoo`,
  `fooBar`, or substring matches inside other words.

The defining-file exclusion (`definingFileIds`) is what keeps the symbol's
own export line out of the result set, so the answer is genuinely "callers
only" (`src/db/search.ts:425-433`).

## Branches and failure cases

- **Empty results.** Single-line "No usages of … found" message with the
  hint that re-indexing or running on the definition file may be needed
  (`src/tools/graph-tools.ts:74-76`).
- **Primary pass returns ≥ `top` results.** The FTS fallback is skipped
  (`src/db/search.ts:485`).
- **FTS query fails.** Wrapped in a try/catch; the function returns
  whatever the primary pass collected so far (`src/db/search.ts:506-507`).
- **Special characters in the name.** The FTS query escapes embedded `"`
  by doubling, and the regex escapes any regex meta-characters before
  applying boundaries (`src/db/search.ts:494-495`, `src/db/search.ts:515-518`).

## Example

```json
{
  "tool": "find_usages",
  "arguments": {
    "symbol": "RagDB",
    "exact": true,
    "top": 30
  }
}
```

Illustrative response (paths and lines obviously synthetic):

```
Found 4 usages of "RagDB" across 2 files:

src/tools/index.ts
  :42  const db: RagDB = await getDB(projectDir);
  :88  function makeDB(): RagDB { ... }

src/server/index.ts
  :17  import { RagDB } from "../db";

── Tip: call depended_on_by("<file>") on any file above to see its full importer tree. ──
```

## Key source files

- `src/tools/graph-tools.ts` — MCP handler, response grouping by file.
- `src/db/search.ts` — `findUsages` two-pass implementation.
- `src/db/graph.ts` — `resolveSymbolRefs` populates the
  `resolved_export_id` join key.

## Related flows

- [Tool: search_symbols](./search-symbols.md) — locate the symbol's
  definition by name before searching for its usages.
- [Tool: depended_on_by](./depended-on-by.md) — file-level blast radius
  when symbol-level granularity is overkill.
