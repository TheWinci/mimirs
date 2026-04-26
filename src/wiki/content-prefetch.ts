import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, basename } from "path";
import Graph from "graphology";
import type { RagDB } from "../db";
import { computePageRank } from "./pagerank";
import { isTestOrBench } from "./community-detection";
import { semanticQueriesFor } from "./semantic-queries";
import { searchChunks } from "../search/hybrid";
import type { RagConfig } from "../config";
import type {
  PageManifest,
  DiscoveryResult,
  ClassifiedInventory,
  ContentCache,
  PageContentCache,
  ArchitectureBundle,
  GettingStartedBundle,
  CommunityBundle,
  SynthesesFile,
  PrefetchedQueryHit,
} from "./types";

/**
 * Narrow a community bundle to a specific subset of its member files for a
 * `community-file` sub-page. Exports, tunables, annotations, and recent
 * commits are filtered to just `files`. The top-member body is set to the
 * highest-PageRank file within the subset so the writer can ground prose in
 * real source. Single-file and group (multi-file) sub-pages share this path.
 */
export function scopeBundleToFiles(
  parent: CommunityBundle,
  files: string[],
  projectDir: string,
): CommunityBundle {
  const fileSet = new Set(files);
  const exports = parent.exports.filter((e) => fileSet.has(e.file));
  const tunables = parent.tunables.filter((t) => fileSet.has(t.file));
  const annotations = parent.annotations.filter((a) => fileSet.has(a.file));
  const recentCommits = parent.recentCommits
    .filter((c) => c.files.some((f) => fileSet.has(f)))
    .map((c) => ({ ...c, files: c.files.filter((f) => fileSet.has(f)) }));
  const topRanked = [...files].sort(
    (a, b) => (parent.pageRank[b] ?? 0) - (parent.pageRank[a] ?? 0),
  )[0] ?? null;
  const memberLoc: Record<string, number> = {};
  let topMemberLoc = 0;
  for (const f of files) {
    const loc = parent.memberLoc[f] ?? 0;
    memberLoc[f] = loc;
    if (loc > topMemberLoc) topMemberLoc = loc;
  }
  const pageRank: Record<string, number> = {};
  for (const f of files) pageRank[f] = parent.pageRank[f] ?? 0;
  const memberPreviews = (parent.memberPreviews ?? []).filter(
    (p) => fileSet.has(p.file) && p.file !== topRanked,
  );
  // Scope per-file edge maps to this sub-page's files. Values were already
  // filtered to "external to the parent community" at bundle build, so the
  // union is automatically external to the sub-page's parent — exactly the
  // surface the writer agent needs to attribute "who imports what" without
  // a `depended_on_by` round-trip per file.
  const consumersByFile: Record<string, string[]> = {};
  const dependenciesByFile: Record<string, string[]> = {};
  const scopedConsumers = new Set<string>();
  const scopedDependencies = new Set<string>();
  for (const f of files) {
    const cs = parent.consumersByFile?.[f] ?? [];
    const ds = parent.dependenciesByFile?.[f] ?? [];
    consumersByFile[f] = cs;
    dependenciesByFile[f] = ds;
    for (const c of cs) scopedConsumers.add(c);
    for (const d of ds) scopedDependencies.add(d);
  }
  return {
    ...parent,
    memberFiles: [...files],
    exports,
    exportCount: exports.length,
    tunables,
    tunableCount: tunables.length,
    annotations,
    recentCommits,
    topRankedFile: topRanked,
    memberPreviews,
    memberLoc,
    topMemberLoc,
    pageRank,
    externalConsumers: [...scopedConsumers].sort(),
    externalDependencies: [...scopedDependencies].sort(),
    consumersByFile,
    dependenciesByFile,
    nearbyDocs: [],
  };
}

/**
 * Per-depth caps on list-shaped bundle fields. Exports + tunables were
 * previously fixed at 60 / 40 regardless of depth, so a `brief` page
 * still shipped every export signature even though the writer had ~200
 * words of prose budget to use them. The trim:
 *
 *   - `full`:      no cap change — deep pages want the full signal.
 *   - `standard`:  25 exports, 15 tunables — enough for a table + prose.
 *   - `brief`:     10 exports, 5 tunables — the rest are summarised as
 *                  a count so the writer still knows what was trimmed.
 *
 * Annotations, external edges, and recent commits also get trimmed at
 * `brief` because they anchor sections the brief page doesn't render.
 * `standard` keeps them intact.
 */
const DEPTH_CAPS = {
  full: { exports: Infinity, tunables: Infinity, keepAnnotations: true, keepEdges: true, keepCommits: true, nearbyDocs: Infinity },
  standard: { exports: 25, tunables: 15, keepAnnotations: true, keepEdges: true, keepCommits: true, nearbyDocs: 3 },
  brief: { exports: 10, tunables: 5, keepAnnotations: false, keepEdges: false, keepCommits: false, nearbyDocs: 0 },
} as const;

/**
 * Trim list-shaped bundle fields for the target depth. Previews are
 * dropped for non-full pages (they're the biggest field and writer
 * prose at lower depths stays at the signatures level). Exports,
 * tunables, annotations, external edges, and recent commits follow
 * `DEPTH_CAPS` above — each cap independent so a brief page can still
 * ship a handful of tunables when a section depends on them.
 *
 * Exports and tunables arrive sorted by per-file PageRank descending, so
 * a slice(0, n) keeps the highest-signal entries. Counts (`tunableCount`,
 * external-edge length) are preserved in the bundle fields the renderer
 * already surfaces; the writer sees "shown X of Y" via existing phrasing.
 */
function stripPreviewsForDepth(
  bundle: CommunityBundle,
  depth: import("./types").PageDepth,
): CommunityBundle {
  const caps = DEPTH_CAPS[depth];
  const exports = Number.isFinite(caps.exports) ? bundle.exports.slice(0, caps.exports) : bundle.exports;
  const tunables = Number.isFinite(caps.tunables) ? bundle.tunables.slice(0, caps.tunables) : bundle.tunables;
  return {
    ...bundle,
    memberPreviews: depth === "full" ? bundle.memberPreviews : [],
    exports,
    tunables,
    annotations: caps.keepAnnotations ? bundle.annotations : [],
    externalConsumers: caps.keepEdges ? bundle.externalConsumers : [],
    externalDependencies: caps.keepEdges ? bundle.externalDependencies : [],
    consumersByFile: caps.keepEdges ? bundle.consumersByFile : {},
    dependenciesByFile: caps.keepEdges ? bundle.dependenciesByFile : {},
    recentCommits: caps.keepCommits ? bundle.recentCommits : [],
    nearbyDocs: Number.isFinite(caps.nearbyDocs)
      ? bundle.nearbyDocs.slice(0, caps.nearbyDocs)
      : bundle.nearbyDocs,
  };
}

const ROOT_DOC_CANDIDATES = [
  "README.md",
  "README",
  "ARCHITECTURE.md",
  "DESIGN.md",
  "CONTRIBUTING.md",
];
const ROOT_DOC_MAX_BYTES = 64 * 1024;
/** Preview size shipped in architecture bundle; full content stays on disk. */
const DOC_PREVIEW_LINES = 10;
const CONFIG_FILE_NAMES = [
  ".env.example",
  ".env.sample",
  "tsconfig.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
];
const CLI_NAME_PATTERN = /(cli|bin|main|server|entry)/i;
const ARCHITECTURAL_KEYWORDS = /architecture|design|invariant|contract|cross[- ]cutting/i;

/**
 * Wire pre-computed community bundles plus new aggregate bundles into the
 * per-page content cache.
 *
 * Community bundles come from `buildCommunityBundles` (already run before
 * synthesis). Architecture + getting-started bundles are built here because
 * they depend on the final synthesis (for community names/slugs) plus
 * project-root files.
 */
/**
 * Pre-run semantic-query knobs. Top-K kept low because each writer page
 * gets its results inlined into the prompt — the goal is to replace the
 * writer's first read_relevant call, not bury them in chunks. Snippet
 * line cap keeps any single hit bounded; writers Read the file when they
 * need more.
 */
const PREFETCH_TOP_K = 4;
const PREFETCH_SCORE_THRESHOLD = 0.3;
const PREFETCH_SNIPPET_LINES = 12;

export async function prefetchContent(
  db: RagDB,
  manifest: PageManifest,
  discovery: DiscoveryResult,
  classified: ClassifiedInventory,
  syntheses: SynthesesFile,
  bundlesById: Map<string, CommunityBundle>,
  projectDir: string,
  config: RagConfig,
  supplementaryDocs: { path: string; content: string }[] = [],
): Promise<ContentCache> {
  const cache: ContentCache = {};

  const architecture = buildArchitectureBundle(
    discovery,
    classified,
    syntheses,
    bundlesById,
    db,
    projectDir,
    supplementaryDocs,
  );
  const gettingStarted = buildGettingStartedBundle(
    discovery,
    classified,
    syntheses,
    bundlesById,
    architecture,
    projectDir,
  );

  for (const [wikiPath, page] of Object.entries(manifest.pages)) {
    const bag: PageContentCache = {};
    if (page.kind === "architecture") {
      bag.architecture = architecture;
    } else if (page.kind === "data-flows") {
      bag.architecture = architecture;
    } else if (page.kind === "getting-started") {
      bag.gettingStarted = gettingStarted;
    } else if (page.kind === "community-file" && page.communityId) {
      // Sub-pages share the parent community bundle scoped to memberFiles.
      // Single-file sub-page: one member; group sub-page: multiple members.
      // Scoping here (vs at render) keeps the JSON cache small and makes the
      // payload self-sufficient.
      const parent = bundlesById.get(page.communityId);
      if (parent && page.memberFiles.length > 0) {
        bag.community = scopeBundleToFiles(parent, page.memberFiles, projectDir);
        bag.community = stripPreviewsForDepth(bag.community, page.depth);
      }
    } else if (page.communityId) {
      const bundle = bundlesById.get(page.communityId);
      if (bundle) bag.community = stripPreviewsForDepth(bundle, page.depth);
    }
    cache[wikiPath] = bag;
  }

  // Pre-run semantic queries for every page in parallel — replaces the
  // first read_relevant tool call each writer would make. Each query goes
  // through the same hybrid search the read_relevant tool uses, so results
  // are identical to what the writer would get.
  const queryTasks: Promise<void>[] = [];
  for (const [wikiPath, page] of Object.entries(manifest.pages)) {
    const queries = semanticQueriesFor(page.kind);
    if (queries.length === 0) continue;
    const bag = cache[wikiPath];
    queryTasks.push(
      runPrefetchQueries(db, config, queries).then((results) => {
        bag.prefetchedQueries = results;
      }),
    );
  }
  await Promise.all(queryTasks);

  return cache;
}

async function runPrefetchQueries(
  db: RagDB,
  config: RagConfig,
  queries: string[],
): Promise<{ query: string; results: PrefetchedQueryHit[] }[]> {
  const out: { query: string; results: PrefetchedQueryHit[] }[] = [];
  for (const query of queries) {
    const hits = await searchChunks(
      query,
      db,
      PREFETCH_TOP_K,
      PREFETCH_SCORE_THRESHOLD,
      config.hybridWeight,
      config.generated,
    );
    out.push({
      query,
      results: hits.map((h) => ({
        path: h.path,
        startLine: h.startLine,
        endLine: h.endLine,
        entityName: h.entityName,
        chunkType: h.chunkType,
        score: h.score,
        snippet: h.content.split("\n").slice(0, PREFETCH_SNIPPET_LINES).join("\n"),
      })),
    });
  }
  return out;
}

export function buildArchitectureBundle(
  discovery: DiscoveryResult,
  classified: ClassifiedInventory,
  syntheses: SynthesesFile,
  bundlesById: Map<string, CommunityBundle>,
  db: RagDB,
  projectDir: string,
  supplementaryDocs: { path: string; content: string }[] = [],
): ArchitectureBundle {
  const communities = Object.values(syntheses.payloads)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      purpose: p.purpose,
      memberFiles: syntheses.memberSets[p.communityId] ?? [],
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const fileToCommunity = new Map<string, string>();
  for (const c of communities) {
    for (const f of c.memberFiles) fileToCommunity.set(f, c.slug);
  }

  const metaEdgeWeights = new Map<string, number>();
  for (const edge of discovery.graphData.fileLevel.edges) {
    if (edge.from === edge.to) continue;
    const fromSlug = fileToCommunity.get(edge.from);
    const toSlug = fileToCommunity.get(edge.to);
    if (!fromSlug || !toSlug || fromSlug === toSlug) continue;
    const key = `${fromSlug}\0${toSlug}`;
    metaEdgeWeights.set(key, (metaEdgeWeights.get(key) ?? 0) + 1);
  }
  const metaEdges = [...metaEdgeWeights.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split("\0");
      return { from, to, weight };
    })
    .sort((a, b) =>
      a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
    );

  const communityPageRank = computeCommunityMetaPageRank(
    communities.map((c) => c.slug),
    metaEdges,
  );

  // For every top hub, derive the set of communities that import it via a
  // file-level edge whose source is outside the hub's own community. The
  // list gives the writer prose-ready phrasing ("imported by 8 of 12
  // communities") instead of a raw fan-in number rendered as trivia.
  const importsByHub = new Map<string, Set<string>>();
  for (const edge of discovery.graphData.fileLevel.edges) {
    if (edge.from === edge.to) continue;
    const fromSlug = fileToCommunity.get(edge.from);
    const toSlug = fileToCommunity.get(edge.to);
    if (!fromSlug || !toSlug || fromSlug === toSlug) continue;
    const set = importsByHub.get(edge.to) ?? new Set<string>();
    set.add(fromSlug);
    importsByHub.set(edge.to, set);
  }

  const topHubs = classified.files
    .filter((f) => f.isTopHub)
    .sort((a, b) => b.pageRank - a.pageRank || a.path.localeCompare(b.path))
    .map((f) => ({
      path: f.path,
      pageRank: f.pageRank,
      fanIn: f.fanIn,
      fanOut: f.fanOut,
      bridges: f.bridges,
      importingCommunities: [...(importsByHub.get(f.path) ?? new Set<string>())].sort(),
    }));

  // Derive the repo's source-code extension set from files with classified
  // symbols — anything bun-chunk parsed as code. Entry points with zero
  // exports AND a non-code extension are noise (fixtures, plugin manifests,
  // .md/.txt files the resolver caught as graph sinks).
  const codeExts = new Set<string>();
  for (const s of classified.symbols) {
    const ext = s.file.split(".").pop()?.toLowerCase();
    if (ext) codeExts.add(ext);
  }
  const entryPoints = discovery.graphData.fileLevel.nodes
    .filter((n) => n.isEntryPoint)
    .filter((n) => {
      if (n.exports.length > 0) return true;
      const ext = n.path.split(".").pop()?.toLowerCase();
      return ext ? codeExts.has(ext) : false;
    })
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((n) => ({ path: n.path, exports: n.exports }));

  const CROSS_CUTTING_MIN_FANIN = 5;
  const CROSS_CUTTING_TOP_K = 10;
  const crossCuttingFiles: ArchitectureBundle["crossCuttingFiles"] = discovery.graphData.fileLevel.nodes
    .filter((n) => isTestOrBench(n.path) && n.fanIn >= CROSS_CUTTING_MIN_FANIN)
    .sort((a, b) => b.fanIn - a.fanIn || a.path.localeCompare(b.path))
    .slice(0, CROSS_CUTTING_TOP_K)
    .map((n) => ({
      path: n.path,
      fanIn: n.fanIn,
      fanOut: n.fanOut,
      reason: "test-fixture" as const,
    }));

  const rootDocs = readRootDocs(projectDir);

  const architecturalNotes: ArchitectureBundle["architecturalNotes"] = [];
  for (const bundle of bundlesById.values()) {
    for (const a of bundle.annotations) {
      if (ARCHITECTURAL_KEYWORDS.test(a.note)) {
        architecturalNotes.push(a);
      }
    }
  }
  // Dedup via file:line:note
  const seen = new Set<string>();
  const dedupedNotes = architecturalNotes.filter((n) => {
    const key = `${n.file}\0${n.line}\0${n.note}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Fallback: if nothing was keyword-tagged, pull any annotations at all.
  const notes = dedupedNotes.length > 0
    ? dedupedNotes
    : collectAllAnnotations(db, projectDir, discovery);

  // Drop supplementary docs that duplicate rootDocs or have no usable
  // content. Empty docs (content === "") ship nothing but a path — wasted
  // tokens in the payload. Convert survivors to path+preview shape; full
  // content stays on disk and is Read on demand.
  const rootDocPaths = new Set(rootDocs.map((d) => d.path));
  const dedupedSupp = supplementaryDocs
    .filter((d) => !rootDocPaths.has(d.path))
    .filter((d) => d.content.trim().length > 0)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((d) => toDocPreview(d.path, d.content));

  return {
    communities,
    metaEdges,
    communityPageRank,
    topHubs,
    entryPoints,
    crossCuttingFiles,
    rootDocs,
    architecturalNotes: notes,
    supplementaryDocs: dedupedSupp,
  };
}

export function buildGettingStartedBundle(
  discovery: DiscoveryResult,
  classified: ClassifiedInventory,
  syntheses: SynthesesFile,
  bundlesById: Map<string, CommunityBundle>,
  architecture: ArchitectureBundle,
  projectDir: string,
): GettingStartedBundle {
  const readme = readFileIfExists(join(projectDir, "README.md"))
    ?? readFileIfExists(join(projectDir, "README"));

  const packageManifest = readPackageManifest(projectDir);

  const sortedCommunities = [...architecture.communities].sort((a, b) => {
    const ra = architecture.communityPageRank[a.slug] ?? 0;
    const rb = architecture.communityPageRank[b.slug] ?? 0;
    return rb - ra || a.slug.localeCompare(b.slug);
  });
  const top = sortedCommunities[0];
  const topCommunity = top
    ? { slug: top.slug, name: top.name, purpose: top.purpose }
    : null;

  const cliEntryPoints = discovery.graphData.fileLevel.nodes
    .filter((n) => n.isEntryPoint && CLI_NAME_PATTERN.test(basename(n.path)))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((n) => ({ path: n.path, exports: n.exports }));

  const configFiles = readConfigFiles(projectDir);

  const originCommits = collectOriginCommits(bundlesById);

  return {
    readme,
    packageManifest,
    topCommunity,
    cliEntryPoints,
    configFiles,
    originCommits,
  };
}

// ── Helpers ──

function computeCommunityMetaPageRank(
  slugs: string[],
  metaEdges: { from: string; to: string; weight: number }[],
): Record<string, number> {
  if (slugs.length === 0) return {};
  const graph = new Graph({ type: "undirected", multi: false });
  const sortedSlugs = [...slugs].sort();
  for (const s of sortedSlugs) graph.addNode(s);

  const sortedEdges = [...metaEdges].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
  for (const e of sortedEdges) {
    if (e.from === e.to) continue;
    if (!graph.hasNode(e.from) || !graph.hasNode(e.to)) continue;
    if (graph.hasEdge(e.from, e.to)) {
      graph.updateEdgeAttribute(e.from, e.to, "weight", (w: number | undefined) => (w ?? 1) + e.weight);
    } else {
      graph.addEdge(e.from, e.to, { weight: e.weight });
    }
  }

  if (graph.order === 0) return {};
  return Object.fromEntries(computePageRank(graph));
}

function readRootDocs(projectDir: string): ArchitectureBundle["rootDocs"] {
  const docs: ArchitectureBundle["rootDocs"] = [];
  for (const name of ROOT_DOC_CANDIDATES) {
    const full = join(projectDir, name);
    const content = readFileIfExists(full, ROOT_DOC_MAX_BYTES);
    if (content !== null) docs.push(toDocPreview(name, content));
  }
  // ADR files under docs/adr or adr/
  for (const adrDir of ["docs/adr", "adr", "docs/adrs"]) {
    const full = join(projectDir, adrDir);
    if (!existsSync(full)) continue;
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const e of entries.sort()) {
      if (!e.endsWith(".md")) continue;
      const content = readFileIfExists(join(full, e), ROOT_DOC_MAX_BYTES);
      if (content !== null) docs.push(toDocPreview(`${adrDir}/${e}`, content));
    }
  }
  return docs;
}

function toDocPreview(path: string, content: string): {
  path: string;
  byteSize: number;
  firstLines: string;
} {
  const lines = content.split("\n");
  const firstLines = lines.slice(0, DOC_PREVIEW_LINES).join("\n");
  return {
    path,
    byteSize: Buffer.byteLength(content, "utf-8"),
    firstLines,
  };
}

function readConfigFiles(projectDir: string): GettingStartedBundle["configFiles"] {
  const out: GettingStartedBundle["configFiles"] = [];
  for (const name of CONFIG_FILE_NAMES) {
    const content = readFileIfExists(join(projectDir, name), ROOT_DOC_MAX_BYTES);
    if (content !== null) out.push({ path: name, content });
  }
  return out;
}

function readPackageManifest(projectDir: string): unknown | null {
  const pkgPath = join(projectDir, "package.json");
  const raw = readFileIfExists(pkgPath);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readFileIfExists(path: string, maxBytes = ROOT_DOC_MAX_BYTES): string | null {
  if (!existsSync(path)) return null;
  try {
    const s = statSync(path);
    if (!s.isFile()) return null;
    const raw = readFileSync(path, "utf-8");
    return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  } catch {
    return null;
  }
}

function collectAllAnnotations(
  db: RagDB,
  projectDir: string,
  discovery: DiscoveryResult,
): ArchitectureBundle["architecturalNotes"] {
  const out: ArchitectureBundle["architecturalNotes"] = [];
  for (const node of discovery.graphData.fileLevel.nodes) {
    const notes = db.getAnnotations(resolve(projectDir, node.path));
    for (const n of notes) {
      out.push({
        file: node.path,
        line: (n as { line?: number }).line ?? 0,
        note: (n as { note: string }).note,
      });
    }
  }
  return out;
}

function collectOriginCommits(
  bundlesById: Map<string, CommunityBundle>,
): GettingStartedBundle["originCommits"] {
  const commitsByHash = new Map<string, { sha: string; message: string; date: string }>();
  for (const b of bundlesById.values()) {
    for (const c of b.recentCommits) {
      if (!commitsByHash.has(c.sha)) {
        commitsByHash.set(c.sha, { sha: c.sha, message: c.message, date: c.date });
      }
    }
  }
  return [...commitsByHash.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);
}
