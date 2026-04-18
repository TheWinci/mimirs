import type {
  PageManifest,
  ManifestPage,
  ClassifiedInventory,
} from "./types";

export interface PageDelta {
  wikiPath: string;
  order: number;
  page: ManifestPage;
  /** Files that caused this page to be marked stale. Empty for "new" pages. */
  triggers: string[];
}

export interface StalenessReport {
  stale: PageDelta[];
  added: PageDelta[];
  removed: { wikiPath: string; page: ManifestPage }[];
}

/**
 * Compare a freshly computed manifest against a previous manifest and a set of
 * changed files, and decide which pages need regeneration.
 *
 * Staleness rules:
 * - New page: present in new manifest, absent in old → regenerate.
 * - Removed page: present in old, absent in new → delete.
 * - Module-file page: stale if sourceFiles[0] is in changedFiles.
 * - Module page: stale if any file in its module (from newClassified.modules)
 *   is in changedFiles, or if its depth differs from old.
 * - Aggregate page: stale if the set of module-page paths changed between old
 *   and new, OR any changed file is a hub (classified.files.isHub) or entry
 *   point (nodes with isEntryPoint=true in the new manifest's context).
 */
export function classifyStaleness(
  oldManifest: PageManifest,
  newManifest: PageManifest,
  newClassified: ClassifiedInventory,
  newEntryPoints: Set<string>,
  changedFiles: Set<string>,
): StalenessReport {
  const stale: PageDelta[] = [];
  const added: PageDelta[] = [];
  const removed: { wikiPath: string; page: ManifestPage }[] = [];

  // Removed pages
  for (const [wikiPath, page] of Object.entries(oldManifest.pages)) {
    if (!newManifest.pages[wikiPath]) {
      removed.push({ wikiPath, page });
    }
  }

  // Module-name → file list (for widening module-page source checks)
  const filesByModuleName = new Map<string, string[]>();
  for (const mod of newClassified.modules) {
    filesByModuleName.set(mod.name, mod.files);
  }

  // Hub paths for aggregate-staleness decisions
  const hubPaths = new Set(
    newClassified.files.filter((f) => f.isHub).map((f) => f.path),
  );

  // Old vs new module-page set (aggregates restale if it shifts)
  const oldModulePageSet = new Set(
    Object.entries(oldManifest.pages)
      .filter(([, p]) => p.kind === "module")
      .map(([wp]) => wp),
  );
  const newModulePageSet = new Set(
    Object.entries(newManifest.pages)
      .filter(([, p]) => p.kind === "module")
      .map(([wp]) => wp),
  );
  const modulePageSetChanged = !setsEqual(oldModulePageSet, newModulePageSet);

  const aggregateHubOrEntryChanged = [...changedFiles].some(
    (f) => hubPaths.has(f) || newEntryPoints.has(f),
  );

  for (const [wikiPath, page] of Object.entries(newManifest.pages)) {
    const old = oldManifest.pages[wikiPath];
    if (!old) {
      added.push({ wikiPath, order: page.order, page, triggers: [] });
      continue;
    }

    const triggers: string[] = [];

    if (page.kind === "file" && page.focus === "module-file") {
      const f = page.sourceFiles[0];
      if (f && changedFiles.has(f)) triggers.push(f);
    } else if (page.kind === "module") {
      const moduleFiles = filesByModuleName.get(page.title) ?? page.sourceFiles;
      for (const f of moduleFiles) {
        if (changedFiles.has(f)) triggers.push(f);
      }
      if (page.depth !== old.depth) {
        triggers.push(`depth changed: ${old.depth} → ${page.depth}`);
      }
    } else if (page.tier === "aggregate") {
      if (modulePageSetChanged) {
        triggers.push("module page set changed");
      }
      if (aggregateHubOrEntryChanged) {
        for (const f of changedFiles) {
          if (hubPaths.has(f) || newEntryPoints.has(f)) triggers.push(f);
        }
      }
    }

    if (triggers.length > 0) {
      stale.push({ wikiPath, order: page.order, page, triggers });
    }
  }

  return { stale, added, removed };
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
