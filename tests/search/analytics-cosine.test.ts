import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { search } from "../../src/search/hybrid";
import { vectorScoreToCosine } from "../../src/db/search";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir } from "../helpers";

// Regression for B2: the analytics relevance signal must be a true cosine, not
// the L2-derived stored score `1/(1+distance)`. The stored score bottoms out at
// ~0.333, so a raw-score "< 0.3" low-relevance heuristic could never fire.

describe("vectorScoreToCosine", () => {
  // Stored score s = 1/(1+L2); for unit vectors L2 = sqrt(2(1-cos)).
  const scoreFor = (cos: number) => 1 / (1 + Math.sqrt(2 * (1 - cos)));

  test("identical vectors (cos 1, distance 0) -> cosine 1", () => {
    expect(vectorScoreToCosine(scoreFor(1))).toBeCloseTo(1, 5);
  });

  test("orthogonal vectors (cos 0) -> cosine 0, even though stored score ~0.414", () => {
    const s = scoreFor(0);
    expect(s).toBeCloseTo(0.4142, 3); // never below 0.3 on the raw scale
    expect(vectorScoreToCosine(s)).toBeCloseTo(0, 5);
  });

  test("mid similarity (cos 0.7071) round-trips", () => {
    expect(vectorScoreToCosine(scoreFor(0.7071))).toBeCloseTo(0.7071, 4);
  });

  test("the < 0.3 low-relevance heuristic becomes reachable", () => {
    // A weak top hit (raw score near the 0.333 floor) is >= 0.3 raw — the old
    // heuristic was dead — but its cosine is clearly < 0.3.
    const weakRaw = scoreFor(0.1); // cos 0.1 -> raw ~0.426
    expect(weakRaw).toBeGreaterThan(0.3);
    expect(vectorScoreToCosine(weakRaw)!).toBeLessThan(0.3);
  });

  test("null / non-positive scores map to null", () => {
    expect(vectorScoreToCosine(null)).toBeNull();
    expect(vectorScoreToCosine(undefined)).toBeNull();
    expect(vectorScoreToCosine(0)).toBeNull();
  });

  test("clamps out-of-range results to [-1, 1]", () => {
    // A degenerate (non-unit) embedding can push the stored score below the
    // normal ~0.333 floor; the raw conversion would then exceed cosine range.
    // score 0.2 → 1 - (1/0.2 - 1)²/2 = -7, must clamp to -1.
    expect(vectorScoreToCosine(0.2)).toBe(-1);
    expect(vectorScoreToCosine(1)).toBe(1); // distance 0 → cosine 1, stays in range
  });
});

describe("analytics logs cosine, not the raw L2 score", () => {
  let tempDir: string;
  let db: RagDB;

  beforeAll(async () => {
    await getEmbedder();
  });

  beforeEach(async () => {
    tempDir = await createTempDir();
    db = new RagDB(tempDir);
  });

  afterEach(async () => {
    db.close();
    await cleanupTempDir(tempDir);
  });

  async function seedDB() {
    const files = [
      { path: "/src/auth.ts", text: "JWT authentication middleware with token validation and refresh" },
      { path: "/src/db.ts", text: "PostgreSQL database connection pool and query builder" },
      { path: "/docs/api.md", text: "REST API endpoints for user CRUD operations" },
    ];
    for (const f of files) {
      const emb = await embed(f.text);
      db.upsertFile(f.path, `hash-${f.path}`, [{ snippet: f.text, embedding: emb }]);
    }
  }

  test("logged top_score equals the cosine of the raw top vector hit", async () => {
    await seedDB();
    const query = "database connection pool";

    await search(query, db, 5, 0, 0.5);

    // Independently recover the raw top vector score (1/(1+L2)).
    const rawTop = db.search(await embed(query), 20)[0]?.score;
    expect(rawTop).toBeGreaterThan(0.333); // raw score can never be < 0.3

    const analytics = db.getAnalytics(30);
    expect(analytics.totalQueries).toBe(1);
    // The logged value is the cosine, which differs from the raw L2 score.
    expect(analytics.avgTopScore!).toBeCloseTo(vectorScoreToCosine(rawTop)!, 5);
  });
});
