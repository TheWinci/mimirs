import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { runBenchmark, loadBenchmarkQueries, formatBenchmarkReport, type BenchmarkQuery } from "../../src/search/benchmark";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { writeFile } from "fs/promises";
import { join } from "path";

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
    { path: join(tempDir, "docs/setup.md"), text: "Install Bun runtime for TypeScript development and project setup" },
    { path: join(tempDir, "docs/api.md"), text: "REST API endpoints for user authentication and authorization" },
    { path: join(tempDir, "docs/database.md"), text: "SQLite database schema, migrations, and vector search configuration" },
    { path: join(tempDir, "docs/deploy.md"), text: "Production deployment runbook with Docker and Kubernetes" },
  ];

  for (const f of files) {
    const emb = await embed(f.text);
    db.upsertFile(f.path, `hash-${f.path}`, [{ snippet: f.text, embedding: emb }]);
  }
}

describe("loadBenchmarkQueries", () => {
  test("loads valid benchmark file", async () => {
    const benchPath = join(tempDir, "bench.json");
    await writeFile(benchPath, JSON.stringify([
      { query: "how to install", expected: ["docs/setup.md"] },
      { query: "auth flow", expected: ["docs/api.md"] },
    ]));

    const queries = await loadBenchmarkQueries(benchPath);
    expect(queries).toHaveLength(2);
    expect(queries[0].query).toBe("how to install");
  });

  test("rejects invalid format", async () => {
    const benchPath = join(tempDir, "bad.json");
    await writeFile(benchPath, JSON.stringify({ query: "test" }));

    expect(loadBenchmarkQueries(benchPath)).rejects.toThrow("JSON array");
  });

  test("rejects entries without expected array", async () => {
    const benchPath = join(tempDir, "bad2.json");
    await writeFile(benchPath, JSON.stringify([{ query: "test" }]));

    expect(loadBenchmarkQueries(benchPath)).rejects.toThrow("Invalid benchmark entry");
  });
});

describe("runBenchmark", () => {
  test("computes recall, MRR, and hit status", async () => {
    await seedDB();

    const queries: BenchmarkQuery[] = [
      { query: "database schema migrations", expected: ["docs/database.md"] },
      { query: "install setup TypeScript", expected: ["docs/setup.md"] },
    ];

    const summary = await runBenchmark(queries, db, tempDir);

    expect(summary.total).toBe(2);
    // Both queries should find their expected files
    for (const r of summary.results) {
      expect(r.hit).toBe(true);
      expect(r.recall).toBeGreaterThan(0);
      expect(r.reciprocalRank).toBeGreaterThan(0);
    }
    expect(summary.recallAtK).toBeGreaterThan(0);
    expect(summary.mrr).toBeGreaterThan(0);
  });

  test("reports misses for impossible queries", async () => {
    await seedDB();

    const queries: BenchmarkQuery[] = [
      { query: "quantum computing neural networks", expected: ["docs/quantum.md"] },
    ];

    const summary = await runBenchmark(queries, db, tempDir);
    expect(summary.results[0].hit).toBe(false);
    expect(summary.results[0].recall).toBe(0);
    expect(summary.results[0].reciprocalRank).toBe(0);
    expect(summary.zeroMissRate).toBe(1);
  });

  test("handles partial matches", async () => {
    await seedDB();

    const queries: BenchmarkQuery[] = [
      { query: "database setup", expected: ["docs/database.md", "docs/nonexistent.md"] },
    ];

    const summary = await runBenchmark(queries, db, tempDir);
    const r = summary.results[0];
    expect(r.hit).toBe(true);
    expect(r.recall).toBe(0.5); // found 1 of 2 expected
  });

  test("respects topK parameter", async () => {
    await seedDB();

    const queries: BenchmarkQuery[] = [
      { query: "TypeScript development", expected: ["docs/setup.md"] },
    ];

    const summary = await runBenchmark(queries, db, tempDir, 1);
    // With topK=1, only one result returned
    expect(summary.results[0].results.length).toBeLessThanOrEqual(1);
  });
});

describe("formatBenchmarkReport", () => {
  test("formats summary with failures", () => {
    const report = formatBenchmarkReport({
      total: 3,
      recallAtK: 0.67,
      mrr: 0.72,
      zeroMissRate: 0.33,
      results: [
        { query: "auth", expected: ["api.md"], results: [{ path: "api.md", score: 0.8 }], recall: 1, reciprocalRank: 1, hit: true },
        { query: "deploy", expected: ["deploy.md"], results: [{ path: "deploy.md", score: 0.6 }], recall: 1, reciprocalRank: 1, hit: true },
        { query: "quantum", expected: ["quantum.md"], results: [], recall: 0, reciprocalRank: 0, hit: false },
      ],
    });

    expect(report).toContain("Recall@5");
    expect(report).toContain("67.0%");
    expect(report).toContain("MRR");
    expect(report).toContain("Missed queries");
    expect(report).toContain("quantum");
  });

  test("formats clean report when all pass", () => {
    const report = formatBenchmarkReport({
      total: 1,
      recallAtK: 1,
      mrr: 1,
      zeroMissRate: 0,
      results: [
        { query: "test", expected: ["a.md"], results: [{ path: "a.md", score: 0.9 }], recall: 1, reciprocalRank: 1, hit: true },
      ],
    });

    expect(report).toContain("100.0%");
    expect(report).not.toContain("Missed queries");
  });
});
