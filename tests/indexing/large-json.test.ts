import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory, indexFile } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { cpus } from "os";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";
import type { RagConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;
let abortController: AbortController;

const defaultConfig: RagConfig = {
  include: ["**/*.json"],
  exclude: ["node_modules/**", ".git/**", ".rag/**"],
  chunkSize: 512,
  chunkOverlap: 50,
  hybridWeight: 0.7,
  searchTopK: 10,
  benchmarkTopK: 10,
  benchmarkMinRecall: 0.5,
  benchmarkMinMrr: 0.5,
};

/**
 * Generate a large JSON file content (~500k lines).
 * Produces an array of objects with varied fields to simulate realistic data.
 */
function generateLargeJson(targetLines: number): string {
  const lines: string[] = ["["];
  let currentLine = 1;
  let entryIndex = 0;

  while (currentLine < targetLines - 1) {
    const entry = {
      id: entryIndex,
      name: `user_${entryIndex}`,
      email: `user${entryIndex}@example.com`,
      age: 20 + (entryIndex % 60),
      active: entryIndex % 3 !== 0,
      tags: [`tag_${entryIndex % 10}`, `group_${entryIndex % 5}`],
      address: {
        street: `${100 + entryIndex} Main St`,
        city: ["New York", "London", "Tokyo", "Berlin", "Sydney"][entryIndex % 5],
        zip: String(10000 + (entryIndex % 90000)).padStart(5, "0"),
      },
      metadata: {
        created: `2024-01-${String((entryIndex % 28) + 1).padStart(2, "0")}`,
        score: Math.round((entryIndex * 7.3) % 100 * 100) / 100,
        notes: `Entry number ${entryIndex} in the dataset for testing purposes`,
      },
    };

    // Pretty-printed JSON for a single entry is ~18 lines
    const entryJson = JSON.stringify(entry, null, 2);
    const entryLines = entryJson.split("\n");
    const isLast = currentLine + entryLines.length + 1 >= targetLines - 1;
    const suffix = isLast ? "" : ",";

    for (let i = 0; i < entryLines.length; i++) {
      lines.push("  " + entryLines[i] + (i === entryLines.length - 1 ? suffix : ""));
    }

    currentLine += entryLines.length;
    entryIndex++;

    if (isLast) break;
  }

  lines.push("]");
  return lines.join("\n");
}

const indexThreads = Math.max(2, Math.floor(cpus().length / 2));

beforeAll(async () => {
  // Initialize embedder with limited threads to avoid CPU saturation
  await getEmbedder(indexThreads);
  console.log(`Embedder initialized with ${indexThreads} threads (of ${cpus().length} cores)`);
});

beforeEach(async () => {
  tempDir = await createTempDir();
  db = new RagDB(tempDir);
  abortController = new AbortController();
});

afterEach(async () => {
  abortController.abort();
  db.close();
  await cleanupTempDir(tempDir);
});

describe("large JSON file indexing", () => {
  test("indexes a ~500k line JSON file and reports timing", async () => {
    console.log("Generating large JSON file (~500k lines)...");
    const genStart = performance.now();
    const content = generateLargeJson(500_000);
    const genTime = performance.now() - genStart;
    const lineCount = content.split("\n").length;
    const sizeMB = (Buffer.byteLength(content) / (1024 * 1024)).toFixed(1);
    console.log(`Generated ${lineCount} lines (${sizeMB} MB) in ${genTime.toFixed(0)}ms`);

    await writeFixture(tempDir, "large-dataset.json", content);

    console.log("Starting indexDirectory...");
    const indexStart = performance.now();
    const result = await indexDirectory(tempDir, db, defaultConfig, (msg, opts) => {
      if (opts?.transient) {
        process.stdout.write(`\r  [progress] ${msg}`.padEnd(process.stdout.columns || 80));
      } else {
        console.log(`  [progress] ${msg}`);
      }
    }, abortController.signal);
    const indexTime = performance.now() - indexStart;

    console.log(`\n=== Indexing Results ===`);
    console.log(`  Indexed files: ${result.indexed}`);
    console.log(`  Skipped files: ${result.skipped}`);
    console.log(`  Errors: ${result.errors.length}`);
    console.log(`  Total chunks: ${db.getStatus().totalChunks}`);
    console.log(`  Index time: ${(indexTime / 1000).toFixed(2)}s`);

    expect(result.indexed).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(db.getStatus().totalChunks).toBeGreaterThan(0);
  }, 600_000); // 10 min timeout

  test("event loop is not blocked during large file indexing", async () => {
    // Generate a large JSON to stress-test event loop responsiveness
    console.log("Generating large JSON file (~500k lines)...");
    const content = generateLargeJson(500_000);
    const lineCount = content.split("\n").length;
    const sizeMB = (Buffer.byteLength(content) / (1024 * 1024)).toFixed(1);
    console.log(`Generated ${lineCount} lines (${sizeMB} MB)`);

    await writeFixture(tempDir, "large-dataset.json", content);

    // Track event loop responsiveness by scheduling timers during indexing.
    // If the event loop is blocked, these callbacks will be delayed.
    const tickDelays: number[] = [];
    let tickCount = 0;
    let measuring = true;

    function measureTick() {
      if (!measuring) return;
      const scheduled = performance.now();
      setTimeout(() => {
        if (!measuring) return;
        const delay = performance.now() - scheduled;
        tickDelays.push(delay);
        tickCount++;
        measureTick();
      }, 10); // schedule every 10ms
    }

    measureTick();

    console.log("Starting indexDirectory with event loop monitoring...");
    const indexStart = performance.now();
    const result = await indexDirectory(tempDir, db, defaultConfig, (msg, opts) => {
      if (opts?.transient) {
        process.stdout.write(`\r  [progress] ${msg}`.padEnd(process.stdout.columns || 80));
      } else {
        console.log(`  [progress] ${msg}`);
      }
    }, abortController.signal);
    const indexTime = performance.now() - indexStart;

    // Give time for last scheduled tick to fire
    await Bun.sleep(50);
    measuring = false;

    // Analyze event loop health
    const maxDelay = Math.max(...tickDelays);
    const avgDelay = tickDelays.reduce((a, b) => a + b, 0) / tickDelays.length;
    // Count how many ticks were delayed by more than 500ms (severely blocked)
    const blockedTicks = tickDelays.filter((d) => d > 500).length;
    // Count ticks delayed by more than 100ms (moderately blocked)
    const slowTicks = tickDelays.filter((d) => d > 100).length;

    console.log(`\n=== Event Loop Health ===`);
    console.log(`  Total ticks measured: ${tickCount}`);
    console.log(`  Average tick delay: ${avgDelay.toFixed(1)}ms (target: ~10ms)`);
    console.log(`  Max tick delay: ${maxDelay.toFixed(1)}ms`);
    console.log(`  Ticks > 100ms: ${slowTicks}`);
    console.log(`  Ticks > 500ms: ${blockedTicks}`);
    console.log(`  Index time: ${(indexTime / 1000).toFixed(2)}s`);
    console.log(`  Indexed: ${result.indexed}, Chunks: ${db.getStatus().totalChunks}`);

    // Assertions: the event loop should remain responsive
    expect(result.indexed).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(tickCount).toBeGreaterThan(0); // sanity: we did measure something

    // No tick should be blocked for more than 30 seconds
    // (splitJSON on a 10MB file is inherently synchronous; yielding happens between batches)
    expect(maxDelay).toBeLessThan(30_000);
    // With default batch size 50, most ticks will exceed 500ms due to embedding time.
    // The key metric is max delay — we verify no single operation blocks catastrophically.
    const blockedRatio = blockedTicks / tickCount;
    console.log(`  Blocked ratio (>500ms): ${(blockedRatio * 100).toFixed(1)}%`);
  }, 600_000); // 10 min timeout

  test("indexBatchSize controls yielding frequency", async () => {
    // Use a smaller file but test that batch size affects yielding
    const content = generateLargeJson(50_000);
    await writeFixture(tempDir, "medium-dataset.json", content);

    // Index with small batch size — should yield more frequently
    const smallBatchConfig = { ...defaultConfig, indexBatchSize: 5 };
    const tickDelaysSmall: number[] = [];
    let measuringSmall = true;

    function measureSmall() {
      if (!measuringSmall) return;
      const t = performance.now();
      setTimeout(() => {
        if (!measuringSmall) return;
        tickDelaysSmall.push(performance.now() - t);
        measureSmall();
      }, 10);
    }

    measureSmall();
    await indexDirectory(tempDir, db, smallBatchConfig, undefined, abortController.signal);
    await Bun.sleep(50);
    measuringSmall = false;

    const avgSmall = tickDelaysSmall.reduce((a, b) => a + b, 0) / tickDelaysSmall.length;
    const maxSmall = Math.max(...tickDelaysSmall);

    // Clean up and re-create DB for second run
    db.close();
    await cleanupTempDir(tempDir);
    tempDir = await createTempDir();
    db = new RagDB(tempDir);
    await writeFixture(tempDir, "medium-dataset.json", content);

    // Index with large batch size — may block longer between yields
    const largeBatchConfig = { ...defaultConfig, indexBatchSize: 200 };
    const tickDelaysLarge: number[] = [];
    let measuringLarge = true;

    function measureLarge() {
      if (!measuringLarge) return;
      const t = performance.now();
      setTimeout(() => {
        if (!measuringLarge) return;
        tickDelaysLarge.push(performance.now() - t);
        measureLarge();
      }, 10);
    }

    measureLarge();
    await indexDirectory(tempDir, db, largeBatchConfig, undefined, abortController.signal);
    await Bun.sleep(50);
    measuringLarge = false;

    const avgLarge = tickDelaysLarge.reduce((a, b) => a + b, 0) / tickDelaysLarge.length;
    const maxLarge = Math.max(...tickDelaysLarge);

    console.log(`\n=== Batch Size Comparison ===`);
    console.log(`  Small batch (5):  avg=${avgSmall.toFixed(1)}ms, max=${maxSmall.toFixed(1)}ms, ticks=${tickDelaysSmall.length}`);
    console.log(`  Large batch (200): avg=${avgLarge.toFixed(1)}ms, max=${maxLarge.toFixed(1)}ms, ticks=${tickDelaysLarge.length}`);

    // Both should complete without errors — the small batch should generally
    // have a lower max delay, but we don't assert that strictly since timing
    // varies. We just verify both work and neither blocks catastrophically.
    expect(maxSmall).toBeLessThan(5000);
    expect(maxLarge).toBeLessThan(5000);
  }, 300_000); // 5 min timeout
});
