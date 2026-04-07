import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "..", "src", "main.ts");
let tempDir: string;

async function runCLI(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCLIWithStdin(undefined, ...args);
}

async function runCLIWithStdin(stdin: string | undefined, ...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: tempDir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin !== undefined ? new Response(stdin) : undefined,
    env: process.env,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  tempDir = await createTempDir();

  await writeFixture(
    tempDir,
    "guide.md",
    `---
name: setup-guide
description: Project setup instructions
type: reference
---

Install dependencies with bun install.
`
  );
  await writeFixture(tempDir, "notes.txt", "Remember to write tests.");
});

afterAll(async () => {
  await cleanupTempDir(tempDir);
});

describe("CLI", () => {
  test("--help prints usage", async () => {
    const { stdout, exitCode } = await runCLI("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("mimirs");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("index");
    expect(stdout).toContain("search");
    expect(stdout).toContain("analytics");
  });

  test("init creates .mimirs/config.json and CLAUDE.md", async () => {
    const { stdout, exitCode } = await runCLIWithStdin("n\n", "init", tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(".mimirs/config.json");
    expect(stdout).toContain("CLAUDE.md");
    expect(stdout).toContain("mimirs");

    // RAG_PROJECT_DIR is in the .mcp.json file, not stdout
    const mcpContent = await Bun.file(join(tempDir, ".mcp.json")).text();
    expect(mcpContent).toContain("RAG_PROJECT_DIR");

    const { existsSync } = await import("fs");
    expect(existsSync(join(tempDir, ".mimirs", "config.json"))).toBe(true);
    expect(existsSync(join(tempDir, "CLAUDE.md"))).toBe(true);
  });

  test("init is idempotent", async () => {
    await runCLIWithStdin("n\n", "init", tempDir);
    const { stdout, exitCode } = await runCLIWithStdin("n\n", "init", tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Already set up — nothing to do.");
  });

  test("index reports indexed counts", async () => {
    const { stdout, exitCode } = await runCLI("index", tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Indexing");
    expect(stdout).toContain("indexed");
  });

  test("search prints ranked results with scores", async () => {
    const { stdout, exitCode } = await runCLI(
      "search",
      "project setup install",
      "--dir",
      tempDir,
      "--top",
      "3"
    );
    expect(exitCode).toBe(0);
    // Should contain a score like "0.XXXX"
    expect(stdout).toMatch(/\d\.\d{4}/);
    expect(stdout).toContain("guide.md");
  });

  test("status prints file/chunk counts", async () => {
    const { stdout, exitCode } = await runCLI("status", tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Files:");
    expect(stdout).toContain("Chunks:");
    expect(stdout).toContain("Last indexed:");
  });

  test("remove confirms removal", async () => {
    const filePath = join(tempDir, "notes.txt");
    const { stdout, exitCode } = await runCLI("remove", filePath, tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed");
  });

  test("analytics prints summary after search", async () => {
    // Run a search first to generate a log entry
    await runCLI("search", "project setup install", "--dir", tempDir, "--top", "3");

    const { stdout, exitCode } = await runCLI("analytics", tempDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Search analytics");
    expect(stdout).toContain("Total queries:");
    expect(stdout).toContain("Avg results:");
  });

  test("unknown command prints error", async () => {
    const { stderr, exitCode } = await runCLI("foobar");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});
