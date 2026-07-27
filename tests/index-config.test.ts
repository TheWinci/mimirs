import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_INDEX_CONFIG,
  createDefaultIndexConfigIfMissing,
  IndexConfigError,
  loadIndexConfig,
  setIndexDomainEnabled,
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
  test("atomically materializes complete defaults once", async () => {
    const directory = await temporaryProject();
    const created = await Promise.all([
      createDefaultIndexConfigIfMissing(directory),
      createDefaultIndexConfigIfMissing(directory),
    ]);
    expect(created.sort()).toEqual([false, true]);
    expect(await createDefaultIndexConfigIfMissing(directory)).toBe(false);
    expect(await loadIndexConfig(directory)).toEqual(DEFAULT_INDEX_CONFIG);
  });

  test("enables and disables project-local domains idempotently", async () => {
    const directory = await temporaryProject();
    await setIndexDomainEnabled(directory, "source", false);
    await setIndexDomainEnabled(directory, "source", false);
    expect((await loadIndexConfig(directory)).index).toEqual({
      source: { directories: [] },
      history: { provider: "git", directories: [] },
      conversations: { directories: [] },
    });

    await setIndexDomainEnabled(directory, "source", true);
    await setIndexDomainEnabled(directory, "source", true);
    expect((await loadIndexConfig(directory)).index?.source.directories)
      .toEqual(["."]);
  });

  test("uses defaults without creating a config file", async () => {
    const directory = await temporaryProject();
    const config = await loadIndexConfig(directory);

    expect(config).toEqual(DEFAULT_INDEX_CONFIG);
    expect(await Bun.file(join(directory, ".mimirs", "config.json")).exists())
      .toBe(false);
  });

  test("inherits omitted fields and respects explicit empty lists", async () => {
    const directory = await temporaryProject();
    await writeConfig(directory, { include: [] });
    const config = await loadIndexConfig(directory);

    expect(config.include).toEqual([]);
    expect(config.exclude).toEqual(DEFAULT_INDEX_CONFIG.exclude);
  });

  test("normalizes Windows path separators in patterns", async () => {
    const directory = await temporaryProject();
    await writeConfig(directory, {
      include: ["src\\**\\*.ts"],
      exclude: ["src\\generated\\**"],
      generated: ["src\\api\\generated\\**"],
    });

    expect(await loadIndexConfig(directory)).toEqual({
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
      generated: ["src/api/generated/**"],
      index: {
        source: { directories: ["."] },
        history: { provider: "git", directories: [] },
        conversations: { directories: [] },
      },
    });
  });

  test("keeps generated files searchable as an explicit ranking policy", async () => {
    const directory = await temporaryProject();
    await writeConfig(directory, {
      generated: ["applyconfigurations/**", "**/*_generated.go"],
    });

    const config = await loadIndexConfig(directory);
    expect(config.generated).toEqual([
      "applyconfigurations/**",
      "**/*_generated.go",
    ]);
    expect(config.include).toEqual(DEFAULT_INDEX_CONFIG.include);
    expect(config.exclude).toEqual(DEFAULT_INDEX_CONFIG.exclude);
  });

  test("rejects malformed JSON instead of silently broadening discovery", async () => {
    const directory = await temporaryProject();
    await writeConfig(directory, "{ not-json }");

    await expect(loadIndexConfig(directory)).rejects
      .toBeInstanceOf(IndexConfigError);
    await expect(loadIndexConfig(directory)).rejects
      .toThrow("invalid index config");
  });

  test("rejects unknown and mistyped fields", async () => {
    const directory = await temporaryProject();
    await writeConfig(directory, { includes: ["**/*.ts"] });
    await expect(loadIndexConfig(directory)).rejects.toThrow("includes");

    await writeConfig(directory, { include: "**/*.ts" });
    await expect(loadIndexConfig(directory)).rejects.toThrow("include");

    await writeConfig(directory, { generated: "**/generated/**" });
    await expect(loadIndexConfig(directory)).rejects.toThrow("generated");
  });

  test("restricts source indexing to zero or one project-root entry", async () => {
    const directory = await temporaryProject();
    for (const directories of [
      ["src"],
      [".."],
      [directory],
      [".", "."],
    ]) {
      await writeConfig(directory, {
        index: { source: { directories } },
      });
      await expect(loadIndexConfig(directory)).rejects.toThrow(
        "index.source.directories",
      );
    }

    await writeConfig(directory, {
      index: { source: { directories: [] } },
    });
    expect((await loadIndexConfig(directory)).index?.source.directories)
      .toEqual([]);
    await writeConfig(directory, {
      index: { source: { directories: ["./"] } },
    });
    expect((await loadIndexConfig(directory)).index?.source.directories)
      .toEqual(["."]);
  });
});
