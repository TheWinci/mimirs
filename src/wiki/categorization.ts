import { relative } from "path";
import Graph from "graphology";
import type { RagDB } from "../db";
import type { SymbolResult } from "../db/types";
import type {
  DiscoveryResult,
  ClassifiedSymbol,
  ClassifiedFile,
  ClassifiedInventory,
  SymbolTier,
  Scope,
} from "./types";
import { computePageRank } from "./pagerank";

const TYPE_PRIORITY: Record<string, number> = {
  class: 0,
  interface: 1,
  enum: 2,
  type: 3,
  function: 4,
  variable: 5,
  constant: 6,
};
/**
 * Types we pull from `file_exports`. Matches the set bun-chunk emits:
 * `class|interface|type|enum|function|variable` (`constant` is included
 * defensively for parsers that emit it separately). `export` was in the
 * original list but never appears in the DB — bun-chunk emits the concrete
 * kind — so including it meant zero rows returned and every community
 * shipped `tunables: []`.
 */
const SYMBOL_TYPES = [
  "class",
  "interface",
  "type",
  "enum",
  "function",
  "variable",
  "constant",
] as const;

/**
 * Phase 2: Classify every symbol and file.
 *
 * Files get a global PageRank score; the top slice of that ranking replaces
 * the old `isHub` threshold (`fanIn >= 5` or `fanIn >= 2 && fanOut >= 2`),
 * which used magic numbers that don't scale with project size.
 *
 * Module classification is gone — in the new pipeline, communities are the
 * unit of work and they're named by the LLM in step 4.
 */
export function runCategorization(
  db: RagDB,
  discovery: DiscoveryResult,
  projectDir: string,
): ClassifiedInventory {
  const warnings: string[] = [];

  const topK = Math.max(200, discovery.fileCount * 2);
  const allSymbols: SymbolResult[] = [];
  for (const type of SYMBOL_TYPES) {
    const results = db.searchSymbols(undefined, false, type, topK);
    allSymbols.push(...results);
  }

  const deduped = deduplicateSymbols(allSymbols);
  if (deduped.length === 0) {
    warnings.push("No exported symbols found — classification will be empty");
  }

  const classifiedSymbols = deduped.map((s) => classifySymbol(s, projectDir));
  const classifiedFiles = classifyFiles(discovery, classifiedSymbols);

  return {
    symbols: classifiedSymbols,
    files: classifiedFiles,
    warnings,
  };
}

function deduplicateSymbols(symbols: SymbolResult[]): SymbolResult[] {
  const map = new Map<string, SymbolResult>();
  for (const s of symbols) {
    const key = `${s.symbolName}\0${s.path}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, s);
      continue;
    }
    const existingPriority = TYPE_PRIORITY[existing.symbolType] ?? 99;
    const newPriority = TYPE_PRIORITY[s.symbolType] ?? 99;
    if (newPriority < existingPriority) map.set(key, s);
  }
  return [...map.values()];
}

function classifySymbol(s: SymbolResult, projectDir: string): ClassifiedSymbol {
  const tier: SymbolTier = s.hasChildren ? "bridge" : "entity";
  const scope: Scope =
    s.referenceModuleCount >= 3 ? "cross-cutting" :
    s.referenceModuleCount === 2 ? "shared" :
    "local";

  return {
    name: s.symbolName,
    type: s.symbolType,
    file: relative(projectDir, s.path) || s.path,
    tier,
    scope,
    referenceCount: s.referenceCount,
    referenceModuleCount: s.referenceModuleCount,
    referenceModules: s.referenceModules,
    hasChildren: s.hasChildren,
    childCount: s.childCount,
    isReexport: s.isReexport,
    snippet: s.snippet,
  };
}

function classifyFiles(
  discovery: DiscoveryResult,
  symbols: ClassifiedSymbol[],
): ClassifiedFile[] {
  const symbolsByFile = new Map<string, ClassifiedSymbol[]>();
  for (const s of symbols) {
    if (!symbolsByFile.has(s.file)) symbolsByFile.set(s.file, []);
    symbolsByFile.get(s.file)!.push(s);
  }

  const pageRank = computeGlobalPageRank(discovery);
  const topK = Math.max(5, Math.ceil(discovery.graphData.fileLevel.nodes.length * 0.05));
  const rankedPaths = [...pageRank.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([path]) => path);
  const topHubs = new Set(rankedPaths);

  return discovery.graphData.fileLevel.nodes.map((node) => {
    const fileSymbols = symbolsByFile.get(node.path) ?? [];
    const bridges = fileSymbols.filter((s) => s.tier === "bridge").map((s) => s.name);
    const entities = fileSymbols.filter((s) => s.tier === "entity").map((s) => s.name);

    return {
      path: node.path,
      fanIn: node.fanIn,
      fanOut: node.fanOut,
      pageRank: pageRank.get(node.path) ?? 0,
      isTopHub: topHubs.has(node.path),
      bridges,
      entities,
    };
  });
}

/**
 * Global PageRank over the file-level import graph. Used to replace the
 * threshold-based `isHub` flag — top-K by PageRank are the load-bearing
 * files regardless of project size.
 */
function computeGlobalPageRank(discovery: DiscoveryResult): Map<string, number> {
  const graph = new Graph({ type: "undirected", multi: false });

  const sortedNodes = [...discovery.graphData.fileLevel.nodes]
    .map((n) => n.path)
    .sort();
  for (const path of sortedNodes) graph.addNode(path);

  const sortedEdges = [...discovery.graphData.fileLevel.edges].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)
  );
  for (const edge of sortedEdges) {
    if (edge.from === edge.to) continue;
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    if (graph.hasEdge(edge.from, edge.to)) {
      graph.updateEdgeAttribute(edge.from, edge.to, "weight", (w: number | undefined) => (w ?? 1) + 1);
    } else {
      graph.addEdge(edge.from, edge.to, { weight: 1 });
    }
  }

  if (graph.order === 0) return new Map();
  return computePageRank(graph);
}
