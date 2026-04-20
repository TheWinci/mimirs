import { dirname, relative } from "path";
import type { RagDB } from "../db";
import type { SymbolResult } from "../db/types";
import type {
  DiscoveryResult,
  DiscoveryModule,
  ClassifiedSymbol,
  ClassifiedFile,
  ClassifiedModule,
  ClassifiedInventory,
  SymbolTier,
  Scope,
  HubPath,
} from "./types";

// Priority for deduplication: more specific types win
/** Minimum value score for a module to qualify for its own wiki page. */
const MIN_MODULE_VALUE = 8;

const TYPE_PRIORITY: Record<string, number> = {
  class: 0,
  interface: 1,
  enum: 2,
  type: 3,
  function: 4,
  export: 5,
};
const SYMBOL_TYPES = ["class", "interface", "type", "enum", "function", "export"] as const;

/**
 * Phase 2: Classify every symbol and file into tiers.
 * Uses hasChildren for entity/bridge, fanIn/fanOut for hubs, and
 * referenceModuleCount for scope. All data comes from searchSymbols
 * enrichment + discovery graph data — no additional tool calls needed.
 */
export function runCategorization(
  db: RagDB,
  discovery: DiscoveryResult,
  projectDir: string,
): ClassifiedInventory {
  const warnings: string[] = [];

  // Step 2.1: Get all exported symbols
  const topK = Math.max(200, discovery.fileCount * 2);
  const allSymbols: SymbolResult[] = [];
  for (const type of SYMBOL_TYPES) {
    const results = db.searchSymbols(undefined, false, type, topK);
    allSymbols.push(...results);
  }

  // Deduplicate by (symbolName, path) — keep the most specific type
  const deduped = deduplicateSymbols(allSymbols);
  if (deduped.length === 0) {
    warnings.push("No exported symbols found — classification will be empty");
  }

  // Step 2.2: Classify symbols as entity or bridge
  const classifiedSymbols = deduped.map((s) => classifySymbol(s, projectDir));

  // Step 2.3: Classify files as hub or not
  const classifiedFiles = classifyFiles(
    discovery,
    classifiedSymbols,
    projectDir,
  );

  // Step 2.4: Classify modules (flatten nested children first)
  const allModules = flattenModules(discovery.modules);
  const classifiedModules = classifyModules(
    allModules,
    discovery,
    classifiedFiles,
    classifiedSymbols,
    projectDir,
    warnings,
  );

  return {
    symbols: classifiedSymbols,
    files: classifiedFiles,
    modules: classifiedModules,
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
    } else {
      // Keep the more specific type
      const existingPriority = TYPE_PRIORITY[existing.symbolType] ?? 99;
      const newPriority = TYPE_PRIORITY[s.symbolType] ?? 99;
      if (newPriority < existingPriority) {
        map.set(key, s);
      }
    }
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
  projectDir: string,
): ClassifiedFile[] {
  // Group symbols by file
  const symbolsByFile = new Map<string, ClassifiedSymbol[]>();
  for (const s of symbols) {
    if (!symbolsByFile.has(s.file)) symbolsByFile.set(s.file, []);
    symbolsByFile.get(s.file)!.push(s);
  }

  return discovery.graphData.fileLevel.nodes.map((node) => {
    const relPath = node.path;
    const fileSymbols = symbolsByFile.get(relPath) ?? [];
    const bridges = fileSymbols.filter((s) => s.tier === "bridge").map((s) => s.name);
    const entities = fileSymbols.filter((s) => s.tier === "entity").map((s) => s.name);

    // Hub Path A: crossroads (fanIn >= 2 AND fanOut >= 2 AND has bridge)
    const pathA = node.fanIn >= 2 && node.fanOut >= 2 && bridges.length >= 1;
    // Hub Path B: foundational (fanIn >= 5)
    const pathB = node.fanIn >= 5;
    const isHub = pathA || pathB;

    let hubPath: HubPath | undefined;
    if (isHub) {
      hubPath = pathA ? "A" : "B";
    }

    return {
      path: relPath,
      fanIn: node.fanIn,
      fanOut: node.fanOut,
      isHub,
      hubPath,
      bridges,
      entities,
    };
  });
}

/** Recursively flatten nested modules into a single array. */
function flattenModules(modules: DiscoveryModule[]): DiscoveryModule[] {
  const result: DiscoveryModule[] = [];
  for (const mod of modules) {
    result.push(mod);
    if (mod.children) {
      result.push(...flattenModules(mod.children));
    }
  }
  return result;
}

function classifyModules(
  allModules: DiscoveryModule[],
  discovery: DiscoveryResult,
  files: ClassifiedFile[],
  symbols: ClassifiedSymbol[],
  projectDir: string,
  warnings: string[],
): ClassifiedModule[] {
  const hubFiles = new Set(files.filter((f) => f.isHub).map((f) => f.path));
  const bridgesByFile = new Map<string, string[]>();
  for (const f of files) {
    if (f.bridges.length > 0) bridgesByFile.set(f.path, f.bridges);
  }

  return allModules.map((mod) => {
    const moduleFiles = mod.files;
    const moduleFileSet = new Set(moduleFiles);

    // Count hubs in this module
    const hubs = moduleFiles.filter((f) => hubFiles.has(f));

    // Count bridges in this module
    const bridges: string[] = [];
    for (const f of moduleFiles) {
      const fileBridges = bridgesByFile.get(f);
      if (fileBridges) bridges.push(...fileBridges);
    }

    // Value score: how important is this module for documentation?
    const value = mod.fanIn * 2 + mod.exports.length + moduleFiles.length;
    const byValue = value >= MIN_MODULE_VALUE;

    // Structural overrides (only with fileCount >= 2 to avoid single-file "modules")
    // Use Set.has instead of Array.some to keep this O(symbols) per module
    // instead of O(symbols * files) — matters on large projects.
    let crossCuttingCount = 0;
    let entityCount = 0;
    for (const s of symbols) {
      if (!moduleFileSet.has(s.file)) continue;
      if (s.scope === "cross-cutting") crossCuttingCount++;
      if (s.tier === "entity") entityCount++;
    }
    const byCrossCutting = moduleFiles.length >= 2 && crossCuttingCount >= 1;
    const byEntryFanIn = moduleFiles.length >= 2 && mod.entryFile !== null && mod.fanIn >= 3;

    const qualifies = byValue || byCrossCutting || byEntryFanIn;

    let reason: string;
    if (byValue) {
      reason = `value ${value} (fanIn=${mod.fanIn}, exports=${mod.exports.length}, files=${moduleFiles.length})`;
    } else if (byCrossCutting) {
      reason = `structural: hosts ${crossCuttingCount} cross-cutting symbol(s)`;
    } else if (byEntryFanIn) {
      reason = `structural: entry file with fanIn=${mod.fanIn}`;
    } else {
      reason = `value ${value} < ${MIN_MODULE_VALUE}, no structural override`;
    }

    return {
      name: mod.name,
      path: mod.path,
      entryFile: mod.entryFile,
      files: moduleFiles,
      qualifiesAsModulePage: qualifies,
      reason,
      hubs,
      bridges,
      entityCount,
      fileCount: moduleFiles.length,
      exportCount: mod.exports.length,
      fanIn: mod.fanIn,
      fanOut: mod.fanOut,
      value,
    };
  });
}
