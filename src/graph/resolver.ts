import { dirname, resolve, relative, basename, extname } from "path";
import { existsSync, readFileSync } from "fs";
import { resolveImport as bcResolveImport, loadTsConfig, EXTENSION_MAP } from "@winci/bun-chunk";
import type { Language } from "@winci/bun-chunk";
import { RagDB } from "../db";

// Extensions to try when resolving relative imports (DB-based fallback)
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const INDEX_FILES = RESOLVE_EXTENSIONS.map((ext) => `/index${ext}`);

/**
 * Detect language from file extension using bun-chunk's EXTENSION_MAP.
 */
function detectLanguage(filePath: string): Language | null {
  const ext = extname(filePath).toLowerCase();
  return ((EXTENSION_MAP as Record<string, string>)[ext] as Language) ?? null;
}

/**
 * Resolve all unresolved imports in the database by matching import specifiers
 * to indexed file paths. Uses a two-pass approach:
 *   1. bun-chunk's filesystem resolver (handles tsconfig paths, Python, Rust)
 *   2. DB-based resolution as fallback
 */
export function resolveImports(db: RagDB, projectDir: string): number {
  const unresolved = db.getUnresolvedImports();
  const pathToId = buildPathToIdMap(db);
  const tsConfig = loadTsConfig(projectDir);

  const goModule = readGoModule(projectDir);
  const basenameIndex = buildBasenameIndex(pathToId);
  let resolvedCount = 0;

  for (const imp of unresolved) {
    const lang = detectLanguage(imp.filePath);
    const target = resolveSpecifier(imp.source, lang, imp.filePath, projectDir, pathToId, tsConfig, goModule, basenameIndex);
    if (target !== null) {
      db.resolveImport(imp.id, target);
      resolvedCount++;
    }
  }

  return resolvedCount;
}

// Per-pathToId basename index: a watcher batch passes the SAME prebuilt map to
// many resolveImportsForFile calls, but the O(all files) basename index was
// rebuilt for every importer anyway — defeating the prebuilt-maps optimization.
const basenameIndexCache = new WeakMap<Map<string, number>, Map<string, string[]>>();
// tsconfig/go.mod re-read per call is wasted IO in the same batch; cache with a
// short TTL so an edited tsconfig is still picked up promptly.
const projectMetaCache = new Map<string, { at: number; tsConfig: ReturnType<typeof loadTsConfig>; goModule: ReturnType<typeof readGoModule> }>();
const PROJECT_META_TTL_MS = 10_000;

function getProjectMeta(projectDir: string) {
  const cached = projectMetaCache.get(projectDir);
  if (cached && Date.now() - cached.at < PROJECT_META_TTL_MS) return cached;
  const fresh = { at: Date.now(), tsConfig: loadTsConfig(projectDir), goModule: readGoModule(projectDir) };
  projectMetaCache.set(projectDir, fresh);
  return fresh;
}

/**
 * Resolve imports for a single file (used by watcher after re-indexing).
 * Accepts optional prebuilt maps to avoid repeated full-table scans
 * when resolving multiple files in sequence.
 */
export function resolveImportsForFile(
  db: RagDB,
  fileId: number,
  projectDir: string,
  pathToId?: Map<string, number>,
  idToPath?: Map<number, string>
): void {
  if (!pathToId) {
    pathToId = buildPathToIdMap(db);
  }
  if (!idToPath) {
    idToPath = buildIdToPathMap(pathToId);
  }

  const imports = db.getImportsForFile(fileId);
  const filePath = idToPath.get(fileId);
  if (!filePath) return;

  const lang = detectLanguage(filePath);
  const { tsConfig, goModule } = getProjectMeta(projectDir);
  let basenameIndex = basenameIndexCache.get(pathToId);
  if (!basenameIndex) {
    basenameIndex = buildBasenameIndex(pathToId);
    basenameIndexCache.set(pathToId, basenameIndex);
  }

  for (const imp of imports) {
    if (imp.resolvedFileId !== null) continue;
    const target = resolveSpecifier(imp.source, lang, filePath, projectDir, pathToId, tsConfig, goModule, basenameIndex);
    if (target !== null) db.resolveImport(imp.id, target);
  }
}

/** Build path → fileId and fileId → path lookups from all indexed files. */
export function buildPathToIdMap(db: RagDB): Map<string, number> {
  const allFiles = db.getAllFilePaths();
  const map = new Map<string, number>();
  for (const f of allFiles) {
    map.set(f.path, f.id);
  }
  return map;
}

export function buildIdToPathMap(pathToId: Map<string, number>): Map<number, string> {
  const map = new Map<number, string>();
  for (const [path, id] of pathToId) {
    map.set(id, path);
  }
  return map;
}

function tryResolvePath(basePath: string, pathToId: Map<string, number>): number | null {
  // Exact match
  if (pathToId.has(basePath)) return pathToId.get(basePath)!;

  // Try adding extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = basePath + ext;
    if (pathToId.has(withExt)) return pathToId.get(withExt)!;
  }

  // Try index files (e.g. ./utils → ./utils/index.ts)
  for (const idx of INDEX_FILES) {
    const withIndex = basePath + idx;
    if (pathToId.has(withIndex)) return pathToId.get(withIndex)!;
  }

  return null;
}

/**
 * Resolve an ABSOLUTE dotted intra-project module import (e.g. Python's
 * `pylint.config.argument` or `matplotlib.cbook`) to an indexed file. The dotted
 * path maps onto directories under the project root; probe `<root>/a/b/c.py` and
 * the package form `<root>/a/b/c/__init__.py`. External modules (`os`, `numpy`)
 * map to paths that aren't indexed, so they simply return null — no false edges.
 *
 * This is the fix for graph completeness on projects that use absolute imports
 * exclusively (pylint, matplotlib): without it, only relative `.`-imports built
 * edges, leaving those repos' dependency graphs empty.
 */
// Languages whose intra-project imports are ABSOLUTE dotted module paths that map
// onto the directory tree (`a.b.C` → `a/b/C.<ext>`). bun-chunk's Pass-1 resolver
// only handles relative imports (`./`, `.`-prefixed, rust `crate::`), so these
// absolute forms otherwise never become graph edges. Each entry lists the source
// extensions, the package-init filename (Python only), and the package roots to
// probe (flat layout + common src layouts). Adding a language is one entry here.
//
// Not covered (different import models, separate gaps): Go (package=directory),
// C/C++ (`#include "x.h"` is file-relative), Rust (`crate::`/`super::` already
// handled by bun-chunk Pass 1).
const DOTTED_IMPORT_LANGS: Record<string, { exts: string[]; pkgInit?: string; roots: string[] }> = {
  python: { exts: [".py"], pkgInit: "__init__.py", roots: ["", "src", "lib"] },
  java:   { exts: [".java"],  roots: ["", "src", "src/main/java"] },
  kotlin: { exts: [".kt"],    roots: ["", "src", "src/main/kotlin"] },
  scala:  { exts: [".scala"], roots: ["", "src", "src/main/scala"] },
};

/**
 * Resolve an ABSOLUTE dotted intra-project module import (Python `pylint.config.x`,
 * Java `com.foo.Bar`, …) to an indexed file. Maps the dotted path onto the dir
 * tree and probes each package root with the language's extensions (and package
 * init). External modules (`os`, `java.util.List`) map to unindexed paths and
 * return null — no false edges.
 */
function tryResolveDotted(
  source: string,
  lang: string | null,
  projectDir: string,
  filePath: string,
  pathToId: Map<string, number>,
  basenameIndex: Map<string, string[]>,
): number | null {
  const cfg = lang ? DOTTED_IMPORT_LANGS[lang] : undefined;
  if (!cfg) return null;
  const relPath = source.replace(/\./g, "/");
  // Fast path: probe the configured package roots (flat + src layouts).
  for (const root of cfg.roots) {
    const base = resolve(projectDir, root, relPath);
    for (const ext of cfg.exts) {
      if (pathToId.has(base + ext)) return pathToId.get(base + ext)!;
    }
    if (cfg.pkgInit && pathToId.has(base + "/" + cfg.pkgInit)) {
      return pathToId.get(base + "/" + cfg.pkgInit)!;
    }
  }
  // Generic fallback: suffix-match the dotted path against the indexed tree, so
  // unconventional layouts (monorepos, `packages/foo/...`) resolve too.
  for (const ext of cfg.exts) {
    const hit = resolveBySuffix(relPath + ext, filePath, pathToId, basenameIndex);
    if (hit !== null) return hit;
  }
  if (cfg.pkgInit) {
    const hit = resolveBySuffix(relPath + "/" + cfg.pkgInit, filePath, pathToId, basenameIndex);
    if (hit !== null) return hit;
  }
  return null;
}

/** Count leading path segments two directories share (proximity metric). */
function sharedDirDepth(a: string, b: string): number {
  const as = a.split("/"), bs = b.split("/");
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
  return i;
}

/** basename → indexed paths, built once so suffix matching is O(matches). */
function buildBasenameIndex(pathToId: Map<string, number>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of pathToId.keys()) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    const arr = m.get(base);
    if (arr) arr.push(p); else m.set(base, [p]);
  }
  return m;
}

/**
 * Resolve `relPath` (e.g. `inc/helper.h`) by matching it against the actual
 * indexed tree by path SUFFIX — no guessing of include/src roots, so it works for
 * any project layout. Unique suffix match wins; on a basename collision the
 * candidate sharing the longest directory prefix with the importer wins; a true
 * tie resolves to nothing (never a false edge).
 */
function resolveBySuffix(
  relPath: string,
  filePath: string,
  pathToId: Map<string, number>,
  basenameIndex: Map<string, string[]>,
): number | null {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const needle = "/" + relPath;
  const cands = (basenameIndex.get(base) ?? []).filter((p) => p.endsWith(needle));
  if (cands.length === 0) return null;
  if (cands.length === 1) return pathToId.get(cands[0])!;
  const fileDir = dirname(filePath);
  let best: string | null = null, bestDepth = -1, tie = false;
  for (const p of cands) {
    const d = sharedDirDepth(fileDir, dirname(p));
    if (d > bestDepth) { best = p; bestDepth = d; tie = false; }
    else if (d === bestDepth) tie = true;
  }
  return best && !tie ? pathToId.get(best)! : null;
}

/**
 * C/C++ quoted includes (`#include "util.h"`, `#include "inc/helper.h"`): resolve
 * relative to the including file's directory first (authoritative), then by
 * matching the include against the indexed tree (handles arbitrary `-I` layouts).
 * Angle includes (<stdio.h>) are system headers — not indexed, so they return null.
 */
function tryResolveInclude(
  source: string,
  filePath: string,
  pathToId: Map<string, number>,
  basenameIndex: Map<string, string[]>,
): number | null {
  const local = resolve(dirname(filePath), source);
  if (pathToId.has(local)) return pathToId.get(local)!;
  return resolveBySuffix(source, filePath, pathToId, basenameIndex);
}

/** Read the module path from go.mod (`module example.com/proj`), or null. */
function readGoModule(projectDir: string): string | null {
  const p = resolve(projectDir, "go.mod");
  if (!existsSync(p)) return null;
  try {
    const m = readFileSync(p, "utf8").match(/^\s*module\s+(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Go imports are full module paths (`example.com/proj/internal/foo`). Strip the
// go.mod module prefix to get the package directory, then link to a representative
// `.go` file in it. A Go package is a directory of files; the file-level graph
// links one (the lexically-first non-test source) so the edge exists — full
// package fan-out is a separate enhancement.
function tryResolveGoPackage(
  source: string,
  projectDir: string,
  pathToId: Map<string, number>,
  goModule: string | null,
): number | null {
  if (!goModule || (source !== goModule && !source.startsWith(goModule + "/"))) return null;
  const sub = source === goModule ? "" : source.slice(goModule.length + 1);
  const pkgPrefix = resolve(projectDir, sub) + "/";
  let bestPath: string | null = null;
  let bestId = -1;
  for (const [p, id] of pathToId) {
    if (!p.startsWith(pkgPrefix)) continue;
    const rest = p.slice(pkgPrefix.length);
    if (rest.includes("/")) continue;                       // nested → different package
    if (!rest.endsWith(".go") || rest.endsWith("_test.go")) continue;
    if (bestPath === null || p < bestPath) { bestPath = p; bestId = id; }
  }
  return bestPath === null ? null : bestId;
}

/**
 * Resolve one import specifier to an indexed file id, trying each strategy in
 * order: bun-chunk filesystem resolution (relative ts/js/python/rust), explicit
 * relative DB probing, then per-language intra-project strategies for non-relative
 * specifiers (dotted modules, C includes, Go packages). Returns null for bare
 * external specifiers (`react`, `fmt`, `<stdio.h>`) — they map to no indexed file.
 */
function resolveSpecifier(
  source: string,
  lang: Language | null,
  filePath: string,
  projectDir: string,
  pathToId: Map<string, number>,
  tsConfig: ReturnType<typeof loadTsConfig>,
  goModule: string | null,
  basenameIndex: Map<string, string[]>,
): number | null {
  // Pass 1: bun-chunk filesystem resolution.
  const p1 = bcResolveImport(source, filePath, projectDir, lang, tsConfig);
  if (p1 && pathToId.has(p1)) return pathToId.get(p1)!;

  // Pass 2: explicit relative ("./x", "/abs", python ".x") against importer dir.
  if (source.startsWith(".") || source.startsWith("/")) {
    return tryResolvePath(resolve(dirname(filePath), source), pathToId);
  }

  // Pass 2 language strategies for non-relative intra-project specifiers.
  if (lang && DOTTED_IMPORT_LANGS[lang]) return tryResolveDotted(source, lang, projectDir, filePath, pathToId, basenameIndex);
  if (lang === "c" || lang === "cpp") return tryResolveInclude(source, filePath, pathToId, basenameIndex);
  if (lang === "go") return tryResolveGoPackage(source, projectDir, pathToId, goModule);
  return null;
}

export interface GraphOptions {
  zoom?: "file" | "directory";
  focus?: string;
  maxHops?: number;
  showExternals?: boolean;
  format?: "text" | "json";
  projectDir: string;
}

interface GraphNode {
  id: number;
  path: string;
  exports: { name: string; type: string }[];
}

interface GraphEdge {
  fromId: number;
  fromPath: string;
  toId: number;
  toPath: string;
  source: string;
}

/**
 * Generate a structured text dependency map optimized for AI agent consumption.
 * Replaces the old Mermaid format with a more parseable, information-dense output.
 * When format is "json", returns structured data instead of prose.
 */
export function generateProjectMap(
  db: RagDB,
  options: GraphOptions
): string {
  const {
    zoom = "file",
    focus,
    maxHops = 2,
    format = "text",
    projectDir,
  } = options;

  let graph: { nodes: GraphNode[]; edges: GraphEdge[] };

  if (focus) {
    const file = db.getFileByPath(resolve(projectDir, focus));
    if (file) {
      graph = db.getSubgraph([file.id], maxHops);
    } else {
      graph = { nodes: [], edges: [] };
    }
  } else {
    graph = db.getGraph();
  }

  if (graph.nodes.length === 0) {
    if (format === "json") {
      return JSON.stringify({ level: zoom, nodes: [], edges: [], directories: [] });
    }
    return "No files indexed or no dependencies found.";
  }

  if (format === "json") {
    if (zoom === "directory") {
      return generateDirectoryMapJson(graph, projectDir);
    }
    return generateFileMapJson(graph, projectDir);
  }

  if (zoom === "directory") {
    return generateDirectoryMap(graph, projectDir);
  }

  return generateFileMap(graph, projectDir);
}


function generateFileMap(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  projectDir: string
): string {
  // Build adjacency maps
  const dependsOn = new Map<number, string[]>();
  const dependedOnBy = new Map<number, string[]>();
  const idToRel = new Map<number, string>();

  for (const node of graph.nodes) {
    const relPath = relative(projectDir, node.path);
    idToRel.set(node.id, relPath);
    dependsOn.set(node.id, []);
    dependedOnBy.set(node.id, []);
  }

  for (const edge of graph.edges) {
    const fromRel = idToRel.get(edge.fromId);
    const toRel = idToRel.get(edge.toId);
    if (fromRel && toRel) {
      dependsOn.get(edge.fromId)!.push(toRel);
      dependedOnBy.get(edge.toId)!.push(fromRel);
    }
  }

  // Identify files with no indexed importers. This is structural fan-in,
  // not necessarily an external application entry point.
  const noImporterNodes: GraphNode[] = [];
  const otherNodes: GraphNode[] = [];

  for (const node of graph.nodes) {
    if (dependedOnBy.get(node.id)!.length === 0) {
      noImporterNodes.push(node);
    } else {
      otherNodes.push(node);
    }
  }

  const lines: string[] = [];
  lines.push(`## Project Map (file-level, ${graph.nodes.length} files)\n`);

  function formatNode(node: GraphNode) {
    const relPath = idToRel.get(node.id)!;
    lines.push(`  ${relPath}`);

    if (node.exports.length > 0) {
      const exps = node.exports
        .slice(0, 8)
        .map((e) => `${e.name} (${e.type})`)
        .join(", ");
      const suffix = node.exports.length > 8 ? `, +${node.exports.length - 8} more` : "";
      lines.push(`    exports: ${exps}${suffix}`);
    }

    const deps = dependsOn.get(node.id)!;
    if (deps.length > 0) {
      lines.push(`    depends_on: ${deps.join(", ")}`);
    }

    const importers = dependedOnBy.get(node.id)!;
    if (importers.length > 0) {
      lines.push(`    dependents: ${importers.join(", ")}`);
    }
  }

  if (noImporterNodes.length > 0) {
    lines.push(`### Files With No Importers`);
    for (const node of noImporterNodes) {
      formatNode(node);
    }
    lines.push("");
  }

  if (otherNodes.length > 0) {
    lines.push(`### Files`);
    for (const node of otherNodes) {
      formatNode(node);
    }
  }

  return lines.join("\n");
}

function generateDirectoryMap(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  projectDir: string
): string {
  // Group nodes by directory
  const dirFiles = new Map<string, string[]>();
  const nodeToDir = new Map<number, string>();

  for (const node of graph.nodes) {
    const relPath = relative(projectDir, node.path);
    const dir = dirname(relPath) || ".";
    nodeToDir.set(node.id, dir);
    if (!dirFiles.has(dir)) dirFiles.set(dir, []);
    dirFiles.get(dir)!.push(basename(relPath));
  }

  // Directory-level edges (deduplicated with count)
  const dirEdgeCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    const fromDir = nodeToDir.get(edge.fromId)!;
    const toDir = nodeToDir.get(edge.toId)!;
    if (fromDir !== toDir) {
      const key = `${fromDir} -> ${toDir}`;
      dirEdgeCounts.set(key, (dirEdgeCounts.get(key) || 0) + 1);
    }
  }

  const lines: string[] = [];
  lines.push(`## Project Map (directory-level, ${dirFiles.size} directories)\n`);

  lines.push("### Directories");
  for (const [dir, files] of dirFiles) {
    lines.push(`  ${dir}/ (${files.length} files)`);
    lines.push(`    files: ${files.join(", ")}`);
  }

  if (dirEdgeCounts.size > 0) {
    lines.push("");
    lines.push("### Dependencies");
    for (const [edge, count] of dirEdgeCounts) {
      lines.push(`  ${edge} (${count} import${count !== 1 ? "s" : ""})`);
    }
  }

  return lines.join("\n");
}

function generateFileMapJson(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  projectDir: string
): string {
  const fanIn = new Map<number, number>();
  const fanOut = new Map<number, number>();
  const idToRel = new Map<number, string>();

  for (const node of graph.nodes) {
    idToRel.set(node.id, relative(projectDir, node.path));
    fanIn.set(node.id, 0);
    fanOut.set(node.id, 0);
  }

  for (const edge of graph.edges) {
    fanOut.set(edge.fromId, (fanOut.get(edge.fromId) ?? 0) + 1);
    fanIn.set(edge.toId, (fanIn.get(edge.toId) ?? 0) + 1);
  }

  const nodes = graph.nodes.map((node) => ({
    path: idToRel.get(node.id)!,
    exports: node.exports.map((e) => ({ name: e.name, type: e.type })),
    fanIn: fanIn.get(node.id) ?? 0,
    fanOut: fanOut.get(node.id) ?? 0,
  }));

  const edges = graph.edges.map((edge) => ({
    from: idToRel.get(edge.fromId)!,
    to: idToRel.get(edge.toId)!,
    source: edge.source,
  }));

  return JSON.stringify({ level: "file", nodes, edges });
}

function generateDirectoryMapJson(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  projectDir: string
): string {
  const dirFiles = new Map<string, string[]>();
  const dirExportCounts = new Map<string, number>();
  const nodeToDir = new Map<number, string>();

  for (const node of graph.nodes) {
    const relPath = relative(projectDir, node.path);
    const dir = dirname(relPath) || ".";
    nodeToDir.set(node.id, dir);
    if (!dirFiles.has(dir)) {
      dirFiles.set(dir, []);
      dirExportCounts.set(dir, 0);
    }
    dirFiles.get(dir)!.push(basename(relPath));
    dirExportCounts.set(dir, dirExportCounts.get(dir)! + node.exports.length);
  }

  // Compute directory-level fan-in/fan-out and edge counts
  const dirFanIn = new Map<string, Set<string>>();
  const dirFanOut = new Map<string, Set<string>>();
  const dirEdgeCounts = new Map<string, number>();

  for (const dir of dirFiles.keys()) {
    dirFanIn.set(dir, new Set());
    dirFanOut.set(dir, new Set());
  }

  for (const edge of graph.edges) {
    const fromDir = nodeToDir.get(edge.fromId)!;
    const toDir = nodeToDir.get(edge.toId)!;
    if (fromDir !== toDir) {
      dirFanOut.get(fromDir)!.add(toDir);
      dirFanIn.get(toDir)!.add(fromDir);
      const key = `${fromDir}->${toDir}`;
      dirEdgeCounts.set(key, (dirEdgeCounts.get(key) ?? 0) + 1);
    }
  }

  const directories = [...dirFiles.entries()].map(([dir, files]) => ({
    path: dir,
    fileCount: files.length,
    files,
    totalExports: dirExportCounts.get(dir) ?? 0,
    fanIn: dirFanIn.get(dir)?.size ?? 0,
    fanOut: dirFanOut.get(dir)?.size ?? 0,
  }));

  const edges = [...dirEdgeCounts.entries()].map(([key, count]) => {
    const [from, to] = key.split("->");
    return { from, to, importCount: count };
  });

  return JSON.stringify({ level: "directory", directories, edges });
}
