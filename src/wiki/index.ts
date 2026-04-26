import type { RagDB } from "../db";
import type { RagConfig } from "../config";
import { runDiscovery } from "./discovery";
import { runCategorization } from "./categorization";
import { buildPageTree } from "./page-tree";
import { prefetchContent } from "./content-prefetch";
import { buildPagePayload } from "./page-payload";
import { buildCommunityBundles } from "./community-synthesis";
import type { ClusterMode } from "./community-detection";
import type {
  WikiPlanResult,
  PagePayload,
  PageManifest,
  ContentCache,
  CommunityBundle,
  SynthesesFile,
} from "./types";

export { runDiscovery } from "./discovery";
export { runCategorization } from "./categorization";
export { buildPageTree } from "./page-tree";
export { prefetchContent } from "./content-prefetch";
export { buildPagePayload } from "./page-payload";
export {
  buildCommunityBundles,
  renderSynthesisPrompt,
  validateSynthesisPayload,
  communityIdFor,
  requiredSectionsFor,
  mergeRequiredSections,
  clipDocPreview,
} from "./community-synthesis";
export type { RequiredSection } from "./community-synthesis";
export type { ClusterMode } from "./community-detection";
export type { WikiPlanResult, PagePayload } from "./types";

/**
 * Run phases 1-2 (discovery + categorization) and build community bundles.
 *
 * This is the first half of planning — everything the synthesis LLM needs
 * to decide community names, slugs, and section shapes. Call
 * `runWikiFinalPlanning` after syntheses are stored to produce the manifest
 * and content cache.
 */
export function runWikiBundling(
  db: RagDB,
  projectDir: string,
  cluster: ClusterMode = "files",
) {
  const status = db.getStatus();
  console.error(`[wiki] bundling ${status.totalFiles} files, ${status.totalChunks} chunks (cluster=${cluster})`);

  const t0 = Date.now();
  const discovery = runDiscovery(db, projectDir, cluster);
  console.error(`[wiki] discovery ${Date.now() - t0}ms — ${discovery.modules.length} communities`);

  const t1 = Date.now();
  const classified = runCategorization(db, discovery, projectDir);
  console.error(`[wiki] categorization ${Date.now() - t1}ms — ${classified.symbols.length} symbols`);

  const t2 = Date.now();
  const { bundles, unmatchedDocs } = buildCommunityBundles(db, discovery, classified, projectDir);
  console.error(`[wiki] bundles ${Date.now() - t2}ms — ${bundles.length} communities — total ${Date.now() - t0}ms`);

  return { discovery, classified, bundles, unmatchedDocs };
}

/**
 * Build the manifest + prefetch content. Run after all syntheses are
 * captured in the SynthesesFile.
 */
export async function runWikiFinalPlanning(
  db: RagDB,
  projectDir: string,
  gitRef: string,
  discovery: ReturnType<typeof runDiscovery>,
  classified: ReturnType<typeof runCategorization>,
  bundles: CommunityBundle[],
  syntheses: SynthesesFile,
  unmatchedDocs: { path: string; content: string }[],
  config: RagConfig,
  cluster: ClusterMode = "files",
): Promise<WikiPlanResult> {
  const t0 = Date.now();
  const manifest = buildPageTree(discovery, classified, syntheses, gitRef, cluster, bundles);
  console.error(`[wiki] page-tree ${Date.now() - t0}ms — ${manifest.pageCount} pages`);

  const bundlesById = new Map(bundles.map((b) => [b.communityId, b]));
  const t1 = Date.now();
  const content = await prefetchContent(
    db,
    manifest,
    discovery,
    classified,
    syntheses,
    bundlesById,
    projectDir,
    config,
    unmatchedDocs,
  );
  console.error(`[wiki] prefetch ${Date.now() - t1}ms`);

  const warnings = [
    ...discovery.warnings,
    ...classified.warnings,
    ...manifest.warnings,
  ];

  return { discovery, classified, manifest, content, syntheses, warnings };
}

/** Build a focused payload for a single page. */
export function getPagePayload(
  pageIndex: number,
  manifest: PageManifest,
  content: ContentCache,
): PagePayload {
  return buildPagePayload(pageIndex, manifest, content);
}
