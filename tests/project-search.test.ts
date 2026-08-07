import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Embedder, EmbeddingIdentity } from
  "../src/internals/embeddings/embedder.ts";
import { ProjectDirectoryNotFoundError } from
  "../src/internals/project/analysis.ts";
import { defaultIndexConfig } from
  "../src/internals/indexing/config.ts";
import { ProjectSearchSession } from
  "../src/internals/search/project-search.ts";
import { indexProject } from
  "../src/internals/storage/project-index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

class KeywordEmbedder implements Embedder {
  readonly model = "test/project-search";
  readonly revision = "1";
  readonly variant = "keywords";
  readonly dimensions = 2;
  readonly calls: string[][] = [];

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes("alpha")) return new Float32Array([1, 0]);
      if (normalized.includes("beta")) return new Float32Array([0, 1]);
      return new Float32Array([Math.SQRT1_2, Math.SQRT1_2]);
    });
  }
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mimirs-project-search-"));
  temporaryDirectories.push(root);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return root;
}

describe("project search session", () => {
  test("creates, incrementally refreshes, and reopens one project index", async () => {
    const root = await project({
      "src/alpha.ts": "export function alpha() { return 'first'; }\n",
      "src/beta.ts": "export function beta() { return 'second'; }\n",
    });
    const embedder = new KeywordEmbedder();
    const session = await ProjectSearchSession.open(root, { embedder });
    const databasePath = join(root, ".mimirs", "index.sqlite");
    expect(await Bun.file(join(root, ".mimirs", "config.json")).exists())
      .toBe(true);
    let embeddingManifest: EmbeddingIdentity | null = null;
    try {
      await session.refresh();
      const first = await session.search({ query: "find alpha", maxResults: 10 });
      expect(first.source.map((result) => result.path)).toEqual([
        "src/alpha.ts",
        "src/beta.ts",
      ]);
      expect(first.preparation).toMatchObject({
        index: {
          root: await realpath(root),
          discovered: 2,
          indexed: 2,
          unchanged: 0,
          failed: [],
        },
        embeddings: { total: 2, embedded: 2, unchanged: 0, batches: 1 },
      });
      embeddingManifest = first.preparation.embeddings;
      expect(await Bun.file(databasePath).exists()).toBe(true);
      const alphaId = session.sourceIndex.loadWindows("src/alpha.ts")[0]!.id;

      await session.refresh();
      const second = await session.search({ query: "find alpha", maxResults: 1 });
      expect(second.source.map((result) => result.path)).toEqual([
        "src/alpha.ts",
      ]);
      expect(second.preparation).toMatchObject({
        index: { indexed: 0, unchanged: 2, failed: [] },
        embeddings: { total: 2, embedded: 0, unchanged: 2, batches: 0 },
      });
      expect(session.sourceIndex.loadWindows("src/alpha.ts")[0]!.id).toBe(alphaId);
      expect(embedder.calls.map((call) => call.length)).toEqual([
        2,
        2,
        1,
        1,
        1,
        1,
      ]);
    } finally {
      await session.close();
    }

    const reopenedEmbedder = new KeywordEmbedder();
    const reopened = await ProjectSearchSession.open(root, {
      embedder: reopenedEmbedder,
      embeddingManifest,
    });
    try {
      await reopened.refresh();
      const response = await reopened.search({ query: "find beta", maxResults: 1 });
      expect(response.source[0]!.path).toBe("src/beta.ts");
      expect(response.preparation.embeddings).toMatchObject({
        total: 2,
        embedded: 0,
        unchanged: 2,
      });
      expect(reopenedEmbedder.calls).toEqual([
        ["find beta"],
        ["find beta"],
      ]);
    } finally {
      await reopened.close();
    }
  });

  test("reads current vector counts after the writer changes shared rows", async () => {
    const root = await project({
      "alpha.ts": "export const alpha = true;\n",
    });
    const session = await ProjectSearchSession.open(root, {
      embedder: new KeywordEmbedder(),
    });
    try {
      await session.refresh();
      expect((await session.search({ query: "alpha", maxResults: 10 }))
        .diagnostics.total).toBe(1);

      await writeFile(join(root, "beta.ts"), "export const beta = true;\n");
      await session.refresh();
      expect((await session.search({ query: "beta", maxResults: 10 }))
        .diagnostics.total).toBe(2);
    } finally {
      await session.close();
    }
  });

  test("trusts vectors in a current owned schema without a status manifest", async () => {
    const root = await project({
      "alpha.ts": "export const alpha = true;\n",
    });
    const first = await ProjectSearchSession.open(root, {
      embedder: new KeywordEmbedder(),
    });
    try {
      await first.refresh();
    } finally {
      await first.close();
    }

    const replacement = new KeywordEmbedder();
    const reopened = await ProjectSearchSession.open(root, {
      embedder: replacement,
    });
    try {
      const preparation = await reopened.refresh();
      expect(preparation.embeddings).toMatchObject({
        total: 1,
        embedded: 0,
        unchanged: 1,
      });
    } finally {
      await reopened.close();
    }
  });

  test("honors config and handles a project with no included sources", async () => {
    const root = await project({
      "src/main.ts": "export const alpha = true;\n",
      "src/main.test.ts": "export const beta = false;\n",
      "README.md": "# Alpha documentation\n",
    });
    const embedder = new KeywordEmbedder();
    const session = await ProjectSearchSession.open(root, {
      config: {
        include: ["src/**/*.ts"],
        exclude: ["**/*.test.ts", "**/.mimirs/**"],
      },
      embedder,
    });
    try {
      await session.refresh();
      const response = await session.search({ query: "alpha", maxResults: 10 });
      expect(response.source.map((result) => result.path)).toEqual([
        "src/main.ts",
      ]);
      expect(response.preparation.index).toMatchObject({
        discovered: 1,
        indexed: 1,
        failed: [],
      });
    } finally {
      await session.close();
    }

    const emptyEmbedder = new KeywordEmbedder();
    const empty = await ProjectSearchSession.open(root, {
      config: { include: [], exclude: [] },
      databasePath: ":memory:",
      embedder: emptyEmbedder,
    });
    try {
      await empty.refresh();
      const response = await empty.search({ query: "nothing", maxResults: 5 });
      expect(response.source).toEqual([]);
      expect(response.preparation.index).toMatchObject({
        discovered: 0,
        indexed: 0,
        unchanged: 0,
        failed: [],
      });
      expect(response.preparation.embeddings).toMatchObject({ total: 0, embedded: 0 });
      expect(emptyEmbedder.calls).toEqual([]);
    } finally {
      await empty.close();
    }
  });

  test("does not search rows for files deleted after an earlier refresh", async () => {
    const root = await project({
      "alpha.ts": "export const alpha = true;\n",
      "beta.ts": "export const beta = true;\n",
    });
    const session = await ProjectSearchSession.open(root, {
      embedder: new KeywordEmbedder(),
    });
    try {
      await session.refresh();
      expect((await session.search({ query: "beta", maxResults: 1 })).source[0]!.path)
        .toBe("beta.ts");
      await unlink(join(root, "beta.ts"));

      await session.refresh();
      const after = await session.search({ query: "beta", maxResults: 10 });
      expect(after.source.map((result) => result.path)).toEqual(["alpha.ts"]);
      expect(after.preparation).toMatchObject({
        index: { discovered: 1, indexed: 0, unchanged: 1, failed: [] },
        embeddings: { total: 1, embedded: 0, unchanged: 1 },
      });
      expect(session.sourceIndex.getFile("beta.ts")).toBeNull();
      expect(session.sourceIndex.loadWindows("beta.ts")).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("reloads config and stops searching a newly excluded path", async () => {
    const root = await project({
      "alpha.ts": "export const alpha = true;\n",
      "beta.ts": "export const beta = true;\n",
    });
    const session = await ProjectSearchSession.open(root, {
      embedder: new KeywordEmbedder(),
    });
    try {
      await session.refresh();
      expect((await session.search({ query: "beta", maxResults: 1 })).source[0]!.path)
        .toBe("beta.ts");
      await writeFile(
        join(root, ".mimirs", "config.json"),
        JSON.stringify({
          include: ["**/*"],
          exclude: ["beta.ts", "**/.mimirs/**"],
          index: defaultIndexConfig(root).index,
        }),
      );

      await session.refresh();
      const after = await session.search({ query: "beta", maxResults: 10 });
      expect(after.source.map((result) => result.path)).toEqual(["alpha.ts"]);
      expect(after.preparation.index).toMatchObject({
        discovered: 1,
        indexed: 0,
        unchanged: 1,
        failed: [],
      });
      expect(await Bun.file(join(root, "beta.ts")).exists()).toBe(true);
      expect(session.sourceIndex.getFile("beta.ts")).toBeNull();
      expect(session.sourceIndex.loadWindows("beta.ts")).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("reloads generated policy without rebuilding unchanged files", async () => {
    const root = await project({
      "generated/alpha.ts": "export const generatedValue = true;\n",
      "src/alpha.ts": "export const handwrittenValue = true;\n",
    });
    await mkdir(join(root, ".mimirs"), { recursive: true });
    await writeFile(
      join(root, ".mimirs", "config.json"),
      JSON.stringify({
        include: ["**/*.ts"],
        exclude: ["**/.mimirs/**"],
        generated: [],
        index: defaultIndexConfig(root).index,
      }),
    );
    const session = await ProjectSearchSession.open(root, {
      embedder: new KeywordEmbedder(),
    });
    const request = {
      query: "behavior with no matching source terms",
      maxResults: 2,
    };
    try {
      await session.refresh();
      const before = await session.search(request);
      expect(before.source.map((result) => result.path)).toEqual([
        "generated/alpha.ts",
        "src/alpha.ts",
      ]);

      await writeFile(
        join(root, ".mimirs", "config.json"),
        JSON.stringify({
          include: ["**/*.ts"],
          exclude: ["**/.mimirs/**"],
          generated: ["generated/**"],
          index: defaultIndexConfig(root).index,
        }),
      );
      await session.refresh();
      const after = await session.search(request);
      expect(after.source.map((result) => result.path)).toEqual([
        "src/alpha.ts",
        "generated/alpha.ts",
      ]);
      expect(after.preparation).toMatchObject({
        index: { indexed: 0, unchanged: 2 },
        embeddings: { embedded: 0, unchanged: 2 },
      });
    } finally {
      await session.close();
    }
  });

  test("excludes an old row when current analysis of that path fails", async () => {
    const root = await project({
      "alpha.ts": "export const alpha = true;\n",
      "beta.ts": "export const beta = true;\n",
    });
    let failBeta = false;
    const session = await ProjectSearchSession.open(root, {
      embedder: new KeywordEmbedder(),
      dependencies: {
        indexProject: async (directory, sourceIndex, options) => {
          if (!failBeta) return indexProject(directory, sourceIndex, options);
          const alpha = await sourceIndex.indexFile(
            "alpha.ts",
            await Bun.file(join(root, "alpha.ts")).text(),
          );
          sourceIndex.reconcileFiles(new Set(["alpha.ts"]));
          return {
            root: resolve(root),
            discovered: 2,
            indexed: alpha.changed ? 1 : 0,
            unchanged: alpha.changed ? 0 : 1,
            currentPaths: ["alpha.ts"],
            failed: [{ path: "beta.ts", message: "simulated parse failure" }],
          };
        },
      },
    });
    try {
      await session.refresh();
      await session.search({ query: "beta", maxResults: 2 });
      await writeFile(join(root, "beta.ts"), "export const beta = 'changed';\n");
      failBeta = true;

      await session.refresh();
      const response = await session.search({ query: "beta", maxResults: 10 });
      expect(response.source.map((result) => result.path)).toEqual(["alpha.ts"]);
      expect(response.preparation.index.failed).toEqual([{
        path: "beta.ts",
        message: "simulated parse failure",
      }]);
      expect(session.sourceIndex.getFile("beta.ts")).toBeNull();
      expect(session.sourceIndex.loadWindows("beta.ts")).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("serializes concurrent refresh calls", async () => {
    const root = await project({
      "alpha.ts": "export const alpha = true;\n",
      "beta.ts": "export const beta = true;\n",
    });
    let active = 0;
    let maximumActive = 0;
    const session = await ProjectSearchSession.open(root, {
      embedder: new KeywordEmbedder(),
      dependencies: {
        indexProject: async (...args) => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          await Bun.sleep(5);
          try {
            return await indexProject(...args);
          } finally {
            active--;
          }
        },
      },
    });
    try {
      await Promise.all([session.refresh(), session.refresh()]);
      const [alpha, beta] = await Promise.all([
        session.search({ query: "alpha", maxResults: 1 }),
        session.search({ query: "beta", maxResults: 1 }),
      ]);
      expect(alpha.source[0]!.path).toBe("alpha.ts");
      expect(beta.source[0]!.path).toBe("beta.ts");
      expect(maximumActive).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("validates the root and config before creating an index", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mimirs-project-search-errors-"));
    temporaryDirectories.push(parent);
    const missing = join(parent, "missing");
    await expect(ProjectSearchSession.open(missing, {
      embedder: new KeywordEmbedder(),
    })).rejects.toBeInstanceOf(ProjectDirectoryNotFoundError);
    expect(await Bun.file(join(missing, ".mimirs", "index.sqlite")).exists())
      .toBe(false);

    const invalid = join(parent, "invalid");
    await mkdir(join(invalid, ".mimirs"), { recursive: true });
    await writeFile(join(invalid, ".mimirs", "config.json"), "{oops");
    await expect(ProjectSearchSession.open(invalid, {
      embedder: new KeywordEmbedder(),
    })).rejects.toThrow("invalid index config");
    expect(await Bun.file(join(invalid, ".mimirs", "index.sqlite")).exists())
      .toBe(false);

    const collision = join(parent, "collision");
    await mkdir(collision);
    await writeFile(join(collision, ".mimirs"), "not a directory");
    await expect(ProjectSearchSession.open(collision, {
      config: { include: [], exclude: [] },
      embedder: new KeywordEmbedder(),
    })).rejects.toThrow();
  });

  test("closes idempotently after queued work and rejects later calls", async () => {
    const root = await project({
      "alpha.ts": "export const alpha = true;\n",
    });
    const session = await ProjectSearchSession.open(root, {
      embedder: new KeywordEmbedder(),
    });
    const pending = session.refresh();
    await Promise.all([pending, session.close(), session.close()]);
    await expect(session.search({ query: "alpha", maxResults: 1 }))
      .rejects.toThrow("session is closed");
    await expect(session.refresh()).rejects.toThrow("session is closed");
  });
});
