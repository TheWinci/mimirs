import { dirname, resolve, relative, basename, extname } from "path";
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

  let resolvedCount = 0;

  for (const imp of unresolved) {
    const lang = detectLanguage(imp.filePath);

    // Skip bare/external specifiers — but let Python/Rust through since
    // their relative imports don't always start with ./ (e.g. crate::, from .x)
    if (!imp.source.startsWith(".") && !imp.source.startsWith("/")) {
      if (lang !== "rust" && lang !== "python") continue;
    }

    // Pass 1: bun-chunk filesystem resolution
    const resolvedPath = bcResolveImport(imp.source, imp.filePath, projectDir, lang, tsConfig);
    if (resolvedPath && pathToId.has(resolvedPath)) {
      db.resolveImport(imp.id, pathToId.get(resolvedPath)!);
      resolvedCount++;
      continue;
    }

    // Pass 2: DB-based resolution (extension probing against indexed paths)
    if (imp.source.startsWith(".") || imp.source.startsWith("/")) {
      const importerDir = dirname(imp.filePath);
      const basePath = resolve(importerDir, imp.source);
      const dbResolved = tryResolvePath(basePath, pathToId);
      if (dbResolved !== null) {
        db.resolveImport(imp.id, dbResolved);
        resolvedCount++;
      }
    }
  }

  return resolvedCount;
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
  const tsConfig = loadTsConfig(projectDir);

  for (const imp of imports) {
    if (imp.resolvedFileId !== null) continue;

    // Skip bare/external specifiers — but let Python/Rust through
    if (!imp.source.startsWith(".") && !imp.source.startsWith("/")) {
      if (lang !== "rust" && lang !== "python") continue;
    }

    // Pass 1: bun-chunk filesystem resolution
    const resolvedPath = bcResolveImport(imp.source, filePath, projectDir, lang, tsConfig);
    if (resolvedPath && pathToId.has(resolvedPath)) {
      db.resolveImport(imp.id, pathToId.get(resolvedPath)!);
      continue;
    }

    // Pass 2: DB-based resolution
    if (imp.source.startsWith(".") || imp.source.startsWith("/")) {
      const importerDir = dirname(filePath);
      const basePath = resolve(importerDir, imp.source);
      const resolved = tryResolvePath(basePath, pathToId);
      if (resolved !== null) {
        db.resolveImport(imp.id, resolved);
      }
    }
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

  // Identify entry points (no importers)
  const entryPoints: GraphNode[] = [];
  const otherNodes: GraphNode[] = [];

  for (const node of graph.nodes) {
    if (dependedOnBy.get(node.id)!.length === 0) {
      entryPoints.push(node);
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
      lines.push(`    depended_on_by: ${importers.join(", ")}`);
    }
  }

  if (entryPoints.length > 0) {
    lines.push(`### Entry Points (no importers)`);
    for (const node of entryPoints) {
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
    isEntryPoint: (fanIn.get(node.id) ?? 0) === 0,
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
