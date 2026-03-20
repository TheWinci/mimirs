import { dirname, resolve, relative, basename } from "path";
import { existsSync } from "fs";
import { RagDB } from "../db";

// Extensions to try when resolving relative imports
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const INDEX_FILES = RESOLVE_EXTENSIONS.map((ext) => `/index${ext}`);

/**
 * Resolve all unresolved imports in the database by matching import specifiers
 * to indexed file paths.
 */
export function resolveImports(db: RagDB, projectDir: string): number {
  const unresolved = db.getUnresolvedImports();
  const allFiles = db.getAllFilePaths();

  // Build lookup: absolute path → file ID
  const pathToId = new Map<string, number>();
  for (const f of allFiles) {
    pathToId.set(f.path, f.id);
  }

  let resolvedCount = 0;

  for (const imp of unresolved) {
    // Skip bare/external specifiers (no ./ or ../ prefix)
    if (!imp.source.startsWith(".") && !imp.source.startsWith("/")) {
      continue;
    }

    const importerDir = dirname(imp.filePath);
    const basePath = resolve(importerDir, imp.source);

    const resolved = tryResolvePath(basePath, pathToId);
    if (resolved !== null) {
      db.resolveImport(imp.id, resolved);
      resolvedCount++;
    }
  }

  return resolvedCount;
}

/**
 * Resolve imports for a single file (used by watcher after re-indexing).
 */
export function resolveImportsForFile(db: RagDB, fileId: number, projectDir: string): void {
  const allFiles = db.getAllFilePaths();
  const pathToId = new Map<string, number>();
  for (const f of allFiles) {
    pathToId.set(f.path, f.id);
  }

  const imports = db.getImportsForFile(fileId);
  const file = allFiles.find((f) => f.id === fileId);
  if (!file) return;

  const importerDir = dirname(file.path);

  for (const imp of imports) {
    if (imp.resolvedFileId !== null) continue;
    if (!imp.source.startsWith(".") && !imp.source.startsWith("/")) continue;

    const basePath = resolve(importerDir, imp.source);
    const resolved = tryResolvePath(basePath, pathToId);
    if (resolved !== null) {
      db.resolveImport(imp.id, resolved);
    }
  }
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
  maxNodes?: number;
  maxHops?: number;
  showExternals?: boolean;
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
 * Generate a Mermaid dependency graph from the stored import/export data.
 */
export function generateMermaid(
  db: RagDB,
  options: GraphOptions
): string {
  const {
    zoom = "file",
    focus,
    maxNodes = 50,
    maxHops = 2,
    projectDir,
  } = options;

  let graph: { nodes: GraphNode[]; edges: GraphEdge[] };

  if (focus) {
    // Find the focused file(s)
    const file = db.getFileByPath(resolve(projectDir, focus));
    if (file) {
      graph = db.getSubgraph([file.id], maxHops);
    } else {
      // No exact match — return empty graph
      graph = { nodes: [], edges: [] };
    }
  } else {
    graph = db.getGraph();
  }

  if (graph.nodes.length === 0) {
    return "graph TD\n  empty[\"No files indexed or no dependencies found\"]";
  }

  // Auto-switch to directory view if too many nodes
  const effectiveZoom = graph.nodes.length > maxNodes ? "directory" : zoom;

  if (effectiveZoom === "directory") {
    return generateDirectoryMermaid(graph, projectDir);
  }

  return generateFileMermaid(graph, projectDir);
}

function sanitizeId(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "_");
}

function generateFileMermaid(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  projectDir: string
): string {
  const lines: string[] = ["graph TD"];

  // Determine entry points (nodes with no incoming edges)
  const hasIncoming = new Set<number>();
  for (const edge of graph.edges) {
    hasIncoming.add(edge.toId);
  }

  // Node definitions
  for (const node of graph.nodes) {
    const relPath = relative(projectDir, node.path);
    const id = sanitizeId(relPath);
    const topExports = node.exports.slice(0, 3);
    const exportLines = topExports.map((e) => `+ ${e.name}`).join("\\n");
    const label = exportLines ? `${relPath}\\n${exportLines}` : relPath;
    lines.push(`  ${id}["${label}"]`);
  }

  // Edges
  for (const edge of graph.edges) {
    const fromRel = relative(projectDir, edge.fromPath);
    const toRel = relative(projectDir, edge.toPath);
    lines.push(`  ${sanitizeId(fromRel)} --> ${sanitizeId(toRel)}`);
  }

  // Style entry points
  for (const node of graph.nodes) {
    if (!hasIncoming.has(node.id)) {
      const relPath = relative(projectDir, node.path);
      lines.push(`  style ${sanitizeId(relPath)} fill:#e1f5fe,stroke:#0288d1`);
    }
  }

  return lines.join("\n");
}

function generateDirectoryMermaid(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  projectDir: string
): string {
  const lines: string[] = ["graph TD"];

  // Group nodes by directory
  const dirFiles = new Map<string, number>();
  const nodeToDir = new Map<number, string>();

  for (const node of graph.nodes) {
    const relPath = relative(projectDir, node.path);
    const dir = dirname(relPath) || ".";
    dirFiles.set(dir, (dirFiles.get(dir) || 0) + 1);
    nodeToDir.set(node.id, dir);
  }

  // Directory nodes
  for (const [dir, count] of dirFiles) {
    const id = sanitizeId(dir);
    lines.push(`  ${id}["${dir}/ (${count} files)"]`);
  }

  // Directory edges (deduplicated)
  const dirEdges = new Set<string>();
  for (const edge of graph.edges) {
    const fromDir = nodeToDir.get(edge.fromId)!;
    const toDir = nodeToDir.get(edge.toId)!;
    if (fromDir !== toDir) {
      const key = `${fromDir}->${toDir}`;
      if (!dirEdges.has(key)) {
        dirEdges.add(key);
        lines.push(`  ${sanitizeId(fromDir)} --> ${sanitizeId(toDir)}`);
      }
    }
  }

  return lines.join("\n");
}
