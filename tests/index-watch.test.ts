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
  watchSourceIndex,
  type IndexCommandOutput,
} from "../src/cli/commands/index.ts";
import type { Embedder } from "../src/internals/embeddings/embedder.ts";
import { readProjectIndexLock } from
  "../src/internals/indexing/lock.ts";
import { readSharedProjectStatus } from
  "../src/internals/indexing/status.ts";
import { RefreshCoordinator } from
  "../src/internals/indexing/watch.ts";
import { initializeProject } from
  "../src/internals/project/initialize.ts";
import { SourceIndex } from "../src/internals/storage/source-index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function controlledEmbedder(): Embedder {
  return {
    model: "test/index-watch",
    revision: "1",
    variant: "controlled",
    dimensions: 2,
    embed: async (texts) =>
      texts.map(() => new Float32Array([1, 0])),
  };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await Bun.sleep(20);
  }
}

describe("index watch", () => {
  test("production observer reports source and config changes but ignores state writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-observer-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".mimirs"));
    await writeFile(join(root, ".mimirs", "config.json"), "{}\n");
    const moduleUrl = new URL(
      "../src/internals/indexing/watch.ts",
      import.meta.url,
    ).href;
    const script = `
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      import { observeProject } from ${JSON.stringify(moduleUrl)};
      const root = ${JSON.stringify(root)};
      let changes = 0;
      let failure;
      const observer = observeProject(
        root,
        () => changes++,
        (error) => failure = error,
      );
      const waitFor = async (minimum) => {
        const deadline = Date.now() + 2000;
        while (changes < minimum) {
          if (failure) throw failure;
          if (Date.now() >= deadline) throw new Error("observer timed out");
          await Bun.sleep(20);
        }
      };
      await Bun.sleep(50);
      await writeFile(join(root, "source.ts"), "export const value = 1;\\n");
      await waitFor(1);
      const afterSource = changes;
      await writeFile(join(root, ".mimirs", "status.json"), "{}\\n");
      await Bun.sleep(100);
      if (changes !== afterSource) throw new Error("state write was observed");
      await writeFile(join(root, ".mimirs", "config.json"), "{ }\\n");
      await waitFor(afterSource + 1);
      observer.close();
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  test("coalesces bursts and runs one follow-up for events during refresh", async () => {
    let refreshes = 0;
    let release: (() => void) | null = null;
    const coordinator = new RefreshCoordinator(async () => {
      refreshes++;
      if (refreshes === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    }, { debounceMs: 10, maximumDelayMs: 30 });

    const initial = coordinator.refreshNow();
    await waitFor(() => refreshes === 1);
    coordinator.notify();
    coordinator.notify();
    coordinator.notify();
    release!();
    await initial;
    await waitFor(() => refreshes === 2);
    await coordinator.close();
    expect(refreshes).toBe(2);
  });

  test("indexes, watches one source root, reconciles a change, and shuts down", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-index-watch-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "alpha.ts"), "export const alpha = 1;\n");
    await initializeProject(root);

    const abort = new AbortController();
    const logs: string[] = [];
    const errors: string[] = [];
    const progressWrites: string[] = [];
    let changed!: () => void;
    let watching!: () => void;
    const ready = new Promise<void>((resolve) => {
      watching = resolve;
    });
    const output: IndexCommandOutput = {
      log: (message) => {
        logs.push(message);
        if (message.startsWith("Watching ")) watching();
      },
      error: (message) => errors.push(message),
      progressStream: {
        isTTY: false,
        write: (value) => progressWrites.push(value),
      },
    };
    const running = watchSourceIndex(root, output, {
      debounceMs: 30,
      maximumDelayMs: 100,
      session: { embedder: controlledEmbedder() },
      signal: abort.signal,
      observer: (_root, onChange) => {
        changed = onChange;
        return { close: () => undefined };
      },
    });

    await ready;
    expect((await readSharedProjectStatus(root))?.index.generation).toBe(1);
    expect((await readProjectIndexLock(root))?.pid).toBe(process.pid);

    await writeFile(join(root, "src", "beta.ts"), "export const beta = 2;\n");
    changed();
    await waitFor(async () =>
      ((await readSharedProjectStatus(root))?.index.generation ?? 0) >= 2
    );
    const index = SourceIndex.openReadOnly(join(root, ".mimirs", "index.sqlite"));
    try {
      expect(index.listFiles().map((file) => file.path)).toContain("src/beta.ts");
    } finally {
      index.close();
    }

    abort.abort();
    const result = await running;
    expect(result.status.index.generation).toBeGreaterThanOrEqual(2);
    expect(await readProjectIndexLock(root)).toBeNull();
    expect(logs.at(-1)).toContain("Generation:");
    expect(errors).toEqual([]);
    expect(progressWrites.some((value) =>
      value.includes("Indexing:") || value.includes("Embedding:")
    )).toBe(true);
  });

  test("keeps the last generation when config becomes invalid and recovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-watch-config-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "alpha.ts"), "export const alpha = 1;\n");
    await initializeProject(root);
    const validConfig = await Bun.file(join(root, ".mimirs", "config.json")).text();
    const abort = new AbortController();
    const errors: string[] = [];
    let changed!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const running = watchSourceIndex(root, {
      log: (message) => {
        if (message.startsWith("Watching ")) ready();
      },
      error: (message) => errors.push(message),
    }, {
      debounceMs: 20,
      maximumDelayMs: 60,
      session: { embedder: controlledEmbedder() },
      signal: abort.signal,
      observer: (_root, onChange) => {
        changed = onChange;
        return { close: () => undefined };
      },
    });

    await started;
    await writeFile(join(root, ".mimirs", "config.json"), "{oops\n");
    changed();
    await waitFor(() => errors.length > 0);
    expect((await readSharedProjectStatus(root))?.index).toMatchObject({
      state: "degraded",
      searchable: true,
      generation: 1,
    });

    await writeFile(join(root, ".mimirs", "config.json"), validConfig);
    changed();
    await waitFor(async () =>
      ((await readSharedProjectStatus(root))?.index.generation ?? 0) >= 2
    );
    abort.abort();
    await running;
    expect((await readSharedProjectStatus(root))?.index.state).toBe("ready");
  });
});
