import { describe, test, expect } from "bun:test";
import {
  detectDispatchDirectories,
  detectFileCommunities,
  detectSymbolCommunities,
} from "../../src/wiki/community-detection";
import type { FileLevelGraph, FileLevelNode, FileLevelEdge } from "../../src/wiki/types";
import type { SymbolGraphData } from "../../src/db/graph";

/**
 * Default node has one synthetic export so the isolate filter
 * (`fanIn===0 && fanOut===0 && exports.length===0`) doesn't drop it. Tests
 * that specifically want an isolate should pass `exports: []` via
 * `isolateNode` below.
 */
function node(path: string, fanIn = 0, fanOut = 0): FileLevelNode {
  return {
    path,
    exports: [{ name: "default", type: "export" }],
    fanIn,
    fanOut,
    isEntryPoint: false,
  };
}

function isolateNode(path: string): FileLevelNode {
  return { path, exports: [], fanIn: 0, fanOut: 0, isEntryPoint: false };
}

function edge(from: string, to: string): FileLevelEdge {
  return { from, to, source: "test" };
}

/**
 * Build a file graph with two well-separated cliques. Each clique has
 * `size` files all importing each other; the two cliques are linked by a
 * single bridge edge. Louvain should recover the two cliques cleanly.
 */
function twoCliques(dirA: string, dirB: string, size: number): FileLevelGraph {
  const a = Array.from({ length: size }, (_, i) => `${dirA}/a${i}.ts`);
  const b = Array.from({ length: size }, (_, i) => `${dirB}/b${i}.ts`);
  const nodes = [...a, ...b].map((p) => node(p));
  const edges: FileLevelEdge[] = [];
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) edges.push(edge(a[i], a[j]));
  }
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) edges.push(edge(b[i], b[j]));
  }
  edges.push(edge(a[0], b[0])); // single bridge
  return { level: "file", nodes, edges };
}

describe("detectFileCommunities", () => {
  test("returns [] when node count is below threshold", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(`src/a${i}.ts`));
    const edges = [edge("src/a0.ts", "src/a1.ts"), edge("src/a1.ts", "src/a2.ts")];
    const result = detectFileCommunities({ level: "file", nodes, edges });
    expect(result).toEqual([]);
  });

  test("returns [] when edge count is below threshold", () => {
    // 12 product files but only a single edge — Louvain has nothing to cluster.
    const nodes = Array.from({ length: 12 }, (_, i) => node(`src/a${i}.ts`));
    const edges = [edge("src/a0.ts", "src/a1.ts")];
    const result = detectFileCommunities({ level: "file", nodes, edges });
    expect(result).toEqual([]);
  });

  test("recovers two cliques as separate modules", () => {
    const graph = twoCliques("src/db", "src/api", 6);
    const modules = detectFileCommunities(graph);

    expect(modules.length).toBe(2);
    const dirs = modules.map((m) => m.path).sort();
    expect(dirs).toEqual(["src/api", "src/db"]);

    const db = modules.find((m) => m.path === "src/db")!;
    expect(db.files.length).toBe(6);
    expect(db.files.every((f) => f.startsWith("src/db/"))).toBe(true);
    expect(db.internalEdges).toBeGreaterThan(0);
  });

  test("excludes graph isolates (no edges, no exports) before clustering", () => {
    // Two cliques plus a pile of floating markdown-like nodes whose dir
    // happens to match one of the cliques. If isolates leaked in, the
    // orphan-reattach step would bundle them into the nearest cluster and
    // pluralityDir would pick the wrong subdir.
    const graph = twoCliques("src/db", "src/api", 6);
    const noiseDir = "src/db";
    for (let i = 0; i < 10; i++) {
      graph.nodes.push(isolateNode(`${noiseDir}/README${i}.md`));
    }

    const modules = detectFileCommunities(graph);
    const allClusteredFiles = modules.flatMap((m) => m.files);
    for (let i = 0; i < 10; i++) {
      expect(allClusteredFiles).not.toContain(`${noiseDir}/README${i}.md`);
    }
    expect(modules.length).toBe(2);
  });

  test("keeps test/bench dir filtering working on relative paths", () => {
    const graph = twoCliques("src/db", "src/api", 6);
    // Relative paths (no leading slash) — the old substring check missed
    // these; the new `hasSegment` helper must catch them.
    const leakers = [
      "tests/fixtures/a.ts",
      "benchmarks/b.ts",
      "__tests__/c.ts",
    ];
    for (const t of leakers) {
      graph.nodes.push(node(t));
      graph.edges.push(edge(t, "src/db/a0.ts"));
      graph.edges.push(edge(t, "src/api/b0.ts"));
    }

    const modules = detectFileCommunities(graph);
    const allClusteredFiles = modules.flatMap((m) => m.files);
    for (const t of leakers) {
      expect(allClusteredFiles).not.toContain(t);
    }
    expect(modules.length).toBe(2);
  });

  test("excludes test and benchmark files before clustering", () => {
    const graph = twoCliques("src/db", "src/api", 6);
    // Sprinkle tests/benches that heavily co-import with src — they should
    // not pull the two product cliques into a single community.
    const testFiles = [
      "tests/db.test.ts",
      "tests/api.test.ts",
      "benchmarks/db.bench.ts",
      "src/db/mod.test.ts",
    ];
    for (const t of testFiles) {
      graph.nodes.push(node(t));
      graph.edges.push(edge(t, "src/db/a0.ts"));
      graph.edges.push(edge(t, "src/api/b0.ts"));
    }

    const modules = detectFileCommunities(graph);
    const allClusteredFiles = modules.flatMap((m) => m.files);
    for (const t of testFiles) {
      expect(allClusteredFiles).not.toContain(t);
    }
    // Still two product clusters, untouched by the noise.
    expect(modules.length).toBe(2);
  });

  test("uses plurality dir when common prefix is shallow", () => {
    // Build one cluster that spans src/a and src/b — commonDirPrefix is "src"
    // (depth 1), so the module path should fall back to whichever sub-dir
    // holds the plurality of files.
    const files = [
      "src/a/f1.ts", "src/a/f2.ts", "src/a/f3.ts", "src/a/f4.ts",
      "src/a/f5.ts", "src/a/f6.ts", "src/a/f7.ts", // 7 in src/a
      "src/b/g1.ts", "src/b/g2.ts", "src/b/g3.ts", // 3 in src/b
    ];
    const nodes = files.map((p) => node(p));
    const edges: FileLevelEdge[] = [];
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) edges.push(edge(files[i], files[j]));
    }
    const modules = detectFileCommunities({ level: "file", nodes, edges });

    expect(modules.length).toBe(1);
    // Plurality dir is src/a (7 files), not the common prefix "src".
    expect(modules[0].path).toBe("src/a");
    expect(modules[0].name).toBe("a");
  });
});

describe("detectSymbolCommunities", () => {
  const PROJECT_DIR = "/proj";

  function abs(rel: string): string {
    return `${PROJECT_DIR}/${rel}`;
  }

  test("returns [] when there are too few symbols", () => {
    // Only two caller chunks — well below the 10-node Louvain threshold.
    const nodes = Array.from({ length: 15 }, (_, i) => node(`src/f${i}.ts`));
    const edges = Array.from({ length: 10 }, (_, i) => edge(`src/f${i}.ts`, `src/f${i + 1}.ts`));
    const fileGraph: FileLevelGraph = { level: "file", nodes, edges };

    const data: SymbolGraphData = {
      files: nodes.map((n, i) => ({ id: i + 1, path: abs(n.path) })),
      imports: [],
      exports: [],
      chunks: [
        { fileId: 1, entityName: "foo", chunkType: "function", snippet: "foo" },
        { fileId: 2, entityName: "bar", chunkType: "function", snippet: "bar" },
      ],
    };

    const modules = detectSymbolCommunities(data, fileGraph, PROJECT_DIR);
    expect(modules).toEqual([]);
  });

  test("normalizes absolute DB paths against projectDir", () => {
    // Build two symbol-clusters that match file-level cliques. The DB stores
    // absolute paths; the fileGraph uses relative. detectSymbolCommunities
    // must normalize to find overlap — without that, productFiles stays empty
    // and the function returns [].
    const fileGraph = twoCliques("src/db", "src/api", 6);

    const files = fileGraph.nodes.map((n, i) => ({ id: i + 1, path: abs(n.path) }));
    const idByRel = new Map(files.map((f) => [f.path.slice(PROJECT_DIR.length + 1), f.id]));

    // Each file exports one symbol named after itself; each file's caller
    // chunk mentions every other symbol in its own clique → cluster edges.
    const exports: SymbolGraphData["exports"] = files.map((f) => ({
      fileId: f.id,
      name: symName(f.path),
      type: "function",
    }));
    const imports: SymbolGraphData["imports"] = [];
    const chunks: SymbolGraphData["chunks"] = [];

    const dbFiles = fileGraph.nodes.filter((n) => n.path.startsWith("src/db")).map((n) => n.path);
    const apiFiles = fileGraph.nodes.filter((n) => n.path.startsWith("src/api")).map((n) => n.path);

    for (const clique of [dbFiles, apiFiles]) {
      for (const self of clique) {
        const selfName = symName(abs(self));
        const selfId = idByRel.get(self)!;
        // Import every other symbol in the clique as a named import.
        for (const other of clique) {
          if (other === self) continue;
          imports.push({
            fileId: selfId,
            names: symName(abs(other)),
            resolvedFileId: idByRel.get(other)!,
            isNamespace: false,
          });
        }
        // The chunk body names every clique peer so snippet-scanning wires
        // the symbol edges.
        const snippet = clique.filter((f) => f !== self).map((f) => symName(abs(f))).join(" ");
        chunks.push({
          fileId: selfId,
          entityName: selfName,
          chunkType: "function",
          snippet,
        });
      }
    }

    const data: SymbolGraphData = { files, imports, exports, chunks };
    const modules = detectSymbolCommunities(data, fileGraph, PROJECT_DIR);

    expect(modules.length).toBe(2);
    const paths = modules.map((m) => m.path).sort();
    expect(paths).toEqual(["src/api", "src/db"]);
    // All files in each community come from the matching clique.
    for (const m of modules) {
      expect(m.files.every((f) => f.startsWith(m.path + "/"))).toBe(true);
    }
  });
});

/** Derive a stable symbol name from an absolute path — just the basename. */
function symName(absPath: string): string {
  const base = absPath.split("/").pop()!;
  return base.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_");
}

describe("community hardening", () => {
  test("cohesion is ~1 for cliques, bounded in [0,1]", () => {
    const graph = twoCliques("src/x", "src/y", 6);
    const modules = detectFileCommunities(graph);
    expect(modules.length).toBe(2);
    for (const m of modules) {
      expect(m.cohesion).toBeGreaterThan(0);
      expect(m.cohesion).toBeLessThanOrEqual(1);
      // Clique with one bridge edge is near-fully connected internally.
      expect(m.cohesion).toBeGreaterThan(0.8);
    }
  });

  test("splits oversized clusters", () => {
    // Two internally-dense subsystems weakly joined by a few cross edges.
    // Louvain may collapse them; the split pass should separate.
    const left = Array.from({ length: 20 }, (_, i) => `src/left/l${i}.ts`);
    const right = Array.from({ length: 20 }, (_, i) => `src/right/r${i}.ts`);
    const nodes = [...left, ...right].map((p) => node(p));
    const edges: FileLevelEdge[] = [];
    for (let i = 0; i < left.length; i++) {
      for (let j = i + 1; j < left.length; j++) edges.push(edge(left[i], left[j]));
    }
    for (let i = 0; i < right.length; i++) {
      for (let j = i + 1; j < right.length; j++) edges.push(edge(right[i], right[j]));
    }
    // A handful of cross edges to stress Louvain.
    for (let i = 0; i < 5; i++) edges.push(edge(left[i], right[i]));

    const modules = detectFileCommunities({ level: "file", nodes, edges });
    expect(modules.length).toBeGreaterThanOrEqual(2);

    // No single community swallows >50% of the graph.
    for (const m of modules) {
      expect(m.files.length).toBeLessThan(nodes.length * 0.55);
    }
  });

  test("output is deterministic across repeated runs", () => {
    const graph = twoCliques("src/alpha", "src/beta", 6);
    const runs = Array.from({ length: 3 }, () => detectFileCommunities(graph));
    const signatures = runs.map((m) =>
      m
        .map((mod) => [...mod.files].sort().join(","))
        .sort()
        .join("|"),
    );
    expect(signatures[0]).toBe(signatures[1]);
    expect(signatures[1]).toBe(signatures[2]);
  });

  test("output ordered size-descending", () => {
    // Three communities of distinct sizes. Emit must be largest-first.
    const sizes = [10, 6, 4];
    const nodes: FileLevelNode[] = [];
    const edges: FileLevelEdge[] = [];
    sizes.forEach((s, idx) => {
      const dir = `src/c${idx}`;
      const files = Array.from({ length: s }, (_, i) => `${dir}/f${i}.ts`);
      files.forEach((f) => nodes.push(node(f)));
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) edges.push(edge(files[i], files[j]));
      }
    });
    // Thin bridges between clusters so they're distinguishable but separate.
    edges.push(edge("src/c0/f0.ts", "src/c1/f0.ts"));
    edges.push(edge("src/c1/f0.ts", "src/c2/f0.ts"));

    const modules = detectFileCommunities({ level: "file", nodes, edges });
    for (let i = 1; i < modules.length; i++) {
      expect(modules[i - 1].files.length).toBeGreaterThanOrEqual(modules[i].files.length);
    }
  });
});

describe("detectDispatchDirectories", () => {
  test("fires on real dispatch pattern: shared parent, no sibling edges", () => {
    const parent = "src/cli/router.ts";
    const siblings = Array.from({ length: 5 }, (_, i) => `src/cli/commands/cmd${i}.ts`);
    const nodes = [node(parent, 0, siblings.length), ...siblings.map((p) => node(p, 1, 0))];
    const edges = siblings.map((s) => edge(parent, s));
    const seeds = detectDispatchDirectories({ level: "file", nodes, edges });
    expect(seeds).toHaveLength(1);
    expect(seeds[0].files).toHaveLength(5);
    expect(new Set(seeds[0].files)).toEqual(new Set(siblings));
  });

  test("does not fire on cohesive module (siblings import each other)", () => {
    const files = Array.from({ length: 5 }, (_, i) => `src/module/f${i}.ts`);
    const nodes = files.map((p) => node(p, 2, 2));
    const edges: FileLevelEdge[] = [];
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) edges.push(edge(files[i], files[j]));
    }
    // Also import from a shared parent — cohesion should still disqualify.
    const parent = "src/module/entry.ts";
    nodes.push(node(parent, 0, files.length));
    for (const f of files) edges.push(edge(parent, f));
    const seeds = detectDispatchDirectories({ level: "file", nodes, edges });
    expect(seeds).toHaveLength(0);
  });

  test("does not fire below sibling-count threshold", () => {
    const parent = "src/cli/router.ts";
    const siblings = ["src/cli/commands/a.ts", "src/cli/commands/b.ts", "src/cli/commands/c.ts"];
    const nodes = [node(parent, 0, siblings.length), ...siblings.map((p) => node(p, 1, 0))];
    const edges = siblings.map((s) => edge(parent, s));
    const seeds = detectDispatchDirectories({ level: "file", nodes, edges });
    expect(seeds).toHaveLength(0);
  });

  test("does not fire without a shared parent", () => {
    const siblings = Array.from({ length: 5 }, (_, i) => `src/cli/commands/cmd${i}.ts`);
    // Each sibling imported by a different unique parent — no single shared dispatcher.
    const parents = siblings.map((_, i) => `src/caller${i}.ts`);
    const nodes = [
      ...parents.map((p) => node(p, 0, 1)),
      ...siblings.map((p) => node(p, 1, 0)),
    ];
    const edges = siblings.map((s, i) => edge(parents[i], s));
    const seeds = detectDispatchDirectories({ level: "file", nodes, edges });
    expect(seeds).toHaveLength(0);
  });

  test("seedGroups forces scattered siblings into one community", () => {
    // Build a 2-clique graph, then seed across the boundary.
    const graph = twoCliques("src/cli/commands", "src/other", 5);
    // Without seeding: Louvain finds the two cliques.
    const baseline = detectFileCommunities(graph);
    const cliques = baseline.filter((m) => m.files.length >= 3);
    expect(cliques.length).toBeGreaterThanOrEqual(2);

    // With seedGroups: a mixed set from both cliques collapses into one community.
    const seededFiles = [
      "src/cli/commands/a0.ts",
      "src/cli/commands/a1.ts",
      "src/other/b0.ts",
      "src/other/b1.ts",
    ];
    const seeded = detectFileCommunities(graph, {
      seedGroups: [{ label: "merged", files: seededFiles }],
    });
    const merged = seeded.find((m) => m.name === "merged");
    expect(merged).toBeDefined();
    expect(new Set(merged!.files)).toEqual(new Set(seededFiles));
  });
});
