import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, writeDefaultConfig } from "../../src/config";
import { createTempDir, cleanupTempDir } from "../helpers";
import { writeFile, mkdir } from "fs/promises";
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
  test("returns defaults when no config.json exists", async () => {
    const config = await loadConfig(tempDir);
    expect(config.include).toContain("**/*.md");
    expect(config.include).toContain("**/*.yaml");
    expect(config.include).toContain("**/Makefile");
    expect(config.include).toContain("**/Dockerfile");
    expect(config.include).toContain("**/Jenkinsfile");
    expect(config.include).toContain("**/*.toml");
    expect(config.include).toContain("**/*.sh");
    expect(config.include).toContain("**/*.sql");
    expect(config.exclude).toContain("node_modules/**");
    expect(config.chunkSize).toBe(512);
    expect(config.chunkOverlap).toBe(50);
  });

  test("merges user config with defaults", async () => {
    await mkdir(join(tempDir, ".rag"), { recursive: true });
    await writeFile(
      join(tempDir, ".rag", "config.json"),
      JSON.stringify({
        include: ["**/*.md", "**/*.ts", "**/*.py"],
        chunkSize: 1024,
      })
    );

    const config = await loadConfig(tempDir);
    expect(config.include).toEqual(["**/*.md", "**/*.ts", "**/*.py"]);
    expect(config.chunkSize).toBe(1024);
    // Defaults preserved for unset fields
    expect(config.chunkOverlap).toBe(50);
  });
});

describe("writeDefaultConfig", () => {
  test("creates valid JSON config file", async () => {
    await mkdir(join(tempDir, ".rag"), { recursive: true });
    const path = await writeDefaultConfig(tempDir);

    expect(existsSync(path)).toBe(true);

    const content = JSON.parse(await Bun.file(path).text());
    expect(content.include).toBeArray();
    expect(content.exclude).toBeArray();
    expect(content.chunkSize).toBeNumber();
    expect(content.chunkOverlap).toBeNumber();
  });
});
