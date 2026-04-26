# src/wiki/content-prefetch.ts

> [Architecture](../../architecture.md) › [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
>
> Generated from `b47d98e` · 2026-04-26

## Role

`src/wiki/content-prefetch.ts` is the phase-5 worker of the wiki pipeline: it takes the page manifest produced by `runWikiFinalPlanning`, the per-community bundles built earlier in synthesis, and the raw discovery/classification artifacts, and folds them into a `ContentCache` keyed by wiki path. The cache is what `getPagePayload` later reads from to return a focused payload to the writer agent. The file owns three jobs: (1) build the architecture and getting-started bundles that depend on the final synthesis output, (2) scope a community bundle down to the subset of files belonging to a `community-file` sub-page, and (3) pre-run the semantic queries each writer would otherwise issue as their first `read_relevant` call. It depends on `src/wiki/community-detection.ts` for `isTestOrBench`, `src/wiki/pagerank.ts` for `computePageRank`, `src/wiki/semantic-queries.ts` for `semanticQueriesFor`, `src/search/hybrid.ts` for `searchChunks`, and the type module `src/wiki/types.ts`.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `scopeBundleToFiles` | function | `scopeBundleToFiles(parent: CommunityBundle, files: string[], projectDir: string): CommunityBundle` | Narrows a parent community bundle to a specific subset of member files for a `community-file` sub-page. Filters `exports`, `tunables`, `annotations`, and `recentCommits` down to the scoped `files`; selects the highest-PageRank file in the subset as `topRankedFile`; rebuilds `consumersByFile`/`dependenciesByFile` and unions them into scoped `externalConsumers`/`externalDependencies`. Single-file and multi-file group sub-pages share this code path. |
| `prefetchContent` | function | `async prefetchContent(db, manifest, discovery, classified, syntheses, bundlesById, projectDir, config, supplementaryDocs?): Promise<ContentCache>` | Builds the `ContentCache` for every page in the manifest. Constructs the architecture and getting-started bundles once, attaches the right bundle to each page based on `page.kind`, scopes community bundles for sub-pages via `scopeBundleToFiles`, then runs `semanticQueriesFor(page.kind)` against `searchChunks` in parallel for every page that ships queries. |
| `buildArchitectureBundle` | function | `buildArchitectureBundle(discovery, classified, syntheses, bundlesById, db, projectDir, supplementaryDocs?): ArchitectureBundle` | Assembles the `ArchitectureBundle` consumed by the architecture page. Sorts communities alphabetically by slug, computes meta-edges by counting cross-community file imports, runs `computeCommunityMetaPageRank`, derives `topHubs` (filtered by `isTopHub`) with their importing communities, filters `entryPoints` to drop noise (entries with zero exports and a non-code extension), assembles `crossCuttingFiles` from test/bench files with `fanIn >= 5` (top 10), reads root docs and config, and aggregates architectural annotations matching `ARCHITECTURAL_KEYWORDS`. |
| `buildGettingStartedBundle` | function | `buildGettingStartedBundle(discovery, classified, syntheses, bundlesById, architecture, projectDir): GettingStartedBundle` | Builds the `GettingStartedBundle` for the getting-started page. Reads the README, parses the package manifest, picks the highest-PageRank community as `topCommunity`, filters entry points by `CLI_NAME_PATTERN = /(cli|bin|main|server|entry)/i`, reads any present file in `CONFIG_FILE_NAMES`, and collects the earliest five unique commits across all bundles' `recentCommits`. |

The file also declares several module-private constants that govern its behavior:

- `DEPTH_CAPS` — depth-keyed limits on bundle list-fields. `full` keeps everything (`Infinity`), `standard` caps `exports` at `25` and `tunables` at `15` while keeping annotations, edges, commits, and `nearbyDocs: 3`. `brief` caps `exports` at `10`, `tunables` at `5`, drops annotations, drops external edges, drops commits, and `nearbyDocs: 0`.
- `ROOT_DOC_CANDIDATES` — the ordered list of repo-root doc filenames `readRootDocs` probes: README.md, README, ARCHITECTURE.md, DESIGN.md, CONTRIBUTING.md.
- `ROOT_DOC_MAX_BYTES = 64 * 1024` — read cap per root doc; longer files are sliced.
- `DOC_PREVIEW_LINES = 10` — first-line count shipped in `toDocPreview`; full content stays on disk.
- `CONFIG_FILE_NAMES` — the config filenames surfaced to getting-started: .env.example, .env.sample, tsconfig.json, Cargo.toml, pyproject.toml, go.mod.
- `CLI_NAME_PATTERN = /(cli|bin|main|server|entry)/i` — basename matcher for CLI entry points.
- `ARCHITECTURAL_KEYWORDS = /architecture|design|invariant|contract|cross[- ]cutting/i` — annotation note matcher for `architecturalNotes`.
- `PREFETCH_TOP_K = 4`, `PREFETCH_SCORE_THRESHOLD = 0.3`, `PREFETCH_SNIPPET_LINES = 12` — caps on the pre-run `read_relevant` substitute. `PREFETCH_TOP_K` is intentionally low so query results inline cleanly into the prompt.
- The cross-cutting filter inside `buildArchitectureBundle` uses two inline literals — minimum fan-in of `5` and a top-K of `10` — that gate which test/bench files appear in `crossCuttingFiles`.

## Internals

- **`stripPreviewsForDepth` is the depth-aware trimmer.** It is called for every non-architecture page right after the bundle is selected; previews are dropped for `standard` and `brief`, and the `DEPTH_CAPS` slice is applied to `exports`, `tunables`, `annotations`, `externalConsumers`, `externalDependencies`, `consumersByFile`, `dependenciesByFile`, `recentCommits`, and `nearbyDocs`. The doc comment is explicit: exports and tunables arrive sorted by per-file PageRank descending, so `slice(0, n)` keeps the highest-signal entries.
- **`scopeBundleToFiles` rebuilds edge maps from scratch.** It walks each scoped file's `consumersByFile[f]` and `dependenciesByFile[f]` from the parent, unions them into `scopedConsumers`/`scopedDependencies`, and uses those as the new `externalConsumers`/`externalDependencies`. The doc comment notes the parent values were already filtered to "external to the parent community" at bundle build, so the union is automatically external to the sub-page's parent — no `depended_on_by` round-trip needed.
- **The pre-run query loop is parallel across pages, sequential within a page.** `prefetchContent` iterates the manifest, kicks off one `runPrefetchQueries` task per page that has queries, and `await Promise.all`s them. Inside `runPrefetchQueries` the queries run in a `for` loop with sequential `await`s — a deliberate choice because `searchChunks` already does its own parallelism over chunks, and stacking a second layer of concurrency here regresses.
- **`PREFETCH_SNIPPET_LINES = 12` is a hard truncation.** Each pre-fetched hit's `snippet` is the chunk's content split on newlines, sliced to the first 12, and re-joined. Long chunks get cut mid-function. Writers are expected to `Read` the file when they need more, which is why the snippet ships with `path`, `startLine`, and `endLine` for direct navigation.
- **Community-file scoping happens before depth trimming.** In the `prefetchContent` page loop, sub-pages call `scopeBundleToFiles(parent, page.memberFiles, projectDir)` first and `stripPreviewsForDepth(bag.community, page.depth)` second. The order matters: scoping selects the right exports/tunables, then trimming caps them — flipping the order would trim the parent first and silently drop scoped-file signal that survived parent-level capping.
- **`buildArchitectureBundle`'s entry-point filter has a "noise rule".** A node with `n.isEntryPoint` survives only if it has at least one export, OR its extension is in the code-extension set derived from `classified.symbols`. This drops fixtures, plugin manifests, and `.md`/`.txt` files the resolver caught as graph sinks. The set is built dynamically per project — there is no hardcoded list of code extensions.
- **`metaEdges` are weighted by file-import count.** For every cross-community file edge in `discovery.graphData.fileLevel.edges`, the `(fromSlug, toSlug)` key in `metaEdgeWeights` is incremented; same-community and self-edges are skipped. The resulting list is the input to `computeCommunityMetaPageRank`, which builds an undirected `graphology` graph and runs `computePageRank`.
- **`importsByHub` powers the "imported by N of M communities" prose.** A second pass over the same edges builds `Map<hubPath, Set<fromSlug>>`, and each `topHub` ships its sorted `importingCommunities` list. The writer renders that as natural-language fan-in instead of a raw number.
- **`architecturalNotes` has a fallback.** First pass collects annotations whose `note` matches `ARCHITECTURAL_KEYWORDS`, deduped via `${file}:${line}:${note}` keys. If that produces zero, `collectAllAnnotations(db, projectDir, discovery)` walks every file node and pulls every annotation regardless of content. The fallback prevents an empty section on projects that haven't tagged their notes.
- **`readFileIfExists` silently truncates large files.** Files exceeding `maxBytes` (default `ROOT_DOC_MAX_BYTES = 64 * 1024`) are sliced to the cap with no marker; missing files, non-files, and read errors all return `null`. A truncated `README.md` shipped to the architecture bundle therefore looks identical to a complete one — the byte size in `toDocPreview` is the only signal.
- **`collectOriginCommits` returns up to 5 commits, oldest first.** It iterates every community bundle's `recentCommits`, dedupes by `sha`, sorts by `date` ascending (so the earliest commits win), and slices to 5. The intent is "first commits in the project's history" for the getting-started page, but the input is each bundle's `recentCommits` — if a bundle's recents window doesn't reach back far enough, the result misses the actual origin.
- **`scopeBundleToFiles` falls back to `null` for empty subsets.** When `files.length === 0` the sort returns `[][0] = undefined`, the `?? null` coerces to `null`, and the rest of the bundle is preserved with empty maps. The page payload renderer is responsible for surfacing the empty case rather than crashing.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/db/types.ts](src-db-types-ts.md)
- [src/wiki/community-synthesis.ts](community-synthesis.md)
- [src/wiki/types.ts](src-wiki-types-ts.md)
- [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
