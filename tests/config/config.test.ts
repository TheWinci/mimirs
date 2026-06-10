import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../../src/config";
import { createTempDir, cleanupTempDir } from "../helpers";
import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempDir();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("loadConfig", () => {
  test("a valid partial config inherits default include/exclude globs", async () => {
    await mkdir(join(tempDir, ".mimirs"), { recursive: true });
    // A user trims config to just one tunable — must not end up indexing nothing.
    await writeFile(join(tempDir, ".mimirs", "config.json"), JSON.stringify({ chunkSize: 256 }));

    const config = await loadConfig(tempDir);
    expect(config.chunkSize).toBe(256); // user value respected
    expect(config.include).toContain("**/*.ts"); // inherited, not []
    expect(config.exclude).toContain("**/node_modules/**");
  });

  test("rejects chunkOverlap >= chunkSize (would stall the size-splitter)", async () => {
    await mkdir(join(tempDir, ".mimirs"), { recursive: true });
    // overlap == size makes splitBySize's window fail to advance → infinite loop.
    await writeFile(join(tempDir, ".mimirs", "config.json"), JSON.stringify({ chunkSize: 100, chunkOverlap: 100 }));

    const config = await loadConfig(tempDir);
    // Field-level salvage: the offending chunkOverlap is dropped (default 50),
    // the valid chunkSize is kept, and the surviving combination re-validates.
    // The dangerous pair must never come back.
    expect(config.chunkSize).toBe(100);
    expect(config.chunkOverlap).toBe(50);
    expect(config.chunkOverlap).toBeLessThan(config.chunkSize);
  });

  test("one invalid field does not discard the rest of the config", async () => {
    await mkdir(join(tempDir, ".mimirs"), { recursive: true });
    // chunkSize below min is invalid; the custom include must survive — losing
    // it silently changed what got indexed.
    await writeFile(
      join(tempDir, ".mimirs", "config.json"),
      JSON.stringify({ chunkSize: 1, include: ["src/**"] }),
    );

    const config = await loadConfig(tempDir);
    expect(config.chunkSize).toBe(512); // invalid field → default
    expect(config.include).toEqual(["src/**"]); // valid field kept
  });

  test("an explicit empty include is respected (not overridden)", async () => {
    await mkdir(join(tempDir, ".mimirs"), { recursive: true });
    await writeFile(join(tempDir, ".mimirs", "config.json"), JSON.stringify({ include: [] }));
    const config = await loadConfig(tempDir);
    expect(config.include).toEqual([]);
  });

  test("creates config.json with defaults when none exists", async () => {
    const config = await loadConfig(tempDir);
    expect(config.include).toContain("**/*.md");
    expect(config.include).toContain("**/*.ts");
    expect(config.include).toContain("**/*.py");
    expect(config.include).toContain("**/*.yaml");
    expect(config.include).toContain("**/Makefile");
    expect(config.include).toContain("**/Dockerfile");
    expect(config.include).toContain("**/Jenkinsfile");
    expect(config.include).toContain("**/*.toml");
    expect(config.include).toContain("**/*.sh");
    expect(config.include).toContain("**/*.sql");
    expect(config.exclude).toContain("**/node_modules/**");
    expect(config.chunkSize).toBe(512);
    expect(config.chunkOverlap).toBe(50);

    // Verify it was written to disk
    const configPath = join(tempDir, ".mimirs", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
    expect(onDisk.include).toEqual(config.include);
    expect(onDisk.exclude).toEqual(config.exclude);
  });

  test("loads user config from disk without merging defaults", async () => {
    await mkdir(join(tempDir, ".mimirs"), { recursive: true });
    await writeFile(
      join(tempDir, ".mimirs", "config.json"),
      JSON.stringify({
        include: ["**/*.md", "**/*.ts", "**/*.py"],
        chunkSize: 1024,
      })
    );

    const config = await loadConfig(tempDir);
    expect(config.include).toEqual(["**/*.md", "**/*.ts", "**/*.py"]);
    expect(config.chunkSize).toBe(1024);
    // Zod defaults for unset fields
    expect(config.chunkOverlap).toBe(50);
  });

  test("normalizes Windows-style backslashes in glob patterns", async () => {
    // Defensive guard for users who paste Windows paths into config.
    // Glob libs treat `\` as escape — `\` MUST be rewritten to `/`.
    await mkdir(join(tempDir, ".mimirs"), { recursive: true });
    await writeFile(
      join(tempDir, ".mimirs", "config.json"),
      JSON.stringify({
        include: ["**\\*.ts", "src\\**\\*.py"],
        exclude: ["node_modules\\**", "**\\__pycache__\\**"],
        generated: ["dist\\generated\\**"],
      })
    );

    const config = await loadConfig(tempDir);
    expect(config.include).toEqual(["**/*.ts", "src/**/*.py"]);
    expect(config.exclude).toEqual(["node_modules/**", "**/__pycache__/**"]);
    expect(config.generated).toEqual(["dist/generated/**"]);
  });
});
