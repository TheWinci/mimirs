# src/wiki/types.ts

> [Architecture](../../architecture.md) › [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
>
> Generated from `b47d98e` · 2026-04-26

## Role

`src/wiki/types.ts` is the data contract that every other wiki-pipeline file imports. It defines no logic — only `interface`s and `type` aliases that describe phase outputs (`DiscoveryResult`, `ClassifiedInventory`, `CommunityBundle`, `PageManifest`), LLM hand-offs (`SynthesisPayload`, `PagePayload`), per-page caches (`PageContentCache`, `ContentCache`), and update-log artefacts (`PreRegenSnapshot`, `PageDiff`). The only external dependency is `SymbolResult` re-imported from `src/db/types.ts`. Every member of this community plus the orchestrator barrel and MCP tool layer depends on this file — it is the busiest interior import in the wiki package.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `FileLevelNode` | interface | `export interface FileLevelNode` | One file in the import graph: `path`, `exports`, `fanIn`, `fanOut`, `isEntryPoint`. |
| `FileLevelEdge` | interface | `export interface FileLevelEdge` | Directed import edge with `from`, `to`, and `source` (the import statement text). |
| `FileLevelGraph` | interface | `export interface FileLevelGraph` | `{ level: "file", nodes, edges }` — the file-import graph emitted by Phase 1. |
| `DirectoryEntry` | interface | `export interface DirectoryEntry` | Aggregated directory: `path`, `fileCount`, `files`, `totalExports`, `fanIn`, `fanOut`. |
| `DirectoryEdge` | interface | `export interface DirectoryEdge` | Directory-level edge with an aggregate `importCount`. |
| `DirectoryLevelGraph` | interface | `export interface DirectoryLevelGraph` | `{ level: "directory", directories, edges }` — the directory roll-up of the file graph. |
| `DiscoveryModule` | interface | `export interface DiscoveryModule` | One Louvain-detected community with `cohesion = internalEdges / maxPossible` and an optional `children` tree. |
| `DiscoveryResult` | interface | `export interface DiscoveryResult` | Phase-1 output: `fileCount`, `chunkCount`, `lastIndexed`, `modules`, `graphData`, `warnings`. |
| `SymbolTier` | type | `export type SymbolTier = "entity" \| "bridge"` | Whether a symbol has children (bridge) or not (entity). |
| `Scope` | type | `export type Scope = "cross-cutting" \| "shared" \| "local"` | Reach: cross-cutting ≥ 3 modules, shared = 2, local = 1. |
| `ClassifiedSymbol` | interface | `export interface ClassifiedSymbol` | Per-symbol Phase-2 record with `tier`, `scope`, reference counts, `referenceModules`, `isReexport`. |
| `ClassifiedFile` | interface | `export interface ClassifiedFile` | Per-file Phase-2 record with `pageRank`, `isTopHub` (top 5% by PageRank), `bridges`, `entities`. |
| `ClassifiedInventory` | interface | `export interface ClassifiedInventory` | `{ symbols, files, warnings }` — Phase-2 output. |
| `CommunityBundle` | interface | `export interface CommunityBundle` | The deterministic LLM-input shape for one community: id, members, exports, tunables, dependencies, commits, annotations, previews, page-rank, cohesion, nearby docs. |
| `SynthesisPayload` | interface | `export interface SynthesisPayload` | LLM-produced page plan: `communityId`, `name`, `slug` (kebab-case, `/^[a-z0-9-]+$/`), `purpose`, `sections`, optional `kind`. |
| `SectionSpec` | interface | `export interface SectionSpec` | One section: `title`, `purpose`, optional `shape` lifted from `SECTION_CATALOG`. |
| `PageDepth` | type | `export type PageDepth = "full" \| "standard" \| "brief"` | Word-budget tier; drives section count and depth contract. |
| `ManifestPage` | interface | `export interface ManifestPage` | One row in the manifest: kind, slug, title, purpose, sections, depth, memberFiles, optional communityId, relatedPages, order. |
| `PageManifest` | interface | `export interface PageManifest` | `version: 3`, generation metadata, `pages` keyed by wiki path, `cluster` mode. |
| `SynthesesFile` | interface | `export interface SynthesesFile` | `version: 1` persistence: `payloads` keyed by community id, `memberSets` recording the member files each synthesis was approved against. |
| `PageContentCache` | interface | `export interface PageContentCache` | Per-page content slice — one of `community`, `architecture`, `gettingStarted` plus `prefetchedQueries`. |
| `PrefetchedQueryHit` | interface | `export interface PrefetchedQueryHit` | One pre-run semantic-query hit; `snippet` byte-capped at build time. |
| `DocPreview` | interface | `export interface DocPreview` | Path-only doc reference with byte size and first-N-line preview — replaces shipping verbatim content. |
| `ArchitectureBundle` | interface | `export interface ArchitectureBundle` | Architecture-page input: communities, meta-edges, top hubs, entry points, cross-cutting files, root docs, supplementary docs, architectural notes. |
| `GettingStartedBundle` | interface | `export interface GettingStartedBundle` | Getting-started input: README verbatim, package manifest, top community, CLI entry points, config files, origin commits. |
| `ContentCache` | type | `export type ContentCache = Record<string, PageContentCache>` | Per-wiki-path map of content caches. |
| `PagePayload` | interface | `export interface PagePayload` | Phase-5 writer input: every field a writer needs in one shape, including `linkMap`, `breadcrumbs`, `semanticQueries`, `prefetchedQueries`, `preRendered.{breadcrumb, seeAlso}`. |
| `WikiPlanResult` | interface | `export interface WikiPlanResult` | Orchestrator output: discovery + classified + manifest + content + syntheses + warnings. |
| `PreRegenSnapshotPage` | interface | `export interface PreRegenSnapshotPage` | One pre-regen snapshot row: title, kind, depth, triggers, prior `oldContent` (null for added pages). |
| `PreRegenSnapshot` | interface | `export interface PreRegenSnapshot` | Versioned snapshot wrapping commit list, removed pages, and stale/added page table for finalize-time diffs. |
| `PageDiff` | interface | `export interface PageDiff` | Per-page structural diff: status, sections added/removed/rewritten, citation deltas, mermaid delta, numeric-literal deltas, byte delta. |

## Internals

- **`PageManifest.version: 3` is a literal type, not a number field.** Bumping the version forces every consumer to update the literal explicitly — old artifacts with `version: 2` won't typecheck against the new shape, which is the intended migration signal. The synthesis file pins `version: 1` for the same reason.

- **`CommunityBundle.exportCount` and `tunableCount` are pre-cap counts.** The `exports` and `tunables` arrays are capped (at `MAX_EXPORTS_IN_BUNDLE`/`MAX_EXPORTS_LOW_COHESION` and `MAX_TUNABLES = 40` respectively, defined in `src/wiki/community-synthesis.ts`); these companion counts let the writer say "shown N of M" rather than guess.

- **`CommunityBundle.consumersByFile` and `dependenciesByFile` are per-member maps.** They give writer agents file-attributed importer/dependency lists so they don't have to call `depended_on_by` per file. Sub-page scoping in `scopeBundleToFiles` unions these into a sub-page-scoped `externalConsumers` view without re-querying the DB.

- **`CommunityBundle.cohesion` doubles as a cap selector.** Anywhere downstream uses cohesion < `LOW_COHESION_THRESHOLD = 0.15` to switch from cohesive caps (`MAX_EXPORTS_IN_BUNDLE = 60`, `MAX_DOCS_HIGH_COHESION = 8`) to grab-bag caps (`MAX_EXPORTS_LOW_COHESION = 15`, `MAX_DOCS_LOW_COHESION = 3`). The denominator is `n*(n-1)`, so single-member modules report `cohesion: 0`.

- **`SynthesisPayload.kind` is free-form.** The comment notes that `kind` "replaces the old closed `tier` enum" — code that branches on kind (e.g. `semanticQueriesFor`) treats unknown kinds as a no-op rather than throwing. Most LLM payloads write `"community"`, but the orchestrator does not enforce this.

- **`SynthesisPayload.slug` regex is `/^[a-z0-9-]+$/`.** The validation lives in the runtime `validateSynthesisPayload` (not in this file), but the JSDoc on the field documents the constraint. Slugs become path segments under `wiki/communities/`, so any character outside the regex would break path construction in `buildPageTree`.

- **`PageContentCache` is a discriminated-shape-by-presence union.** Exactly one of `community`, `architecture`, or `gettingStarted` is populated per cache entry — the page's `kind` decides which. `prefetchedQueries` is shared across all three, optional for backward compatibility with older artifacts written before the field was added.

- **`PrefetchedQueryHit.snippet` is line-capped at build time.** The doc comment says "Snippet (first N lines) of the chunk. Capped per `PREFETCH_SNIPPET_LINES`" — that constant lives in `src/wiki/content-prefetch.ts`, not here. The cap matters because per-query results can ship 5–10 hits each across 5 queries; uncapped chunks would balloon the payload past LLM context windows.

- **`PagePayload.preRendered` is a copy-verbatim block.** The doc comment records a measured failure: 0 of 12 community pages grew a See also block in the v2 run when guidance was prose-only. Pre-rendering moves the heading and the bulleted list from "writer must remember" to "writer copies verbatim".

- **`PreRegenSnapshotPage.oldContent` is null for added pages.** The diff path needs the prior body to compute deltas, but newly-added pages have no prior version. Consumers must check `oldContent !== null` before diffing.

- **`PageDiff.mermaidDelta` carries old + new counts and types.** It tracks both raw count (added/removed mermaid blocks) and chart-type lists (`flowchart`, `sequenceDiagram`, etc.) so a finalize-time narrator can say "added 1 sequenceDiagram, removed 2 flowcharts" rather than the bare "delta: -1".

- **`ArchitectureBundle.crossCuttingFiles` exists for high-fanIn outsiders.** Some files (test fixtures, benchmark helpers) have huge `fanIn` but are excluded from Louvain communities. Without surfacing them in the architecture bundle, the architecture page would hide real coupling. The list is sorted by `fanIn` descending and capped at 10; the only `reason` value emitted today is `"test-fixture"`.

- **`GettingStartedBundle.readme` ships verbatim.** Unlike `ArchitectureBundle.rootDocs` / `supplementaryDocs` which use `DocPreview`, the README is inlined in full. The shape was chosen because the getting-started writer needs the exact text to weave into prose, not a head preview.

- **`PageManifest.cluster` is optional.** Pre-`cluster` manifests didn't carry the field; new manifests record whether the run used file-level or symbol-level Louvain so staleness detection can branch on cluster mode rather than re-deriving it.

- **`ManifestPage.communityId` is optional.** Aggregate pages (architecture, getting-started, data-flows) have no community id; sub-pages share their parent's id. Consumers walking community pages must filter on `communityId` and `kind` together to avoid collapsing parent + sub-pages into a single record.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/db/types.ts](src-db-types-ts.md)
- [src/wiki/community-synthesis.ts](community-synthesis.md)
- [src/wiki/content-prefetch.ts](content-prefetch.md)
- [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
