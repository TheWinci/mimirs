# src/wiki/types.ts

> [Architecture](../../architecture.md) › [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
>
> Generated from `79e963f` · 2026-04-26

## Role

`src/wiki/types.ts` is the shared type contract for the entire wiki generation pipeline. It defines every interface that crosses a phase boundary — from discovery output through categorization, community bundling, synthesis payloads, the page manifest, and the final per-page payload handed to writer agents. Every other wiki module imports from this file; it has no runtime logic of its own.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `FileLevelNode` | interface | `{ path, exports, fanIn, fanOut, isEntryPoint }` | One node in the file-level import graph, with pre-computed fan-in/out and an entry-point flag. |
| `FileLevelEdge` | interface | `{ from, to, source }` | A directed import edge between two file paths, annotated with the import source string. |
| `FileLevelGraph` | interface | `{ level: "file", nodes, edges }` | The full file-level dependency graph returned by discovery. |
| `DirectoryEntry` | interface | `{ path, fileCount, files, totalExports, fanIn, fanOut }` | Aggregate stats for one directory in the directory-level rollup. |
| `DirectoryEdge` | interface | `{ from, to, importCount }` | An inter-directory dependency with the count of cross-directory imports. |
| `DirectoryLevelGraph` | interface | `{ level: "directory", directories, edges }` | The directory-level rollup graph, used to explain high-level architecture. |
| `DiscoveryModule` | interface | `{ name, path, entryFile, files, exports, fanIn, fanOut, internalEdges, cohesion, children? }` | A Louvain community as seen after discovery — its members, metrics, and optional sub-communities. The `cohesion` field is internal edges divided by max possible internal edges; low values flag grab-bag clusters. |
| `DiscoveryResult` | interface | `{ fileCount, chunkCount, lastIndexed, modules, graphData, warnings }` | The full output of Phase 1 (discovery + Louvain clustering). |
| `SymbolTier` | type | `"entity" \| "bridge"` | Categorization tier: entities are widely-referenced types/classes; bridges are cross-cutting utilities. |
| `Scope` | type | `"cross-cutting" \| "shared" \| "local"` | How broadly a symbol is used across modules. |
| `ClassifiedSymbol` | interface | `{ name, type, file, tier, scope, referenceCount, referenceModuleCount, referenceModules, hasChildren, childCount, isReexport, snippet }` | One symbol after Phase 2 categorization, with reference stats pre-computed. |
| `ClassifiedFile` | interface | `{ path, fanIn, fanOut, pageRank, isTopHub, bridges, entities }` | One file after Phase 2, with PageRank replacing the old `isHub` boolean; `isTopHub` is true for the top-K files by PageRank. |
| `ClassifiedInventory` | interface | `{ symbols, files, warnings }` | Full output of Phase 2 (categorization). |
| `CommunityBundle` | interface | See below | Everything the synthesis LLM needs to name a community and propose page sections. |
| `SynthesisPayload` | interface | `{ communityId, name, slug, purpose, sections, kind? }` | The LLM-produced plan for one community page: title, slug, purpose, and sections. |
| `SectionSpec` | interface | `{ title, purpose, shape? }` | One proposed section within a synthesis, with optional structural shape from the section catalog. |
| `PageDepth` | type | `"full" \| "standard" \| "brief"` | Controls prose word-count target for the page writer. |
| `ManifestPage` | interface | `{ kind, slug, title, purpose, sections, depth, memberFiles, communityId?, relatedPages, order }` | One page in the manifest, either a community page (from synthesis) or an aggregate page (deterministic). |
| `PageManifest` | interface | `{ version: 3, generatedAt, lastGitRef, pageCount, pages, warnings, cluster? }` | The full wiki manifest at version 3. The `cluster` field records whether file-level or symbol-level Louvain was used. |
| `SynthesesFile` | interface | `{ version: 1, payloads, memberSets }` | Persistent store of synthesis payloads keyed by community ID. `memberSets` tracks which member-file set each ID was derived from, enabling staleness detection. |
| `PageContentCache` | interface | `{ community?, architecture?, gettingStarted?, prefetchedQueries? }` | Per-page content bundle holding the community bundle, architecture bundle, or getting-started bundle, plus pre-run semantic query results. |
| `PrefetchedQueryHit` | interface | `{ path, startLine, endLine, entityName, chunkType, score, snippet }` | One pre-run semantic query result, with the snippet byte-capped at build time. |
| `DocPreview` | interface | `{ path, byteSize, firstLines }` | A path-and-preview reference for large doc files. Shipping only the first ~10 lines avoids inflating bundle token counts. |
| `ArchitectureBundle` | interface | See below | All data needed to write the architecture page: communities, meta-graph edges, PageRank, hubs, entry points, cross-cutting files, root docs, annotations, and supplementary docs. |
| `GettingStartedBundle` | interface | `{ readme, packageManifest, topCommunity, cliEntryPoints, configFiles, originCommits }` | Data bundle for the getting-started page. |
| `ContentCache` | type | `Record<string, PageContentCache>` | The in-memory content cache keyed by page slug. |
| `PagePayload` | interface | See below | The full payload returned by `generate_wiki(page: N)` — everything the writer agent needs. |
| `WikiPlanResult` | interface | `{ discovery, classified, manifest, content, syntheses, warnings }` | The in-memory result of the full wiki pipeline run, before anything is written to disk. |

## Internals

**`CommunityBundle` is the densest interface in the file.** It carries: member files, exports (capped at `MAX_EXPORTS_IN_BUNDLE` with `exportCount` for the uncapped count), tunables (constant-typed exports with full initializer snippets), top-ranked file, per-member previews, page rank per file, cohesion score, nearby docs, and per-member consumer/dependency maps. The `consumersByFile` and `dependenciesByFile` fields avoid re-querying the DB during page writing — the bundle is built once and shipped as a self-contained payload. The `memberPreviews` array is byte-capped across the set; lowest-rank members drop first when the budget is exceeded.

**`ArchitectureBundle.topHubs` carries both PageRank and raw fan-in/fan-out.** PageRank provides a ranking signal (relative importance) while `fanIn`/`fanOut` provide citable integers ("imported by 77 files"). The `importingCommunities` field lists community slugs that reach the hub through the import graph, excluding the community the hub itself belongs to. This lets writers produce the sentence "imported by N of M communities" without additional lookups.

**`PagePayload.preRendered` pre-renders the breadcrumb and See also block.** In an earlier design, writer agents were expected to construct the breadcrumb and See also section themselves from the link map. In practice, many pages omitted these blocks. The `preRendered` field ships them as ready-to-copy strings, enforced by the writing rules (`Copy it verbatim`).

**`SynthesesFile.memberSets` enables staleness detection.** When the Louvain clustering runs again and produces a community with the same ID but different members, the system can detect the drift by comparing the stored member set against the new one. Communities whose members changed are flagged for re-synthesis.

**`PageDepth` drives prose word-count targets, not structure.** The `depth` field on `ManifestPage` and `PagePayload` controls how much prose the writer should produce (`brief` = 120–250 words, `standard` = 400–700, `full` = 800–1400), not which sections to include. Sections come exclusively from `sections: SectionSpec[]`.

**`src/wiki/types.ts` depends only on `src/db/types.ts`.** The single external dependency is for the `SymbolResult` type imported from `src/db/types.ts` and re-used in `ClassifiedSymbol`. This narrow dependency keeps the type file importable from any phase without introducing cycles.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/db/types.ts](src-db-types-ts.md)
- [src/wiki/community-synthesis.ts](community-synthesis.md)
- [src/wiki/content-prefetch.ts](content-prefetch.md)
- [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
