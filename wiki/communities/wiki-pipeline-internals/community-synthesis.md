# src/wiki/community-synthesis.ts

> [Architecture](../../architecture.md) › [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
>
> Generated from `b47d98e` · 2026-04-26

## Role

`src/wiki/community-synthesis.ts` is Phase 3 of the wiki pipeline: it turns a `DiscoveryResult` plus a `ClassifiedInventory` into a deterministic `CommunityBundle[]`, one bundle per community. The file owns every threshold and cap that shapes a synthesis prompt — exports, tunables, member previews, nearby docs, recent commits — and the helpers that decide whether a community warrants sub-pages. It leans on `src/wiki/pagerank.ts` for per-community ranking, `src/wiki/isolate-docs.ts` for nearby-doc attachment, `src/wiki/section-catalog.ts` for required-section lookup, and `src/db/index.ts` for the batched DB queries that feed every bundle in one pass.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `BundleBuildResult` | interface | `export interface BundleBuildResult` | Return shape from `buildCommunityBundles` — `{ bundles: CommunityBundle[]; unmatchedDocs: NearbyDoc[] }`. Unmatched docs flow up to the architecture bundle. |
| `RequiredSection` | interface | `export interface RequiredSection` | Pair of a `SectionCatalogEntry` and a human-readable `reason` string explaining which signal triggered the requirement. |
| `buildCommunityBundles` | function | `export function buildCommunityBundles(db: RagDB, discovery: DiscoveryResult, classified: ClassifiedInventory, projectDir: string): BundleBuildResult` | Phase-3 entry point. Builds one bundle per community. Pre-batches DB lookups (file rows, deps, consumers, annotations, history) so per-bundle work is O(member count) against in-memory maps instead of O(member × DB query). |
| `classifyMembers` | function | `export function classifyMembers(bundle: CommunityBundle): { big: string[]; small: string[]; bigCount: number; totalLoc: number }` | Splits members into "big" and "small" by per-file LOC and export count. Big = `loc >= BIG_FILE_LOC = 500` OR per-file `exports >= BIG_FILE_EXPORTS = 8`. |
| `clipDocPreview` | function | `export function clipDocPreview(content: string, maxBytes: number): { preview: string; truncated: boolean }` | Byte-clips a doc body to a head preview with UTF-8-safe truncation. Returns the original content unchanged when it already fits. |
| `communityIdFor` | function | `export function communityIdFor(memberFiles: string[]): string` | SHA-256 prefix (16 hex chars) of the sorted member-file list. Identical member sets produce identical ids; any add/remove changes the id, which is the regeneration trigger. |
| `isSplitCommunity` | function | `export function isSplitCommunity(bundle: CommunityBundle): boolean` | True when `totalLoc >= SPLIT_TOTAL_LOC = 5000` OR `bigCount >= SPLIT_BIG_MEMBER_COUNT = 4`. Drives whether the community gets sub-pages. |
| `BIG_FILE_EXPORTS` | variable | `export const BIG_FILE_EXPORTS = 8;` | Per-file export-count threshold for the "big" classification. |
| `BIG_FILE_LOC` | variable | `export const BIG_FILE_LOC = 500;` | Per-file LOC threshold for the "big" classification. |
| `SPLIT_BIG_MEMBER_COUNT` | variable | `export const SPLIT_BIG_MEMBER_COUNT = 4;` | Number of "big" members above which the community always splits. |
| `SPLIT_TOTAL_LOC` | variable | `export const SPLIT_TOTAL_LOC = 5000;` | Total-LOC threshold above which the community always splits, even if no individual member is "big". |

The file also defines several non-exported tunables that shape every bundle: `MAX_EXPORTS_IN_BUNDLE = 60` (cohesive cap), `MAX_EXPORTS_LOW_COHESION = 15` (grab-bag cap), `LOW_COHESION_THRESHOLD = 0.15`, `MAX_TUNABLES = 40`, `MAX_COMMITS = 10`, `TUNABLE_TYPES = new Set(["constant", "variable"])`, `MAX_PREVIEW_LINES = 60`, `MAX_PREVIEW_BYTES_PER_FILE = 2 * 1024`, `MAX_TOTAL_PREVIEW_BYTES = 24 * 1024`, `MAX_NEARBY_DOC_BYTES = 2 * 1024`, `MAX_TOTAL_NEARBY_DOC_BYTES = 12 * 1024`, `EXTERNAL_DEP_SAMPLE = 5`, `MAX_PER_FILE_EDGES = 30`, and `MAX_SIGNATURE_BYTES = 240`. Two more module-private exports are reachable through orchestrator code: `requiredSectionsFor(bundle): RequiredSection[]` (which catalog entries fire for this bundle) and `renderSynthesisPrompt(bundle, catalogMarkdown, usedSlugs)` (the synthesis prompt builder).

## Internals

- **DB lookups are batched once per `buildCommunityBundles` call.** The earlier per-bundle implementation issued `O(communities × members × 4)` round-trips against `getFileByPath`, `getDependsOn`, `getDependedOnBy`, and `getAnnotations`; on a 1k-file project that was the dominant wall-time cost. The current pass calls `getFilesByPaths`, `getDependsOnForFiles`, `getDependedOnByForFiles`, `getAnnotationsForPaths`, and `getFileHistoryForPaths` once over the entire wiki member set, then `buildOneBundle` consults pre-built `Map`s by file id (`depsByFromId`, `consumersByToId`, `annotationsByPath`, `historyByPath`).

- **Cohesion drives two different caps.** When `community.cohesion < LOW_COHESION_THRESHOLD = 0.15` the bundle uses `MAX_EXPORTS_LOW_COHESION = 15` instead of `MAX_EXPORTS_IN_BUNDLE = 60`, and `MAX_DOCS_LOW_COHESION` (in `isolate-docs.ts`) instead of `MAX_DOCS_HIGH_COHESION`. Grab-bag clusters get tighter caps because their content is noisy by definition.

- **`exportCount` is the pre-cap count.** Both `tunableCount` and `exportCount` are stored before the `slice(0, cap)` call, so the writer LLM can say "shown N of M" rather than guessing the community's interface size from a truncated slice.

- **`TUNABLE_TYPES = new Set(["constant", "variable"])` filters which exports become tunables.** Functions, classes, types, interfaces, and enums never reach the tunables array. The matching set in `src/wiki/categorization.ts` (`SYMBOL_TYPES`) had to be updated to include `"constant"` defensively after a regression where every community shipped `tunables: []` — the bun-chunk parsers for some languages emit `constant` separately.

- **`truncateSignature` is brace-depth + byte-cap, in that order.** The function walks brace depth across multi-line snippets to strip a function body when present (stopping at the first `{` on a line where depth was zero); the result is then hard-capped at `MAX_SIGNATURE_BYTES = 240` with an ellipsis. Single-line arrow-fn signatures and type aliases never trip the brace pass but can still exceed 240 bytes via long generic constraints — the byte cap covers them.

- **`memberPreviews` excludes the top-ranked file.** `buildMemberPreviews` filters `f !== topRankedFile` because the writer is instructed to `Read` the top-ranked file directly. Previews for everyone else are sorted by per-file PageRank descending; lowest-rank files drop first when the running `totalBytes` would exceed `MAX_TOTAL_PREVIEW_BYTES = 24 * 1024`.

- **UTF-8-safe byte truncation throughout.** `clipDocPreview` and the per-file preview path both use `Buffer.from(text, "utf-8").subarray(0, n).toString("utf-8")` rather than `string.slice(...)`, which would split multi-byte sequences. Callers that hand it ASCII pay no extra cost; callers passing CJK or emoji content get a clean preview rather than a mojibake tail.

- **`recentCommits` deduplicates by hash, not by file.** `commitsByHash` keeps a single entry per SHA and accumulates `files` as multiple member files touch the same commit. The output is sorted by `date.localeCompare(a, b)` descending and capped at `MAX_COMMITS = 10`. A single commit that touches 7 member files appears once with all 7 file paths attached.

- **`externalConsumers` and `externalDependencies` are deduped + sorted.** The accumulators are `Set<string>`s — internal community edges (where `memberSet.has(otherPath)`) are filtered out, and the final arrays are sorted alphabetically. Per-member maps `consumersByFile` / `dependenciesByFile` are independently capped at `MAX_PER_FILE_EDGES = 30` after sorting.

- **`perCommunityPageRank` runs PageRank on an undirected community subgraph.** The subgraph is built from `fileGraph.edges`, filtered to edges where both endpoints are in the community, with parallel edges merged by incrementing a `weight` attribute. Empty subgraphs return an empty `Map` rather than throwing.

- **`communityIdFor` is sort-then-hash.** The function sorts the member list before SHA-256-ing, so member ordering doesn't change the id. The 16-char hex prefix is chosen to be short enough for paths and log lines but long enough to avoid collisions across realistic community counts.

- **`requiredSectionsFor` predicates are conjunctive for `per-file-breakdown` only.** `per-file-breakdown` fires when `files >= 3` AND `exports >= 5`. Every other catalog entry fires on a single threshold (LOC OR tunables OR files; annotation count; etc). `lifecycle-flow` fires at `files >= 2`, `dependency-graph` at `>= 3` external edges total, and the `deep` profile (which adds `design-rationale`, `trade-offs`, `common-gotchas`) at `topMemberLoc >= 800` OR `files >= 10`.

- **Split-community LOC trigger replaces a count-only one.** The earlier code split every 10-file community even when each file was 50 LOC — the per-file pages were thin and the parent was empty. Adding the `SPLIT_TOTAL_LOC = 5000` and "big member" thresholds restricts splits to communities that genuinely don't fit one page.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/db/types.ts](src-db-types-ts.md)
- [src/wiki/content-prefetch.ts](content-prefetch.md)
- [src/wiki/types.ts](src-wiki-types-ts.md)
- [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
