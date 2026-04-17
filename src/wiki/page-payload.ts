import { relative, dirname } from "path";
import type {
  PageManifest,
  ManifestPage,
  ContentCache,
  ClassifiedInventory,
  PagePayload,
  SemanticQuery,
  ToolBreadcrumb,
  PageContentCache,
} from "./types";
import { selectSections, exemplarPathFor } from "./section-selector";

/**
 * Build the focused payload for a single page, returned by generate_wiki(page: N).
 * Contains pre-fetched data, semantic query suggestions, and breadcrumbs for
 * additional tool calls if the agent needs more context.
 */
export function buildPagePayload(
  pageIndex: number,
  manifest: PageManifest,
  content: ContentCache,
  classified: ClassifiedInventory,
): PagePayload {
  // Find the page at this index (ordered by manifest's order field)
  const entries = Object.entries(manifest.pages)
    .sort(([, a], [, b]) => a.order - b.order);

  if (pageIndex < 0 || pageIndex >= entries.length) {
    throw new Error(`Page index ${pageIndex} out of range (0-${entries.length - 1})`);
  }

  const [wikiPath, page] = entries[pageIndex];
  const prefetched = content[wikiPath] ?? {};
  const linkMap = buildLinkMap(wikiPath, page, prefetched, manifest);
  const candidateSections = selectSections(page.kind, page.focus, prefetched, {
    relatedPagesCount: page.relatedPages.length,
    linkMapSize: Object.keys(linkMap).length,
  });
  const exemplarPath = exemplarPathFor(page.kind, page.focus);

  return {
    wikiPath,
    kind: page.kind,
    focus: page.focus,
    depth: page.depth,
    title: page.title,
    exemplarPath,
    sourceFile: page.sourceFiles[0] ?? "",
    prefetched,
    candidateSections,
    semanticQueries: buildSemanticQueries(page, prefetched),
    relatedPages: page.relatedPages,
    additionalTools: buildBreadcrumbs(page, prefetched),
    linkMap,
  };
}

/**
 * Generate tailored semantic queries the agent should make.
 * These are only queries the overview/relevantChunks didn't already cover.
 */
function buildSemanticQueries(
  page: ManifestPage,
  prefetched: PageContentCache,
): SemanticQuery[] {
  const queries: SemanticQuery[] = [];
  const title = page.title;
  const file = page.sourceFiles[0] ?? "";
  const key: string = page.focus ?? page.kind;

  switch (key) {
    case "module":
      queries.push({
        query: `${title} purpose responsibilities overview`,
        top: 10,
        reason: "High-level module purpose for overview section",
      });
      queries.push({
        query: `${title} flow pipeline process request handling`,
        top: 10,
        reason: "How data flows through this module (for sequence diagram)",
      });
      break;

    case "module-file":
      queries.push({
        query: `${file} purpose responsibilities architecture`,
        top: 10,
        reason: "Why this file is architecturally important",
      });
      queries.push({
        query: `${title} implementation behavior orchestration`,
        top: 10,
        reason: "How the key exports work together",
      });
      break;

    case "architecture":
      queries.push({
        query: "project architecture overview purpose",
        top: 15,
        reason: "What the project is and why it exists",
      });
      queries.push({
        query: "entry point bootstrap initialization startup",
        top: 10,
        reason: "How execution starts",
      });
      queries.push({
        query: "configuration loading defaults settings",
        top: 10,
        reason: "How the project is configured",
      });
      break;

    case "data-flows":
      queries.push({
        query: "data flow request handling pipeline processing",
        top: 15,
        reason: "Primary data flow through the system",
      });
      queries.push({
        query: "error handling fallback recovery retry",
        top: 10,
        reason: "Error paths in the data flow",
      });
      break;

    case "getting-started":
      queries.push({
        query: "setup install prerequisites getting started",
        top: 15,
        reason: "Prerequisites and setup steps",
      });
      queries.push({
        query: "README overview project description",
        top: 10,
        reason: "Project description",
      });
      queries.push({
        query: "known issues bugs workaround caveat",
        top: 10,
        reason: "Known issues section",
      });
      break;

    case "conventions":
      queries.push({
        query: "naming conventions patterns error handling",
        top: 15,
        reason: "Coding conventions",
      });
      queries.push({
        query: "file organization structure coding style",
        top: 10,
        reason: "File organization patterns",
      });
      break;

    case "testing":
      queries.push({
        query: "test structure helpers fixtures utilities",
        top: 15,
        reason: "Test organization",
      });
      queries.push({
        query: "running tests coverage configuration",
        top: 10,
        reason: "How to run tests",
      });
      break;

    case "index":
      // Index page is assembled from manifest — no semantic queries needed
      break;
  }

  return queries;
}

/**
 * Build breadcrumbs — tools the agent CAN call if pre-fetched data isn't enough.
 * These are suggestions, not requirements.
 */
function buildBreadcrumbs(
  page: ManifestPage,
  prefetched: PageContentCache,
): ToolBreadcrumb[] {
  const breadcrumbs: ToolBreadcrumb[] = [];
  const title = page.title;
  const file = page.sourceFiles[0];

  // Common: deeper implementation details
  if (file) {
    breadcrumbs.push({
      tool: "read_relevant",
      args: { query: `${title} implementation behavior constants`, top: 10 },
      reason: "Deeper implementation details beyond the overview",
    });
  }

  // Common: full usage list
  if (prefetched.usageSites && prefetched.usageSites.length >= MAX_USAGES_SHOWN) {
    breadcrumbs.push({
      tool: "find_usages",
      args: { symbol: title, top: 30 },
      reason: `Full usage list (${prefetched.usageSites.length} shown, may be more)`,
    });
  }

  // Common: re-check signature
  breadcrumbs.push({
    tool: "search_symbols",
    args: { symbol: title, exact: true },
    reason: "Re-check or get full signature",
  });

  // Common: read the source file directly
  if (file) {
    breadcrumbs.push({
      tool: "Read",
      args: { file_path: file },
      reason: "Read the actual source file for implementation details",
    });
  }

  // Module/file: explore dependency graph
  if (page.kind === "module" || page.kind === "file") {
    if (file) {
      breadcrumbs.push({
        tool: "depends_on",
        args: { path: file },
        reason: "Full dependency list with import sources",
      });
      breadcrumbs.push({
        tool: "depended_on_by",
        args: { path: file },
        reason: "Full reverse dependency list",
      });
    }
  }

  return breadcrumbs;
}

const MAX_USAGES_SHOWN = 10;

/**
 * Build a scoped link map: only names this page is likely to reference.
 * Pulls from relatedPages, pre-fetched data, and cross-cutting pages.
 */
function buildLinkMap(
  currentWikiPath: string,
  page: ManifestPage,
  prefetched: PageContentCache,
  manifest: PageManifest,
): Record<string, string> {
  const fromDir = dirname(currentWikiPath);
  const map: Record<string, string> = {};

  // Collect names this page is likely to mention
  const relevantNames = new Set<string>();

  // From pre-fetched exports
  if (prefetched.exports) {
    for (const e of prefetched.exports) relevantNames.add(e.name);
  }
  // From inline children
  if (prefetched.inlineChildren) {
    for (const c of prefetched.inlineChildren) relevantNames.add(c.name);
  }
  // From children list
  if (prefetched.children) {
    for (const c of prefetched.children) relevantNames.add(c);
  }

  // Build reverse lookup: wiki path → title
  const pathToTitle = new Map<string, string>();
  for (const [targetPath, targetPage] of Object.entries(manifest.pages)) {
    pathToTitle.set(targetPath, targetPage.title);
  }

  // Related pages (always included)
  for (const rp of page.relatedPages) {
    const title = pathToTitle.get(rp);
    if (title && rp !== currentWikiPath) {
      map[title] = relative(fromDir, rp);
    }
  }

  // Cross-cutting pages (few, always useful for linking)
  for (const [targetPath, targetPage] of Object.entries(manifest.pages)) {
    if (targetPath === currentWikiPath) continue;
    if (targetPage.tier === "aggregate") {
      map[targetPage.title] = relative(fromDir, targetPath);
    }
  }

  // Pages whose titles match names in the pre-fetched data
  for (const [targetPath, targetPage] of Object.entries(manifest.pages)) {
    if (targetPath === currentWikiPath) continue;
    if (map[targetPage.title]) continue; // already added
    if (relevantNames.has(targetPage.title)) {
      map[targetPage.title] = relative(fromDir, targetPath);
    }
  }

  return map;
}
