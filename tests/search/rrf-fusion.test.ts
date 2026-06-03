import { describe, test, expect } from "bun:test";
import { rrfFuse, mergeHybridScores, DEFAULT_HYBRID_WEIGHT } from "../../src/search/hybrid";

// Part 2 #1: rrfFuse / mergeHybridScores is the single source of truth for all
// hybrid ranking but was only exercised end-to-end. These pin its contract:
// rank-based scoring, weight semantics, dedup, field precedence, K, and
// order-independence.

type Item = { id: string; score: number; tag?: string };
const byId = (r: Item) => r.id;
const RRF_K = 60;
const sortByScore = (xs: Item[]) => [...xs].sort((a, b) => b.score - a.score);
const scoreOf = (xs: Item[], id: string) => xs.find((x) => x.id === id)!.score;

describe("rrfFuse", () => {
  test("an item at rank 0 in both lists scores weight*1 + (1-weight)*1 = 1", () => {
    const fused = rrfFuse([{ id: "a", score: 0.9 }], [{ id: "a", score: 0.1 }], 0.5, byId);
    expect(fused).toHaveLength(1);
    expect(scoreOf(fused, "a")).toBeCloseTo(1.0, 6);
  });

  test("a primary-only item at rank 0 scores weight; secondary-only scores (1-weight)", () => {
    const fused = rrfFuse([{ id: "p", score: 5 }], [{ id: "s", score: 5 }], 0.7, byId);
    expect(scoreOf(fused, "p")).toBeCloseTo(0.7, 6);
    expect(scoreOf(fused, "s")).toBeCloseTo(0.3, 6);
  });

  test("weight=1 ignores the secondary list (secondary-only items score 0)", () => {
    const fused = rrfFuse([{ id: "p", score: 1 }], [{ id: "s", score: 1 }], 1, byId);
    expect(scoreOf(fused, "p")).toBeCloseTo(1, 6);
    expect(scoreOf(fused, "s")).toBeCloseTo(0, 6);
  });

  test("weight=0 ignores the primary list (primary-only items score 0)", () => {
    const fused = rrfFuse([{ id: "p", score: 1 }], [{ id: "s", score: 1 }], 0, byId);
    expect(scoreOf(fused, "p")).toBeCloseTo(0, 6);
    expect(scoreOf(fused, "s")).toBeCloseTo(1, 6);
  });

  test("output length equals the union size (dedup by key)", () => {
    const fused = rrfFuse(
      [{ id: "a", score: 1 }, { id: "b", score: 1 }],
      [{ id: "b", score: 1 }, { id: "c", score: 1 }],
      0.5,
      byId,
    );
    expect(fused.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
  });

  test("a deduped item keeps the PRIMARY object's non-score fields", () => {
    const fused = rrfFuse([{ id: "x", score: 9, tag: "P" }], [{ id: "x", score: 1, tag: "S" }], 0.5, byId);
    expect(fused.find((x) => x.id === "x")!.tag).toBe("P");
  });

  test("RRF_K=60 sets the rank decay: rank 1 in primary-only scores weight*60/61", () => {
    const fused = rrfFuse([{ id: "r0", score: 1 }, { id: "r1", score: 1 }], [], 1, byId);
    expect(scoreOf(fused, "r0")).toBeCloseTo(1, 6);
    expect(scoreOf(fused, "r1")).toBeCloseTo(RRF_K / (RRF_K + 1), 6);
  });

  test("order-independent: rrfFuse(a,b,w) and rrfFuse(b,a,1-w) give equal scores per key", () => {
    const a: Item[] = [{ id: "x", score: 1 }, { id: "y", score: 1 }, { id: "z", score: 1 }];
    const b: Item[] = [{ id: "y", score: 1 }, { id: "w", score: 1 }];
    const f1 = rrfFuse(a, b, 0.65, byId);
    const f2 = rrfFuse(b, a, 0.35, byId);
    for (const id of ["x", "y", "z", "w"]) {
      expect(scoreOf(f1, id)).toBeCloseTo(scoreOf(f2, id), 6);
    }
  });

  test("higher rank in either list beats lower rank after sorting", () => {
    // top of primary vs deep in secondary
    const fused = sortByScore(
      rrfFuse(
        [{ id: "top", score: 1 }, ...Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, score: 1 }))],
        [{ id: "deep", score: 1 }],
        0.5,
        byId,
      ),
    );
    expect(fused[0].id).toBe("top");
  });
});

// Part 2 #2: the read_relevant default threshold (0.3) is coupled to the RRF
// scale — a hit present in only ONE list caps at its list's weight. This pins
// that coupling so a change to RRF_K or the default weight that would amputate
// single-list recall is caught.
describe("scoring contract: 0.3 threshold vs single-list recall", () => {
  const THRESHOLD = 0.3; // read_relevant / search default (src/tools/search.ts)

  test("the default hybrid weight is balanced (0.5), so neither list is starved below threshold", () => {
    expect(DEFAULT_HYBRID_WEIGHT).toBe(0.5);
    // vector-only and BM25-only rank-0 hits both clear the threshold at 0.5.
    expect(scoreOf(rrfFuse([{ id: "v", score: 1 }], [], DEFAULT_HYBRID_WEIGHT, byId), "v")).toBeGreaterThan(THRESHOLD);
    expect(scoreOf(rrfFuse([], [{ id: "t", score: 1 }], DEFAULT_HYBRID_WEIGHT, byId), "t")).toBeGreaterThan(THRESHOLD);
  });

  test("a single-list hit's ceiling is its list weight (so weight must exceed the threshold)", () => {
    expect(scoreOf(rrfFuse([{ id: "v", score: 1 }], [], 0.5, byId), "v")).toBeCloseTo(0.5, 6);
    expect(scoreOf(rrfFuse([], [{ id: "t", score: 1 }], 0.5, byId), "t")).toBeCloseTo(0.5, 6);
  });

  test("at weight 0.7 a BM25-only hit past rank 0 already drops below the 0.3 threshold", () => {
    // (1-0.7) * 60/61 ≈ 0.295 < 0.3 — the amputation the old 70/30 default caused.
    const fused = rrfFuse([], [{ id: "r0", score: 1 }, { id: "r1", score: 1 }], 0.7, byId);
    expect(scoreOf(fused, "r1")).toBeLessThan(THRESHOLD);
  });
});

describe("mergeHybridScores keys by path:chunkIndex", () => {
  test("same path different chunkIndex are distinct; same path+index dedups", () => {
    const v = [
      { path: "/a.ts", chunkIndex: 0, score: 1 },
      { path: "/a.ts", chunkIndex: 1, score: 1 },
    ];
    const t = [{ path: "/a.ts", chunkIndex: 0, score: 1 }];
    const fused = mergeHybridScores(v, t, 0.5);
    expect(fused).toHaveLength(2); // (a:0) deduped, (a:1) kept
    const a0 = fused.find((r) => r.chunkIndex === 0)!;
    expect(a0.score).toBeCloseTo(1, 6); // present in both at rank 0
  });
});
