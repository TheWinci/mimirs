import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSearchArguments,
  runSearch,
  SEARCH_USAGE,
  type SearchCommandDependencies,
  type SearchCommandOutput,
} from "../src/cli/commands/search.ts";
import { openReadOnlyProjectSearch } from
  "../src/internals/search/read-only-project-search.ts";
import { configureSourceIndex } from "../src/cli/commands/index.ts";
import type { Embedder } from "../src/internals/embeddings/embedder.ts";
import {
  renderSegmentedSearchResults,
  renderSearchResults,
  searchWarnings,
} from "../src/cli/renderers/search-results.ts";
import type { ProjectSearchResponse } from
  "../src/internals/search/project-search.ts";
import { SOURCE_INDEX_SCHEMA_VERSION } from
  "../src/internals/storage/schema.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function response(
  overrides: Partial<ProjectSearchResponse> = {},
): ProjectSearchResponse {
  return {
    source: [],
    docs: [],
    relations: [],
    diagnostics: {
      total: 0,
      compatible: 0,
      missingEmbedding: 0,
      incompleteEmbedding: 0,
      incompatibleEmbedding: 0,
      malformedEmbedding: 0,
      orphaned: 0,
      unscorableCandidates: 0,
      lexicalCandidates: 0,
    },
    preparation: {
      index: {
        root: "/project",
        discovered: 0,
        indexed: 0,
        unchanged: 0,
        failed: [],
      },
      embeddings: {
        model: "test/search",
        revision: "1",
        variant: "controlled",
        dimensions: 2,
        total: 0,
        embedded: 0,
        unchanged: 0,
        batches: 0,
      },
    },
    ...overrides,
  };
}

function output(): SearchCommandOutput & { errors: string[]; logs: string[] } {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    logs,
    error: (message) => errors.push(message),
    log: (message) => logs.push(message),
  };
}

function dependencies(
  value: ProjectSearchResponse,
  state: {
      directory?: string;
      stateDirectory?: string;
      request?: { query: string; maxResults: number };
    },
): SearchCommandDependencies {
  return {
    search: async (directory, request, stateDirectory) => {
      state.directory = directory;
      if (stateDirectory !== undefined) state.stateDirectory = stateDirectory;
      state.request = request;
      return value;
    },
  };
}

describe("search CLI", () => {
  async function projectWithSchema(version: number): Promise<{
    root: string;
    databasePath: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "mimirs-search-schema-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, ".mimirs", "index.sqlite");
    await mkdir(join(root, ".mimirs"));
    SourceIndex.open(databasePath).close();
    const database = new Database(databasePath, { strict: true });
    database.exec(`PRAGMA user_version = ${version}`);
    database.close();
    return { root, databasePath };
  }

  test("directs older read-only schemas through the explicit index command", async () => {
    const { root, databasePath } = await projectWithSchema(
      SOURCE_INDEX_SCHEMA_VERSION - 1,
    );
    await expect(openReadOnlyProjectSearch(root)).rejects.toThrow(
      "run `mimirs index source enable -d .`",
    );
    const database = new Database(databasePath, { readonly: true, strict: true });
    expect(database.query<{ user_version: number }, []>(
      "PRAGMA user_version",
    ).get()).toEqual({ user_version: SOURCE_INDEX_SCHEMA_VERSION - 1 });
    database.close();
    expect(await Bun.file(join(root, ".mimirs", "config.json")).exists())
      .toBe(false);
  });

  test("directs newer read-only schemas through a Mimirs upgrade", async () => {
    const { root } = await projectWithSchema(SOURCE_INDEX_SCHEMA_VERSION + 1);
    await expect(openReadOnlyProjectSearch(root)).rejects.toThrow(
      "created by a newer Mimirs version; upgrade Mimirs",
    );
    expect(await Bun.file(join(root, ".mimirs", "config.json")).exists())
      .toBe(false);
  });

  test("opens the owned database read-only without requiring status", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-search-cli-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "alpha.ts"),
      "export const alpha = true;\n",
    );
    const calls: string[][] = [];
    const embedder: Embedder = {
      model: "test/search-cli",
      revision: "1",
      variant: "controlled",
      dimensions: 2,
      embed: async (texts) => {
        calls.push([...texts]);
        return texts.map(() => new Float32Array([1, 0]));
      },
    };
    await configureSourceIndex(root, true, { embedder });
    const databasePath = join(root, ".mimirs", "index.sqlite");
    await Promise.all([
      rm(join(root, ".mimirs", "status.json")),
      rm(join(root, ".mimirs", "config.json")),
    ]);
    const session = await openReadOnlyProjectSearch(root, { embedder });
    try {
      expect(session.sourceIndex.database.query<{ query_only: number }, []>(
        "PRAGMA query_only",
      ).get()).toEqual({ query_only: 1 });
      await expect(session.refresh()).rejects.toThrow("read-only");
      expect((await session.search({ query: "alpha", maxResults: 1 })).source)
        .toHaveLength(1);
    } finally {
      await session.close();
    }
    expect(await Bun.file(join(root, ".mimirs", "status.json")).exists())
      .toBe(false);
    expect(await Bun.file(join(root, ".mimirs", "config.json")).exists())
      .toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("renders exact window and parent citations with compact previews", () => {
    const value = response({
      source: [{
        windowId: 9,
        path: "src/main.ts",
        score: 0.876543,
        semanticScore: 0.812345,
        lexicalScore: 4.25,
        preview: "export function run() { return execute(); }",
        windows: [{
          id: 9,
          startOffset: 24,
          endOffset: 68,
          startLine: 3,
          endLine: 5,
        }, {
          id: 10,
          startOffset: 84,
          endOffset: 108,
          startLine: 10,
          endLine: 11,
        }],
        window: {
          startOffset: 24,
          endOffset: 68,
          startLine: 3,
          endLine: 5,
        },
        sourceChunks: [{
          id: 4,
          kind: "function",
          name: "run\n task",
          startOffset: 20,
          endOffset: 72,
          startLine: 2,
          endLine: 6,
        }, {
          id: 5,
          kind: "function",
          name: "execute",
          startOffset: 80,
          endOffset: 120,
          startLine: 9,
          endLine: 12,
        }],
        sourceChunk: {
          id: 4,
          kind: "function",
          name: "run\n task",
          startOffset: 20,
          endOffset: 72,
          startLine: 2,
          endLine: 6,
        },
      }],
    });
    expect(renderSearchResults(value.source)).toBe(
      "src/main.ts:3-5  function run task  score 0.8765 " +
        "(semantic 0.8123, lexical 4.2500)\n" +
        "parent 2-6; window offsets [24,68); parent offsets [20,72)\n" +
        "matched windows 3-5, 10-11\n" +
        "matched chunks 2-6, 9-12\n" +
        "export function run() { return execute(); }",
    );
    expect(renderSearchResults([])).toBe("No indexed source matched the query.");

    const document = {
      ...value.source[0]!,
      windowId: 10,
      path: "docs/guide.md",
      preview: "Use src.main.run for the main operation.",
    };
    const segmented = response({
      source: value.source,
      docs: [document],
      relations: [{
        documentWindowId: document.windowId,
        documentPath: document.path,
        documentRange: document.window,
        sourceWindowId: value.source[0]!.windowId,
        sourcePath: value.source[0]!.path,
        sourceRange: value.source[0]!.sourceChunk,
        reference: "src.main.run",
        symbol: "run",
        kind: "qualified-symbol",
        inheritedScore: 0.525,
      }],
    });
    expect(renderSegmentedSearchResults(segmented)).toContain(
      "Source\n\nsrc/main.ts:3-5",
    );
    expect(renderSegmentedSearchResults(segmented)).toContain(
      "Documentation\n\ndocs/guide.md:3-5",
    );
    expect(renderSegmentedSearchResults(segmented)).toContain(
      "docs/guide.md:3-5 -> src/main.ts:2-6  qualified-symbol " +
        "src.main.run  inherited 0.5250",
    );
  });

  test("parses the legacy short and long command shapes", () => {
    expect(parseSearchArguments([
      "-q",
      "find alpha",
      "--max-results",
      "7",
      "repo",
    ])).toEqual({
      query: "find alpha",
      maxResults: 7,
      directory: "repo",
    });
    expect(parseSearchArguments([
      "--query",
      "Unicode 🧭 search",
      "--max-results",
      "2",
    ])).toEqual({
      query: "Unicode 🧭 search",
      maxResults: 2,
      directory: ".",
    });
    expect(parseSearchArguments([
      "-q",
      "--needle",
      "--max-results",
      "1",
      "--",
      "-directory",
    ])).toEqual({
      query: "--needle",
      maxResults: 1,
      directory: "-directory",
    });
    expect(parseSearchArguments([
      "-q",
      "find alpha",
      "--max-results",
      "3",
      "-d",
      "repo",
      "--state-dir",
      "state",
    ])).toEqual({
      query: "find alpha",
      maxResults: 3,
      directory: "repo",
      stateDirectory: "state",
    });
  });

  test("forwards the selected state directory to the read-only session", async () => {
    const state: {
      directory?: string;
      stateDirectory?: string;
      request?: { query: string; maxResults: number };
    } = {};
    expect(await runSearch([
      "-q",
      "alpha",
      "--max-results",
      "1",
      "-d",
      "repo",
      "--state-dir",
      "state",
    ], dependencies(response(), state), output())).toBe(0);
    expect(state).toEqual({
      directory: "repo",
      stateDirectory: "state",
      request: { query: "alpha", maxResults: 1 },
    });
  });

  test("runs the shared session and keeps an empty result successful", async () => {
    const state: {
      directory?: string;
      stateDirectory?: string;
      request?: { query: string; maxResults: number };
    } = {};
    const io = output();
    const code = await runSearch(
      ["-q", "find alpha", "--max-results", "5", "repo"],
      dependencies(response(), state),
      io,
    );
    expect(code).toBe(0);
    expect(state).toEqual({
      directory: "repo",
      request: { query: "find alpha", maxResults: 5 },
    });
    expect(io.logs).toEqual([
      "No indexed source or documentation matched the query.",
    ]);
    expect(io.errors).toEqual([]);
  });

  test("writes preparation and retrieval warnings only to stderr", async () => {
    const value = response({
      diagnostics: {
        total: 4,
        compatible: 1,
        missingEmbedding: 1,
        incompleteEmbedding: 0,
        incompatibleEmbedding: 0,
        malformedEmbedding: 1,
        orphaned: 1,
        unscorableCandidates: 1,
        lexicalCandidates: 1,
      },
      preparation: {
        ...response().preparation,
        index: {
          ...response().preparation.index,
          failed: [{ path: "bad.ts", message: "parse failed" }],
        },
      },
    });
    expect(searchWarnings(value)).toEqual([
      "could not index bad.ts: parse failed",
      "1 missing embeddings omitted from search",
      "1 malformed embeddings omitted from search",
      "1 orphaned windows omitted from search",
      "1 unscorable vectors omitted from search",
    ]);

    const io = output();
    const code = await runSearch(
      ["-q", "query", "--max-results", "1"],
      dependencies(value, {}),
      io,
    );
    expect(code).toBe(0);
    expect(io.logs).toEqual([
      "No indexed source or documentation matched the query.",
    ]);
    expect(io.errors.every((message) => message.startsWith("[mimirs] ")))
      .toBe(true);
  });

  test("rejects malformed arguments before opening a session", async () => {
    const cases = [
      [],
      ["-q", "query"],
      ["--max-results", "2"],
      ["-q", " ", "--max-results", "2"],
      ["-q", "query", "--max-results", "0"],
      ["-q", "query", "--max-results", "1.5"],
      ["-q", "query", "--max-results", "101"],
      ["-q", "query", "--max-results", "2", "--unknown"],
      ["-q", "one", "--query", "two", "--max-results", "2"],
      ["-q", "query", "--max-results", "2", "one", "two"],
      ["-q", "--max-results", "2"],
      ["-q", "query", "--max-results", "2", "--state-dir", ""],
      ["-q", "query", "--max-results", "2", "--state-dir", "   "],
    ];
    for (const args of cases) {
      let opened = false;
      const io = output();
      const code = await runSearch(args, {
        search: async () => {
          opened = true;
          throw new Error("must not open");
        },
      }, io);
      expect(code).toBe(2);
      expect(opened).toBe(false);
      expect(io.errors.at(-1)).toBe(SEARCH_USAGE);
      expect(io.logs).toEqual([]);
    }
  });

  test("reports runtime failures without a stack", async () => {
    const io = output();
    const code = await runSearch(
      ["-q", "query", "--max-results", "1"],
      {
        search: async () => {
          throw new Error("inference failed");
        },
      },
      io,
    );
    expect(code).toBe(1);
    expect(io.errors).toEqual(["inference failed"]);
    expect(io.logs).toEqual([]);
  });

  test("package script exposes search and missing arguments exit with usage", async () => {
    const packageJson = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json() as { scripts: Record<string, string> };
    expect(packageJson.scripts.search).toBe("bun run src/cli/index.ts search");

    const process = Bun.spawn(["bun", "run", "search"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("query is required");
    expect(stderr).toContain(SEARCH_USAGE);
  });
});
