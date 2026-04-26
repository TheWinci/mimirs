import { basename, dirname } from "path";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { SymbolGraphData } from "../db/graph";
import type {
  DiscoveryModule,
  FileLevelGraph,
  FileLevelNode,
} from "./types";

export type ClusterMode = "files" | "symbols";

const ENTRY_FILE_PATTERN = /^(index|main|mod|lib|__init__)\./;

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const MEMBER_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)/g;

const CALLER_CHUNK_TYPES = new Set([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "variable",
  "field",
  "export",
]);

/**
 * Tests and benchmarks belong in their own directory trees, but they import
 * heavily from src/. Including them in the clustering graph produces giant
 * blobs that span unrelated subsystems. The wiki documents the product code,
 * so we exclude them.
 *
 * Matches industry-standard test/bench conventions on both absolute and
 * relative paths — the graph uses relative paths, so leading-slash-only
 * substring checks miss matches like `tests/fixtures/foo.ts`.
 */
export function isTestOrBench(path: string): boolean {
  if (hasSegment(path, "tests") || hasSegment(path, "test") || hasSegment(path, "__tests__")) return true;
  if (hasSegment(path, "benchmarks") || hasSegment(path, "bench")) return true;
  if (/\.(test|spec|bench)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(path)) return true;
  return false;
}

function hasSegment(path: string, segment: string): boolean {
  return (
    path === segment ||
    path.startsWith(`${segment}/`) ||
    path.includes(`/${segment}/`)
  );
}

/**
 * Files the graph resolver couldn't parse (markdown, shell, config, data)
 * show up as structural isolates: no imports in, no imports out, no exports.
 * Including them in Louvain drags unrelated files into the nearest cluster
 * via orphan-reattachment and skews `pluralityDir` toward whichever directory
 * happens to hold the most adjacent docs. Generic, language-agnostic filter.
 */
function isGraphIsolate(node: FileLevelNode): boolean {
  return node.fanIn === 0 && node.fanOut === 0 && node.exports.length === 0;
}

function isClusterable(node: FileLevelNode): boolean {
  return !isTestOrBench(node.path) && !isGraphIsolate(node);
}

/**
 * Below these thresholds, Louvain's output is degenerate (one giant community
 * or one-per-file). Callers should fall back to the directory heuristic in
 * that regime — small projects don't need graph clustering to find structure.
 */
const MIN_NODES_FOR_LOUVAIN = 10;
const MIN_EDGES_FOR_LOUVAIN = 5;

/**
 * A cluster that swallows more than this fraction of the graph almost always
 * needs splitting — Louvain occasionally collapses whole projects into a
 * single community when weights skew. We second-pass-cluster anything above
 * `max(MIN_SPLIT_SIZE, MAX_SIZE_FRACTION * n)`.
 *
 * Tightened from 0.25 → 0.18 (and floor 10 → 8) after the v3 review
 * found high-fan-in hubs (e.g. `embed.ts` PR 0.114) absorbed into a
 * larger neighbour community, denying them a standalone landing page.
 * The pair sits at the size where a single hub plus its closest callers
 * forms a coherent ~8-node community on its own.
 */
const MAX_SIZE_FRACTION = 0.18;
const MIN_SPLIT_SIZE = 8;

/** Stable PRNG seed — fixes Louvain's non-determinism across runs. */
const LOUVAIN_SEED = 0x9e3779b9;

/** Mulberry32: tiny, deterministic PRNG for Louvain's `rng` option. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runLouvain(graph: Graph): Record<string, number> {
  return louvain(graph, {
    getEdgeWeight: "weight",
    resolution: 1.0,
    randomWalk: false,
    rng: seededRng(LOUVAIN_SEED),
  });
}

/**
 * Second Louvain pass on any cluster larger than the size cap. The first
 * sub-community inherits the parent cid; the rest get fresh ids. If the
 * subgraph resolves to a single community, leave alone — structurally dense,
 * not over-clustered.
 */
function splitOversized(
  graph: Graph,
  communities: Map<number, string[]>,
): Map<number, string[]> {
  const sizeCap = Math.max(MIN_SPLIT_SIZE, Math.floor(graph.order * MAX_SIZE_FRACTION));
  let nextId = communities.size === 0 ? 0 : Math.max(...communities.keys()) + 1;

  const next = new Map<number, string[]>();
  for (const [cid, members] of [...communities.entries()].sort((a, b) => a[0] - b[0])) {
    if (members.length <= sizeCap) {
      next.set(cid, members);
      continue;
    }

    const sub = new Graph({ type: "undirected", multi: false });
    const memberSet = new Set(members);
    for (const n of [...members].sort()) sub.addNode(n);
    graph.forEachEdge((_edge, attrs, source, target) => {
      if (!memberSet.has(source) || !memberSet.has(target)) return;
      if (source === target) return;
      if (sub.hasEdge(source, target)) return;
      sub.addEdge(source, target, { weight: attrs.weight ?? 1 });
    });

    if (sub.size === 0) { next.set(cid, members); continue; }

    const subAssignment = runLouvain(sub);
    const subBuckets = new Map<number, string[]>();
    for (const [node, subCid] of Object.entries(subAssignment)) {
      if (!subBuckets.has(subCid)) subBuckets.set(subCid, []);
      subBuckets.get(subCid)!.push(node);
    }

    if (subBuckets.size <= 1) { next.set(cid, members); continue; }

    const subSorted = [...subBuckets.values()].sort(
      (a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""),
    );
    next.set(cid, subSorted[0]);
    for (let i = 1; i < subSorted.length; i++) {
      next.set(nextId++, subSorted[i]);
    }
  }
  return next;
}

/**
 * Cohesion = internal edges / max possible edges in the induced subgraph.
 * Computed from the already-counted `internalEdges` on the module.
 */
function cohesionFor(fileCount: number, internalEdges: number): number {
  if (fileCount <= 1) return 1;
  const possible = (fileCount * (fileCount - 1)) / 2;
  return possible === 0 ? 0 : internalEdges / possible;
}

/**
 * Pre-assignment that forces a set of files into a single community no matter
 * what Louvain would do with them. Used for the dispatch/plugin pattern:
 * sibling directories whose files don't call each other (so Louvain splits
 * them up) but which belong together as a readable unit.
 */
export interface SeedGroup {
  /** Human-readable label; surfaces in the discovery module name. */
  label: string;
  /** Project-relative file paths to keep together. */
  files: string[];
}

export interface DetectFileCommunitiesOptions {
  /**
   * Pre-assigned groupings (bypass Louvain). Files listed here are pulled out
   * of whichever community Louvain placed them in and collapsed into one
   * community keyed by the seed label.
   */
  seedGroups?: SeedGroup[];
}

/**
 * Run Louvain on the file-level import graph. Each community becomes a
 * DiscoveryModule. Returns an empty array if the graph is too sparse — the
 * caller should fall back to directory-based detection in that case.
 *
 * `options.seedGroups` forces specific file sets into a single community,
 * overriding Louvain placement. Use for directories that don't cluster by
 * call-graph (dispatch/plugin pattern) — `detectDispatchDirectories` can emit
 * these automatically from the graph shape.
 */
export function detectFileCommunities(
  fileGraph: FileLevelGraph,
  options: DetectFileCommunitiesOptions = {},
): DiscoveryModule[] {
  const productFiles = new Set(
    fileGraph.nodes.filter(isClusterable).map((n) => n.path),
  );

  if (
    productFiles.size < MIN_NODES_FOR_LOUVAIN ||
    fileGraph.edges.length < MIN_EDGES_FOR_LOUVAIN
  ) {
    return [];
  }

  // Sort nodes before insertion — Louvain's output depends on node iteration
  // order, and iteration follows insertion order. Sorted input = deterministic
  // community assignments run-to-run.
  const sortedFiles = [...productFiles].sort();
  const sortedEdges = [...fileGraph.edges].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)
  );

  const g = new Graph({ type: "undirected", multi: false });
  for (const path of sortedFiles) g.addNode(path);
  for (const edge of sortedEdges) {
    if (edge.from === edge.to) continue;
    if (!productFiles.has(edge.from) || !productFiles.has(edge.to)) continue;
    if (g.hasEdge(edge.from, edge.to)) {
      g.updateEdgeAttribute(edge.from, edge.to, "weight", (w: number | undefined) => (w ?? 1) + 1);
    } else {
      g.addEdge(edge.from, edge.to, { weight: 1 });
    }
  }

  const isolates: string[] = [];
  g.forEachNode((n) => { if (g.degree(n) === 0) isolates.push(n); });
  for (const n of isolates) g.dropNode(n);

  if (g.order < 3 || g.size === 0) return [];

  const result = runLouvain(g);

  let communities = new Map<number, string[]>();
  for (const [file, cid] of Object.entries(result)) {
    if (!communities.has(cid)) communities.set(cid, []);
    communities.get(cid)!.push(file);
  }

  communities = splitOversized(g, communities);

  // Files Louvain dropped (isolates) — attach to the nearest-by-path community.
  let isolateFiles = isolates;

  if (options.seedGroups && options.seedGroups.length > 0) {
    const seededFiles = new Set<string>();
    for (const s of options.seedGroups) for (const f of s.files) seededFiles.add(f);
    communities = applySeedGroups(communities, options.seedGroups, productFiles);
    // Seeded files have already been placed into their own community — do not
    // reattach them as isolates or they'll appear in two modules (→ duplicate
    // nodes downstream in perCommunityPageRank).
    isolateFiles = isolateFiles.filter((f) => !seededFiles.has(f));
  }

  return buildModulesFromClusters(communities, fileGraph, isolateFiles);
}

/**
 * Pull seeded files out of whichever Louvain community holds them and
 * collapse them into a single community per seed group. The seed label is
 * attached via module-id metadata so `buildModuleFromCluster` can surface it.
 *
 * Files listed in `seed.files` that aren't in `clusterable` (e.g., tests,
 * isolates) are silently skipped — we don't invent cluster membership for
 * filtered-out nodes.
 */
function applySeedGroups(
  communities: Map<number, string[]>,
  seedGroups: SeedGroup[],
  clusterable: Set<string>,
): Map<number, string[]> {
  if (seedGroups.length === 0) return communities;
  const seededFiles = new Set<string>();
  for (const g of seedGroups) for (const f of g.files) seededFiles.add(f);

  const pruned = new Map<number, string[]>();
  for (const [cid, files] of communities) {
    const kept = files.filter((f) => !seededFiles.has(f));
    if (kept.length > 0) pruned.set(cid, kept);
  }

  let nextId = pruned.size === 0 ? 0 : Math.max(...pruned.keys()) + 1;
  for (const seed of seedGroups) {
    const files = seed.files
      .filter((f) => clusterable.has(f))
      .sort();
    if (files.length === 0) continue;
    pruned.set(nextId, files);
    seedLabelByCid.set(nextId, seed.label);
    nextId++;
  }
  return pruned;
}

/**
 * Seed-label metadata the cluster builder reads when naming its module. Kept
 * as a module-level map because `buildModuleFromCluster` signature is shared
 * across file + symbol paths and plumbing a new arg through every call site
 * is more churn than this one lookup warrants.
 */
const seedLabelByCid = new Map<number, string>();

/**
 * Inspect the file-level import graph for the **dispatch/plugin pattern**:
 * a sibling directory with ≥4 source files where every file is imported
 * from a shared parent but files rarely import each other. Common for
 * router/handler/plugin/middleware layouts across ecosystems — Louvain
 * splits these up because the inter-sibling graph is empty, but a reader
 * wants them as a single section.
 *
 * Generic: no hardcoded directory names. Purely structural.
 *
 * Returns zero or more `SeedGroup`s that callers can feed into
 * `detectFileCommunities({ seedGroups })`.
 */
export function detectDispatchDirectories(
  fileGraph: FileLevelGraph,
): SeedGroup[] {
  const MIN_SIBLINGS = 4;
  const MAX_INTERNAL_RATIO = 0.1;
  const MIN_SHARED_PARENT_FRACTION = 0.5;

  const clusterable = new Set(
    fileGraph.nodes.filter(isClusterable).map((n) => n.path),
  );
  if (clusterable.size < MIN_SIBLINGS) return [];

  const siblingsByDir = new Map<string, string[]>();
  for (const path of clusterable) {
    const d = dirname(path);
    if (!siblingsByDir.has(d)) siblingsByDir.set(d, []);
    siblingsByDir.get(d)!.push(path);
  }

  // Build directed import map from the (from → to) edges for fast lookup.
  const incomingByFile = new Map<string, Set<string>>();
  for (const e of fileGraph.edges) {
    if (!incomingByFile.has(e.to)) incomingByFile.set(e.to, new Set());
    incomingByFile.get(e.to)!.add(e.from);
  }

  const out: SeedGroup[] = [];
  const sortedDirs = [...siblingsByDir.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [dir, siblings] of sortedDirs) {
    if (siblings.length < MIN_SIBLINGS) continue;

    const siblingSet = new Set(siblings);

    // (a) Parent concentration: does at least one file outside the dir import
    //     ≥ MIN_SHARED_PARENT_FRACTION of siblings?
    const parentImportCounts = new Map<string, number>();
    for (const s of siblings) {
      for (const parent of incomingByFile.get(s) ?? []) {
        if (siblingSet.has(parent)) continue;
        parentImportCounts.set(parent, (parentImportCounts.get(parent) ?? 0) + 1);
      }
    }
    const topParentCount = [...parentImportCounts.values()].reduce(
      (m, n) => (n > m ? n : m),
      0,
    );
    if (topParentCount < Math.ceil(MIN_SHARED_PARENT_FRACTION * siblings.length)) {
      continue;
    }

    // (b) Sibling↔sibling edges are a small fraction of each sibling's total
    //     edges. High internal connectivity means it's a cohesive module,
    //     not a dispatch directory.
    let siblingInternalEdgeEnds = 0;
    let siblingTotalEdgeEnds = 0;
    for (const e of fileGraph.edges) {
      if (e.from === e.to) continue;
      const fromIn = siblingSet.has(e.from);
      const toIn = siblingSet.has(e.to);
      if (fromIn) siblingTotalEdgeEnds++;
      if (toIn) siblingTotalEdgeEnds++;
      if (fromIn && toIn) siblingInternalEdgeEnds += 2;
    }
    if (siblingTotalEdgeEnds === 0) continue;
    const internalRatio = siblingInternalEdgeEnds / siblingTotalEdgeEnds;
    if (internalRatio >= MAX_INTERNAL_RATIO) continue;

    out.push({ label: basename(dir) || dir, files: [...siblings].sort() });
  }
  return out;
}

/**
 * Run Louvain on a symbol-level call graph (caller chunks × resolved imports),
 * then project each symbol-community back to a file-community by majority vote.
 * Each file-community becomes a DiscoveryModule.
 */
export function detectSymbolCommunities(
  data: SymbolGraphData,
  fileGraph: FileLevelGraph,
  projectDir: string,
): DiscoveryModule[] {
  const productFiles = new Set(
    fileGraph.nodes.filter(isClusterable).map((n) => n.path),
  );

  // fileGraph uses paths relative to projectDir; DB stores absolute paths.
  // Build id → relative-path so the rest of the function speaks one format.
  const pathById = new Map<number, string>();
  for (const f of data.files) {
    const rel = toRel(f.path, projectDir);
    pathById.set(f.id, rel);
  }

  // Restrict to product files (tests/benches excluded) whose path is also in
  // the file graph.
  const idsInScope = new Set<number>();
  for (const f of data.files) {
    const rel = pathById.get(f.id)!;
    if (productFiles.has(rel)) idsInScope.add(f.id);
  }

  const namedImportsByFile = new Map<number, Map<string, number>>();
  const namespaceImportsByFile = new Map<number, { alias: string; resolvedFileId: number }[]>();
  for (const imp of data.imports) {
    if (!idsInScope.has(imp.fileId) || !idsInScope.has(imp.resolvedFileId)) continue;
    if (imp.isNamespace) {
      let arr = namespaceImportsByFile.get(imp.fileId);
      if (!arr) { arr = []; namespaceImportsByFile.set(imp.fileId, arr); }
      arr.push({ alias: imp.names, resolvedFileId: imp.resolvedFileId });
    } else {
      let m = namedImportsByFile.get(imp.fileId);
      if (!m) { m = new Map(); namedImportsByFile.set(imp.fileId, m); }
      m.set(imp.names, imp.resolvedFileId);
    }
  }

  const exportsByFile = new Map<number, Set<string>>();
  for (const e of data.exports) {
    if (!idsInScope.has(e.fileId)) continue;
    let s = exportsByFile.get(e.fileId);
    if (!s) { s = new Set(); exportsByFile.set(e.fileId, s); }
    s.add(e.name);
  }

  const callerChunks = data.chunks.filter(
    (c) => idsInScope.has(c.fileId) && CALLER_CHUNK_TYPES.has(c.chunkType),
  );

  const symKey = (fileId: number, name: string) => `${fileId}:${name}`;

  // Register caller-chunk nodes and exported-symbol nodes.
  const nodeMeta = new Map<string, { fileId: number; name: string }>();
  for (const c of callerChunks) {
    const k = symKey(c.fileId, c.entityName);
    if (!nodeMeta.has(k)) nodeMeta.set(k, { fileId: c.fileId, name: c.entityName });
  }
  for (const e of data.exports) {
    if (!idsInScope.has(e.fileId)) continue;
    const k = symKey(e.fileId, e.name);
    if (!nodeMeta.has(k)) nodeMeta.set(k, { fileId: e.fileId, name: e.name });
  }

  if (nodeMeta.size < MIN_NODES_FOR_LOUVAIN) return [];

  const g = new Graph({ type: "undirected", multi: false });
  for (const k of nodeMeta.keys()) g.addNode(k);

  for (const c of callerChunks) {
    const srcKey = symKey(c.fileId, c.entityName);
    if (!g.hasNode(srcKey)) continue;

    const named = namedImportsByFile.get(c.fileId);
    const namespaces = namespaceImportsByFile.get(c.fileId);
    if ((!named || named.size === 0) && (!namespaces || namespaces.length === 0)) continue;

    const snippet = c.snippet;
    const seenTargets = new Set<string>();

    if (named && named.size > 0) {
      const tokens = snippet.match(TOKEN_RE) ?? [];
      const seenTok = new Set<string>();
      for (const tok of tokens) {
        if (tok === c.entityName) continue;
        if (seenTok.has(tok)) continue;
        seenTok.add(tok);
        const targetFileId = named.get(tok);
        if (!targetFileId) continue;
        if (targetFileId === c.fileId) continue;
        if (!exportsByFile.get(targetFileId)?.has(tok)) continue;
        const tgtKey = symKey(targetFileId, tok);
        if (!g.hasNode(tgtKey)) continue;
        if (seenTargets.has(tgtKey)) continue;
        seenTargets.add(tgtKey);
        if (g.hasEdge(srcKey, tgtKey)) {
          g.updateEdgeAttribute(srcKey, tgtKey, "weight", (w: number | undefined) => (w ?? 1) + 1);
        } else {
          g.addEdge(srcKey, tgtKey, { weight: 1 });
        }
      }
    }

    if (namespaces && namespaces.length > 0) {
      const aliasToFile = new Map<string, number>();
      for (const ns of namespaces) aliasToFile.set(ns.alias, ns.resolvedFileId);
      const re = new RegExp(MEMBER_RE.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(snippet)) !== null) {
        const alias = m[1];
        const member = m[2];
        const targetFileId = aliasToFile.get(alias);
        if (!targetFileId) continue;
        if (targetFileId === c.fileId) continue;
        if (!exportsByFile.get(targetFileId)?.has(member)) continue;
        const tgtKey = symKey(targetFileId, member);
        if (!g.hasNode(tgtKey)) continue;
        if (seenTargets.has(tgtKey)) continue;
        seenTargets.add(tgtKey);
        if (g.hasEdge(srcKey, tgtKey)) {
          g.updateEdgeAttribute(srcKey, tgtKey, "weight", (w: number | undefined) => (w ?? 1) + 1);
        } else {
          g.addEdge(srcKey, tgtKey, { weight: 1 });
        }
      }
    }
  }

  const isolates: string[] = [];
  g.forEachNode((n) => { if (g.degree(n) === 0) isolates.push(n); });
  for (const n of isolates) g.dropNode(n);

  if (g.order < 3 || g.size === 0) return [];

  const symbolCommunities = runLouvain(g);

  // Project symbol communities back onto files by majority vote.
  const fileVotes = new Map<string, Map<number, number>>();
  for (const [sk, cid] of Object.entries(symbolCommunities)) {
    const meta = nodeMeta.get(sk);
    if (!meta) continue;
    const path = pathById.get(meta.fileId);
    if (!path || !productFiles.has(path)) continue;
    let votes = fileVotes.get(path);
    if (!votes) { votes = new Map(); fileVotes.set(path, votes); }
    votes.set(cid, (votes.get(cid) ?? 0) + 1);
  }

  const fileToCommunity = new Map<string, number>();
  for (const [path, votes] of fileVotes) {
    let bestCid = -1;
    let bestVotes = -1;
    for (const [cid, n] of votes) {
      if (n > bestVotes) { bestVotes = n; bestCid = cid; }
    }
    if (bestCid >= 0) fileToCommunity.set(path, bestCid);
  }

  // Files with no symbols in the graph land in a fallback community keyed by
  // their directory, so the structural layout still captures them.
  const communities = new Map<number, string[]>();
  for (const [file, cid] of fileToCommunity) {
    if (!communities.has(cid)) communities.set(cid, []);
    communities.get(cid)!.push(file);
  }

  const unmappedFiles: string[] = [];
  for (const path of productFiles) {
    if (!fileToCommunity.has(path)) unmappedFiles.push(path);
  }

  return buildModulesFromClusters(communities, fileGraph, unmappedFiles);
}

/**
 * Convert a community → DiscoveryModule. Unmapped files (isolates, symbol-less
 * files) are attached to the community whose directory best matches theirs.
 */
function buildModulesFromClusters(
  communities: Map<number, string[]>,
  fileGraph: FileLevelGraph,
  unmappedFiles: string[],
): DiscoveryModule[] {
  if (communities.size === 0) return [];

  // Attach unmapped files to the community that owns the most files in their
  // directory. If none matches, attach to the largest community.
  for (const orphan of unmappedFiles) {
    const orphanDir = dirname(orphan);
    let bestCid = -1;
    let bestMatch = -1;
    for (const [cid, files] of communities) {
      const match = files.reduce((n, f) => n + (dirname(f) === orphanDir ? 1 : 0), 0);
      if (match > bestMatch) { bestMatch = match; bestCid = cid; }
    }
    if (bestCid < 0) {
      bestCid = [...communities.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
    }
    communities.get(bestCid)!.push(orphan);
  }

  const pathToNode = new Map<string, FileLevelNode>();
  for (const n of fileGraph.nodes) pathToNode.set(n.path, n);

  const modules: DiscoveryModule[] = [];
  for (const [cid, files] of communities) {
    modules.push(buildModuleFromCluster(cid, files, fileGraph, pathToNode));
  }

  // Size-desc with a lex tiebreak on the sorted member list keeps the
  // emitted order stable across runs — downstream caches key on this.
  modules.sort((a, b) => {
    if (b.files.length !== a.files.length) return b.files.length - a.files.length;
    const aKey = [...a.files].sort().join("\n");
    const bKey = [...b.files].sort().join("\n");
    return aKey.localeCompare(bKey);
  });

  return modules;
}

function buildModuleFromCluster(
  cid: number,
  files: string[],
  fileGraph: FileLevelGraph,
  pathToNode: Map<string, FileLevelNode>,
): DiscoveryModule {
  const fileSet = new Set(files);

  // Module path: longest common directory prefix. When that prefix is shallow
  // (depth ≤ 1, e.g. "src"), prefer the directory that holds the plurality of
  // the cluster's files — "src/db" is a more useful anchor than "src".
  let path = commonDirPrefix(files);
  const depth = path === "" ? 0 : path.split("/").length;
  if (depth <= 1) path = pluralityDir(files) || path || ".";

  // Entry file: prefer ENTRY_FILE_PATTERN match on a file inside `path`,
  // else the highest-degree file.
  let entryFile: string | null =
    files.find((f) => dirname(f) === path && ENTRY_FILE_PATTERN.test(basename(f))) ??
    files.find((f) => ENTRY_FILE_PATTERN.test(basename(f))) ??
    null;

  if (!entryFile) {
    let bestDeg = -1;
    for (const f of files) {
      const node = pathToNode.get(f);
      if (!node) continue;
      const deg = node.fanIn + node.fanOut;
      if (deg > bestDeg) { bestDeg = deg; entryFile = f; }
    }
  }

  const exports: string[] = [];
  let fanIn = 0;
  let fanOut = 0;
  for (const f of files) {
    const node = pathToNode.get(f);
    if (!node) continue;
    for (const exp of node.exports) exports.push(exp.name);
    fanIn += node.fanIn;
    fanOut += node.fanOut;
  }

  let internalEdges = 0;
  for (const edge of fileGraph.edges) {
    if (fileSet.has(edge.from) && fileSet.has(edge.to)) {
      internalEdges++;
      fanIn--;
      fanOut--;
    }
  }

  const seedLabel = seedLabelByCid.get(cid);
  return {
    name: seedLabel ?? (basename(path) || `cluster-${cid}`),
    path,
    entryFile,
    files,
    exports,
    fanIn: Math.max(0, fanIn),
    fanOut: Math.max(0, fanOut),
    internalEdges,
    cohesion: cohesionFor(files.length, internalEdges),
  };
}

function toRel(absPath: string, projectDir: string): string {
  const prefix = projectDir.endsWith("/") ? projectDir : projectDir + "/";
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

/** Longest directory prefix shared by every file. "" if nothing in common. */
function commonDirPrefix(files: string[]): string {
  if (files.length === 0) return "";
  if (files.length === 1) return dirname(files[0]);
  const parts = files.map((f) => dirname(f).split("/"));
  const first = parts[0];
  let i = 0;
  for (; i < first.length; i++) {
    const seg = first[i];
    if (!parts.every((p) => p[i] === seg)) break;
  }
  return first.slice(0, i).join("/");
}

/**
 * The directory (up to two segments deep) that holds the most files in the
 * cluster. Used when commonDirPrefix is uninformative — at least the path
 * points at a real place on disk.
 */
function pluralityDir(files: string[]): string {
  if (files.length === 0) return ".";
  const counts = new Map<string, number>();
  for (const f of files) {
    const segs = dirname(f).split("/");
    const key = segs.slice(0, 2).join("/") || segs[0] || ".";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bestKey = ".";
  let bestCount = -1;
  for (const [k, n] of counts) {
    if (n > bestCount) { bestCount = n; bestKey = k; }
  }
  return bestKey;
}
