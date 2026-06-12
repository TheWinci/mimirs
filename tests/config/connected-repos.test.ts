import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";
import { createTempDir, cleanupTempDir } from "../helpers";
import {
  addConnectedRepo,
  loadConfig,
  readConnectedReposSync,
  removeConnectedRepo,
} from "../../src/config";
import { resolveProject } from "../../src/tools";
import { RagDB } from "../../src/db";

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempDir();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("connectedRepos config", () => {
  test("parses entries and defaults to empty", async () => {
    let config = await loadConfig(tempDir); // scaffolds defaults
    expect(config.connectedRepos).toEqual([]);

    const configPath = join(tempDir, ".mimirs", "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.connectedRepos = [{ path: "../other", alias: "other" }];
    await writeFile(configPath, JSON.stringify(raw));

    config = await loadConfig(tempDir);
    expect(config.connectedRepos).toEqual([{ path: "../other", alias: "other" }]);
  });

  test("invalid entries are dropped without losing the rest of the config", async () => {
    await mkdir(join(tempDir, ".mimirs"), { recursive: true });
    await writeFile(
      join(tempDir, ".mimirs", "config.json"),
      JSON.stringify({ chunkSize: 256, connectedRepos: [{ nope: true }] }),
    );
    const config = await loadConfig(tempDir);
    expect(config.chunkSize).toBe(256); // salvage kept the valid field
    expect(config.connectedRepos).toEqual([]);
  });

  test("addConnectedRepo persists, dedups by resolved path, preserves other fields", async () => {
    await mkdir(join(tempDir, ".mimirs"), { recursive: true });
    await writeFile(
      join(tempDir, ".mimirs", "config.json"),
      JSON.stringify({ chunkSize: 256 }),
    );

    expect(await addConnectedRepo(tempDir, { path: "../other", alias: "other" })).toBe("added");
    // Same repo via a different-but-equal path spelling → exists.
    expect(await addConnectedRepo(tempDir, { path: join(tempDir, "..", "other") })).toBe("exists");

    const raw = JSON.parse(await readFile(join(tempDir, ".mimirs", "config.json"), "utf-8"));
    expect(raw.chunkSize).toBe(256); // raw edit, not a default-baking rewrite
    expect(raw.connectedRepos).toEqual([{ path: "../other", alias: "other" }]);
    expect(readConnectedReposSync(tempDir)).toEqual([{ path: "../other", alias: "other" }]);
  });

  test("removeConnectedRepo removes by alias or path", async () => {
    await loadConfig(tempDir);
    await addConnectedRepo(tempDir, { path: "../a", alias: "aaa" });
    await addConnectedRepo(tempDir, { path: "../b" });

    expect(await removeConnectedRepo(tempDir, "aaa")).toBe(true);
    expect(await removeConnectedRepo(tempDir, "../b")).toBe(true);
    expect(await removeConnectedRepo(tempDir, "ghost")).toBe(false);
    expect(readConnectedReposSync(tempDir)).toEqual([]);
  });
});

describe("alias resolution in resolveProject", () => {
  test("directory argument matching an alias resolves to the configured path", async () => {
    const foreign = await createTempDir();
    new RagDB(foreign).close(); // real index so the foreign-dir guard passes

    await loadConfig(tempDir);
    await addConnectedRepo(tempDir, { path: foreign, alias: "sibling" });

    const prevEnv = process.env.RAG_PROJECT_DIR;
    process.env.RAG_PROJECT_DIR = tempDir;
    try {
      const opened: string[] = [];
      const fakeGetDB = ((dir: string) => {
        opened.push(dir);
        return new RagDB(dir, undefined, { readonly: true });
      }) as Parameters<typeof resolveProject>[1];

      const { projectDir } = await resolveProject("sibling", fakeGetDB);
      expect(projectDir).toBe(foreign);
      expect(opened).toEqual([foreign]);
    } finally {
      if (prevEnv === undefined) delete process.env.RAG_PROJECT_DIR;
      else process.env.RAG_PROJECT_DIR = prevEnv;
      await cleanupTempDir(foreign);
    }
  });
});
