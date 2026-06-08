import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { RagDB } from "../../src/db";
import { resolveImports } from "../../src/graph/resolver";
import { createTempDir, cleanupTempDir } from "../helpers";

// Per-language intra-project import resolution (Pass 2 / 2b). These exercise the
// DB-based strategies — absolute dotted modules, C includes, Go packages — which
// don't need files on disk (resolution probes indexed paths), so we seed the DB
// directly. bun-chunk's Pass 1 (disk filesystem) is a no-op here, exactly as in
// production when the import target wasn't found by the filesystem resolver.

let tempDir: string;
let db: RagDB;
const EMB = new Float32Array(384);

beforeEach(async () => {
  tempDir = await createTempDir();
  db = new RagDB(tempDir);
});
afterEach(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

/** Seed an indexed file with its import specifiers. Returns the file id. */
function seed(relPath: string, imports: string[] = []): number {
  const path = join(tempDir, relPath);
  db.upsertFile(path, `h-${relPath}`, [{ snippet: relPath, embedding: EMB }]);
  const f = db.getFileByPath(path)!;
  if (imports.length) {
    db.upsertFileGraph(f.id, imports.map((source) => ({ name: "x", source })), []);
  }
  return f.id;
}

/** Resolved target path (repo-relative) of the importer's single import, or null. */
function resolvedTarget(importerId: number): string | null {
  const imp = db.getImportsForFile(importerId)[0];
  if (imp?.resolvedFileId == null) return null;
  const all = db.getAllFilePaths();
  const hit = all.find((f) => f.id === imp.resolvedFileId);
  return hit ? hit.path.slice(tempDir.length + 1) : null;
}

describe("resolver — Python absolute dotted imports", () => {
  test("flat layout: pkg.b → pkg/b.py", () => {
    const a = seed("pkg/a.py", ["pkg.b"]);
    seed("pkg/b.py");
    expect(resolveImports(db, tempDir)).toBe(1);
    expect(resolvedTarget(a)).toBe("pkg/b.py");
  });

  test("package import resolves to __init__.py", () => {
    const a = seed("pkg/a.py", ["pkg.sub"]);
    seed("pkg/sub/__init__.py");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("pkg/sub/__init__.py");
  });

  test("src layout: src/pkg/b resolves via src root", () => {
    const a = seed("src/pkg/a.py", ["pkg.b"]);
    seed("src/pkg/b.py");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("src/pkg/b.py");
  });

  test("monorepo layout resolves via generic suffix fallback", () => {
    // package nested under packages/foo/ — not a configured root, only the
    // suffix match (/pkg/b.py) finds it.
    const a = seed("packages/foo/pkg/a.py", ["pkg.b"]);
    seed("packages/foo/pkg/b.py");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("packages/foo/pkg/b.py");
  });

  test("external module is not resolved (no false edge)", () => {
    const a = seed("pkg/a.py", ["os"]);
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBeNull();
  });
});

describe("resolver — JVM dotted imports", () => {
  test("Java: com.foo.B → com/foo/B.java", () => {
    const a = seed("com/foo/A.java", ["com.foo.B"]);
    seed("com/foo/B.java");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("com/foo/B.java");
  });

  test("Kotlin: maven src/main/kotlin root", () => {
    const a = seed("src/main/kotlin/app/A.kt", ["app.B"]);
    seed("src/main/kotlin/app/B.kt");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("src/main/kotlin/app/B.kt");
  });
});

describe("resolver — C/C++ includes", () => {
  test("file-relative include (same dir)", () => {
    const a = seed("main.c", ["util.h"]);
    seed("util.h");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("util.h");
  });

  test("subdir include relative to file", () => {
    const a = seed("main.c", ["inc/helper.h"]);
    seed("inc/helper.h");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("inc/helper.h");
  });

  test("suffix-match when not in the file's dir (arbitrary -I layout)", () => {
    const a = seed("deep/consumer.c", ["util.h"]);
    seed("util.h");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("util.h");
  });

  test("ambiguous basename: nearest directory wins", () => {
    const a = seed("a/sub/main.c", ["util.h"]);
    seed("a/util.h");
    seed("b/util.h");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("a/util.h");
  });

  test("ambiguous basename, equidistant: no edge (no false positive)", () => {
    const a = seed("c/main.c", ["util.h"]);
    seed("a/util.h");
    seed("b/util.h");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBeNull();
  });

  test("system angle-include header not indexed → no edge", () => {
    const a = seed("main.c", ["stdio.h"]);
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBeNull();
  });
});

describe("resolver — Go package imports", () => {
  test("strips go.mod module prefix → representative .go file", () => {
    writeFileSync(join(tempDir, "go.mod"), "module example.com/proj\n\ngo 1.20\n");
    const a = seed("main.go", ["example.com/proj/internal/helper"]);
    seed("internal/helper/helper.go");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("internal/helper/helper.go");
  });

  test("package with multiple files picks lexically-first non-test source", () => {
    writeFileSync(join(tempDir, "go.mod"), "module m\n");
    const a = seed("main.go", ["m/pkg"]);
    seed("pkg/aaa.go");
    seed("pkg/zzz.go");
    seed("pkg/aaa_test.go");
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBe("pkg/aaa.go");
  });

  test("external/stdlib import not resolved", () => {
    writeFileSync(join(tempDir, "go.mod"), "module m\n");
    const a = seed("main.go", ["fmt"]);
    resolveImports(db, tempDir);
    expect(resolvedTarget(a)).toBeNull();
  });
});
