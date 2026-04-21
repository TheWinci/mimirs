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
 */
function isTestOrBench(path: string): boolean {
  if (path.includes("/tests/") || path.includes("/test/")) return true;
  if (path.includes("/benchmarks/") || path.includes("/bench/")) return true;
  if (/\.(test|spec|bench)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(path)) return true;
  return false;
}

/**
 * Below these thresholds, Louvain's output is degenerate (one giant community
 * or one-per-file). Callers should fall back to the directory heuristic in
 * that regime — small projects don't need graph clustering to find structure.
 */
const MIN_NODES_FOR_LOUVAIN = 10;
const MIN_EDGES_FOR_LOUVAIN = 5;

/**
 * Run Louvain on the file-level import graph. Each community becomes a
 * DiscoveryModule. Returns an empty array if the graph is too sparse — the
 * caller should fall back to directory-based detection in that case.
 */
export function detectFileCommunities(
  fileGraph: FileLevelGraph,
): DiscoveryModule[] {
  const productFiles = new Set(
    fileGraph.nodes.filter((n) => !isTestOrBench(n.path)).map((n) => n.path),
  );

  if (
    productFiles.size < MIN_NODES_FOR_LOUVAIN ||
    fileGraph.edges.length < MIN_EDGES_FOR_LOUVAIN
  ) {
    return [];
  }

  const g = new Graph({ type: "undirected", multi: false });
  for (const path of productFiles) g.addNode(path);
  for (const edge of fileGraph.edges) {
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

  const result = louvain(g, { getEdgeWeight: "weight", resolution: 1.0 });

  const communities = new Map<number, string[]>();
  for (const [file, cid] of Object.entries(result)) {
    if (!communities.has(cid)) communities.set(cid, []);
    communities.get(cid)!.push(file);
  }

  // Files Louvain dropped (isolates) — attach to the nearest-by-path community.
  const isolateFiles = isolates;

  return buildModulesFromClusters(communities, fileGraph, isolateFiles);
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
    fileGraph.nodes.filter((n) => !isTestOrBench(n.path)).map((n) => n.path),
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

  const symbolCommunities = louvain(g, { getEdgeWeight: "weight", resolution: 1.0 });

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

  return {
    name: basename(path) || `cluster-${cid}`,
    path,
    entryFile,
    files,
    exports,
    fanIn: Math.max(0, fanIn),
    fanOut: Math.max(0, fanOut),
    internalEdges,
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
