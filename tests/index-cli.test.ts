import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureSourceIndex,
  INDEX_USAGE,
  parseIndexArguments,
  runIndex,
  type IndexCommandOutput,
} from "../src/cli/commands/index.ts";
import { openReadOnlyProjectSearch } from
  "../src/internals/search/read-only-project-search.ts";
import type { Embedder } from "../src/internals/embeddings/embedder.ts";
import { loadIndexConfig } from "../src/internals/indexing/config.ts";
import { tryAcquireProjectIndexLock } from
  "../src/internals/indexing/lock.ts";
import { readSharedProjectStatus } from
  "../src/internals/indexing/status.ts";
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

describe("index CLI", () => {
  test("parses explicit domain actions and status", () => {
    expect(parseIndexArguments(["source", "enable", "-d", "repo"]))
      .toEqual({
        command: "configure",
        domain: "source",
        action: "enable",
        directory: "repo",
      });
    expect(parseIndexArguments(["status", "--directory", "repo"]))
      .toEqual({ command: "status", directory: "repo" });
    expect(parseIndexArguments([
      "source",
      "enable",
      "-d",
      "repo",
      "--state-dir",
      "state",
    ])).toEqual({
      command: "configure",
      domain: "source",
      action: "enable",
      directory: "repo",
      stateDirectory: "state",
    });
    expect(parseIndexArguments([
      "status",
      "--state-dir",
      "state",
      "-d",
      "repo",
    ])).toEqual({
      command: "status",
      directory: "repo",
      stateDirectory: "state",
    });
  });

  test("forwards the state directory through configure and status commands", async () => {
    const calls: unknown[][] = [];
    const dependencies = {
      assertDirectory: async () => undefined,
      configureSource: async (...args: [string, boolean, string?]) => {
        calls.push(args);
        return "completed" as const;
      },
      readStatus: async (...args: [string, string?]) => {
        calls.push(args);
        return null;
      },
    };
    expect(await runIndex([
      "source",
      "enable",
      "-d",
      "repo",
      "--state-dir",
      "state",
    ], dependencies, output())).toBe(0);
    expect(await runIndex([
      "status",
      "-d",
      "repo",
      "--state-dir",
      "state",
    ], dependencies, output())).toBe(0);
    expect(calls).toEqual([
      ["repo", true, "state"],
      ["repo", "state"],
    ]);
  });

  test("rejects ambiguous or incomplete command shapes", async () => {
    for (const args of [
      [],
      ["source"],
      ["source", "toggle", "-d", "."],
      ["unknown", "enable", "-d", "."],
      ["status"],
      ["source", "enable", "-d", "one", "-d", "two"],
      ["source", "enable", "-d", ".", "--state-dir", ""],
      ["status", "-d", ".", "--state-dir", "   "],
    ]) {
      const io = output();
      expect(await runIndex(args, {
        assertDirectory: async () => undefined,
        configureSource: async () => "completed",
        readStatus: async () => null,
      }, io)).toBe(2);
      expect(io.errors.at(-1)).toBe(INDEX_USAGE);
    }
  });

  test("keeps unimplemented domains side-effect free", async () => {
    let configured = 0;
    for (const domain of ["history", "conversations"] as const) {
      const io = output();
      expect(await runIndex(
        [domain, "enable", "-d", "repo"],
        {
          assertDirectory: async () => undefined,
          configureSource: async () => {
            configured++;
            return "completed";
          },
          readStatus: async () => null,
        },
        io,
      )).toBe(1);
      expect(io.errors).toEqual([`${domain} indexing is not implemented yet`]);
    }
    expect(configured).toBe(0);
  });

  test("indexes incrementally without status and physically disables source", async () => {
    const root = await project();
    const calls: string[][] = [];
    const embedder = controlledEmbedder(calls);

    expect(await configureSourceIndex(root, true, { embedder })).toBe("completed");
    expect(calls).toHaveLength(1);
    expect((await loadIndexConfig(root)).index?.source.directories).toEqual(["."]);

    await rm(join(root, ".mimirs", "status.json"));
    expect(await configureSourceIndex(root, true, { embedder })).toBe("completed");
    expect(calls).toHaveLength(1);

    expect(await configureSourceIndex(root, false, { embedder })).toBe("completed");
    expect((await loadIndexConfig(root)).index?.source.directories).toEqual([]);
    const index = SourceIndex.openReadOnly(join(root, ".mimirs", "index.sqlite"));
    try {
      expect(index.listFiles()).toEqual([]);
      expect(index.countWindows()).toBe(0);
      expect(index.countSemanticVectors()).toBe(0);
    } finally {
      index.close();
    }
    const status = await readSharedProjectStatus(root);
    expect(status?.domains.source).toMatchObject({
      state: "disabled",
      directories: [],
    });
  });

  test("does not mutate config behind another indexing writer", async () => {
    const root = await project();
    const lock = await tryAcquireProjectIndexLock(
      root,
      "other-cli",
      process.pid,
    );
    expect(lock).not.toBeNull();
    try {
      await expect(configureSourceIndex(root, false, {
        embedder: controlledEmbedder([]),
      })).rejects.toThrow("another index command owns");
      expect(await Bun.file(join(root, ".mimirs", "config.json")).exists())
        .toBe(false);
    } finally {
      await lock!.release();
    }
  });

  test("persists a source-domain failure for a later status command", async () => {
    const root = await project();
    const failing: Embedder = {
      model: "test/index-cli",
      revision: "1",
      variant: "failing",
      dimensions: 2,
      embed: async () => {
        throw new Error("controlled embedding failure");
      },
    };
    await expect(configureSourceIndex(root, true, { embedder: failing }))
      .rejects.toThrow("controlled embedding failure");

    const status = await readSharedProjectStatus(root);
    expect(status?.index).toMatchObject({
      state: "failed",
      searchable: false,
      error: {
        code: "CLI_INDEX_FAILED",
        message: "controlled embedding failure",
      },
    });
    expect(status?.domains.source).toMatchObject({
      state: "failed",
      error: {
        code: "CLI_INDEX_FAILED",
        message: "controlled embedding failure",
      },
    });
  });

  test("indexes an empty project and creates a missing state host namespace", async () => {
    const container = await mkdtemp(join(tmpdir(), "mimirs-index-empty-"));
    temporaryDirectories.push(container);
    const root = join(container, "project");
    const stateHost = join(container, "state");
    await mkdir(root);

    expect(await configureSourceIndex(
      root,
      true,
      { embedder: controlledEmbedder([]) },
      stateHost,
    )).toBe("completed");
    expect(await Bun.file(join(root, ".mimirs")).exists()).toBe(false);
    for (const file of [
      "config.json",
      "index.sqlite",
      "project.json",
      "status.json",
    ]) {
      expect(await Bun.file(join(stateHost, ".mimirs", file)).exists())
        .toBe(true);
    }
    expect((await readSharedProjectStatus(root, stateHost))?.index.files).toBe(0);
  });

  test("rejects external state bound to a different project on read", async () => {
    const first = await project();
    const second = await project();
    const stateHost = await mkdtemp(join(tmpdir(), "mimirs-index-bound-state-"));
    temporaryDirectories.push(stateHost);
    const embedder = controlledEmbedder([]);
    await configureSourceIndex(first, true, { embedder }, stateHost);

    await expect(openReadOnlyProjectSearch(second, { embedder }, stateHost))
      .rejects.toThrow("cannot be reused");
    await expect(readSharedProjectStatus(second, stateHost))
      .rejects.toThrow("cannot be reused");
  });

  test("indexes and searches a read-only project using only external state", async () => {
    const root = await project();
    const state = await mkdtemp(join(tmpdir(), "mimirs-index-state-"));
    temporaryDirectories.push(state);
    const sourcePath = join(root, "src", "alpha.ts");
    const sourceBefore = await readFile(sourcePath, "utf8");
    const enforcePermissions = process.platform !== "win32" &&
      process.getuid?.() !== 0;
    if (enforcePermissions) {
      await chmod(sourcePath, 0o444);
      await chmod(join(root, "src"), 0o555);
      await chmod(root, 0o555);
      await expect(writeFile(join(root, "write-probe"), "no\n"))
        .rejects.toMatchObject({ code: "EACCES" });
    }

    const embedder = controlledEmbedder([]);
    try {
      expect(await configureSourceIndex(root, true, { embedder }, state))
        .toBe("completed");
      const session = await openReadOnlyProjectSearch(
        root,
        { embedder },
        state,
      );
      try {
        expect((await session.search({ query: "alpha", maxResults: 1 })).source)
          .toContainEqual(expect.objectContaining({ path: "src/alpha.ts" }));
      } finally {
        await session.close();
      }
      expect(await Bun.file(join(root, ".mimirs")).exists()).toBe(false);
      expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
      const mimirsState = join(state, ".mimirs");
      for (const file of [
        "config.json",
        "index.sqlite",
        "project.json",
        "status.json",
      ]) {
        expect(await Bun.file(join(mimirsState, file)).exists()).toBe(true);
      }
      expect(await Bun.file(join(mimirsState, "index.lock")).exists()).toBe(false);
    } finally {
      if (enforcePermissions) {
        await chmod(root, 0o755);
        await chmod(join(root, "src"), 0o755);
        await chmod(sourcePath, 0o644);
      }
    }
  });

  test("does not fall back to project-local state when external state is unwritable", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await project();
    const state = await mkdtemp(join(tmpdir(), "mimirs-index-unwritable-"));
    temporaryDirectories.push(state);
    await chmod(state, 0o555);
    try {
      await expect(configureSourceIndex(
        root,
        true,
        { embedder: controlledEmbedder([]) },
        state,
      )).rejects.toMatchObject({ code: "EACCES" });
      expect(await Bun.file(join(root, ".mimirs")).exists()).toBe(false);
    } finally {
      await chmod(state, 0o755);
    }
  });

  test("does not initialize external state when the project is missing", async () => {
    const container = await mkdtemp(join(tmpdir(), "mimirs-index-missing-"));
    const stateHost = await mkdtemp(join(tmpdir(), "mimirs-index-unused-state-"));
    temporaryDirectories.push(container, stateHost);
    const missing = join(container, "missing");
    await expect(configureSourceIndex(
      missing,
      true,
      { embedder: controlledEmbedder([]) },
      stateHost,
    )).rejects.toThrow("no such project directory");
    expect(await Bun.file(join(stateHost, ".mimirs")).exists()).toBe(false);
  });
});
