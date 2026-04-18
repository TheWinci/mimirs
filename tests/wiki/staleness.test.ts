import { describe, test, expect } from "bun:test";
import { classifyStaleness } from "../../src/wiki/staleness";
import type {
  PageManifest,
  ManifestPage,
  ClassifiedInventory,
  ClassifiedModule,
  ClassifiedFile,
} from "../../src/wiki/types";

function makePage(overrides: Partial<ManifestPage> = {}): ManifestPage {
  return {
    kind: overrides.kind ?? "module",
    focus: overrides.focus,
    tier: overrides.tier ?? "module",
    title: overrides.title ?? "m",
    depth: overrides.depth ?? "standard",
    sourceFiles: overrides.sourceFiles ?? [],
    relatedPages: overrides.relatedPages ?? [],
    order: overrides.order ?? 0,
  };
}

function makeManifest(
  pages: Record<string, ManifestPage>,
  lastGitRef = "abc",
): PageManifest {
  return {
    version: 2,
    generatedAt: "2026-01-01T00:00:00Z",
    lastGitRef,
    pageCount: Object.keys(pages).length,
    pages,
    warnings: [],
  };
}

function makeModule(overrides: Partial<ClassifiedModule> = {}): ClassifiedModule {
  return {
    name: overrides.name ?? "m",
    path: overrides.path ?? "src/m",
    entryFile: overrides.entryFile ?? "src/m/index.ts",
    files: overrides.files ?? ["src/m/index.ts"],
    qualifiesAsModulePage: true,
    reason: "",
    hubs: [],
    bridges: [],
    entityCount: 0,
    fileCount: overrides.fileCount ?? 1,
    exportCount: 1,
    fanIn: 1,
    fanOut: 1,
    value: 1,
  };
}

function makeClassified(
  modules: ClassifiedModule[] = [],
  files: ClassifiedFile[] = [],
): ClassifiedInventory {
  return { symbols: [], files, modules, warnings: [] };
}

describe("classifyStaleness", () => {
  test("module-file page stale when its source file changes", () => {
    const old = makeManifest({
      "wiki/modules/m/foo.md": makePage({
        kind: "file",
        focus: "module-file",
        sourceFiles: ["src/m/foo.ts"],
        depth: "standard",
      }),
    });
    const fresh = makeManifest({
      "wiki/modules/m/foo.md": makePage({
        kind: "file",
        focus: "module-file",
        sourceFiles: ["src/m/foo.ts"],
        depth: "standard",
      }),
    });
    const report = classifyStaleness(
      old,
      fresh,
      makeClassified(),
      new Set(),
      new Set(["src/m/foo.ts"]),
    );
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].wikiPath).toBe("wiki/modules/m/foo.md");
    expect(report.stale[0].triggers).toContain("src/m/foo.ts");
  });

  test("module-file page fresh when an unrelated file changes", () => {
    const old = makeManifest({
      "wiki/modules/m/foo.md": makePage({
        kind: "file",
        focus: "module-file",
        sourceFiles: ["src/m/foo.ts"],
      }),
    });
    const report = classifyStaleness(
      old,
      old,
      makeClassified(),
      new Set(),
      new Set(["src/other/bar.ts"]),
    );
    expect(report.stale).toHaveLength(0);
  });

  test("module page stale when any file in its module changes (not just entry)", () => {
    const old = makeManifest({
      "wiki/modules/m.md": makePage({
        kind: "module",
        title: "m",
        sourceFiles: ["src/m/index.ts"],
      }),
    });
    const report = classifyStaleness(
      old,
      old,
      makeClassified([
        makeModule({
          name: "m",
          files: ["src/m/index.ts", "src/m/helper.ts"],
        }),
      ]),
      new Set(),
      new Set(["src/m/helper.ts"]),
    );
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].triggers).toContain("src/m/helper.ts");
  });

  test("module page stale when depth changes", () => {
    const old = makeManifest({
      "wiki/modules/m.md": makePage({
        kind: "module",
        title: "m",
        sourceFiles: ["src/m/index.ts"],
        depth: "brief",
      }),
    });
    const fresh = makeManifest({
      "wiki/modules/m.md": makePage({
        kind: "module",
        title: "m",
        sourceFiles: ["src/m/index.ts"],
        depth: "full",
      }),
    });
    const report = classifyStaleness(
      old,
      fresh,
      makeClassified([makeModule({ name: "m" })]),
      new Set(),
      new Set(),
    );
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].triggers[0]).toMatch(/depth changed/);
  });

  test("aggregate page fresh when only an interior module file changes", () => {
    const modulePage = makePage({
      kind: "module",
      title: "m",
      sourceFiles: ["src/m/index.ts"],
    });
    const aggregatePage = makePage({
      kind: "aggregate",
      focus: "architecture",
      tier: "aggregate",
      title: "Architecture",
      sourceFiles: [],
    });
    const old = makeManifest({
      "wiki/modules/m.md": modulePage,
      "wiki/architecture.md": aggregatePage,
    });
    const report = classifyStaleness(
      old,
      old,
      makeClassified(
        [makeModule({ name: "m", files: ["src/m/index.ts", "src/m/helper.ts"] })],
        // helper.ts is NOT a hub
        [{ path: "src/m/helper.ts", fanIn: 0, fanOut: 0, isHub: false, bridges: [], entities: [] }],
      ),
      new Set(), // no entry points
      new Set(["src/m/helper.ts"]),
    );
    const agg = report.stale.find((s) => s.wikiPath === "wiki/architecture.md");
    expect(agg).toBeUndefined();
  });

  test("aggregate page stale when a hub file changes", () => {
    const aggregatePage = makePage({
      kind: "aggregate",
      focus: "architecture",
      tier: "aggregate",
      title: "Architecture",
      sourceFiles: [],
    });
    const old = makeManifest({ "wiki/architecture.md": aggregatePage });
    const report = classifyStaleness(
      old,
      old,
      makeClassified(
        [],
        [{ path: "src/core.ts", fanIn: 20, fanOut: 5, isHub: true, bridges: [], entities: [] }],
      ),
      new Set(),
      new Set(["src/core.ts"]),
    );
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].wikiPath).toBe("wiki/architecture.md");
    expect(report.stale[0].triggers).toContain("src/core.ts");
  });

  test("aggregate page stale when an entry point file changes", () => {
    const aggregatePage = makePage({
      kind: "aggregate",
      focus: "architecture",
      tier: "aggregate",
      title: "Architecture",
    });
    const old = makeManifest({ "wiki/architecture.md": aggregatePage });
    const report = classifyStaleness(
      old,
      old,
      makeClassified(),
      new Set(["src/cli.ts"]),
      new Set(["src/cli.ts"]),
    );
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].triggers).toContain("src/cli.ts");
  });

  test("aggregate page stale when the module-page set changes", () => {
    const aggregatePage = makePage({
      kind: "aggregate",
      focus: "architecture",
      tier: "aggregate",
      title: "Architecture",
    });
    const old = makeManifest({
      "wiki/modules/gone.md": makePage({ kind: "module", title: "gone" }),
      "wiki/architecture.md": aggregatePage,
    });
    const fresh = makeManifest({
      "wiki/modules/new.md": makePage({ kind: "module", title: "new" }),
      "wiki/architecture.md": aggregatePage,
    });
    const report = classifyStaleness(
      old,
      fresh,
      makeClassified([makeModule({ name: "new" })]),
      new Set(),
      new Set(),
    );
    const agg = report.stale.find((s) => s.wikiPath === "wiki/architecture.md");
    expect(agg).toBeDefined();
    expect(agg?.triggers).toContain("module page set changed");
  });

  test("new page detected when wiki path only exists in new manifest", () => {
    const old = makeManifest({});
    const fresh = makeManifest({
      "wiki/modules/new.md": makePage({ kind: "module", title: "new", order: 3 }),
    });
    const report = classifyStaleness(
      old,
      fresh,
      makeClassified([makeModule({ name: "new" })]),
      new Set(),
      new Set(),
    );
    expect(report.added).toHaveLength(1);
    expect(report.added[0].wikiPath).toBe("wiki/modules/new.md");
    expect(report.stale).toHaveLength(0);
  });

  test("removed page detected when wiki path only exists in old manifest", () => {
    const old = makeManifest({
      "wiki/modules/gone.md": makePage({ kind: "module", title: "gone" }),
    });
    const fresh = makeManifest({});
    const report = classifyStaleness(
      old,
      fresh,
      makeClassified(),
      new Set(),
      new Set(),
    );
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].wikiPath).toBe("wiki/modules/gone.md");
  });
});
