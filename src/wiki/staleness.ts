import type {
  PageManifest,
  ManifestPage,
  CommunityBundle,
  SynthesesFile,
} from "./types";

export interface PageDelta {
  wikiPath: string;
  order: number;
  page: ManifestPage;
  /** Files or events that triggered staleness. Empty for new pages. */
  triggers: string[];
}

export interface StalenessReport {
  stale: PageDelta[];
  added: PageDelta[];
  removed: { wikiPath: string; page: ManifestPage }[];
  /** Community ids that no longer match a stored synthesis. */
  missingSyntheses: string[];
}

/**
 * Decide which pages need regeneration given the old manifest, new
 * community bundles, stored syntheses, and set of changed files.
 *
 * Rules:
 * - Community page: stale if any member file is in changedFiles.
 * - Architecture / getting-started: stale if ANY community's member set
 *   changed (communities appeared, disappeared, or shifted), or if any
 *   top-hub / entry-point file changed.
 * - missingSyntheses: community ids present in new bundles but missing from
 *   the stored syntheses file — the orchestrator must prompt for them
 *   before building the new manifest.
 */
export function classifyStaleness(
  oldManifest: PageManifest,
  newManifest: PageManifest,
  newBundles: CommunityBundle[],
  storedSyntheses: SynthesesFile,
  topHubPaths: Set<string>,
  entryPoints: Set<string>,
  changedFiles: Set<string>,
): StalenessReport {
  const stale: PageDelta[] = [];
  const added: PageDelta[] = [];
  const removed: { wikiPath: string; page: ManifestPage }[] = [];

  for (const [wikiPath, page] of Object.entries(oldManifest.pages)) {
    if (!newManifest.pages[wikiPath]) {
      removed.push({ wikiPath, page });
    }
  }

  const oldCommunityIds = new Set(
    Object.values(oldManifest.pages)
      .filter((p) => p.communityId)
      .map((p) => p.communityId!),
  );
  const newCommunityIds = new Set(newBundles.map((b) => b.communityId));
  const communitySetShifted =
    oldCommunityIds.size !== newCommunityIds.size ||
    [...newCommunityIds].some((id) => !oldCommunityIds.has(id));

  const aggregateTouchedByHub = [...changedFiles].some(
    (f) => topHubPaths.has(f) || entryPoints.has(f),
  );

  for (const [wikiPath, page] of Object.entries(newManifest.pages)) {
    const old = oldManifest.pages[wikiPath];
    if (!old) {
      added.push({ wikiPath, order: page.order, page, triggers: [] });
      continue;
    }

    const triggers: string[] = [];

    if (
      page.kind === "architecture" ||
      page.kind === "getting-started" ||
      page.kind === "data-flows"
    ) {
      if (communitySetShifted) triggers.push("community set changed");
      if (aggregateTouchedByHub) {
        for (const f of changedFiles) {
          if (topHubPaths.has(f) || entryPoints.has(f)) triggers.push(f);
        }
      }
    } else {
      for (const f of page.memberFiles) {
        if (changedFiles.has(f)) triggers.push(f);
      }
    }

    if (triggers.length > 0) {
      stale.push({ wikiPath, order: page.order, page, triggers });
    }
  }

  const missingSyntheses = newBundles
    .filter((b) => !storedSyntheses.payloads[b.communityId])
    .map((b) => b.communityId);

  return { stale, added, removed, missingSyntheses };
}
