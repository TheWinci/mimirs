import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDefaultIndexConfigIfMissing,
  defaultIndexConfig,
  IndexConfigError,
  loadIndexConfig,
  loadInitializedIndexConfig,
  ProjectNotInitializedError,
} from "../src/internals/indexing/config.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mimirs-index-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeConfig(
  directory: string,
  value: string | Record<string, unknown>,
): Promise<void> {
  await mkdir(join(directory, ".mimirs"), { recursive: true });
  await writeFile(
    join(directory, ".mimirs", "config.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

describe("index config", () => {
  test("atomically materializes absolute project defaults once", async () => {
    const directory = await temporaryProject();
    const canonical = await realpath(directory);
    const created = await Promise.all([
      createDefaultIndexConfigIfMissing(directory),
      createDefaultIndexConfigIfMissing(directory),
    ]);

    expect(created.sort()).toEqual([false, true]);
    expect(await createDefaultIndexConfigIfMissing(directory)).toBe(false);
    expect(await loadIndexConfig(directory)).toEqual(defaultIndexConfig(directory));
    expect((await loadIndexConfig(directory)).index?.source.directories)
      .toEqual([canonical]);
  });

  test("uses in-memory defaults without pretending the project was initialized", async () => {
    const directory = await temporaryProject();

    expect(await loadIndexConfig(directory)).toEqual(defaultIndexConfig(directory));
    await expect(loadInitializedIndexConfig(directory))
      .rejects.toBeInstanceOf(ProjectNotInitializedError);
    expect(await Bun.file(join(directory, ".mimirs", "config.json")).exists())
      .toBe(false);
  });

  test("inherits omitted fields while retaining the absolute source", async () => {
    const directory = await temporaryProject();
    await writeConfig(directory, {
      include: [],
      index: {
        source: { directories: [await realpath(directory)] },
      },
    });
    const config = await loadIndexConfig(directory);

    expect(config.include).toEqual([]);
    expect(config.exclude).toEqual(defaultIndexConfig(directory).exclude);
    expect(config.index?.source.directories).toEqual([await realpath(directory)]);
  });

  test("normalizes glob separators without rewriting the source path", async () => {
    const directory = await temporaryProject();
    await writeConfig(directory, {
      include: ["src\\**\\*.ts"],
      exclude: ["src\\generated\\**"],
      generated: ["src\\api\\generated\\**"],
      index: {
        source: { directories: [await realpath(directory)] },
      },
    });

    expect(await loadIndexConfig(directory)).toEqual({
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
      generated: ["src/api/generated/**"],
      index: {
        source: { directories: [await realpath(directory)] },
        history: { provider: "git", directories: [] },
        conversations: { directories: [] },
      },
    });
  });

  test("rejects malformed JSON and unknown fields", async () => {
    const directory = await temporaryProject();
    await writeConfig(directory, "{ not-json }");
    await expect(loadIndexConfig(directory)).rejects
      .toBeInstanceOf(IndexConfigError);

    await writeConfig(directory, { includes: ["**/*.ts"] });
    await expect(loadIndexConfig(directory)).rejects.toThrow("includes");
  });

  test("requires exactly one absolute source matching the project", async () => {
    const directory = await temporaryProject();
    const other = await temporaryProject();
    for (const directories of [
      [],
      ["."],
      ["src"],
      [await realpath(other)],
      [await realpath(directory), await realpath(directory)],
    ]) {
      await writeConfig(directory, {
        index: { source: { directories } },
      });
      await expect(loadIndexConfig(directory)).rejects.toThrow(
        "index.source.directories",
      );
    }

    await writeConfig(directory, { include: ["**/*"] });
    await expect(loadIndexConfig(directory)).rejects.toThrow(
      "index.source.directories",
    );
  });

  test("accepts a symlink alias and returns its canonical source path", async () => {
    const container = await temporaryProject();
    const source = join(container, "source");
    const alias = join(container, "alias");
    await mkdir(source);
    await symlink(source, alias, "dir");
    await writeConfig(source, {
      index: { source: { directories: [alias] } },
    });

    expect((await loadIndexConfig(alias)).index?.source.directories)
      .toEqual([await realpath(source)]);
  });
});
