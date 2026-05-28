import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { buildExcludeFilter, buildIncludeFilter, indexFile } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";
import { normalizePath } from "../../src/utils/path";

describe("buildExcludeFilter", () => {
  const patterns = [
    "**/node_modules/**",
    ".git/**",
    "**/__pycache__/**",
    "**/.venv/**",
    "**/venv/**",
    ".mimirs/**",
  ];
  const isExcluded = buildExcludeFilter(patterns);

  test("excludes any-depth dir at root (forward slash)", () => {
    expect(isExcluded(".venv/Lib/site-packages/pyarrow/pandas_compat.py")).toBe(true);
    expect(isExcluded("node_modules/foo/index.js")).toBe(true);
    expect(isExcluded("__pycache__/x.pyc")).toBe(true);
  });

  test("excludes nested any-depth dir match", () => {
    expect(isExcluded("packages/app/node_modules/dep.js")).toBe(true);
    expect(isExcluded("src/.venv/lib.py")).toBe(true);
  });

  test("excludes anchored dir prefix", () => {
    expect(isExcluded(".git/HEAD")).toBe(true);
    expect(isExcluded(".mimirs/config.json")).toBe(true);
  });

  test("does not exclude unrelated paths", () => {
    expect(isExcluded("src/main.py")).toBe(false);
    expect(isExcluded("README.md")).toBe(false);
  });

  // Regression: GitHub issue #1 — Windows backslash paths skipped exclude check.
  // collectFiles() must normalize backslashes before invoking this filter.
  test("backslash path normalized to forward slash is excluded", () => {
    const winRel = ".venv\\Lib\\site-packages\\pyarrow\\pandas_compat.py";
    const normalized = winRel.replaceAll("\\", "/");
    expect(isExcluded(normalized)).toBe(true);
    // Sanity: raw backslash form is NOT matched (which is exactly why the
    // normalization step in collectFiles is required).
    expect(isExcluded(winRel)).toBe(false);
  });

  test("backslash path nested any-depth match", () => {
    const winRel = "packages\\app\\node_modules\\dep.js";
    expect(isExcluded(winRel.replaceAll("\\", "/"))).toBe(true);
  });
});

describe("buildIncludeFilter", () => {
  const isIncluded = buildIncludeFilter(["**/*.py", "**/*.md"]);

  test("matches by extension on forward-slash paths", () => {
    expect(isIncluded("src/main.py")).toBe(true);
    expect(isIncluded("docs/readme.md")).toBe(true);
    expect(isIncluded("src/main.js")).toBe(false);
  });

  test("matches by extension on normalized Windows paths", () => {
    const winRel = "src\\pkg\\main.py";
    expect(isIncluded(winRel.replaceAll("\\", "/"))).toBe(true);
  });

  test("matches rooted extension globs", () => {
    const srcOnly = buildIncludeFilter(["src/**/*.ts"]);
    expect(srcOnly("src/index.ts")).toBe(true);
    expect(srcOnly("src/nested/file.ts")).toBe(true);
    expect(srcOnly("tests/index.test.ts")).toBe(false);
  });

  test("matches exact relative file paths and basename globs with dots", () => {
    const exact = buildIncludeFilter(["src/wiki/rebuild.ts", "**/AGENTS.md"]);
    expect(exact("src/wiki/rebuild.ts")).toBe(true);
    expect(exact("docs/AGENTS.md")).toBe(true);
    expect(exact("src/wiki/other.ts")).toBe(false);
  });
});

describe("normalizePath", () => {
  test("idempotent on POSIX-style paths", () => {
    expect(normalizePath("src/foo/bar.ts")).toBe("src/foo/bar.ts");
  });

  test("converts backslashes", () => {
    expect(normalizePath("src\\foo\\bar.ts")).toBe("src/foo/bar.ts");
  });

  test("handles mixed separators", () => {
    expect(normalizePath("src\\foo/bar\\baz.ts")).toBe("src/foo/bar/baz.ts");
  });
});

describe("DB path normalization (Windows interop)", () => {
  let tempDir: string;
  let db: RagDB;

  const config: RagConfig = {
    include: ["**/*.md"],
    exclude: [],
    chunkSize: 512,
    chunkOverlap: 50,
  };

  beforeAll(async () => {
    await getEmbedder();
  });

  beforeEach(async () => {
    tempDir = await createTempDir();
    db = new RagDB(tempDir);
  });

  afterEach(async () => {
    db.close();
    await cleanupTempDir(tempDir);
  });

  test("indexFile with backslash path stores forward-slash and is queryable both ways", async () => {
    const posixPath = await writeFixture(tempDir, "doc.md", "# Hello");
    // Simulate Windows path coming in from a watcher / fs event.
    const winPath = posixPath.replaceAll("/", "\\");

    const status = await indexFile(winPath, db, config);
    expect(status).toBe("indexed");

    // Query both sep styles — DB layer normalizes both.
    const a = db.getFileByPath(winPath);
    const b = db.getFileByPath(posixPath);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBe(b!.id);

    // Stored path is canonical forward-slash.
    expect(a!.path).not.toContain("\\");
    expect(a!.path).toBe(normalizePath(posixPath));
  });

  test("indexFile twice — once with each separator — does not double-insert", async () => {
    const posixPath = await writeFixture(tempDir, "doc.md", "# Hello");
    const winPath = posixPath.replaceAll("/", "\\");

    await indexFile(posixPath, db, config);
    await indexFile(winPath, db, config); // same hash → skipped

    expect(db.getStatus().totalFiles).toBe(1);
  });
});
