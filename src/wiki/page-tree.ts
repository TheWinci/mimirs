import type {
  DiscoveryResult,
  ClassifiedInventory,
  ClassifiedModule,
  PageManifest,
  ManifestPage,
  PageDepth,
  PageFocus,
  FileLevelNode,
} from "./types";

/** Max sub-pages per module when it qualifies for splitting. */
const MAX_SUB_PAGES = 5;
/** Modules at full depth with fileCount >= this OR exportCount >= EXPORT_THRESHOLD get sub-pages. */
const FILE_THRESHOLD = 10;
const EXPORT_THRESHOLD = 20;
/** A file qualifies for a sub-page when exports >= this OR fanIn >= FAN_IN_THRESHOLD. */
const FILE_EXPORT_THRESHOLD = 5;
const FAN_IN_THRESHOLD = 3;

/**
 * Phase 3: Decide what pages to generate, at what depth, in what order.
 * Pure computation — no DB calls needed.
 *
 * Two tiers:
 *   module      — one page per qualifying directory + sub-pages for key files
 *   cross-cutting — architecture, data-flows, guides, index
 */
export function buildPageTree(
  discovery: DiscoveryResult,
  classified: ClassifiedInventory,
  gitRef: string,
): PageManifest {
  const warnings: string[] = [];
  const pages: Record<string, ManifestPage> = {};
  let order = 0;

  // ── Module pages ──

  const modulePages = buildModulePages(classified, discovery, warnings);
  for (const [path, page] of modulePages) {
    pages[path] = { ...page, order: order++ };
  }

  // ── Module-file sub-pages ──

  const moduleFilePages = buildModuleFilePages(classified, discovery, pages);
  for (const [path, page] of moduleFilePages) {
    pages[path] = { ...page, order: order++ };
  }

  // ── Cross-cutting pages ──

  const crossCuttingPages = buildCrossCuttingPages(discovery);
  for (const [path, page] of crossCuttingPages) {
    pages[path] = { ...page, order: order++ };
  }

  // Compute relatedPages for all pages
  computeRelatedPages(pages, classified, discovery);

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    lastGitRef: gitRef,
    pageCount: Object.keys(pages).length,
    pages,
    warnings,
  };
}

// ── Module pages ──

function buildModulePages(
  classified: ClassifiedInventory,
  discovery: DiscoveryResult,
  warnings: string[],
): [string, Omit<ManifestPage, "order">][] {
  const qualifying = classified.modules.filter((m) => m.qualifiesAsModulePage);
  const pages: [string, Omit<ManifestPage, "order">][] = [];

  if (qualifying.length === 0) {
    if (classified.modules.length > 0) {
      warnings.push("No modules qualified for pages");
    }
    return pages;
  }

  // Compute importance and complexity
  const withMetrics = qualifying.map((m) => ({
    mod: m,
    importance: m.fanIn * 2 + m.fanOut * 0.5,
    complexity: m.fileCount + m.exportCount * 0.5,
  }));

  // Small project rule: < 5 modules → skip percentiles, all get brief minimum
  const usePercentiles = qualifying.length >= 5;

  let depthMap: Map<string, PageDepth>;
  if (usePercentiles) {
    const complexities = withMetrics.map((m) => m.complexity).sort((a, b) => a - b);
    const p90 = percentile(complexities, 90);
    const p70 = percentile(complexities, 70);

    depthMap = new Map();
    for (const { mod, complexity } of withMetrics) {
      if (complexity >= p90) depthMap.set(mod.path, "full");
      else if (complexity >= p70) depthMap.set(mod.path, "standard");
      else depthMap.set(mod.path, "brief");
    }
  } else {
    depthMap = new Map();
    for (const { mod } of withMetrics) {
      depthMap.set(mod.path, "brief");
    }
  }

  // Sort by importance descending for generation order
  withMetrics.sort((a, b) => b.importance - a.importance);

  // Build file node lookup for sub-page prediction
  const fileNodes = new Map<string, FileLevelNode>();
  for (const n of discovery.graphData.fileLevel.nodes) {
    fileNodes.set(n.path, n);
  }

  for (const { mod } of withMetrics) {
    const depth = depthMap.get(mod.path) ?? "brief";
    const sourceFiles = mod.entryFile ? [mod.entryFile] : [];
    const usesFolder = willHaveSubPages(mod, depth, fileNodes);
    const wikiPath = usesFolder
      ? `wiki/modules/${toKebabCase(mod.name)}/index.md`
      : `wiki/modules/${toKebabCase(mod.name)}.md`;

    pages.push([
      wikiPath,
      {
        kind: "module",
        tier: "module",
        title: mod.name,
        depth,
        sourceFiles,
        relatedPages: [],
      },
    ]);
  }

  return pages;
}

// ── Module-file sub-pages ──

function buildModuleFilePages(
  classified: ClassifiedInventory,
  discovery: DiscoveryResult,
  existingPages: Record<string, ManifestPage>,
): [string, Omit<ManifestPage, "order">][] {
  const pages: [string, Omit<ManifestPage, "order">][] = [];
  const fileNodes = new Map<string, FileLevelNode>();
  for (const n of discovery.graphData.fileLevel.nodes) {
    fileNodes.set(n.path, n);
  }

  for (const [pagePath, page] of Object.entries(existingPages)) {
    if (page.kind !== "module" || page.depth !== "full") continue;

    const mod = classified.modules.find((m) => m.name === page.title);
    if (!mod) continue;

    // Only split large modules
    if (mod.fileCount < FILE_THRESHOLD && mod.exportCount < EXPORT_THRESHOLD) continue;

    // Score each file in the module
    const scored: { file: string; score: number; node: FileLevelNode }[] = [];
    for (const f of mod.files) {
      // Skip the entry file — it's already covered by the module index page
      if (f === mod.entryFile) continue;
      const node = fileNodes.get(f);
      if (!node) continue;
      const exportCount = node.exports.length;
      const fanIn = node.fanIn;
      if (exportCount >= FILE_EXPORT_THRESHOLD || fanIn >= FAN_IN_THRESHOLD) {
        scored.push({ file: f, score: exportCount + fanIn, node });
      }
    }

    // Take top N by score
    scored.sort((a, b) => b.score - a.score);
    const topFiles = scored.slice(0, MAX_SUB_PAGES);

    for (const { file } of topFiles) {
      const fileName = deriveNameFromPath(file);
      pages.push([
        `wiki/modules/${toKebabCase(mod.name)}/${toKebabCase(fileName)}.md`,
        {
          kind: "file",
          focus: "module-file",
          tier: "module",
          title: fileName,
          depth: "standard",
          sourceFiles: [file],
          relatedPages: [],
        },
      ]);
    }
  }

  return pages;
}

// ── Cross-cutting pages ──

function buildCrossCuttingPages(
  discovery: DiscoveryResult,
): [string, Omit<ManifestPage, "order">][] {
  const pages: [string, Omit<ManifestPage, "order">][] = [];
  const hasTestFiles = discovery.graphData.fileLevel.nodes.some(
    (n) => /\.(test|spec)\.(ts|js|tsx|jsx|py|rs)$/.test(n.path) || n.path.includes("/test/") || n.path.includes("/tests/")
  );

  // Always generated
  pages.push(["wiki/architecture.md", aggregatePage("architecture", "Architecture")]);
  pages.push(["wiki/data-flows.md", aggregatePage("data-flows", "Data Flows")]);
  pages.push(["wiki/guides/getting-started.md", aggregatePage("getting-started", "Getting Started")]);

  if (discovery.fileCount >= 20) {
    pages.push(["wiki/guides/conventions.md", aggregatePage("conventions", "Conventions")]);
  }
  if (hasTestFiles) {
    pages.push(["wiki/guides/testing.md", aggregatePage("testing", "Testing")]);
  }

  // Index is always last
  pages.push(["wiki/index.md", aggregatePage("index", "Index")]);

  return pages;
}

function aggregatePage(focus: PageFocus, title: string): Omit<ManifestPage, "order"> {
  return {
    kind: "aggregate",
    focus,
    tier: "aggregate",
    title,
    depth: "standard",
    sourceFiles: [],
    relatedPages: [],
  };
}

// ── Related pages ──

function computeRelatedPages(
  pages: Record<string, ManifestPage>,
  classified: ClassifiedInventory,
  discovery: DiscoveryResult,
): void {
  const allPaths = Object.keys(pages);
  const modulePages = allPaths.filter((p) => pages[p].kind === "module");
  const moduleFilePages = allPaths.filter((p) => pages[p].kind === "file");

  for (const [path, page] of Object.entries(pages)) {
    const related = new Set<string>();
    const key: string = page.focus ?? page.kind;

    switch (key) {
      case "module": {
        // Link to sub-pages of this module
        const prefix = path.replace(/index\.md$/, "");
        for (const mfp of moduleFilePages) {
          if (mfp.startsWith(prefix) && mfp !== path) {
            related.add(mfp);
          }
        }
        break;
      }
      case "module-file": {
        // Link to parent module index
        const parentPrefix = path.substring(0, path.lastIndexOf("/") + 1);
        const parentIndex = `${parentPrefix}index.md`;
        if (pages[parentIndex]) related.add(parentIndex);
        // Link to sibling sub-pages
        for (const mfp of moduleFilePages) {
          if (mfp !== path && mfp.startsWith(parentPrefix)) {
            related.add(mfp);
          }
        }
        break;
      }
      case "architecture": {
        for (const mp of modulePages) related.add(mp);
        if (pages["wiki/data-flows.md"]) related.add("wiki/data-flows.md");
        break;
      }
      case "data-flows": {
        if (pages["wiki/architecture.md"]) related.add("wiki/architecture.md");
        break;
      }
    }

    page.relatedPages = [...related];
  }
}

// ── Utilities ──

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/\..*$/, "") // strip file extension
    .toLowerCase();
}

function deriveNameFromPath(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.(ts|js|tsx|jsx|py|rs|go)$/, "");
}

/** Predict whether a module will produce sub-pages (same criteria as buildModuleFilePages). */
function willHaveSubPages(
  mod: ClassifiedModule,
  depth: PageDepth,
  fileNodes: Map<string, FileLevelNode>,
): boolean {
  if (depth !== "full") return false;
  if (mod.fileCount < FILE_THRESHOLD && mod.exportCount < EXPORT_THRESHOLD) return false;

  for (const f of mod.files) {
    if (f === mod.entryFile) continue;
    const node = fileNodes.get(f);
    if (!node) continue;
    if (node.exports.length >= FILE_EXPORT_THRESHOLD || node.fanIn >= FAN_IN_THRESHOLD) {
      return true;
    }
  }
  return false;
}
