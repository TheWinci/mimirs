import type { RagDB } from "../db";
import { runDiscovery } from "./discovery";
import { runCategorization } from "./categorization";
import { buildPageTree } from "./page-tree";
import { prefetchContent } from "./content-prefetch";
import { buildPagePayload } from "./page-payload";
import type { WikiPlanResult, PagePayload, PageManifest, ContentCache, ClassifiedInventory } from "./types";

export { runDiscovery } from "./discovery";
export { runCategorization } from "./categorization";
export { buildPageTree } from "./page-tree";
export { prefetchContent } from "./content-prefetch";
export { buildPagePayload } from "./page-payload";
export type { WikiPlanResult, PagePayload } from "./types";

/**
 * Run phases 1-3 + content pre-fetch. Returns all artifacts ready to be
 * written to disk and served to agents page-by-page.
 */
export function runWikiPlanning(
  db: RagDB,
  projectDir: string,
  gitRef: string,
): WikiPlanResult {
  const discovery = runDiscovery(db, projectDir);
  const classified = runCategorization(db, discovery, projectDir);
  const manifest = buildPageTree(discovery, classified, gitRef);
  const content = prefetchContent(db, manifest, discovery, classified, projectDir);

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
