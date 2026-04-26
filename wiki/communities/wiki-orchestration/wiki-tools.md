# src/tools/wiki-tools.ts

> [Architecture](../../architecture.md) › [Wiki orchestration](../wiki-orchestration.md)
>
> Generated from `b47d98e` · 2026-04-26

## Role

This file is the MCP-tool surface of the wiki orchestration community. It registers eight server tools (`generate_wiki`, `write_synthesis`, `write_synthesis_batch`, `wiki_lint_page`, `wiki_lint_batch`, `wiki_rewrite_page`, `wiki_finalize_log`, `wiki_finalize_log_apply`) on top of the underlying engine in `src/wiki/index.ts`, and renders every payload — page, synthesis, finalize, resume, incremental, lint — into the markdown text the calling agent reads. Three exports are public; the rest are response-renderer helpers and validators that lean on `src/wiki/lint-page.ts`, `src/wiki/section-catalog.ts`, `src/wiki/staleness.ts`, `src/wiki/diff-page.ts`, and `src/wiki/update-log.ts`.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `registerWikiTools` | function | `export function registerWikiTools(server: McpServer, getDB: GetDB)` | Registers all eight wiki MCP tools on `server`. Each tool wraps `resolveProject(directory, getDB)` to resolve the project dir and DB, then dispatches to the matching `build…Response` function and returns a single text-content result. Called once from `src/tools/index.ts` during server bootstrap. |
| `communityReadBreadcrumbs` | function | `export function communityReadBreadcrumbs(payload: PagePayload): ReadBreadcrumb[]` | For a community-kind page, computes which non-top member files the writer should `Read` to fill behavioral gaps. Sorts members by `pageRank` descending (lex-tiebroken), excludes the top-ranked file (whose body is already inlined), and caps at `MAX_READ_BREADCRUMBS = 8`. Each breadcrumb's `reason` differs depending on whether the member is in `memberPreviews` ("preview covers it — Read only if prose cites a non-previewed symbol") or not ("no preview shipped — Read before citing behavior or per-file prose"). |
| `suggestedQueriesFor` | function | `export function suggestedQueriesFor(payload: PagePayload): SuggestedQuery[]` | Returns at most one `Read` suggestion per member file, but only when `payload.kind === "community-file"`. All other kinds rely entirely on the canonical `payload.semanticQueries` list defined in `src/wiki/semantic-queries.ts`; the comment notes the prior boilerplate `read_relevant` entries duplicated that list and were dropped. When `memberFiles` is empty the function falls back to one `Read` keyed off the page title. |

## Internals

- **The dispatcher in `registerWikiTools` is a flat if-else** (`src/tools/wiki-tools.ts:89-276`). `generate_wiki` accepts six mutually-exclusive switches (`finalize`, `resume`, `incremental`, `synthesis`, `page`, plus the default root response) and the handler picks the first one that's set. Adding a new mode means adding a new `if` branch and a new `build…Response` helper; there is no schema-driven router.
- **Outer `communityId` splices into the synthesis payload.** `write_synthesis` normalizes via `{ ...payload, communityId: payload.communityId ?? communityId }` (`src/tools/wiki-tools.ts:89-276`). The comment notes the practical reason: agents routinely pass `communityId` on the outer arg and omit it from the nested payload, and failing validation would discard a multi-minute 4-agent batch.
- **Writing rules are written to disk, not inlined into prompts.** `WRITING_RULES_PROJECT_PATH = "wiki/_meta/writing-rules.md"` and `writeWritingRulesFile(wikiDir)` (`src/tools/wiki-tools.ts:772-773`) persist the `WRITING_RULES` blob once per planning pass; orchestrator prompts then point writer agents at the file via the standard `Read` tool. The write is wrapped in a try/catch — non-fatal because the init/finalize responses carry a fallback inline mention of the path.
- **`WRITER_PARALLELISM = 4`** (`src/tools/wiki-tools.ts:797`) is the agent-batch planner's default fan-out. The comment cites two constraints: Claude Code rate limits below 4 are wasteful, scaling past 6 is sub-linear.
- **`AGGREGATE_KINDS = new Set(["architecture", "getting-started", "data-flows"])`** (`src/tools/wiki-tools.ts:801`) drives the wave-2 split: aggregate pages link into community pages and must run after every community is written. `packBatches` and `renderWave` consume this set to emit two ordered batches in init/finalize responses.
- **`MAX_READ_BREADCRUMBS = 8`** (`src/tools/wiki-tools.ts:958`) caps the "Member files you may need to Read" block in `renderAssistBlock`. The cap matches the typical PageRank long-tail length where the marginal Read is no longer worth recommending.
- **`NEARBY_DOC_BYTES_CAP = 2 * 1024`** and **`NEARBY_DOCS_TOTAL_BYTES_CAP = 12 * 1024`** (`src/tools/wiki-tools.ts:1199-1200`) bound the per-doc and aggregate sizes for nearby-docs inlined in community page payloads. The comment ties these caps to the synthesis prompt's matching limits — together they prevent large READMEs/design notes from dominating token spend.
- **`EXTERNAL_DEP_SAMPLE = 5`** (`src/tools/wiki-tools.ts:1208-1209`) is the head-sample size for `externalConsumers` and `externalDependencies` inlined in page payloads. Down from a previous 30-each because downstream links are lazy: writers can always call `read_relevant`, `depended_on_by`, or `depends_on` for the full list.
- **`PER_FILE_EDGES_MAX_MEMBERS = 5`** and **`PER_FILE_EDGE_SAMPLE = 8`** (`src/tools/wiki-tools.ts:1217-1218`) gate the per-file importer/dependency table. Bundles with at most 5 members render the table; larger bundles fall back to the flat aggregate so the prompt stays compact. Each direction is capped at 8 entries so a hub file's long importer list can't dominate.
- **`CITED_RANGE_RE = /\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}):\d+(?:-\d+)?\b/g`** (`src/tools/wiki-tools.ts:2054-2055`) is the regex `loadChunkRangesForCitedPaths` uses to scan rendered prose for path-with-line-range style citations and pre-load their `ChunkRange` for the linter. Regex limits the extension to 1–6 characters so it doesn't match arbitrary ratios in prose.
- **`INDEX_FRESHNESS_NOTE`** (`src/tools/wiki-tools.ts:1879-1881`) is the standard banner about when the search index was last refreshed; finalize and incremental responses surface it.
- **`META_DIR = "_meta"`** plus the seven sibling filename constants (`BUNDLES_FILE`, `SYNTHESES_FILE`, `DISCOVERY_FILE`, `CLASSIFIED_FILE`, `MANIFEST_FILE`, `CONTENT_FILE`, `ISOLATE_DOCS_FILE` — declared starting at `src/tools/wiki-tools.ts:421-421` and the seven sibling constants on the lines immediately below) name every JSON artifact the wiki pipeline persists under `wiki/_meta/`. Helpers `p(wikiDir, name)`, `readJSON<T>(path)`, and `writeJSON(path, value)` thread these through every reader/writer in this file.
- **`buildLintBatchResponse(projectDir, ragDb, applyFixes)`** (`src/tools/wiki-tools.ts:285-372`) walks every `.md` under `wiki/`, lints with `lintPage`, and when `applyFixes` is `true` substitutes `correctedMatch` for warnings that ship one — currently only `line-range-drift`. The comment is explicit that the operation is safe to run repeatedly because warnings without corrections are never touched.
- **`buildLintPageResponse` resolves both relative and absolute paths.** `src/tools/wiki-tools.ts:374-417` checks `inputPath.startsWith("/")` and otherwise joins against `projectDir` before `existsSync`. The error message tells the caller exactly which forms are accepted.
- **`safeRead(path)`** (`src/tools/wiki-tools.ts:2110-2116`) is the shared `try { readFileSync } catch { null }` helper used everywhere a file may be missing or unreadable. Functions further up the call stack treat `null` as "skip this artifact" rather than propagating an error.
- **`inferFence(filePath)`** (`src/tools/wiki-tools.ts:1179-1193`) maps a file extension to the Markdown fence language used inside rendered code blocks. It hardcodes `.cjs`/`.mjs` to `js`, `.kt` to `kotlin`, `.cs` to `csharp`, `.h` to `c`, and so on. Unknown extensions return the empty string so the fence falls back to bare `\`\`\``.
- **`renderAssistBlock(payload)`** (`src/tools/wiki-tools.ts:1025-1050`) is the only consumer of both public helpers (`communityReadBreadcrumbs`, `suggestedQueriesFor`). When both lists are empty it returns the empty string so the section doesn't render at all — the page payload then omits the `## When you need more context` heading entirely.
- **Snapshot capture is split into two paths.** `captureSnapshot` (`src/tools/wiki-tools.ts:1700-1740`) is the standard incremental capture; `captureFallbackSnapshot` (`src/tools/wiki-tools.ts:1748-1779`) handles the case where the prior manifest JSON is missing or corrupt. Both write to `snapshotPath(wikiDir)` via `src/wiki/update-log.ts`, and `wiki_finalize_log` reads exactly that file.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/wiki/index.ts](index.md)
- [src/wiki/lint-page.ts](lint-page.md)
- [src/wiki/update-log.ts](update-log.md)
- [Wiki orchestration](../wiki-orchestration.md)
