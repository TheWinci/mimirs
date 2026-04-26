import { basename, extname } from "path";
import type {
  DiscoveryResult,
  ClassifiedInventory,
  CommunityBundle,
  PageManifest,
  ManifestPage,
  PageDepth,
  SynthesesFile,
  SynthesisPayload,
  SectionSpec,
} from "./types";
import { classifyMembers, isSplitCommunity } from "./community-synthesis";

/**
 * Depth-auto thresholds. File count remains the baseline; LOC + tunable count
 * escalate to `full` when a community has visible complexity (big modules or
 * heavy tuning) that file count alone misses.
 */
const DEPTH_FULL_FILE_COUNT = 10;
const DEPTH_STANDARD_FILE_COUNT = 4;
const DEPTH_FULL_TOP_LOC = 400;
const DEPTH_FULL_TUNABLE_COUNT = 8;

const ARCHITECTURE_PATH = "wiki/architecture.md";
const GETTING_STARTED_PATH = "wiki/getting-started.md";
const DATA_FLOWS_PATH = "wiki/data-flows.md";

/**
 * Community pages live under a flat `wiki/communities/` folder; aggregates
 * (architecture, getting-started, data-flows, and the user-written index)
 * sit at the root of `wiki/`.
 */
const COMMUNITIES_DIR = "communities";

/**
 * Build the page manifest from LLM-produced synthesis payloads plus three
 * hardcoded aggregate pages (architecture, getting-started, data-flows).
 *
 * Community pages: one per synthesis under `wiki/communities/<slug>.md`.
 * Slug / title / purpose / sections all come from the LLM. Depth is derived
 * from member-file count plus bundle-provided complexity signals.
 */
export function buildPageTree(
  discovery: DiscoveryResult,
  classified: ClassifiedInventory,
  syntheses: SynthesesFile,
  gitRef: string,
  cluster: "files" | "symbols" = "files",
  bundles: CommunityBundle[] = [],
): PageManifest {
  void classified;
  const warnings: string[] = [];
  const pages: Record<string, ManifestPage> = {};
  let order = 0;

  const communityPages = buildCommunityPages(syntheses, bundles);
  for (const [path, page] of communityPages) {
    pages[path] = { ...page, order: order++ };
  }

  const subPages = buildCommunitySubPages(syntheses, bundles);
  for (const [path, page] of subPages) {
    pages[path] = { ...page, order: order++ };
  }

  pages[ARCHITECTURE_PATH] = { ...architecturePage(), order: order++ };
  pages[DATA_FLOWS_PATH] = { ...dataFlowsPage(), order: order++ };
  pages[GETTING_STARTED_PATH] = { ...gettingStartedPage(), order: order++ };

  const metaEdges = computeMetaEdges(syntheses, discovery);
  computeRelatedPages(pages, metaEdges);

  if (communityPages.length === 0) {
    warnings.push("No syntheses found — only aggregate pages will be generated");
  }

  return {
    version: 3,
    generatedAt: new Date().toISOString(),
    lastGitRef: gitRef,
    pageCount: Object.keys(pages).length,
    pages,
    warnings,
    cluster,
  };
}

function buildCommunityPages(
  syntheses: SynthesesFile,
  bundles: CommunityBundle[],
): [string, Omit<ManifestPage, "order">][] {
  const bundleById = new Map(bundles.map((b) => [b.communityId, b]));
  const entries = Object.values(syntheses.payloads).sort((a, b) => {
    const sa = syntheses.memberSets[a.communityId]?.length ?? 0;
    const sb = syntheses.memberSets[b.communityId]?.length ?? 0;
    return sb - sa || a.slug.localeCompare(b.slug);
  });

  return entries.map((p) => {
    const memberFiles = syntheses.memberSets[p.communityId] ?? [];
    const wikiPath = `wiki/${COMMUNITIES_DIR}/${p.slug}.md`;
    const bundle = bundleById.get(p.communityId);
    const split = bundle ? isSplitCommunity(bundle) : false;
    // Split communities own a lot of prose (per-file breakdown for smalls +
    // Sub-pages index) so they always get the full word budget.
    const depth: PageDepth = split
      ? "full"
      : depthForCommunity(
          memberFiles.length,
          bundle?.topMemberLoc ?? 0,
          bundle?.tunableCount ?? 0,
        );
    return [
      wikiPath,
      {
        kind: p.kind ?? "community",
        slug: p.slug,
        title: p.name,
        purpose: p.purpose,
        sections: maybeAppendSubPagesSection(p.sections, split),
        depth,
        memberFiles,
        communityId: p.communityId,
        relatedPages: [],
      },
    ];
  });
}

/**
 * Split communities get a "Sub-pages" section — a short index pointing to the
 * big-member drill-downs. Small members live inline in the parent's per-file-
 * breakdown, so this is only a signpost to the handful of big files that got
 * promoted. Un-split communities keep their LLM sections as-is.
 */
function maybeAppendSubPagesSection(
  sections: SectionSpec[],
  split: boolean,
): SectionSpec[] {
  if (!split) return sections;
  if (sections.some((s) => /^(sub-?pages|members)\b/i.test(s.title))) return sections;
  return [
    ...sections,
    {
      title: "Sub-pages",
      purpose:
        "One bullet per big-member sub-page in the link map: `- [sub-page title](./<slug>/<sub-slug>.md) — <1-line role>`. Omit the section entirely if the link map has no sub-pages. Small members are NOT listed here — they live inline in the per-file-breakdown section.",
      shape: "bulleted list: [sub-page](relative link) — 1-line role",
    },
  ];
}

/**
 * When a community is split (size-based trigger in
 * `community-synthesis.isSplitCommunity`), emit a sub-page per "big" member
 * under `wiki/communities/<slug>/<sub-slug>.md`. Small members stay on the
 * parent — the parent's `per-file-breakdown` section covers them. All sub-
 * pages share the parent's `communityId` so prefetch can reuse the community
 * bundle scoped to each sub-page's `memberFiles`.
 */
function buildCommunitySubPages(
  syntheses: SynthesesFile,
  bundles: CommunityBundle[],
): [string, Omit<ManifestPage, "order">][] {
  const bundleById = new Map(bundles.map((b) => [b.communityId, b]));
  const out: [string, Omit<ManifestPage, "order">][] = [];

  const payloads = Object.values(syntheses.payloads).sort((a, b) => {
    const sa = syntheses.memberSets[a.communityId]?.length ?? 0;
    const sb = syntheses.memberSets[b.communityId]?.length ?? 0;
    return sb - sa || a.slug.localeCompare(b.slug);
  });

  for (const p of payloads) {
    const memberFiles = syntheses.memberSets[p.communityId] ?? [];
    const bundle = bundleById.get(p.communityId);
    if (!bundle) continue;
    if (!isSplitCommunity(bundle)) continue;

    const { big } = classifyMembers(bundle);
    const topLoc = bundle.topMemberLoc;
    const usedSlugs = new Set<string>();

    for (const file of big) {
      const sub = uniqueFileSlug(file, memberFiles, usedSlugs);
      usedSlugs.add(sub);
      const wikiPath = `wiki/${COMMUNITIES_DIR}/${p.slug}/${sub}.md`;
      const loc = bundle.memberLoc[file] ?? 0;
      out.push([
        wikiPath,
        {
          kind: "community-file",
          slug: `${p.slug}/${sub}`,
          title: file,
          purpose: `Per-file detail for \`${file}\` — a member of the ${p.name} community.`,
          sections: singleFileSubPageSections(),
          depth: loc > DEPTH_FULL_TOP_LOC || topLoc > DEPTH_FULL_TOP_LOC ? "standard" : "brief",
          memberFiles: [file],
          communityId: p.communityId,
          relatedPages: [],
        },
      ]);
    }
  }
  return out;
}

/** Sections for a single-file sub-page — one concrete file, tight scope. */
function singleFileSubPageSections(): SectionSpec[] {
  return [
    {
      title: "Role",
      purpose:
        "1-2 sentences naming the file's role in the parent community: what concern it owns, what other members it leans on.",
      shape: "short prose paragraph",
    },
    {
      title: "Exports",
      purpose:
        "Every export from this file with signature + 1-sentence description of what it does (not just types). Quote constants verbatim (e.g. `DEFAULT_WEIGHT = 0.7`).",
      shape: "markdown table: Name | Kind | Signature | What it does",
    },
    {
      title: "Internals",
      purpose:
        "Non-obvious behavior a reader would miss from signatures alone — silent fallbacks, tuning knobs disguised as constants, defensive guards, heuristics with blind spots. Skip if the file is pure signature glue.",
      shape: "bulleted list: bold claim, then 1-3 sentences of elaboration with file:line references",
    },
  ];
}

/**
 * Turn a project-relative path into a filesystem-safe slug for a sub-page
 * filename. Prefers the basename (no extension) for brevity; falls back to
 * the full dashified path on collision within the same community.
 */
function uniqueFileSlug(
  file: string,
  allMembers: string[],
  used: Set<string>,
): string {
  const base = fileSlug(basename(file, extname(file)));
  if (!used.has(base)) {
    const collides = allMembers.some(
      (m) => m !== file && fileSlug(basename(m, extname(m))) === base,
    );
    if (!collides) return base;
  }
  return fileSlug(file);
}

function fileSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function depthForCommunity(
  memberFileCount: number,
  topMemberLoc: number,
  tunableCount: number,
): PageDepth {
  if (
    memberFileCount >= DEPTH_FULL_FILE_COUNT ||
    topMemberLoc > DEPTH_FULL_TOP_LOC ||
    tunableCount > DEPTH_FULL_TUNABLE_COUNT
  ) {
    return "full";
  }
  if (memberFileCount >= DEPTH_STANDARD_FILE_COUNT) return "standard";
  return "brief";
}

function architecturePage(): Omit<ManifestPage, "order"> {
  const sections: SectionSpec[] = [
    { title: "System map", purpose: "Mermaid diagram showing how communities relate to each other at a high level" },
    { title: "Load-bearing files", purpose: "Short list of the top PageRank files and what they anchor" },
    { title: "Entry points", purpose: "Files with no incoming edges — the graph sinks / true entry points" },
    { title: "Cross-cutting dependencies", purpose: "Communities or modules that everything depends on, pulled out of the main map" },
    {
      title: "Design decisions",
      purpose:
        "3–6 numbered structural choices that shaped the codebase — each one paragraph: the decision, the alternative it beat, and the reason. Source from architectural annotations, the top-community `design-rationale` sections, and root docs (README, ARCHITECTURE, ADRs). Do not fabricate — skip the section only if the bundle truly has no material.",
      shape: "numbered list of bold decision titles, each followed by a short paragraph (decision → alternative → reason)",
    },
  ];
  return {
    kind: "architecture",
    slug: "architecture",
    title: "Architecture",
    purpose: "Bird's-eye view of how the codebase is organised — communities, their relationships, and the load-bearing files that anchor everything.",
    sections,
    depth: "standard",
    memberFiles: [],
    relatedPages: [],
  };
}

function gettingStartedPage(): Omit<ManifestPage, "order"> {
  const sections: SectionSpec[] = [
    { title: "What this is", purpose: "One-paragraph summary of the project from the README" },
    { title: "Installation", purpose: "How to install dependencies and build" },
    { title: "First run", purpose: "The shortest path to seeing something work — command, expected output" },
    { title: "Where to look next", purpose: "Pointer to the top community page and the architecture page" },
  ];
  return {
    kind: "getting-started",
    slug: "getting-started",
    title: "Getting started",
    purpose: "Fastest path from zero to a working install. Points onward into the architecture page and the most-used community.",
    sections,
    depth: "standard",
    memberFiles: [],
    relatedPages: [],
  };
}

/**
 * Trace-oriented aggregate page — the narrative companion to architecture.
 * Architecture answers *what lives where*; data flows answers *what happens
 * when X is triggered*. The LLM should pick 2–4 real flows (not invent) and
 * give each a sequence diagram + numbered walkthrough + error paths.
 */
function dataFlowsPage(): Omit<ManifestPage, "order"> {
  const sections: SectionSpec[] = [
    {
      title: "Overview",
      purpose:
        "One paragraph naming the flows and where each is triggered (CLI command, HTTP handler, library entry, watcher event).",
    },
    {
      title: "Flow 1",
      purpose:
        "Pick the most-run flow. Start with a `sequenceDiagram` tracing the call path across communities, then a numbered step list citing the specific files/functions. Include an `### Error paths` subsection when the flow has real error handling (retries, fallbacks, graceful degradation).",
    },
    {
      title: "Flow 2",
      purpose:
        "Second most-used flow, same shape as Flow 1. Prefer sequence diagrams; only fall back to flowchart if the flow is a pipeline with no caller/callee relationship.",
    },
    {
      title: "Additional flows",
      purpose:
        "If the codebase has a third or fourth named flow (e.g. background sync, incremental update, pre-flight validation), cover it here. Omit the section entirely when there are no additional flows — do not stub.",
    },
  ];
  return {
    kind: "data-flows",
    slug: "data-flows",
    title: "Data flows",
    purpose:
      "How a request travels end-to-end for each of the project's primary triggers. Pairs with the architecture page: architecture shows where things live, this shows what runs in what order.",
    sections,
    depth: "full",
    memberFiles: [],
    relatedPages: [],
  };
}

/**
 * Top-N sibling communities each community page links to under "See also".
 * Navigation (9→6 in the v2 review) collapsed because community pages
 * related only to aggregates + own sub-pages — no cross-community edges.
 * Three is the sweet spot: enough to cover co-changed neighbors, not so
 * many that "See also" turns into a second navigation index.
 */
const MAX_SIBLING_COMMUNITIES = 3;

/**
 * Adjacency map keyed by community id: `id → Map<siblingId, edgeWeight>`.
 * Weight is the count of file-level import edges crossing the community
 * boundary (both directions summed). Empty map when no metadata is
 * available (e.g. one-community repos, fresh runs without discovery).
 */
type MetaEdges = Map<string, Map<string, number>>;

/**
 * Derive inter-community edge weights from the file-level import graph.
 * For each edge `from → to`, if the two files live in different
 * communities, accumulate one unit of weight on the ordered pair.
 *
 * Mirrors the calculation in `content-prefetch.ts:buildArchitectureBundle`
 * but keyed by `communityId` (not slug) because the manifest indexes by
 * id, and syntheses may lag behind discovery when a slug is renamed.
 */
function computeMetaEdges(
  syntheses: SynthesesFile,
  discovery: DiscoveryResult,
): MetaEdges {
  const fileToCommunity = new Map<string, string>();
  for (const [communityId, files] of Object.entries(syntheses.memberSets)) {
    for (const f of files) fileToCommunity.set(f, communityId);
  }

  const edges: MetaEdges = new Map();
  for (const edge of discovery.graphData.fileLevel.edges) {
    if (edge.from === edge.to) continue;
    const fromId = fileToCommunity.get(edge.from);
    const toId = fileToCommunity.get(edge.to);
    if (!fromId || !toId || fromId === toId) continue;
    const addWeight = (a: string, b: string) => {
      const row = edges.get(a) ?? new Map<string, number>();
      row.set(b, (row.get(b) ?? 0) + 1);
      edges.set(a, row);
    };
    // Undirected adjacency — "See also" is bidirectional.
    addWeight(fromId, toId);
    addWeight(toId, fromId);
  }
  return edges;
}

function computeRelatedPages(
  pages: Record<string, ManifestPage>,
  metaEdges: MetaEdges,
): void {
  const allPaths = Object.keys(pages);
  const communityPaths = allPaths.filter((p) => pages[p].kind === "community");
  const aggregatePaths = [ARCHITECTURE_PATH, DATA_FLOWS_PATH, GETTING_STARTED_PATH].filter(
    (p) => pages[p],
  );

  // Sub-page → parent community lookup and parent community → sub-pages lookup.
  const subPagesByCommunityId = new Map<string, string[]>();
  const parentByCommunityId = new Map<string, string>();
  for (const [path, page] of Object.entries(pages)) {
    if (page.kind === "community" && page.communityId) {
      parentByCommunityId.set(page.communityId, path);
    }
    if (page.kind === "community-file" && page.communityId) {
      const arr = subPagesByCommunityId.get(page.communityId) ?? [];
      arr.push(path);
      subPagesByCommunityId.set(page.communityId, arr);
    }
  }

  const siblingPaths = (communityId: string): string[] => {
    const row = metaEdges.get(communityId);
    if (!row) return [];
    const ranked = [...row.entries()]
      .filter(([otherId]) => otherId !== communityId)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const out: string[] = [];
    for (const [otherId] of ranked) {
      const sibPath = parentByCommunityId.get(otherId);
      if (sibPath) out.push(sibPath);
      if (out.length >= MAX_SIBLING_COMMUNITIES) break;
    }
    return out;
  };

  for (const [path, page] of Object.entries(pages)) {
    const related = new Set<string>();
    const isAggregate = aggregatePaths.includes(path);
    const isSubPage = page.kind === "community-file";

    if (isAggregate) {
      for (const cp of communityPaths) related.add(cp);
      for (const ap of aggregatePaths) if (ap !== path) related.add(ap);
    } else if (isSubPage) {
      if (page.communityId) {
        const parent = parentByCommunityId.get(page.communityId);
        if (parent) related.add(parent);
        for (const sib of subPagesByCommunityId.get(page.communityId) ?? []) {
          if (sib !== path) related.add(sib);
        }
      }
      for (const ap of aggregatePaths) related.add(ap);
    } else {
      for (const ap of aggregatePaths) if (ap !== path) related.add(ap);
      if (page.communityId) {
        for (const sp of subPagesByCommunityId.get(page.communityId) ?? []) {
          related.add(sp);
        }
        // Cross-community siblings by meta-graph weight — the fix for the
        // Navigation regression flagged in the v2 review.
        for (const sib of siblingPaths(page.communityId)) related.add(sib);
      }
    }

    related.delete(path);
    page.relatedPages = [...related].sort();
  }
}

/** Exposed for staleness/orchestrator — the canonical aggregate page paths. */
export const AGGREGATE_PAGE_PATHS = [
  ARCHITECTURE_PATH,
  DATA_FLOWS_PATH,
  GETTING_STARTED_PATH,
] as const;
