import { resolve } from "path";
import type { RagDB } from "../db";
import { generateProjectMap } from "../graph/resolver";
import type {
  PageManifest,
  DiscoveryResult,
  ClassifiedInventory,
  ContentCache,
  PageContentCache,
  ClassifiedSymbol,
} from "./types";

const MAX_USAGES = 10;

/** Strip function/class bodies, keeping only the declaration signature. */
function truncateToSignature(snippet: string, symbolType: string, filePath: string): string {
  // Interface/type/enum bodies ARE the signature — keep them
  if (symbolType === "interface" || symbolType === "type" || symbolType === "enum") {
    return snippet;
  }

  // Python: declaration ends at first ":" at end of a line
  if (filePath.endsWith(".py")) {
    const lines = snippet.split("\n");
    const sig: string[] = [];
    for (const line of lines) {
      sig.push(line);
      if (line.trimEnd().endsWith(":")) break;
    }
    return sig.join("\n");
  }

  // Brace-based languages (TS, JS, Go, Rust, Java, C, etc.)
  const lines = snippet.split("\n");
  const sig: string[] = [];
  let braceDepth = 0;

  for (const line of lines) {
    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }

    if (braceDepth <= 0) {
      sig.push(line);
    } else {
      const idx = line.indexOf("{");
      if (idx >= 0) sig.push(line.slice(0, idx).trimEnd());
      break;
    }
  }

  return sig.join("\n").trimEnd() || snippet.split("\n")[0];
}

/**
 * Phase 4 (mechanical): Pre-fetch structural + semantic data for every page.
 * Structural: depends_on, depended_on_by, find_usages, project_map(focus).
 * Semantic: read_relevant for overview + top snippets.
 */
export function prefetchContent(
  db: RagDB,
  manifest: PageManifest,
  discovery: DiscoveryResult,
  classified: ClassifiedInventory,
  projectDir: string,
): ContentCache {
  const cache: ContentCache = {};

  // Build lookup maps
  const symbolsByFile = new Map<string, ClassifiedSymbol[]>();
  for (const s of classified.symbols) {
    if (!symbolsByFile.has(s.file)) symbolsByFile.set(s.file, []);
    symbolsByFile.get(s.file)!.push(s);
  }

  for (const [wikiPath, page] of Object.entries(manifest.pages)) {
    const key: string = page.focus ?? page.kind;
    switch (key) {
      case "module":
        cache[wikiPath] = prefetchModule(db, page.title, page.sourceFiles, classified, symbolsByFile, discovery, projectDir);
        break;
      case "module-file":
        cache[wikiPath] = prefetchModuleFile(db, page.title, page.sourceFiles, classified, symbolsByFile, projectDir);
        break;
      case "architecture":
        cache[wikiPath] = prefetchArchitecture(discovery, classified);
        break;
      case "data-flows":
        cache[wikiPath] = prefetchDataFlows(discovery, classified);
        break;
      case "getting-started":
        cache[wikiPath] = prefetchGettingStarted(discovery, classified);
        break;
      case "testing":
        cache[wikiPath] = prefetchTesting(discovery);
        break;
      default:
        cache[wikiPath] = {};
        break;
    }
  }

  return cache;
}

function prefetchModule(
  db: RagDB,
  moduleName: string,
  sourceFiles: string[],
  classified: ClassifiedInventory,
  symbolsByFile: Map<string, ClassifiedSymbol[]>,
  discovery: DiscoveryResult,
  projectDir: string,
): PageContentCache {
  const entryFile = sourceFiles[0];
  const mod = classified.modules.find((m) => m.name === moduleName);

  // Dependencies and dependents aggregated across all module files
  const moduleFiles = mod?.files ?? (entryFile ? [entryFile] : []);
  const depSet = new Set<string>();
  const depBySet = new Set<string>();
  for (const f of moduleFiles) {
    const fileObj = db.getFileByPath(resolve(projectDir, f));
    if (!fileObj) continue;
    for (const d of db.getDependsOn(fileObj.id)) depSet.add(d.path);
    for (const d of db.getDependedOnBy(fileObj.id)) depBySet.add(d.path);
  }
  // Exclude intra-module files from both lists
  const moduleFileSet = new Set(moduleFiles);
  const dependencies = [...depSet].filter((p) => !moduleFileSet.has(p));
  const dependents = [...depBySet].filter((p) => !moduleFileSet.has(p));

  // Neighborhood
  let neighborhood: object | undefined;
  if (entryFile) {
    try {
      const json = generateProjectMap(db, {
        projectDir,
        focus: entryFile,
        format: "json",
      });
      neighborhood = JSON.parse(json);
    } catch {
      // Ignore
    }
  }

  // All exports from module files
  const allExports: { name: string; type: string; signature: string }[] = [];
  for (const f of moduleFiles) {
    const syms = symbolsByFile.get(f) ?? [];
    for (const s of syms) {
      allExports.push({
        name: s.name,
        type: s.type,
        signature: truncateToSignature(s.snippet ?? `${s.type} ${s.name}`, s.type, s.file),
      });
    }
  }

  const classifiedMod = classified.modules.find((m) => m.name === moduleName);

  return {
    exports: allExports,
    dependencies,
    dependents,
    fanIn: classifiedMod?.fanIn,
    fanOut: classifiedMod?.fanOut,
    files: moduleFiles,
    neighborhood,
  };
}

function prefetchModuleFile(
  db: RagDB,
  title: string,
  sourceFiles: string[],
  classified: ClassifiedInventory,
  symbolsByFile: Map<string, ClassifiedSymbol[]>,
  projectDir: string,
): PageContentCache {
  const file = sourceFiles[0];
  const fileSymbols = symbolsByFile.get(file) ?? [];
  const primaryExport = fileSymbols[0];

  // Dependencies
  const fileObj = db.getFileByPath(resolve(projectDir, file));
  let dependencies: string[] = [];
  let dependents: string[] = [];
  if (fileObj) {
    dependencies = db.getDependsOn(fileObj.id).map((d) => d.path);
    dependents = db.getDependedOnBy(fileObj.id).map((d) => d.path);
  }

  // Usages of primary export
  let usageSites: { path: string; line: number }[] = [];
  if (primaryExport) {
    const usages = db.findUsages(primaryExport.name, true, MAX_USAGES);
    usageSites = usages.map((u) => ({ path: u.path, line: u.line ?? 0 }));
  }

  // Neighborhood
  let neighborhood: object | undefined;
  try {
    const json = generateProjectMap(db, {
      projectDir,
      focus: file,
      format: "json",
    });
    neighborhood = JSON.parse(json);
  } catch {
    // Ignore — neighborhood is optional
  }

  // Exports with signatures
  const exports = fileSymbols.map((s) => ({
    name: s.name,
    type: s.type,
    signature: truncateToSignature(s.snippet ?? `${s.type} ${s.name}`, s.type, s.file),
  }));

  const fileNode = classified.files.find((f) => f.path === file);

  return {
    exports,
    dependencies,
    dependents,
    usageSites,
    fanIn: fileNode?.fanIn,
    fanOut: fileNode?.fanOut,
    neighborhood,
    overview: primaryExport ? truncateToSignature(primaryExport.snippet ?? `${primaryExport.type} ${primaryExport.name}`, primaryExport.type, primaryExport.file) : undefined,
  };
}

function prefetchArchitecture(discovery: DiscoveryResult, classified: ClassifiedInventory): PageContentCache {
  const modules = classified.modules
    .filter((m) => m.qualifiesAsModulePage)
    .sort((a, b) => b.value - a.value)
    .map((m) => ({ name: m.name, fileCount: m.fileCount, exportCount: m.exportCount, fanIn: m.fanIn, fanOut: m.fanOut, entryFile: m.entryFile }));

  const hubs = classified.files
    .filter((f) => f.isHub)
    .map((f) => ({ path: f.path, fanIn: f.fanIn, fanOut: f.fanOut, bridges: f.bridges }));

  const entryPoints = discovery.graphData.fileLevel.nodes
    .filter((n) => n.isEntryPoint)
    .map((n) => ({ path: n.path, exports: n.exports }));

  const crossCuttingSymbols = classified.symbols
    .filter((s) => s.scope === "cross-cutting")
    .sort((a, b) => b.referenceModuleCount - a.referenceModuleCount)
    .slice(0, 20)
    .map((s) => ({ name: s.name, type: s.type, file: s.file, referenceModuleCount: s.referenceModuleCount, referenceModules: s.referenceModules }));

  return {
    neighborhood: discovery.graphData.directoryLevel as unknown as object,
    modules,
    hubs,
    entryPoints,
    crossCuttingSymbols,
  };
}

function prefetchDataFlows(discovery: DiscoveryResult, classified: ClassifiedInventory): PageContentCache {
  const entryPointPaths = discovery.graphData.fileLevel.nodes
    .filter((n) => n.isEntryPoint)
    .map((n) => n.path);

  const entryPoints = discovery.graphData.fileLevel.nodes
    .filter((n) => n.isEntryPoint)
    .map((n) => ({ path: n.path, exports: n.exports }));

  const hubs = classified.files
    .filter((f) => f.isHub)
    .map((f) => ({ path: f.path, fanIn: f.fanIn, fanOut: f.fanOut, bridges: f.bridges }));

  return {
    files: entryPointPaths,
    neighborhood: discovery.graphData.fileLevel as unknown as object,
    entryPoints,
    hubs,
  };
}

function prefetchGettingStarted(discovery: DiscoveryResult, classified: ClassifiedInventory): PageContentCache {
  const modules = classified.modules
    .filter((m) => m.qualifiesAsModulePage)
    .sort((a, b) => b.value - a.value)
    .map((m) => ({ name: m.name, fileCount: m.fileCount, exportCount: m.exportCount, fanIn: m.fanIn, fanOut: m.fanOut, entryFile: m.entryFile }));

  const entryPoints = discovery.graphData.fileLevel.nodes
    .filter((n) => n.isEntryPoint)
    .map((n) => ({ path: n.path, exports: n.exports }));

  return {
    modules,
    entryPoints,
  };
}

function prefetchTesting(discovery: DiscoveryResult): PageContentCache {
  const testFiles = discovery.graphData.fileLevel.nodes
    .filter((n) => /\.(test|spec)\.(ts|js|tsx|jsx|py|rs)$/.test(n.path) || n.path.includes("/test/") || n.path.includes("/tests/"))
    .map((n) => n.path)
    .sort();

  return { testFiles };
}
