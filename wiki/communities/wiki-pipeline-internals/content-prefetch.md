# src/wiki/content-prefetch.ts

> [Architecture](../../architecture.md) › [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
>
> Generated from `79e963f` · 2026-04-26

`src/wiki/content-prefetch.ts` is the bundle-assembly and semantic-query pre-run layer for the wiki generation pipeline. It takes the community bundles produced by earlier pipeline phases and wires them into the per-page content cache that `generate_wiki(page: N)` serves to writer agents. It also runs semantic search queries in advance so each writer's first `read_relevant` call is already answered before the agent starts.

## Role

This file owns the transition from "we have communities and syntheses" to "each wiki page has its content payload ready." It sits between community bundling (which runs during the synthesis phase) and page rendering (which happens per-page when an agent calls `generate_wiki(page: N)`). It depends on `src/wiki/community-detection.ts` (for `isTestOrBench`), `src/wiki/pagerank.ts` (for `computePageRank`), `src/wiki/semantic-queries.ts` (for per-kind query lists), `src/search/hybrid.ts` (for `searchChunks`), and the DB and config layers.

## Exports

| Name | Kind | Signature | What it does |
|---|---|---|---|
| `scopeBundleToFiles` | function | `scopeBundleToFiles(parent: CommunityBundle, files: string[], projectDir: string): CommunityBundle` | Narrows a full community bundle to a specific subset of member files for a `community-file` sub-page. Filters exports, tunables, annotations, commits, edge maps, and previews to the subset. Sets `topRankedFile` to the highest-PageRank file within the subset. |
| `prefetchContent` | function | `async prefetchContent(db, manifest, discovery, classified, syntheses, bundlesById, projectDir, config, supplementaryDocs?): Promise<ContentCache>` | Builds the complete `ContentCache` for all pages in the manifest. Calls `buildArchitectureBundle` and `buildGettingStartedBundle` once, then dispatches per-page bundle scoping, and finally runs all semantic query prefetches in parallel. |
| `buildArchitectureBundle` | function | `buildArchitectureBundle(discovery, classified, syntheses, bundlesById, db, projectDir, supplementaryDocs?): ArchitectureBundle` | Constructs the bundle for the architecture page: community list, meta-edges, community-level PageRank, top hub files with their importing communities, entry points, cross-cutting files, root docs, and architectural annotations. |
| `buildGettingStartedBundle` | function | `buildGettingStartedBundle(discovery, classified, syntheses, bundlesById, architecture, projectDir): GettingStartedBundle` | Constructs the bundle for the getting-started page: README, package manifest, top community, CLI entry points, config files, and early commits. |

## Internals

**`DEPTH_CAPS` controls what each bundle depth ships.** The constant `DEPTH_CAPS` defines three depth levels:
- `full`: no caps — `exports: Infinity`, `tunables: Infinity`, `nearbyDocs: Infinity`, all annotations and edges kept.
- `standard`: `exports: 25`, `tunables: 15`, `nearbyDocs: 3`, annotations and edges kept.
- `brief`: `exports: 10`, `tunables: 5`, `nearbyDocs: 0`, annotations and edges dropped.

`stripPreviewsForDepth` applies these caps before storing the bundle in the cache. Member previews (the largest field) are always dropped for non-`full` pages. Exports and tunables are sliced from the front of their arrays, which are pre-sorted by per-file PageRank descending — so slicing keeps the highest-signal entries.

**Semantic query prefetch constants gate noise.** Three constants bound the prefetch queries:
- `PREFETCH_TOP_K = 4` — only the top 4 hits per query are kept.
- `PREFETCH_SCORE_THRESHOLD = 0.3` — hits below this relevance score are dropped.
- `PREFETCH_SNIPPET_LINES = 12` — each hit's snippet is capped at 12 lines.

These deliberately small values prevent prefetch results from overwhelming the writer's context. The goal is to replace the writer's first `read_relevant` call, not to provide exhaustive search results.

**`scopeBundleToFiles` produces a self-sufficient sub-page payload.** When scoping for a `community-file` page, the function copies `consumersByFile` and `dependenciesByFile` entries for the subset, then assembles `externalConsumers` and `externalDependencies` as the union of those entries. These were already filtered to "external to the parent community" at bundle-build time, so the sub-page's external edges are automatically correct without a `depended_on_by` round-trip. `nearbyDocs` is always set to `[]` for sub-pages — the parent community page owns that content.

**Architecture bundle derives `importingCommunities` per top hub.** For each file marked `isTopHub`, `buildArchitectureBundle` scans all file-level edges and collects the set of community slugs that import the hub file from outside the hub's own community. This gives the architecture page writer a prose-ready list ("imported by the cli-commands and search-runtime communities") rather than a raw fan-in integer.

**Root doc discovery is conservative.** `readRootDocs` probes for five well-known names at the project root (README.md, README, ARCHITECTURE.md, DESIGN.md, CONTRIBUTING.md) and ADR files under `docs/adr`, `adr`, or `docs/adrs`. Files above `ROOT_DOC_MAX_BYTES = 64 * 1024` bytes are read up to that limit. The `DOC_PREVIEW_LINES = 10` constant controls how many lines of each doc are included in the bundle payload — full content stays on disk and is `Read` on demand.

**Architectural annotations fall back to all annotations.** `buildArchitectureBundle` first filters annotations across all bundles for those matching `ARCHITECTURAL_KEYWORDS = /architecture|design|invariant|contract|cross[- ]cutting/i`. If no annotations match, it falls back to collecting every annotation in the DB. This ensures the architecture page always has some annotation content, even in projects that haven't written keyword-tagged notes.

**Supplementary docs are deduped and filtered.** Docs that duplicate a root doc path or have empty content are dropped before being added to the architecture bundle. The survivors are converted to `{ path, byteSize, firstLines }` previews using `toDocPreview` — the same shape as root docs.

**Community meta-PageRank is computed on an undirected graph.** `computeCommunityMetaPageRank` builds a `graphology` graph from community slugs and meta-edges (cross-community import edges weighted by file-import count). The graph is undirected so PageRank reflects overall centrality rather than directional flow. Edges between the same community pair are merged by summing weights. The resulting PageRank scores are used to rank communities on the getting-started page.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/db/types.ts](src-db-types-ts.md)
- [src/wiki/community-synthesis.ts](community-synthesis.md)
- [src/wiki/types.ts](src-wiki-types-ts.md)
- [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
