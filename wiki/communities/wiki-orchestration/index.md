# src/wiki/index.ts

> [Architecture](../../architecture.md) › [Wiki orchestration](../wiki-orchestration.md)
>
> Generated from `b47d98e` · 2026-04-26

## Role

`src/wiki/index.ts` is the package façade for the wiki pipeline — the single entry point every external caller (the `src/tools/wiki-tools.ts` MCP layer, `scripts/regen-meta.ts`) imports from. It holds two execution drivers (`runWikiBundling` for phases 1–3, `runWikiFinalPlanning` for phases 4–5), one payload helper (`getPagePayload`), and a curated list of re-exports that pull synthesis helpers, the catalog, and shared types up from the per-phase implementation files. It depends on `runDiscovery` (`src/wiki/discovery.ts`), `runCategorization` (`src/wiki/categorization.ts`), `buildPageTree` (`src/wiki/page-tree.ts`), `prefetchContent` (`src/wiki/content-prefetch.ts`), `buildPagePayload` (`src/wiki/page-payload.ts`), and `buildCommunityBundles` (`src/wiki/community-synthesis.ts`).

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `runWikiBundling` | function | `runWikiBundling(db: RagDB, projectDir: string, cluster: ClusterMode = "files")` | Runs phases 1–3 of the pipeline. Calls `db.getStatus()` for the file/chunk counts, then `runDiscovery`, `runCategorization`, and `buildCommunityBundles` in sequence, logging each phase duration to stderr. Returns `{ discovery, classified, bundles, unmatchedDocs }` — everything the synthesis LLM needs to name communities and pick sections. |
| `runWikiFinalPlanning` | function | `async runWikiFinalPlanning(db, projectDir, gitRef, discovery, classified, bundles, syntheses, unmatchedDocs, config, cluster?): Promise<WikiPlanResult>` | Runs phases 4–5 after every synthesis is captured. Builds the `PageManifest` via `buildPageTree`, materializes `bundlesById` from the bundles array, calls `prefetchContent` to populate the `ContentCache`, then returns `WikiPlanResult` carrying the manifest, content, syntheses, and the merged warnings from discovery/categorization/manifest stages. |
| `getPagePayload` | function | `getPagePayload(pageIndex: number, manifest: PageManifest, content: ContentCache): PagePayload` | One-line delegator to `buildPagePayload(pageIndex, manifest, content)`. Builds the focused per-page payload (title, purpose, sections, bundle, link map) consumed by `generate_wiki(page: N)`. |
| `runDiscovery` | re-export | from `./discovery` | Phase 1: graph build, Louvain clustering, module discovery. |
| `runCategorization` | re-export | from `./categorization` | Phase 2: classifies symbols and files (top-hub, entry-point, isolate-doc) for downstream consumers. |
| `buildPageTree` | re-export | from `./page-tree` | Phase 4: turns syntheses + bundles into a `PageManifest`. |
| `prefetchContent` | re-export | from `./content-prefetch` | Phase 5: builds the `ContentCache`, including architecture/getting-started bundles and pre-run semantic queries. |
| `buildPagePayload` | re-export | from `./page-payload` | Per-page payload builder used by `getPagePayload`. |
| `buildCommunityBundles` | re-export | from `./community-synthesis` | Phase 3: produces per-community bundles (members, exports, tunables, edges, recents). |
| `renderSynthesisPrompt` | re-export | from `./community-synthesis` | Renders the synthesis-LLM prompt for a single community bundle. |
| `validateSynthesisPayload` | re-export | from `./community-synthesis` | Validates a synthesis-LLM response against the expected shape before storing. |
| `communityIdFor` | re-export | from `./community-synthesis` | Stable id derivation for a community based on its members. |
| `requiredSectionsFor` | re-export | from `./community-synthesis` | Returns the catalog-id list a synthesis must cover for a given community. |
| `mergeRequiredSections` | re-export | from `./community-synthesis` | Merges required-section ids when a community spans multiple required sets. |
| `clipDocPreview` | re-export | from `./community-synthesis` | Truncates an inline doc preview to a budgeted length for prompt inclusion. |
| `RequiredSection` | type re-export | from `./community-synthesis` | Required-section shape used by the synthesis flow. |
| `ClusterMode` | type re-export | from `./community-detection` | Union of `"files"` and `"symbols"` — selects the Louvain clustering granularity. |
| `WikiPlanResult` | type re-export | from `./types` | Shape returned by `runWikiFinalPlanning`. |
| `PagePayload` | type re-export | from `./types` | Shape returned by `getPagePayload`. |

This file declares no module-level constants — every `tunable` reported by the bundle is a re-exported name that originates in `src/wiki/community-synthesis.ts`, `src/wiki/community-detection.ts`, or `src/wiki/page-payload.ts`. The literal default that lives in the file itself is the `cluster: ClusterMode = "files"` parameter on both `runWikiBundling` and `runWikiFinalPlanning`.

## Internals

- **Progress logging is `console.error`, not the project logger.** Every progress line in `src/wiki/index.ts:44-66` and `src/wiki/index.ts:71-110` calls `console.error` directly with a `[wiki]` tag. The intent is to surface progress in `bun run` output without depending on `LOG_LEVEL` — the bundling phase emits four lines (`bundling`, `discovery <ms>ms`, `categorization <ms>ms`, `bundles <ms>ms — total <ms>ms`) and the final-planning phase emits two (`page-tree <ms>ms`, `prefetch <ms>ms`). Anything that wants to suppress wiki progress has to redirect stderr.
- **`runWikiBundling` returns a four-field tuple, not a `WikiPlanResult`.** The drivers split the pipeline at the synthesis boundary — bundling yields `{ discovery, classified, bundles, unmatchedDocs }`, the synthesis LLM produces a `SynthesesFile`, and `runWikiFinalPlanning` is called with both. The split is intentional because synthesis happens out-of-process (the LLM call is the caller's problem), and the orchestrator must not assume it succeeds.
- **`bundlesById` is materialized inside `runWikiFinalPlanning`.** Inside `src/wiki/index.ts:71-110` the line `new Map(bundles.map((b) => [b.communityId, b]))` rebuilds the index every call. The map could in principle be returned by `runWikiBundling`, but keeping it private to the final-planning step lets `runWikiBundling` ship a plain array (easier to serialize for tests and the synthesis LLM) without callers having to maintain index consistency.
- **`unmatchedDocs` flows through both phases.** `runWikiBundling` returns it, the caller passes it back into `runWikiFinalPlanning`, and `prefetchContent` receives it as `supplementaryDocs`. The intermediate hop is what lets the synthesis LLM see the unmatched doc list while building syntheses, then feed it back to the architecture/getting-started bundles after synthesis is final.
- **Warnings are merged once at the end.** `runWikiFinalPlanning` collects `discovery.warnings`, `classified.warnings`, and `manifest.warnings` into a single array on the returned `WikiPlanResult`. Earlier stages keep their warnings local; only the final result carries the merged list, and prefetch warnings (if any were ever surfaced) are not included in the merge.
- **`getPagePayload` is a thin proxy.** Every line of behavior lives in `buildPagePayload` (`src/wiki/page-payload.ts`); the wrapper exists to keep the public package surface consistent — callers import everything from `src/wiki`, and a future change to the payload builder doesn't ripple out to call sites.
- **Re-exports are the contract.** The seven synthesis helpers (`buildCommunityBundles`, `renderSynthesisPrompt`, `validateSynthesisPayload`, `communityIdFor`, `requiredSectionsFor`, `mergeRequiredSections`, `clipDocPreview`) and the per-phase entry points are listed explicitly so a contributor reading `src/wiki/index.ts` sees the full public surface without opening the implementation files. Importing any of these from their source path bypasses the contract and breaks when the implementation moves.
- **Synthesis is not represented here.** There is no `runSynthesis` driver in the file — the synthesis step is owned by the caller (the MCP tool layer renders the prompt via `renderSynthesisPrompt`, sends it to an LLM, validates the response with `validateSynthesisPayload`, and writes it to the syntheses meta artifact under `wiki/_meta/`). The orchestrator deliberately stops at "build the bundles" and resumes at "you have a `SynthesesFile` — finish planning".

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/tools/wiki-tools.ts](wiki-tools.md)
- [src/wiki/lint-page.ts](lint-page.md)
- [src/wiki/update-log.ts](update-log.md)
- [Wiki orchestration](../wiki-orchestration.md)
