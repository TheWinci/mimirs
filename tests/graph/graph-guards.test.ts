import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { resolveSymbol, impactWalk, tracePath } from "../../src/graph/trace";
import type { RagConfig } from "../../src/config";

// Part 2 #6: termination on cycles/recursion (the walk must not hang) and the
// ambient high-fan-in prune (a hot node is cited, not expanded). Neither had
// any coverage despite "must not regress" comments in trace.ts.

let tempDir: string;
let db: RagDB;
const N_CALLERS = 30; // > AMBIENT_FANIN (25)

const tsConfig: RagConfig = {
  include: ["**/*.ts"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 2048,
  chunkOverlap: 50,
};

beforeAll(async () => {
  await getEmbedder();
  tempDir = await createTempDir();
  db = new RagDB(tempDir);

  // A 3-cycle across files: a → b → c → a.
  await writeFixture(tempDir, "src/ca.ts", `import { b } from "./cb";\nexport function a(): number { return b() + 1; }\n`);
  await writeFixture(tempDir, "src/cb.ts", `import { c } from "./cc";\nexport function b(): number { return c() + 1; }\n`);
  await writeFixture(tempDir, "src/cc.ts", `import { a } from "./ca";\nexport function c(): number { return a() + 1; }\n`);

  // Self-recursion.
  await writeFixture(tempDir, "src/fact.ts", `export function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }\n`);

  // Ambient fan-in: leaf ← hot ← N callers.
  await writeFixture(tempDir, "src/leaf.ts", `export function leaf(): number { return 0; }\n`);
  await writeFixture(tempDir, "src/hot.ts", `import { leaf } from "./leaf";\nexport function hot(): number { return leaf(); }\n`);
  for (let i = 0; i < N_CALLERS; i++) {
    await writeFixture(
      tempDir,
      `src/caller${i}.ts`,
      `import { hot } from "./hot";\nexport function caller${i}(): number { return hot(); }\n`,
    );
  }

  await indexDirectory(tempDir, db, tsConfig);
});

afterAll(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

describe("cycle and recursion termination", () => {
  test("impactWalk terminates on a 3-cycle with a finite, deduped caller set", () => {
    const root = resolveSymbol(db, "a").node!;
    const res = impactWalk(db, root, { maxDepth: 6 });
    // Reaching this line at all proves termination. The 3-cycle dedups to a
    // bounded set (its 3 nodes), never an unbounded walk — the root re-surfaces
    // as a "seen" caller, so the count is 2-3, never infinite.
    expect(res.totalCallers).toBeGreaterThan(0);
    expect(res.totalCallers).toBeLessThanOrEqual(3);
    expect(res.tree.children.map((c) => c.node.name)).toEqual(["c"]); // direct caller of a
  });

  test("tracePath terminates and finds a path along the cycle", () => {
    const from = resolveSymbol(db, "a").node!;
    const to = resolveSymbol(db, "c").node!;
    const res = tracePath(db, from, to);
    expect(res.found).toBe(true);
    expect(res.spine[0].name).toBe("a");
    expect(res.spine[res.spine.length - 1].name).toBe("c");
  });

  test("self-recursion has no external callers and terminates", () => {
    const root = resolveSymbol(db, "fact").node!;
    const res = impactWalk(db, root, { maxDepth: 6 });
    expect(res.totalCallers).toBe(0); // self-edges are stripped
  });
});

describe("ambient high-fan-in prune", () => {
  test("a node with > AMBIENT_FANIN callers is cited, not expanded", () => {
    const root = resolveSymbol(db, "leaf").node!;
    const res = impactWalk(db, root, { maxDepth: 6 });

    const hotChild = res.tree.children.find((c) => c.node.name === "hot");
    expect(hotChild).toBeDefined();
    expect(hotChild!.ambient).toBe(true); // not expanded into its 30 callers
    expect(res.ambientNames.get("hot")).toBe(N_CALLERS);
    expect(res.truncated).toBe(true);

    // The count pass ignores the ambient prune — the total stays honest.
    expect(res.totalCallers).toBe(N_CALLERS + 1); // hot + its N callers
  });
});
