import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import {
  resolveSymbol,
  impactWalk,
  tracePath,
  collectTests,
  affectedTests,
  directCallees,
  nodeKey,
} from "../../src/graph/trace";
import type { RagConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;

const tsConfig: RagConfig = {
  include: ["**/*.ts"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 2048,
  chunkOverlap: 50,
};

// A known call graph:
//   handleRequest ─┐                ┌─ persist ─┐
//                  ├─► processJob ──┤            ├─► writeRow
//   cacheWarm ─────┘                └─ flush ───┘
beforeAll(async () => {
  await getEmbedder();
  tempDir = await createTempDir();
  db = new RagDB(tempDir);

  await writeFixture(tempDir, "src/target.ts", `export function writeRow(x: number) {\n  return x;\n}\n`);
  await writeFixture(
    tempDir,
    "src/db.ts",
    `import { writeRow } from "./target";\n\nexport function persist(x: number) {\n  return writeRow(x);\n}\n\nexport function flush(x: number) {\n  return writeRow(x + 1);\n}\n`,
  );
  await writeFixture(
    tempDir,
    "src/jobs.ts",
    `import { persist, flush } from "./db";\n\nexport function processJob(x: number) {\n  return persist(x) + flush(x);\n}\n`,
  );
  await writeFixture(
    tempDir,
    "src/server.ts",
    `import { processJob } from "./jobs";\n\nexport function handleRequest(x: number) {\n  return processJob(x);\n}\n\nexport function cacheWarm(x: number) {\n  return processJob(x);\n}\n`,
  );

  // Ambiguity fixtures — same name, two files.
  await writeFixture(tempDir, "src/dup1.ts", `export function dup() {\n  return 1;\n}\n`);
  await writeFixture(tempDir, "src/dup2.ts", `export function dup() {\n  return 2;\n}\n`);

  // Test fixtures: one references writeRow directly (precise), one only imports
  // server.ts (transitively imports target.ts → broad).
  await writeFixture(
    tempDir,
    "tests/write.test.ts",
    `import { writeRow } from "../src/target";\n\ntest("writeRow", () => {\n  expect(writeRow(1)).toBe(1);\n});\n`,
  );
  await writeFixture(
    tempDir,
    "tests/server.test.ts",
    `import { handleRequest } from "../src/server";\n\ntest("server", () => {\n  handleRequest(1);\n});\n`,
  );

  // A deep linear chain c0 → c1 → … → c15 (15 hops). Longer than the old
  // bidirectional cap (2 × maxDepth = 12 with the former default 6), so the
  // capped search would have falsely reported "no path". Reachability is now
  // uncapped, so it must be found.
  const N = 16;
  let chain = "";
  for (let i = 0; i < N; i++) {
    chain += i < N - 1
      ? `export function c${i}(x: number) {\n  return c${i + 1}(x);\n}\n`
      : `export function c${i}(x: number) {\n  return x;\n}\n`;
  }
  await writeFixture(tempDir, "src/chain.ts", chain);

  await indexDirectory(tempDir, db, tsConfig);
});

afterAll(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

describe("resolveSymbol", () => {
  test("resolves a unique exported callable", () => {
    const r = resolveSymbol(db, "writeRow");
    expect(r.status).toBe("ok");
    expect(r.node?.name).toBe("writeRow");
    expect(r.node?.kind).toBe("export");
  });

  test("reports not_found for an unknown name", () => {
    expect(resolveSymbol(db, "doesNotExist").status).toBe("not_found");
  });

  test("reports ambiguous when a name is defined twice", () => {
    const r = resolveSymbol(db, "dup");
    expect(r.status).toBe("ambiguous");
    expect(r.candidates?.length).toBe(2);
  });

  test("disambiguates by file", () => {
    const r = resolveSymbol(db, "dup", "src/dup1.ts");
    expect(r.status).toBe("ok");
    expect(r.node?.filePath.endsWith("dup1.ts")).toBe(true);
  });
});

describe("impactWalk", () => {
  test("finds transitive callers grouped across files", () => {
    const root = resolveSymbol(db, "writeRow").node!;
    const res = impactWalk(db, root, { maxDepth: 3 });
    // persist, flush (d1), processJob (d2), handleRequest, cacheWarm (d3)
    expect(res.totalCallers).toBe(5);
    expect(res.shownCallers).toBe(5); // all within depth 3
    // db.ts, jobs.ts, server.ts
    expect(res.totalFiles).toBe(3);

    const directCallers = res.tree.children.map((c) => c.node.name).sort();
    expect(directCallers).toEqual(["flush", "persist"]);
  });

  test("depth limit bounds the tree but the total count stays honest", () => {
    const root = resolveSymbol(db, "writeRow").node!;
    const res = impactWalk(db, root, { maxDepth: 1 });
    expect(res.shownCallers).toBe(2); // only direct callers printed
    expect(res.totalCallers).toBe(5); // full transitive count still reported
    expect(res.totalFiles).toBe(3); // full file count too
    expect(res.truncated).toBe(true);
  });

  test("an entry point has zero callers", () => {
    const root = resolveSymbol(db, "handleRequest").node!;
    const res = impactWalk(db, root, { maxDepth: 3 });
    expect(res.totalCallers).toBe(0);
    expect(res.shownCallers).toBe(0);
  });
});

describe("tracePath", () => {
  test("finds the sub-graph and shortest spine from source to target", () => {
    const from = resolveSymbol(db, "handleRequest").node!;
    const to = resolveSymbol(db, "writeRow").node!;
    const res = tracePath(db, from, to);

    expect(res.found).toBe(true);
    // handleRequest, processJob, persist, flush, writeRow — cacheWarm excluded
    // (not forward-reachable from handleRequest).
    expect(res.subgraphSize).toBe(5);

    expect(res.spine[0].name).toBe("handleRequest");
    expect(res.spine[res.spine.length - 1].name).toBe("writeRow");
    expect(res.spine.length - 1).toBe(3); // 3 hops

    // The tree branches at processJob into persist + flush, both reaching writeRow.
    const flat: string[] = [];
    const walk = (t: typeof res.tree): void => {
      if (!t) return;
      flat.push(t.node.name);
      t.children.forEach(walk);
    };
    walk(res.tree);
    expect(flat).toContain("persist");
    expect(flat).toContain("flush");
  });

  test("reports no path when the target is not forward-reachable", () => {
    const from = resolveSymbol(db, "flush").node!;
    const to = resolveSymbol(db, "handleRequest").node!;
    const res = tracePath(db, from, to);
    expect(res.found).toBe(false);
    expect(res.spine).toEqual([]);
  });

  test("finds a path longer than the old bidirectional cap (reachability is uncapped)", () => {
    const from = resolveSymbol(db, "c0").node!;
    const to = resolveSymbol(db, "c15").node!;
    const res = tracePath(db, from, to);
    expect(res.found).toBe(true);
    // c0 → c1 → … → c15 = 15 hops. The old default (maxDepth 6, bidirectional
    // reach 12) would have returned found:false here.
    expect(res.spine.length - 1).toBe(15);
    expect(res.spine[0].name).toBe("c0");
    expect(res.spine[res.spine.length - 1].name).toBe("c15");
  });

  test("maxNodes bounds the drawn tree but subgraphSize stays the true total", () => {
    const from = resolveSymbol(db, "c0").node!;
    const to = resolveSymbol(db, "c15").node!;
    const res = tracePath(db, from, to, { budget: 3 });
    expect(res.found).toBe(true);
    // The full connecting chain is 16 nodes regardless of the draw budget.
    expect(res.subgraphSize).toBe(16);
    // Spine is always kept whole even under a tight budget.
    expect(res.spine.length).toBe(16);
  });

  test("source equal to target is trivially found", () => {
    const n = resolveSymbol(db, "writeRow").node!;
    const res = tracePath(db, n, n);
    expect(res.found).toBe(true);
    expect(res.subgraphSize).toBe(1);
    expect(nodeKey(res.from)).toBe(nodeKey(res.to));
  });

  // Part 2 #6: a failed trace must still hand back actionable frontiers — the
  // only useful output of a no-path result. These were never asserted.
  test("no-path result populates forward and backward frontiers", () => {
    // flush reaches only writeRow; persist is NOT forward-reachable from flush.
    const from = resolveSymbol(db, "flush").node!;
    const to = resolveSymbol(db, "persist").node!;
    const res = tracePath(db, from, to);

    expect(res.found).toBe(false);
    expect(res.spine).toEqual([]);
    // Deepest nodes reached going forward from `flush` (e.g. writeRow).
    expect(res.forwardFrontier && res.forwardFrontier.length).toBeGreaterThan(0);
    // Direct callers of the target `persist` — processJob calls it.
    expect((res.backwardFrontier ?? []).map((n) => n.name)).toContain("processJob");
  });
});

describe("directCallees", () => {
  test("lists the direct callees of a function, resolved", () => {
    const node = resolveSymbol(db, "processJob").node!;
    const names = directCallees(db, node).map((c) => c.name).sort();
    // processJob calls persist + flush (one hop); not writeRow (two hops).
    expect(names).toEqual(["flush", "persist"]);
  });

  test("a leaf function has no callees", () => {
    const node = resolveSymbol(db, "writeRow").node!;
    expect(directCallees(db, node).length).toBe(0);
  });
});

describe("collectTests", () => {
  test("splits precise (by name) from broad (by import)", () => {
    const root = resolveSymbol(db, "writeRow").node!;
    const tests = collectTests(db, root, tempDir);

    expect(tests.precise.some((p) => p.endsWith("write.test.ts"))).toBe(true);
    expect(tests.broad.some((p) => p.endsWith("server.test.ts"))).toBe(true);

    // No double-counting: a precise file never appears in broad.
    expect(tests.broad.some((p) => p.endsWith("write.test.ts"))).toBe(false);
    expect(tests.precise.some((p) => p.endsWith("server.test.ts"))).toBe(false);
  });
});

describe("affectedTests", () => {
  test("changing a leaf surfaces every transitively-importing test", () => {
    const res = affectedTests(db, [join(tempDir, "src/target.ts")], tempDir);
    // write.test imports target directly; server.test reaches it via server→jobs→db.
    expect(res.tests.some((p) => p.endsWith("write.test.ts"))).toBe(true);
    expect(res.tests.some((p) => p.endsWith("server.test.ts"))).toBe(true);
    expect(res.unknown.length).toBe(0);
  });

  test("changing a mid file excludes tests that don't reach it", () => {
    const res = affectedTests(db, [join(tempDir, "src/db.ts")], tempDir);
    expect(res.tests.some((p) => p.endsWith("server.test.ts"))).toBe(true);
    // write.test imports target, not db — so changing db can't affect it.
    expect(res.tests.some((p) => p.endsWith("write.test.ts"))).toBe(false);
    expect(res.changed.some((p) => p.endsWith("db.ts"))).toBe(true);
  });

  test("unknown input files are reported, not crashed on", () => {
    const res = affectedTests(db, [join(tempDir, "src/nope.ts")], tempDir);
    expect(res.unknown.length).toBe(1);
    expect(res.tests.length).toBe(0);
  });
});
