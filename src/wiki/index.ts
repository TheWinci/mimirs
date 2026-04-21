import type { RagDB } from "../db";
import { runDiscovery } from "./discovery";
import { runCategorization } from "./categorization";
import { buildPageTree } from "./page-tree";
import { prefetchContent } from "./content-prefetch";
import { buildPagePayload } from "./page-payload";
import type { ClusterMode } from "./community-detection";
import type { WikiPlanResult, PagePayload, PageManifest, ContentCache, ClassifiedInventory } from "./types";

export { runDiscovery } from "./discovery";
export { runCategorization } from "./categorization";
export { buildPageTree } from "./page-tree";
export { prefetchContent } from "./content-prefetch";
export { buildPagePayload } from "./page-payload";
export type { ClusterMode } from "./community-detection";
export type { WikiPlanResult, PagePayload } from "./types";

/**
 * Run phases 1-3 + content pre-fetch. Returns all artifacts ready to be
 * written to disk and served to agents page-by-page.
 *
 * Emits phase timings on stderr so hangs in long-running planning runs are
 * diagnosable from the MCP server log (MCP reserves stdout for the protocol).
 */
export function runWikiPlanning(
  db: RagDB,
  projectDir: string,
  gitRef: string,
  cluster: ClusterMode = "files",
): WikiPlanResult {
  const status = db.getStatus();
  console.error(`[wiki] planning ${status.totalFiles} files, ${status.totalChunks} chunks (cluster=${cluster})`);

  const t0 = Date.now();
  const discovery = runDiscovery(db, projectDir, cluster);
  console.error(`[wiki] discovery ${Date.now() - t0}ms — ${discovery.modules.length} modules`);

  const t1 = Date.now();
  const classified = runCategorization(db, discovery, projectDir);
  console.error(`[wiki] categorization ${Date.now() - t1}ms — ${classified.symbols.length} symbols, ${classified.modules.length} classified modules`);

  const t2 = Date.now();
  const manifest = buildPageTree(discovery, classified, gitRef);
  console.error(`[wiki] page-tree ${Date.now() - t2}ms — ${manifest.pageCount} pages`);

  const t3 = Date.now();
  const content = prefetchContent(db, manifest, discovery, classified, projectDir);
  console.error(`[wiki] prefetch ${Date.now() - t3}ms — total ${Date.now() - t0}ms`);

  manifest.cluster = cluster;

  const warnings = [
    ...discovery.warnings,
    ...classified.warnings,
    ...manifest.warnings,
  ];

  return { discovery, classified, manifest, content, warnings };
}

/**
 * Build a focused payload for a single page. Reads from pre-computed artifacts.
 */
export function getPagePayload(
  pageIndex: number,
  manifest: PageManifest,
  content: ContentCache,
  classified: ClassifiedInventory,
): PagePayload {
  return buildPagePayload(pageIndex, manifest, content, classified);
}
