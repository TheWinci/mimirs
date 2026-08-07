import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INDEX_USAGE,
  indexProjectOnce,
  indexProjectWithProgress,
  parseIndexArguments,
  renderIndexSummary,
  runIndex,
  type IndexCommandDependencies,
  type IndexCommandOutput,
  type ProjectIndexRefreshResult,
} from "../src/cli/commands/index.ts";
import type { Embedder } from "../src/internals/embeddings/embedder.ts";
import { tryAcquireProjectIndexLock } from
  "../src/internals/indexing/lock.ts";
import { readSharedProjectStatus } from
  "../src/internals/indexing/status.ts";
import { initializeProject } from
  "../src/internals/project/initialize.ts";
import { SourceIndex } from "../src/internals/storage/source-index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mimirs-index-cli-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "alpha.ts"), "export const alpha = true;\n");
  return root;
}

function controlledEmbedder(calls: string[][]): Embedder {
  return {
    model: "test/index-cli",
    revision: "1",
    variant: "controlled",
    dimensions: 2,
    embed: async (texts) => {
      calls.push([...texts]);
      return texts.map(() => new Float32Array([1, 0]));
    },
  };
}

function output(): IndexCommandOutput & { errors: string[]; logs: string[] } {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    logs,
    error: (message) => errors.push(message),
    log: (message) => logs.push(message),
  };
}

function result(root = "/project"): ProjectIndexRefreshResult {
  return {
    root,
    durationMs: 1_250,
    status: {
      version: 2,
      sourceIndexSchemaVersion: 6,
      root,
      owner: {
        instanceId: "test",
        pid: process.pid,
        acquiredAt: "2026-01-01T00:00:00.000Z",
      },
      index: {
        state: "ready",
        searchable: true,
        ownerPid: process.pid,
        generation: 1,
        phase: null,
        progress: null,
        files: 1,
        sourceChunks: 2,
        embeddedWindows: 2,
        factDocuments: 1,
        embeddedFacts: 1,
        relationDocuments: 1,
        embeddedRelations: 1,
        lastUpdatedAt: "2026-01-01T00:00:00.000Z",
        error: null,
      },
      domains: {
        source: {
          state: "ready",
          directories: [root],
          generation: 1,
          phase: null,
          progress: null,
          lastUpdatedAt: "2026-01-01T00:00:00.000Z",
          error: null,
        },
        history: {
          state: "disabled",
          directories: [],
          generation: 0,
          phase: null,
          progress: null,
          lastUpdatedAt: null,
          error: null,
        },
        conversations: {
          state: "disabled",
          directories: [],
          generation: 0,
          phase: null,
          progress: null,
          lastUpdatedAt: null,
          error: null,
        },
      },
      preparation: null,
      config: null,
    },
  };
}

function dependencies(
  overrides: Partial<IndexCommandDependencies> = {},
): IndexCommandDependencies {
  return {
    assertDirectory: async () => undefined,
    index: async () => result(),
    watch: async () => result(),
    readStatus: async () => null,
    readLock: async () => null,
    ...overrides,
  };
}

describe("index CLI", () => {
  test("parses one-shot, watch, status, and optional project selection", () => {
    expect(parseIndexArguments([])).toEqual({
      command: "index",
      directory: ".",
      watch: false,
    });
    expect(parseIndexArguments(["--watch", "-d", "repo"])).toEqual({
      command: "index",
      directory: "repo",
      watch: true,
    });
    expect(parseIndexArguments(["status", "--directory", "repo"])).toEqual({
      command: "status",
      directory: "repo",
      watch: false,
    });
  });

  test("routes one-shot, watch, and status without source mutations", async () => {
    const calls: string[] = [];
    const io = output();
    const deps = dependencies({
      index: async (directory) => {
        calls.push(`index:${directory}`);
        return result(directory);
      },
      watch: async (directory) => {
        calls.push(`watch:${directory}`);
        return result(directory);
      },
      readStatus: async (directory) => {
        calls.push(`status:${directory}`);
        return null;
      },
      readLock: async (directory) => {
        calls.push(`lock:${directory}`);
        return null;
      },
    });

    expect(await runIndex(["-d", "one"], deps, io)).toBe(0);
    expect(await runIndex(["--watch", "-d", "two"], deps, io)).toBe(0);
    expect(await runIndex(["status", "-d", "three"], deps, io)).toBe(0);
    expect(calls).toEqual([
      "index:one",
      "watch:two",
      "status:three",
      "lock:three",
    ]);
  });

  test("rejects removed, duplicate, and invalid command shapes", async () => {
    for (const args of [
      ["source", "enable"],
      ["source"],
      ["--state-dir", "state"],
      ["status", "--watch"],
      ["--watch", "--watch"],
      ["-d"],
      ["-d", "one", "-d", "two"],
      ["history", "enable"],
    ]) {
      const io = output();
      expect(await runIndex(args, dependencies(), io)).toBe(2);
      expect(io.errors.at(-1)).toBe(INDEX_USAGE);
    }
  });

  test("requires init before indexing and leaves missing state absent", async () => {
    const root = await project();

    await expect(indexProjectOnce(root, {
      embedder: controlledEmbedder([]),
    })).rejects.toThrow("run `mimirs init");
    expect(await Bun.file(join(root, ".mimirs")).exists()).toBe(false);
  });

  test("indexes incrementally without changing the configured source", async () => {
    const root = await project();
    await initializeProject(root);
    const calls: string[][] = [];
    const embedder = controlledEmbedder(calls);

    expect((await indexProjectOnce(root, { embedder })).status.index.generation)
      .toBe(1);
    expect(calls).toHaveLength(2);
    expect((await indexProjectOnce(root, { embedder })).status.index.generation)
      .toBe(2);
    expect(calls).toHaveLength(2);

    await writeFile(join(root, "src", "alpha.ts"), "export const beta = true;\n");
    await indexProjectOnce(root, { embedder });
    expect(calls).toHaveLength(4);
    await rm(join(root, "src", "alpha.ts"));
    const final = await indexProjectOnce(root, { embedder });
    expect(final.status.index.files).toBe(1); // .gitignore remains discoverable.
    const index = SourceIndex.openReadOnly(join(root, ".mimirs", "index.sqlite"));
    try {
      expect(index.listFiles()).not.toContain("src/alpha.ts");
    } finally {
      index.close();
    }
  });

  test("reports file and embedding progress during a one-shot index", async () => {
    const root = await project();
    await initializeProject(root);
    const io = output();
    const writes: string[] = [];
    io.progressStream = {
      isTTY: false,
      write: (value) => writes.push(value),
    };

    await indexProjectWithProgress(
      root,
      io,
      { embedder: controlledEmbedder([]) },
    );

    expect(writes[0]).toBe("Scanning source files…\n");
    expect(writes.some((value) => value.startsWith("Indexing:"))).toBe(true);
    expect(writes.some((value) => value.startsWith("Embedding:"))).toBe(true);
  });

  test("renders a durable refresh summary with changed and reused work", () => {
    const value = result();
    value.status.preparation = {
      index: {
        root: "/project",
        discovered: 3,
        indexed: 1,
        unchanged: 2,
        failed: [],
      },
      embeddings: {
        model: "test/index",
        revision: "1",
        variant: "controlled",
        dimensions: 2,
        total: 8,
        embedded: 3,
        unchanged: 5,
        batches: 1,
      },
      facts: {
        model: "test/index",
        revision: "1",
        variant: "controlled|document:fact-scope:v1",
        dimensions: 2,
        total: 4,
        embedded: 1,
        unchanged: 3,
        batches: 1,
        projectedFiles: 3,
        changedProjectionFiles: 1,
      },
      relations: {
        model: "test/index",
        revision: "1",
        variant: "controlled|document:relation-edge:v1",
        dimensions: 2,
        total: 2,
        embedded: 0,
        unchanged: 2,
        batches: 0,
        projectedFiles: 3,
        changedProjectionFiles: 0,
      },
    };

    expect(renderIndexSummary(value)).toBe(
      "Indexed /project\n" +
        "  Generation: 1 (ready)\n" +
        "  Files: 3 total; 1 indexed, 2 unchanged, 0 failed\n" +
        "  Chunks: 2\n" +
        "  Embeddings: 8 total; 3 embedded, 5 unchanged, 1 batch\n" +
        "  Facts: 4 total; 1 embedded, 3 unchanged, 1 batch\n" +
        "  Relations: 2 total; 0 embedded, 2 unchanged, 0 batches\n" +
        "  Duration: 1.3s",
    );
  });

  test("does not write behind another indexing writer", async () => {
    const root = await project();
    await initializeProject(root);
    const configPath = join(root, ".mimirs", "config.json");
    const before = await Bun.file(configPath).text();
    const lock = await tryAcquireProjectIndexLock(root, "other-cli");
    expect(lock).not.toBeNull();
    try {
      await expect(indexProjectOnce(root, {
        embedder: controlledEmbedder([]),
      })).rejects.toThrow("another index command owns");
      expect(await Bun.file(configPath).text()).toBe(before);
      expect(await Bun.file(join(root, ".mimirs", "index.sqlite")).exists())
        .toBe(false);
    } finally {
      await lock!.release();
    }
  });

  test("persists a failed initial generation for status", async () => {
    const root = await project();
    await initializeProject(root);
    const failing: Embedder = {
      model: "test/index-cli",
      revision: "1",
      variant: "failing",
      dimensions: 2,
      embed: async () => {
        throw new Error("controlled embedding failure");
      },
    };

    await expect(indexProjectOnce(root, { embedder: failing }))
      .rejects.toThrow("controlled embedding failure");
    expect((await readSharedProjectStatus(root))?.index).toMatchObject({
      state: "failed",
      searchable: false,
      generation: 0,
      error: {
        code: "CLI_INDEX_FAILED",
        message: "controlled embedding failure",
      },
    });
  });

  test("reports active writer state separately from the persisted generation", async () => {
    const io = output();
    expect(await runIndex(["status"], dependencies({
      readStatus: async () => result().status,
      readLock: async () => ({
        instanceId: "live",
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
    }), io)).toBe(0);

    expect(io.logs[0]).toContain("Index: ready");
    expect(io.logs[0]).toContain(`Writer: active (pid ${process.pid})`);
  });
});
