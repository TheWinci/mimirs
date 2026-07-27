import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { renderProjectAnalysis } from
  "../src/cli/renderers/project-analysis.ts";
import { analyzeProject } from
  "../src/internals/project/analysis.ts";
import { analyzeIndexedProject, indexProject } from
  "../src/internals/storage/project-index.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "projects",
  "source-index",
  "basic",
);
const ALL_LANGUAGES_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "project-discovery",
);
const EXPECTED_PATHS = [
  "src/config.ts",
  "src/main.ts",
  "src/models/user.ts",
  "src/services/user-service.ts",
];

interface FileRow {
  id: number;
  path: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

function files(index: SourceIndex): FileRow[] {
  return index.database.query<FileRow, []>(
    "SELECT id, path FROM files ORDER BY path",
  ).all();
}

describe("project source index", () => {
  test("builds, reopens, and reuses a disposable multi-file index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mimirs-project-index-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "index.sqlite");
    expect(await Bun.file(databasePath).exists()).toBe(false);

    const writer = SourceIndex.open(databasePath);
    const first = await indexProject(FIXTURE, writer, {
      targetCharacters: 120,
    });
    const firstFiles = files(writer);
    writer.close();

    expect(first).toEqual({
      root: resolve(FIXTURE),
      discovered: EXPECTED_PATHS.length,
      indexed: EXPECTED_PATHS.length,
      unchanged: 0,
      currentPaths: EXPECTED_PATHS,
      failed: [],
    });
    expect(firstFiles.map((file) => file.path)).toEqual(EXPECTED_PATHS);

    const reader = SourceIndex.open(databasePath);
    try {
      const reopenedFiles = files(reader);
      expect(reopenedFiles).toEqual(firstFiles);
      expect(reader.getFile(".mimirs/ignored.ts")).toBeNull();
      for (const path of EXPECTED_PATHS) {
        const windows = reader.loadWindows(path);
        expect(windows.length).toBeGreaterThan(0);
        expect(windows.every((window) => window.path === path)).toBe(true);
      }

      const direct = await analyzeProject(FIXTURE);
      const persisted = await analyzeIndexedProject(FIXTURE, reader);
      expect(persisted.files.map((file) => ({
        path: file.path,
        facts: file.result.facts,
      }))).toEqual(direct.files.map((file) => ({
        path: file.path,
        facts: file.result.facts,
      })));
      expect(renderProjectAnalysis("source-index/basic", persisted)).toBe(
        renderProjectAnalysis("source-index/basic", direct),
      );

      const second = await indexProject(FIXTURE, reader, {
        targetCharacters: 120,
      });
      expect(second).toEqual({
        root: resolve(FIXTURE),
        discovered: EXPECTED_PATHS.length,
        indexed: 0,
        unchanged: EXPECTED_PATHS.length,
        currentPaths: EXPECTED_PATHS,
        failed: [],
      });
      expect(files(reader)).toEqual(firstFiles);
    } finally {
      reader.close();
    }
  });

  test("persists the common fact model across the reviewed language frontier", async () => {
    const index = SourceIndex.open();
    try {
      const summary = await indexProject(ALL_LANGUAGES_FIXTURE, index);
      const analysis = await analyzeIndexedProject(ALL_LANGUAGES_FIXTURE, index);
      const golden = await Bun.file(join(
        import.meta.dir,
        "goldens",
        "project-analysis",
        "all-languages.txt",
      )).text();

      expect(summary).toMatchObject({
        discovered: 49,
        indexed: 49,
        unchanged: 0,
        failed: [],
      });
      expect(renderProjectAnalysis("all-languages", analysis)).toBe(
        golden.trimEnd(),
      );
    } finally {
      index.close();
    }
  });

  test("uses the project config for direct and persisted analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-configured-index-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".mimirs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, ".mimirs", "config.json"),
      JSON.stringify({
        include: ["**/*.ts"],
        exclude: ["**/*.test.ts", "**/.mimirs/**"],
      }),
    );
    await writeFile(join(root, "src", "main.ts"), "export const main = true;\n");
    await writeFile(join(root, "src", "main.test.ts"), "throw new Error();\n");
    await writeFile(join(root, "README.md"), "# Not included\n");

    const direct = await analyzeProject(root);
    expect(direct.files.map((file) => file.path)).toEqual(["src/main.ts"]);

    const index = SourceIndex.open();
    try {
      const summary = await indexProject(root, index);
      const persisted = await analyzeIndexedProject(root, index);
      expect(summary).toMatchObject({ discovered: 1, indexed: 1, failed: [] });
      expect(persisted.files.map((file) => file.path)).toEqual(["src/main.ts"]);
      expect(renderProjectAnalysis("configured", persisted)).toBe(
        renderProjectAnalysis("configured", direct),
      );
    } finally {
      index.close();
    }
  });

  test("removes a previously indexed file when its current read fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-failed-index-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "alpha.ts"), "export const alpha = true;\n");
    await writeFile(join(root, "beta.ts"), "export const beta = true;\n");
    const index = SourceIndex.open();
    try {
      await indexProject(root, index);
      const summary = await indexProject(root, index, {
        onProgress: async ({ completed }) => {
          if (completed === 0) await unlink(join(root, "beta.ts"));
        },
      });

      expect(summary).toMatchObject({
        discovered: 2,
        unchanged: 1,
        currentPaths: ["alpha.ts"],
      });
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0]!.path).toBe("beta.ts");
      expect(index.listFiles().map((file) => file.path)).toEqual(["alpha.ts"]);
      expect(index.loadWindows("beta.ts")).toEqual([]);
    } finally {
      index.close();
    }
  });

  test("does not reconcile an interrupted project scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-aborted-index-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "alpha.ts"), "export const alpha = true;\n");
    await writeFile(join(root, "beta.ts"), "export const beta = true;\n");
    const index = SourceIndex.open();
    try {
      await indexProject(root, index);
      await unlink(join(root, "beta.ts"));
      const controller = new AbortController();

      await expect(indexProject(root, index, {
        signal: controller.signal,
        onProgress: ({ completed }) => {
          if (completed === 0) controller.abort();
        },
      })).rejects.toThrow();
      expect(index.listFiles().map((file) => file.path)).toEqual([
        "alpha.ts",
        "beta.ts",
      ]);
    } finally {
      index.close();
    }
  });
});
