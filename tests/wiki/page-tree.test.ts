import { describe, test, expect } from "bun:test";
import { buildPageTree } from "../../src/wiki/page-tree";
import type {
  DiscoveryResult,
  ClassifiedInventory,
  ClassifiedSymbol,
  ClassifiedFile,
  ClassifiedModule,
  FileLevelNode,
} from "../../src/wiki/types";

/** Build a minimal discovery result. */
function makeDiscovery(opts: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    fileCount: opts.fileCount ?? 20,
    chunkCount: opts.chunkCount ?? 80,
    lastIndexed: "2024-01-01T00:00:00Z",
    modules: opts.modules ?? [],
    graphData: opts.graphData ?? {
      fileLevel: { level: "file", nodes: [], edges: [] },
      directoryLevel: { level: "directory", directories: [], edges: [] },
    },
    warnings: [],
  };
}

function makeSymbol(overrides: Partial<ClassifiedSymbol> = {}): ClassifiedSymbol {
  return {
    name: overrides.name ?? "TestSymbol",
    type: overrides.type ?? "function",
    file: overrides.file ?? "src/test.ts",
    tier: overrides.tier ?? "entity",
    scope: overrides.scope ?? "local",
    referenceCount: overrides.referenceCount ?? 0,
    referenceModuleCount: overrides.referenceModuleCount ?? 0,
    referenceModules: overrides.referenceModules ?? [],
    hasChildren: overrides.hasChildren ?? false,
    childCount: overrides.childCount ?? 0,
    isReexport: overrides.isReexport ?? false,
    snippet: overrides.snippet ?? null,
  };
}

function makeFile(overrides: Partial<ClassifiedFile> = {}): ClassifiedFile {
  return {
    path: overrides.path ?? "src/test.ts",
    fanIn: overrides.fanIn ?? 0,
    fanOut: overrides.fanOut ?? 0,
    isHub: overrides.isHub ?? false,
    bridges: overrides.bridges ?? [],
    entities: overrides.entities ?? [],
    ...overrides,
  };
}

function makeModule(overrides: Partial<ClassifiedModule> = {}): ClassifiedModule {
  const fanIn = overrides.fanIn ?? 3;
  const exportCount = overrides.exportCount ?? 5;
  const fileCount = overrides.fileCount ?? 3;
  return {
    name: overrides.name ?? "test",
    path: overrides.path ?? "src/test",
    entryFile: overrides.entryFile ?? "src/test/index.ts",
    files: overrides.files ?? ["src/test/index.ts"],
    qualifiesAsModulePage: overrides.qualifiesAsModulePage ?? true,
    reason: overrides.reason ?? "test",
    hubs: overrides.hubs ?? [],
    bridges: overrides.bridges ?? [],
    entityCount: overrides.entityCount ?? 0,
    fileCount,
    exportCount,
    fanIn,
    fanOut: overrides.fanOut ?? 2,
    value: overrides.value ?? (fanIn * 2 + exportCount + fileCount),
  };
}

function makeClassified(opts: Partial<ClassifiedInventory> = {}): ClassifiedInventory {
  return {
    symbols: opts.symbols ?? [],
    files: opts.files ?? [],
    modules: opts.modules ?? [],
    warnings: [],
  };
}

function makeFileNode(overrides: Partial<FileLevelNode> = {}): FileLevelNode {
  return {
    path: overrides.path ?? "src/test.ts",
    exports: overrides.exports ?? [],
    fanIn: overrides.fanIn ?? 0,
    fanOut: overrides.fanOut ?? 0,
    isEntryPoint: overrides.isEntryPoint ?? false,
  };
}

describe("buildPageTree", () => {
  test("generates cross-cutting pages always", () => {
    const discovery = makeDiscovery();
    const classified = makeClassified();
    const manifest = buildPageTree(discovery, classified, "abc123");

    const pages = Object.keys(manifest.pages);
    expect(pages).toContain("wiki/architecture.md");
    expect(pages).toContain("wiki/data-flows.md");
    expect(pages).toContain("wiki/guides/getting-started.md");
    expect(pages).toContain("wiki/index.md");
  });

  test("does not generate glossary or entity pages", () => {
    const classified = makeClassified({
      symbols: [
        makeSymbol({ name: "A", scope: "cross-cutting", referenceCount: 10 }),
        makeSymbol({ name: "B", scope: "local" }),
      ],
    });
    const manifest = buildPageTree(makeDiscovery(), classified, "abc");
    const pages = Object.keys(manifest.pages);

    // No entity, bridge, hub, or glossary pages
    expect(pages.filter((p) => p.includes("/entities/"))).toHaveLength(0);
    expect(pages.filter((p) => p.includes("/bridges/"))).toHaveLength(0);
    expect(pages.filter((p) => p.includes("/hubs/"))).toHaveLength(0);
    expect(pages).not.toContain("wiki/glossary.md");
  });

  test("gates conventions on file count >= 20", () => {
    const small = makeDiscovery({ fileCount: 10 });
    const manifest1 = buildPageTree(small, makeClassified(), "abc");
    expect(Object.keys(manifest1.pages)).not.toContain("wiki/guides/conventions.md");

    const large = makeDiscovery({ fileCount: 25 });
    const manifest2 = buildPageTree(large, makeClassified(), "abc");
    expect(Object.keys(manifest2.pages)).toContain("wiki/guides/conventions.md");
  });

  test("creates module pages for qualifying modules", () => {
    const classified = makeClassified({
      modules: [
        makeModule({ name: "db", fanIn: 10, fanOut: 3, fileCount: 5, exportCount: 12 }),
        makeModule({ name: "search", fanIn: 5, fanOut: 2, fileCount: 3, exportCount: 4 }),
      ],
    });

    const manifest = buildPageTree(makeDiscovery(), classified, "abc");
    expect(Object.keys(manifest.pages)).toContain("wiki/modules/db.md");
    expect(Object.keys(manifest.pages)).toContain("wiki/modules/search.md");
  });

  test("small project rule: < 5 modules all get at least brief", () => {
    const modules = Array.from({ length: 3 }, (_, i) =>
      makeModule({ name: `mod${i}`, fileCount: 1, exportCount: 1, fanIn: 1, fanOut: 1 })
    );
    const classified = makeClassified({ modules });

    const manifest = buildPageTree(makeDiscovery(), classified, "abc");

    for (let i = 0; i < 3; i++) {
      const path = `wiki/modules/mod${i}.md`;
      expect(manifest.pages[path]).toBeDefined();
      expect(manifest.pages[path].depth).toBe("brief");
    }
  });

  test("assigns depth based on complexity percentiles for >= 5 modules", () => {
    const modules = [
      makeModule({ name: "huge", path: "src/huge", entryFile: "src/huge/index.ts", fileCount: 50, exportCount: 100, fanIn: 20, fanOut: 10 }),
      makeModule({ name: "large", path: "src/large", entryFile: "src/large/index.ts", fileCount: 30, exportCount: 60, fanIn: 15, fanOut: 8 }),
      makeModule({ name: "medium", path: "src/medium", entryFile: "src/medium/index.ts", fileCount: 15, exportCount: 20, fanIn: 8, fanOut: 5 }),
      makeModule({ name: "small", path: "src/small", entryFile: "src/small/index.ts", fileCount: 5, exportCount: 4, fanIn: 3, fanOut: 2 }),
      makeModule({ name: "tiny", path: "src/tiny", entryFile: "src/tiny/index.ts", fileCount: 2, exportCount: 1, fanIn: 1, fanOut: 1 }),
    ];
    const classified = makeClassified({ modules });

    const manifest = buildPageTree(makeDiscovery(), classified, "abc");

    const depths = Object.values(manifest.pages)
      .filter((p) => p.kind === "module")
      .map((p) => p.depth);
    expect(depths).toContain("full");
  });

  test("low-complexity modules get brief instead of being dropped", () => {
    const modules = [
      makeModule({ name: "huge", path: "src/huge", entryFile: "src/huge/index.ts", fileCount: 50, exportCount: 100, fanIn: 20, fanOut: 10 }),
      makeModule({ name: "large", path: "src/large", entryFile: "src/large/index.ts", fileCount: 30, exportCount: 60, fanIn: 15, fanOut: 8 }),
      makeModule({ name: "medium", path: "src/medium", entryFile: "src/medium/index.ts", fileCount: 15, exportCount: 20, fanIn: 8, fanOut: 5 }),
      makeModule({ name: "small", path: "src/small", entryFile: "src/small/index.ts", fileCount: 5, exportCount: 4, fanIn: 3, fanOut: 2 }),
      makeModule({ name: "tiny", path: "src/tiny", entryFile: "src/tiny/index.ts", fileCount: 2, exportCount: 1, fanIn: 1, fanOut: 1 }),
    ];
    const classified = makeClassified({ modules });
    const manifest = buildPageTree(makeDiscovery(), classified, "abc");

    // All 5 qualifying modules should get pages — none dropped
    const modulePages = Object.values(manifest.pages).filter((p) => p.kind === "module");
    expect(modulePages).toHaveLength(5);

    // The least complex module should get "brief"
    const tinyPage = manifest.pages["wiki/modules/tiny.md"];
    expect(tinyPage).toBeDefined();
    expect(tinyPage.depth).toBe("brief");
  });

  test("modules before cross-cutting in ordering", () => {
    const classified = makeClassified({
      modules: [makeModule({ name: "mod1" })],
    });

    const manifest = buildPageTree(makeDiscovery(), classified, "abc");
    const sorted = Object.entries(manifest.pages).sort(([, a], [, b]) => a.order - b.order);

    const firstModule = sorted.findIndex(([, p]) => p.tier === "module");
    const firstAggregate = sorted.findIndex(([, p]) => p.tier === "aggregate");

    if (firstModule >= 0 && firstAggregate >= 0) {
      expect(firstModule).toBeLessThan(firstAggregate);
    }
  });

  test("computes relatedPages for module pages", () => {
    const classified = makeClassified({
      modules: [makeModule({ name: "mod1" })],
    });

    const manifest = buildPageTree(makeDiscovery(), classified, "abc");
    const modPage = manifest.pages["wiki/modules/mod1.md"];

    // Module page should not link to entities/hubs (they don't exist)
    if (modPage) {
      expect(modPage.relatedPages.filter((r) => r.includes("/entities/"))).toHaveLength(0);
      expect(modPage.relatedPages.filter((r) => r.includes("/hubs/"))).toHaveLength(0);
    }
  });

  test("manifest metadata is populated", () => {
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), "abc123");

    expect(manifest.version).toBe(2);
    expect(manifest.lastGitRef).toBe("abc123");
    expect(manifest.generatedAt).toBeTruthy();
    expect(manifest.pageCount).toBeGreaterThan(0);
    expect(manifest.pageCount).toBe(Object.keys(manifest.pages).length);
  });

  test("handles empty classified inventory gracefully", () => {
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), "abc");

    expect(manifest.pageCount).toBeGreaterThan(0);
    expect(Object.keys(manifest.pages)).toContain("wiki/index.md");
  });

  test("all pages have tier module or aggregate", () => {
    const classified = makeClassified({
      modules: [makeModule({ name: "db" })],
    });
    const manifest = buildPageTree(makeDiscovery(), classified, "abc");

    for (const page of Object.values(manifest.pages)) {
      expect(["module", "aggregate"]).toContain(page.tier);
    }
  });

  // ── Module sub-pages ──

  test("generates sub-pages for large full-depth modules", () => {
    // Create a module large enough to qualify: fileCount >= 10, full depth
    // Need >= 5 modules for percentile system, and this one must be p90 for "full"
    const bigFiles = Array.from({ length: 12 }, (_, i) => `src/big/file${i}.ts`);
    const bigExports = Array.from({ length: 6 }, (_, i) => ({
      name: `export${i}`,
      type: "function",
    }));

    const modules = [
      makeModule({
        name: "big",
        path: "src/big",
        entryFile: "src/big/index.ts",
        files: bigFiles,
        fileCount: 12,
        exportCount: 25,
        fanIn: 20,
        fanOut: 10,
      }),
      makeModule({ name: "m2", path: "src/m2", fileCount: 8, exportCount: 10, fanIn: 10, fanOut: 5 }),
      makeModule({ name: "m3", path: "src/m3", fileCount: 5, exportCount: 6, fanIn: 5, fanOut: 3 }),
      makeModule({ name: "m4", path: "src/m4", fileCount: 3, exportCount: 3, fanIn: 3, fanOut: 2 }),
      makeModule({ name: "m5", path: "src/m5", fileCount: 2, exportCount: 1, fanIn: 1, fanOut: 1 }),
    ];

    // Create file-level nodes for the big module's files with high exports/fanIn
    const fileNodes = bigFiles.map((f, i) =>
      makeFileNode({
        path: f,
        exports: i < 3 ? bigExports : [], // first 3 files have 6 exports each
        fanIn: i < 2 ? 5 : 0, // first 2 files have fanIn 5
      })
    );

    const discovery = makeDiscovery({
      graphData: {
        fileLevel: { level: "file", nodes: fileNodes, edges: [] },
        directoryLevel: { level: "directory", directories: [], edges: [] },
      },
    });

    const classified = makeClassified({ modules });
    const manifest = buildPageTree(discovery, classified, "abc");

    // The big module should have sub-pages
    const subPages = Object.keys(manifest.pages).filter(
      (p) => p.startsWith("wiki/modules/big/") && p !== "wiki/modules/big/index.md"
    );
    expect(subPages.length).toBeGreaterThan(0);
    expect(subPages.length).toBeLessThanOrEqual(5); // capped at 5
  });

  test("does not generate sub-pages for small modules", () => {
    const modules = Array.from({ length: 3 }, (_, i) =>
      makeModule({ name: `mod${i}`, fileCount: 3, exportCount: 4 })
    );
    const classified = makeClassified({ modules });
    const manifest = buildPageTree(makeDiscovery(), classified, "abc");

    // No module-file pages
    const subPages = Object.values(manifest.pages).filter((p) => p.kind === "file");
    expect(subPages).toHaveLength(0);
  });

  test("sub-pages are typed module-file with module tier", () => {
    const bigFiles = Array.from({ length: 12 }, (_, i) => `src/big/file${i}.ts`);
    const bigExports = Array.from({ length: 6 }, (_, i) => ({
      name: `export${i}`,
      type: "function",
    }));

    const modules = [
      makeModule({
        name: "big",
        path: "src/big",
        entryFile: "src/big/index.ts",
        files: bigFiles,
        fileCount: 12,
        exportCount: 25,
        fanIn: 20,
        fanOut: 10,
      }),
      makeModule({ name: "m2", path: "src/m2", fileCount: 8, exportCount: 10, fanIn: 10, fanOut: 5 }),
      makeModule({ name: "m3", path: "src/m3", fileCount: 5, exportCount: 6, fanIn: 5, fanOut: 3 }),
      makeModule({ name: "m4", path: "src/m4", fileCount: 3, exportCount: 3, fanIn: 3, fanOut: 2 }),
      makeModule({ name: "m5", path: "src/m5", fileCount: 2, exportCount: 1, fanIn: 1, fanOut: 1 }),
    ];

    const fileNodes = bigFiles.map((f, i) =>
      makeFileNode({
        path: f,
        exports: i < 3 ? bigExports : [],
        fanIn: i < 2 ? 5 : 0,
      })
    );

    const discovery = makeDiscovery({
      graphData: {
        fileLevel: { level: "file", nodes: fileNodes, edges: [] },
        directoryLevel: { level: "directory", directories: [], edges: [] },
      },
    });

    const classified = makeClassified({ modules });
    const manifest = buildPageTree(discovery, classified, "abc");

    const moduleFilePages = Object.values(manifest.pages).filter((p) => p.kind === "file");
    for (const page of moduleFilePages) {
      expect(page.tier).toBe("module");
      expect(page.depth).toBe("standard");
      expect(page.focus).toBe("module-file");
    }
  });

  test("sub-pages link to parent module and siblings", () => {
    const bigFiles = Array.from({ length: 12 }, (_, i) => `src/big/file${i}.ts`);
    const bigExports = Array.from({ length: 6 }, (_, i) => ({
      name: `export${i}`,
      type: "function",
    }));

    const modules = [
      makeModule({
        name: "big",
        path: "src/big",
        entryFile: "src/big/index.ts",
        files: bigFiles,
        fileCount: 12,
        exportCount: 25,
        fanIn: 20,
        fanOut: 10,
      }),
      makeModule({ name: "m2", path: "src/m2", fileCount: 8, exportCount: 10, fanIn: 10, fanOut: 5 }),
      makeModule({ name: "m3", path: "src/m3", fileCount: 5, exportCount: 6, fanIn: 5, fanOut: 3 }),
      makeModule({ name: "m4", path: "src/m4", fileCount: 3, exportCount: 3, fanIn: 3, fanOut: 2 }),
      makeModule({ name: "m5", path: "src/m5", fileCount: 2, exportCount: 1, fanIn: 1, fanOut: 1 }),
    ];

    const fileNodes = bigFiles.map((f, i) =>
      makeFileNode({
        path: f,
        exports: i < 3 ? bigExports : [],
        fanIn: i < 2 ? 5 : 0,
      })
    );

    const discovery = makeDiscovery({
      graphData: {
        fileLevel: { level: "file", nodes: fileNodes, edges: [] },
        directoryLevel: { level: "directory", directories: [], edges: [] },
      },
    });

    const classified = makeClassified({ modules });
    const manifest = buildPageTree(discovery, classified, "abc");

    const subPages = Object.entries(manifest.pages).filter(([, p]) => p.kind === "file");
    for (const [path, page] of subPages) {
      // Should link to parent module index
      expect(page.relatedPages).toContain("wiki/modules/big/index.md");
    }

    // Parent module should link to sub-pages
    const parentPage = manifest.pages["wiki/modules/big/index.md"];
    expect(parentPage).toBeDefined();
    for (const [subPath] of subPages) {
      expect(parentPage.relatedPages).toContain(subPath);
    }
  });

  test("converts names to kebab-case paths", () => {
    const classified = makeClassified({
      modules: [
        makeModule({ name: "SearchResult" }),
      ],
    });

    const manifest = buildPageTree(makeDiscovery(), classified, "abc");
    expect(Object.keys(manifest.pages)).toContain("wiki/modules/search-result.md");
  });
});
