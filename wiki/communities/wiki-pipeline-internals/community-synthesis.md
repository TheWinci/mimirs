# src/wiki/community-synthesis.ts

> [Architecture](../../architecture.md) › [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
>
> Generated from `79e963f` · 2026-04-26

## Role

`src/wiki/community-synthesis.ts` owns everything between "here is a list of community member files" and "here is the bundle the LLM reads to name and structure the community page." It builds community bundles deterministically from the DB and file graph, classifies members as big or small for split decisions, computes the required sections whose predicates have fired, and renders the synthesis prompt. It depends on `src/wiki/pagerank.ts` for intra-community ranking, `src/wiki/isolate-docs.ts` for nearby prose, `src/wiki/section-catalog.ts` for section metadata, and `src/wiki/types.ts` for all data shapes.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `SPLIT_TOTAL_LOC` | variable | `export const SPLIT_TOTAL_LOC = 5000` | Total LOC threshold across all community members that triggers a split into sub-pages. |
| `SPLIT_BIG_MEMBER_COUNT` | variable | `export const SPLIT_BIG_MEMBER_COUNT = 4` | Number of "big" members required to trigger a split, as an alternative to the LOC threshold. |
| `BIG_FILE_LOC` | variable | `export const BIG_FILE_LOC = 500` | Per-file LOC threshold: a file at or above this is classified as "big". |
| `BIG_FILE_EXPORTS` | variable | `export const BIG_FILE_EXPORTS = 8` | Per-file export count threshold: a file with this many or more exports is also classified as "big". |
| `BundleBuildResult` | interface | `export interface BundleBuildResult` | Return type of `buildCommunityBundles`: the array of assembled bundles plus the set of isolate docs no community claimed (passed to the architecture bundle). |
| `RequiredSection` | interface | `export interface RequiredSection` | A section whose predicate has fired for a given bundle: the full `SectionCatalogEntry` plus a human-readable `reason` string shown to the LLM so it understands why the section is mandatory. |
| `isSplitCommunity` | function | `export function isSplitCommunity(bundle: CommunityBundle): boolean` | Returns `true` when the community's total LOC >= `SPLIT_TOTAL_LOC` OR its big-member count >= `SPLIT_BIG_MEMBER_COUNT`. Used by `page-tree` and `content-prefetch` to decide whether to emit sub-pages. |
| `classifyMembers` | function | `export function classifyMembers(bundle)` | Splits member files into `big` and `small` arrays, returns `bigCount` and `totalLoc`. Shared so `page-tree` and `community-synthesis` agree on what "big" means. |
| `communityIdFor` | function | `export function communityIdFor(memberFiles: string[]): string` | Derives a stable 16-hex-char community id by SHA-256 hashing the sorted member file list. Identical member sets across runs produce identical ids; any file change produces a new id. |
| `requiredSectionsFor` | function | `export function requiredSectionsFor(bundle: CommunityBundle): RequiredSection[]` | Evaluates data-driven predicates against the bundle and returns the sections the LLM must include. Predicates cover per-file breakdown, lifecycle flow, dependency graph, internals, known issues, tuning knobs, and deep-community shape sections. |
| `buildCommunityBundles` | function | `export function buildCommunityBundles(db, discovery, classified, projectDir): BundleBuildResult` | The main entry point. Flattens the community tree, batches all DB queries into O(4) round-trips, computes per-community PageRank, attaches isolate docs, and assembles one `CommunityBundle` per community. |
| `renderSynthesisPrompt` | function | `export function renderSynthesisPrompt(bundle, catalogMarkdown, usedSlugs): string` | Renders the Markdown prompt sent to the LLM for step 4 (naming and section selection). Inlines the bundle data, the required sections with their reasons, the section catalog, and the list of already-used slugs. |
| `mergeRequiredSections` | function | `export function mergeRequiredSections(proposed, required)` | Merges LLM-proposed sections with required sections: required sections not already present by catalog id are injected at the right position, preserving LLM ordering for the rest. |
| `clipDocPreview` | function | `export function clipDocPreview(content, maxBytes)` | Byte-clips a doc body to a head preview while preserving UTF-8 boundaries. Returns `{ preview, truncated }`. Used by `isolate-docs.ts` when attaching nearby docs to bundles. |

## Internals

- **`buildCommunityBundles` batches all DB queries before the community loop.** For a project with K communities each having M members, the naive approach would make O(K × M × 4) DB round-trips (file rows, depends-on edges, depended-on edges, annotations). The batched approach issues 4 queries covering all member paths at once, then resolves per-community values from in-memory maps. On 1k-file projects this was the dominant wall-time cost before the optimization was introduced.

- **`DEPTH_PROFILE` centralizes all required-section thresholds.** The object has five keys: `perFile` (minFiles: 3, minExports: 5), `flow` (minFiles: 2), `internals` (minLoc: 400, minTunables: 8, minFiles: 10), `depGraph` (minEdges: 3), and `deep` (minTopMemberLoc: 800, minFiles: 10). Adding a new required-section predicate means adding one key here and one `push()` call in `requiredSectionsFor` — no grep-and-replace required.

- **Signature truncation is brace-depth-aware but has a flat byte cap.** `truncateSignature` strips the body by tracking brace depth but still emits at most `MAX_SIGNATURE_BYTES = 240` bytes. Single-line arrow functions and long generic constraints can exceed this limit; the `…` suffix indicates truncation. This prevents one runaway type signature from dominating the exports table.

- **Per-community PageRank uses an undirected subgraph.** `perCommunityPageRank` builds an undirected `graphology` graph containing only intra-community edges. Multi-edges between the same pair of files are collapsed into a single weighted edge. Nodes are added in member-file order; edges are sorted before insertion for determinism. The result ranks files by their intra-community connectivity, not their global importance.

- **Low-cohesion bundles are trimmed at two levels.** When `cohesion < LOW_COHESION_THRESHOLD = 0.15`, exports are capped at `MAX_EXPORTS_LOW_COHESION = 15` (instead of `MAX_EXPORTS_IN_BUNDLE = 60`) and nearby doc count drops to `MAX_DOCS_LOW_COHESION = 3` (instead of `MAX_DOCS_HIGH_COHESION = 8`). The rationale: a grab-bag community's exports are noise, not signal, and shipping all of them inflates the prompt without helping the LLM name the community.

- **`EXTERNAL_DEP_SAMPLE = 5` is intentionally small.** An earlier setting of 30 caused writers to cite every shown edge, increasing per-page agentic verification work by 63% in real wiki generation runs. The current cap keeps the bundle tight; writers call `depends_on` / `depended_on_by` when the full list matters.

- **`consumersByFile` and `dependenciesByFile` are pre-computed per-member maps.** These let sub-page scoping in `content-prefetch.ts` recompute an "external to this sub-page" view without re-querying the DB. They are capped at `MAX_PER_FILE_EDGES = 30` per file to prevent hub files from inflating the bundles artifact past the 8-edge slice the renderer actually displays.

- **`clipDocPreview` preserves UTF-8 boundaries by slicing `Buffer`, not the string.** Slicing a string at a byte offset can split a multi-byte character in half, producing invalid UTF-8. The implementation converts to a Buffer, slices at the byte boundary, then decodes back to a string. This is the only way to guarantee a valid UTF-8 head without knowing the character distribution in advance.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/db/types.ts](src-db-types-ts.md)
- [src/wiki/content-prefetch.ts](content-prefetch.md)
- [src/wiki/types.ts](src-wiki-types-ts.md)
- [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
