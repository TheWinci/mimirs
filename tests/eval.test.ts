import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { loadEvalTasks, runEval, runEvalTask, formatEvalReport, type EvalTask } from "../src/eval";
import { RagDB } from "../src/db";
import { embed, getEmbedder } from "../src/embed";
import { createTempDir, cleanupTempDir } from "./helpers";
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
    { path: join(tempDir, "src/auth.ts"), text: "Authentication middleware handles JWT tokens and session management" },
    { path: join(tempDir, "src/retry.ts"), text: "Retry logic with exponential backoff for failed HTTP requests" },
    { path: join(tempDir, "docs/deploy.md"), text: "Deployment process using Docker containers and CI/CD pipeline" },
  ];

  for (const f of files) {
    const emb = await embed(f.text);
    db.upsertFile(f.path, `hash-${f.path}`, [{ snippet: f.text, embedding: emb }]);
  }
}

describe("loadEvalTasks", () => {
  test("loads valid eval file", async () => {
    const path = join(tempDir, "tasks.json");
    await writeFile(path, JSON.stringify([
      { task: "How does auth work?", grading: "must reference auth middleware" },
    ]));

    const tasks = await loadEvalTasks(path);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task).toBe("How does auth work?");
  });

  test("rejects invalid format", async () => {
    const path = join(tempDir, "bad.json");
    await writeFile(path, JSON.stringify([{ task: "no grading" }]));

    expect(loadEvalTasks(path)).rejects.toThrow("Invalid eval entry");
  });
});

describe("runEvalTask", () => {
  test("with-rag returns search results", async () => {
    await seedDB();

    const task: EvalTask = { task: "authentication JWT session", grading: "must reference auth" };
    const trace = await runEvalTask(task, db, tempDir, "with-rag");

    expect(trace.condition).toBe("with-rag");
    expect(trace.searchResults.length).toBeGreaterThan(0);
    expect(trace.filesReferenced.length).toBeGreaterThan(0);
    expect(trace.searchCount).toBe(1);
  });

  test("without-rag returns empty results", async () => {
    await seedDB();

    const task: EvalTask = { task: "authentication", grading: "must reference auth" };
    const trace = await runEvalTask(task, db, tempDir, "without-rag");

    expect(trace.condition).toBe("without-rag");
    expect(trace.searchResults).toHaveLength(0);
    expect(trace.filesReferenced).toHaveLength(0);
    expect(trace.searchCount).toBe(0);
  });
});

describe("runEval", () => {
  test("produces summary with both conditions", async () => {
    await seedDB();

    const tasks: EvalTask[] = [
      { task: "authentication JWT", grading: "must reference auth middleware", expectedFiles: ["src/auth.ts"] },
      { task: "retry failed requests", grading: "must reference retry logic", expectedFiles: ["src/retry.ts"] },
    ];

    const summary = await runEval(tasks, db, tempDir);

    expect(summary.totalTasks).toBe(2);
    expect(summary.traces).toHaveLength(4); // 2 tasks × 2 conditions
    expect(summary.withRag.avgSearchResults).toBeGreaterThan(0);
    expect(summary.withoutRag.avgSearchResults).toBe(0);
    expect(summary.withRag.fileHitRate).toBeGreaterThan(0);
    expect(summary.withoutRag.fileHitRate).toBe(0);
  });
});

describe("formatEvalReport", () => {
  test("formats summary table", () => {
    const report = formatEvalReport({
      totalTasks: 2,
      withRag: { avgSearchResults: 3.5, avgFilesReferenced: 3.5, avgDurationMs: 50, fileHitRate: 1 },
      withoutRag: { avgSearchResults: 0, avgFilesReferenced: 0, avgDurationMs: 0, fileHitRate: 0 },
      traces: [
        { task: "auth", grading: "check auth", condition: "with-rag", searchResults: [], filesReferenced: ["/src/auth.ts"], searchCount: 1, durationMs: 50 },
        { task: "auth", grading: "check auth", condition: "without-rag", searchResults: [], filesReferenced: [], searchCount: 0, durationMs: 0 },
      ],
    });

    expect(report).toContain("With RAG");
    expect(report).toContain("Without RAG");
    expect(report).toContain("100%");
    expect(report).toContain("0%");
  });
});
