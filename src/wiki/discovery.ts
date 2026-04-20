import { basename, dirname } from "path";
import type { RagDB } from "../db";
import { generateProjectMap } from "../graph/resolver";
import type {
  DiscoveryResult,
  DiscoveryModule,
  FileLevelGraph,
  FileLevelNode,
  FileLevelEdge,
  DirectoryLevelGraph,
} from "./types";

const ENTRY_FILE_PATTERN = /^(index|main|mod|lib|__init__)\./;
const WORKSPACE_ROOTS = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml"];

/**
 * Phase 1: Discover the project's structure from the graph index.
 * Returns module inventory + raw graph data for subsequent phases.
 */
export function runDiscovery(db: RagDB, projectDir: string): DiscoveryResult {
  const warnings: string[] = [];
  const status = db.getStatus();

  if (status.totalFiles === 0) {
    return {
      fileCount: 0,
      chunkCount: 0,
      lastIndexed: null,
      modules: [],
      graphData: {
        fileLevel: { level: "file", nodes: [], edges: [] },
        directoryLevel: { level: "directory", directories: [], edges: [] },
      },
      warnings: ["Index is empty — no files indexed"],
    };
  }

  // Get file-level graph
  const fileGraphJson = generateProjectMap(db, {
    projectDir,
    format: "json",
  });
  let fileGraph: FileLevelGraph;
  try {
    fileGraph = JSON.parse(fileGraphJson);
  } catch {
    warnings.push("File-level graph JSON was truncated or invalid — using empty graph");
    fileGraph = { level: "file", nodes: [], edges: [] };
  }

  // Get directory-level graph
  const dirGraphJson = generateProjectMap(db, {
    projectDir,
    format: "json",
    zoom: "directory",
  });
  let dirGraph: DirectoryLevelGraph;
  try {
    dirGraph = JSON.parse(dirGraphJson);
  } catch {
    warnings.push("Directory-level graph JSON was truncated or invalid — using empty graph");
    dirGraph = { level: "directory", directories: [], edges: [] };
  }

  // Build lookup maps
  const pathToNode = new Map<string, FileLevelNode>();
  for (const node of fileGraph.nodes) {
    pathToNode.set(node.path, node);
  }

  // Group file-level edges by directory pair for cohesion check
  const dirToFiles = new Map<string, string[]>();
  for (const node of fileGraph.nodes) {
    const dir = dirname(node.path);
    if (!dirToFiles.has(dir)) dirToFiles.set(dir, []);
    dirToFiles.get(dir)!.push(node.path);
  }

  // Detect modules from directories
  let modules = detectDirectoryModules(dirGraph, fileGraph, dirToFiles);

  // Flat project fallback
  if (modules.length < 3) {
    const largestDirSize = Math.max(0, ...dirGraph.directories.map((d) => d.fileCount));
    if (largestDirSize >= 10) {
      warnings.push("Fewer than 3 modules detected with large directory — using graph clustering fallback");
      modules = flatProjectFallback(fileGraph, pathToNode);
    }
  }

  // Monorepo detection
  const allPaths = db.getAllFilePaths().map((f) => f.path);
  const workspaceRoots = detectWorkspaceRoots(allPaths, projectDir);
  if (workspaceRoots.length >= 2) {
    warnings.push(`Monorepo detected: ${workspaceRoots.length} workspace roots`);
    // Each workspace root becomes a top-level module if not already covered
    for (const root of workspaceRoots) {
      const exists = modules.some((m) => m.path === root || root.startsWith(m.path + "/"));
      if (!exists) {
        const filesInRoot = [...dirToFiles.entries()]
          .filter(([dir]) => dir === root || dir.startsWith(root + "/"))
          .flatMap(([, files]) => files);
        if (filesInRoot.length > 0) {
          modules.push(buildModuleFromFiles(root, filesInRoot, fileGraph));
        }
      }
    }
  }

  // Nest modules by path depth
  modules = nestModules(modules);

  // Small project: if still 0 modules, treat every dir as a module
  if (modules.length === 0 && dirGraph.directories.length > 0) {
    warnings.push("No modules detected — treating each directory as a module");
    for (const dir of dirGraph.directories) {
      const files = dirToFiles.get(dir.path) ?? [];
      modules.push(buildModuleFromFiles(dir.path, files, fileGraph));
    }
  }

  return {
    fileCount: status.totalFiles,
    chunkCount: status.totalChunks,
    lastIndexed: status.lastIndexed ?? null,
    modules,
    graphData: { fileLevel: fileGraph, directoryLevel: dirGraph },
    warnings,
  };
}

function detectDirectoryModules(
  dirGraph: DirectoryLevelGraph,
  fileGraph: FileLevelGraph,
  dirToFiles: Map<string, string[]>,
): DiscoveryModule[] {
  const modules: DiscoveryModule[] = [];

  // Build set of intra-directory edges per directory
  const intraEdgeCounts = new Map<string, number>();
  for (const edge of fileGraph.edges) {
    const fromDir = dirname(edge.from);
    const toDir = dirname(edge.to);
    if (fromDir === toDir) {
      intraEdgeCounts.set(fromDir, (intraEdgeCounts.get(fromDir) ?? 0) + 1);
    }
  }

  for (const dir of dirGraph.directories) {
    const files = dirToFiles.get(dir.path) ?? dir.files;
    const hasEntryFile = files.some((f) => ENTRY_FILE_PATTERN.test(basename(f)));
    const hasExternalConsumers = dir.fanIn > 0;
    const internalCohesion = intraEdgeCounts.get(dir.path) ?? 0;
    const hasExports = dir.totalExports > 0;

    const isModule = hasEntryFile || hasExternalConsumers || (internalCohesion >= 2 && hasExports);

    if (isModule) {
      modules.push(buildModuleFromDir(dir, files, fileGraph));
    }
  }

  return modules;
}

function buildModuleFromDir(
  dir: DirectoryLevelGraph["directories"][0],
  files: string[],
  fileGraph: FileLevelGraph,
): DiscoveryModule {
  const entryFile = files.find((f) => ENTRY_FILE_PATTERN.test(basename(f))) ?? null;

  // Collect exports from file-level nodes
  const exports: string[] = [];
  for (const f of files) {
    const node = fileGraph.nodes.find((n) => n.path === f);
    if (node) {
      for (const exp of node.exports) {
        exports.push(exp.name);
      }
    }
  }

  // Count internal edges
  const fileSet = new Set(files);
  let internalEdges = 0;
  for (const edge of fileGraph.edges) {
    if (fileSet.has(edge.from) && fileSet.has(edge.to)) {
      internalEdges++;
    }
  }

  return {
    name: basename(dir.path) || dir.path,
    path: dir.path,
    entryFile,
    files,
    exports,
    fanIn: dir.fanIn,
    fanOut: dir.fanOut,
    internalEdges,
  };
}

function buildModuleFromFiles(
  path: string,
  files: string[],
  fileGraph: FileLevelGraph,
): DiscoveryModule {
  const entryFile = files.find((f) => ENTRY_FILE_PATTERN.test(basename(f))) ?? null;

  const exports: string[] = [];
  let fanIn = 0;
  let fanOut = 0;
  const fileSet = new Set(files);
  let internalEdges = 0;

  for (const node of fileGraph.nodes) {
    if (fileSet.has(node.path)) {
      for (const exp of node.exports) exports.push(exp.name);
      fanIn += node.fanIn;
      fanOut += node.fanOut;
    }
  }

  for (const edge of fileGraph.edges) {
    if (fileSet.has(edge.from) && fileSet.has(edge.to)) {
      internalEdges++;
      // Subtract internal edges from fanIn/fanOut (they were double-counted)
      fanIn--;
      fanOut--;
    }
  }

  return {
    name: basename(path) || path,
    path,
    entryFile,
    files,
    exports,
    fanIn: Math.max(0, fanIn),
    fanOut: Math.max(0, fanOut),
    internalEdges,
  };
}

function flatProjectFallback(
  fileGraph: FileLevelGraph,
  pathToNode: Map<string, FileLevelNode>,
): DiscoveryModule[] {
  const modules: DiscoveryModule[] = [];
  const assigned = new Set<string>();

  // Pre-build undirected adjacency once. The previous implementation scanned
  // the full edge list on every BFS pop — O(nodes × edges) per fallback run,
  // which becomes a hang on large projects the moment this branch triggers.
  const adjacency = new Map<string, string[]>();
  for (const edge of fileGraph.edges) {
    let a = adjacency.get(edge.from);
    if (!a) { a = []; adjacency.set(edge.from, a); }
    a.push(edge.to);
    let b = adjacency.get(edge.to);
    if (!b) { b = []; adjacency.set(edge.to, b); }
    b.push(edge.from);
  }

  // Sort nodes by fanIn descending
  const sorted = [...fileGraph.nodes].sort((a, b) => b.fanIn - a.fanIn);

  for (const seed of sorted) {
    if (assigned.has(seed.path)) continue;

    // BFS with an index pointer — Array.shift() is O(n) in V8, and the queue
    // can grow to the size of the component on large projects.
    const group = new Set<string>([seed.path]);
    const queue: string[] = [seed.path];
    let head = 0;
    assigned.add(seed.path);

    while (head < queue.length) {
      const current = queue[head++];
      const neighbors = adjacency.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!assigned.has(neighbor) && pathToNode.has(neighbor)) {
          group.add(neighbor);
          assigned.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const files = [...group];
    modules.push(buildModuleFromFiles(dirname(seed.path), files, fileGraph));
  }

  // Assign remaining ungrouped files as "utilities"
  const ungrouped = fileGraph.nodes.filter((n) => !assigned.has(n.path));
  if (ungrouped.length > 0) {
    const files = ungrouped.map((n) => n.path);
    modules.push({
      name: "utilities",
      path: ".",
      entryFile: null,
      files,
      exports: ungrouped.flatMap((n) => n.exports.map((e) => e.name)),
      fanIn: 0,
      fanOut: 0,
      internalEdges: 0,
    });
  }

  return modules;
}

function detectWorkspaceRoots(allPaths: string[], projectDir: string): string[] {
  const roots: string[] = [];
  for (const p of allPaths) {
    const name = basename(p);
    if (!WORKSPACE_ROOTS.includes(name)) continue;

    const dir = dirname(p);
    // Depth <= 2 from project root
    const relDir = dir.startsWith(projectDir)
      ? dir.slice(projectDir.length).replace(/^\//, "")
      : dir;
    const depth = relDir === "" ? 0 : relDir.split("/").length;
    if (depth <= 2 && depth > 0) {
      roots.push(relDir || dir);
    }
  }
  return [...new Set(roots)];
}

function nestModules(modules: DiscoveryModule[]): DiscoveryModule[] {
  // Sort deepest first so children are processed before parents
  const sorted = [...modules].sort(
    (a, b) => b.path.split("/").length - a.path.split("/").length
  );

  const nested = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[i].path.startsWith(sorted[j].path + "/") && !nested.has(sorted[i].path)) {
        if (!sorted[j].children) sorted[j].children = [];
        sorted[j].children!.push(sorted[i]);
        nested.add(sorted[i].path);
      }
    }
  }

  return sorted.filter((m) => !nested.has(m.path));
}
