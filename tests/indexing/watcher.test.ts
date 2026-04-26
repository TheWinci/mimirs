import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexFile } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { startWatcher } from "../../src/indexing/watcher";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";
import { unlink } from "fs/promises";

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

describe("indexFile", () => {
  test("indexes a new file", async () => {
    await writeFixture(tempDir, "doc.md", "# Setup\n\nInstall with bun install.");
    const config = await loadConfig(tempDir);
    const result = await indexFile(join(tempDir, "doc.md"), db, config);
    expect(result).toBe("indexed");

    const status = db.getStatus();
    expect(status.totalFiles).toBe(1);
  });

  test("skips unchanged file", async () => {
    await writeFixture(tempDir, "doc.md", "# Setup\n\nInstall with bun install.");
    const config = await loadConfig(tempDir);

    await indexFile(join(tempDir, "doc.md"), db, config);
    const result = await indexFile(join(tempDir, "doc.md"), db, config);
    expect(result).toBe("skipped");
  });

  test("re-indexes changed file", async () => {
    const filePath = join(tempDir, "doc.md");
    await writeFixture(tempDir, "doc.md", "# Version 1\n\nOriginal content.");
    const config = await loadConfig(tempDir);

    await indexFile(filePath, db, config);

    // Modify the file
    await writeFixture(tempDir, "doc.md", "# Version 2\n\nUpdated content with new info.");
    const result = await indexFile(filePath, db, config);
    expect(result).toBe("indexed");
  });

  test("skips empty file", async () => {
    await writeFixture(tempDir, "empty.md", "   ");
    const config = await loadConfig(tempDir);
    const result = await indexFile(join(tempDir, "empty.md"), db, config);
    expect(result).toBe("skipped");
  });

  test("returns error for missing file", async () => {
    const config = await loadConfig(tempDir);
    const result = await indexFile(join(tempDir, "nonexistent.md"), db, config);
    expect(result).toBe("error");
  });
});

describe("startWatcher", () => {
  test("starts and can be closed", async () => {
    const config = await loadConfig(tempDir);
    const events: string[] = [];
    const watcher = startWatcher(tempDir, db, config, (msg) => events.push(msg));

    expect(events).toContain(`Watching ${tempDir} for changes`);
    watcher.close();
  });

  test("detects new file and indexes it", async () => {
    const config = await loadConfig(tempDir);
    const events: string[] = [];
    const watcher = startWatcher(tempDir, db, config, (msg) => events.push(msg));

    // Write a new file
    await writeFixture(tempDir, "new-doc.md", "# New\n\nBrand new documentation.");

    // Poll for indexing (debounce 2s + processing time varies)
    let indexed = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (db.getStatus().totalFiles >= 1) {
        indexed = true;
        break;
      }
    }

    expect(indexed).toBe(true);

    watcher.close();
  });

  test("detects file deletion and removes from index", async () => {
    // Pre-index a file
    await writeFixture(tempDir, "to-delete.md", "# Delete me\n\nThis will be removed.");
    const config = await loadConfig(tempDir);
    await indexFile(join(tempDir, "to-delete.md"), db, config);
    expect(db.getStatus().totalFiles).toBe(1);

    const events: string[] = [];
    const watcher = startWatcher(tempDir, db, config, (msg) => events.push(msg));

    // Delete the file
    await unlink(join(tempDir, "to-delete.md"));

    // Wait for fs.watch + debounce + processing (poll to avoid flakiness)
    let removed = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (db.getStatus().totalFiles === 0) {
        removed = true;
        break;
      }
    }

    expect(removed).toBe(true);

    watcher.close();
  });

  test("detects edit to existing file and re-indexes it", async () => {
    // Pre-index a file
    const filePath = join(tempDir, "edit-me.md");
    await writeFixture(tempDir, "edit-me.md", "# Version 1\n\nOriginal content.");
    const config = await loadConfig(tempDir);
    await indexFile(filePath, db, config);
    const before = db.getFileByPath(filePath);
    expect(before).not.toBeNull();
    const originalHash = before!.hash;

    const events: string[] = [];
    const watcher = startWatcher(tempDir, db, config, (msg) => events.push(msg));

    // Mutate file content after watcher is running
    await writeFixture(tempDir, "edit-me.md", "# Version 2\n\nCompletely different content with new info.");

    // Poll for hash change (debounce + processing varies)
    let reindexed = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const after = db.getFileByPath(filePath);
      if (after && after.hash !== originalHash) {
        reindexed = true;
        break;
      }
    }

    expect(reindexed).toBe(true);

    watcher.close();
  });

  test("ignores excluded paths", async () => {
    const config = await loadConfig(tempDir);
    config.exclude = [...config.exclude, "**/*.log"];
    const events: string[] = [];
    const watcher = startWatcher(tempDir, db, config, (msg) => events.push(msg));

    // Write an excluded file
    await writeFixture(tempDir, "debug.log", "some log output");

    await new Promise((r) => setTimeout(r, 3000));

    // Should not have indexed it
    expect(db.getStatus().totalFiles).toBe(0);

    watcher.close();
  });
});
