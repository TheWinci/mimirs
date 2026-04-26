import { describe, test, expect } from "bun:test";
import { classifyStaleness } from "../../src/wiki/staleness";
import type {
  PageManifest,
  ManifestPage,
  CommunityBundle,
  SynthesesFile,
} from "../../src/wiki/types";

function makePage(overrides: Partial<ManifestPage> = {}): ManifestPage {
  return {
    kind: overrides.kind ?? "community",
    slug: overrides.slug ?? "test",
    title: overrides.title ?? "Test",
    purpose: overrides.purpose ?? "",
    sections: overrides.sections ?? [],
    depth: overrides.depth ?? "standard",
    memberFiles: overrides.memberFiles ?? [],
    communityId: overrides.communityId,
    relatedPages: overrides.relatedPages ?? [],
    order: overrides.order ?? 0,
  };
}

function makeManifest(
  pages: Record<string, ManifestPage>,
  lastGitRef = "abc",
): PageManifest {
  return {
    version: 3,
    generatedAt: "2026-01-01T00:00:00Z",
    lastGitRef,
    pageCount: Object.keys(pages).length,
    pages,
    warnings: [],
  };
}

function makeBundle(id: string, files: string[]): CommunityBundle {
  return {
    communityId: id,
    memberFiles: files,
    exports: [],
    tunables: [],
    topMemberLoc: 0,
    memberLoc: {},
    tunableCount: 0,
    exportCount: 0,
    externalConsumers: [],
    externalDependencies: [],
    consumersByFile: {},
    dependenciesByFile: {},
    recentCommits: [],
    annotations: [],
    topRankedFile: files[0] ?? null,
    memberPreviews: [],
    pageRank: {},
    cohesion: 1,
    nearbyDocs: [],
  };
}

function makeSyntheses(ids: string[], members: Record<string, string[]> = {}): SynthesesFile {
  const out: SynthesesFile = { version: 1, payloads: {}, memberSets: {} };
  for (const id of ids) {
    out.payloads[id] = {
      communityId: id,
      name: id,
      slug: id,
      purpose: "",
      sections: [{ title: "x", purpose: "y" }],
      kind: "community",
    };
    out.memberSets[id] = members[id] ?? [];
  }
  return out;
}

describe("classifyStaleness", () => {
  test("community page stale when one of its member files changes", () => {
    const old = makeManifest({
      "wiki/communities/alpha.md": makePage({ slug: "alpha", communityId: "a", memberFiles: ["src/a.ts", "src/b.ts"] }),
    });
    const fresh = old;
    const bundles = [makeBundle("a", ["src/a.ts", "src/b.ts"])];
    const report = classifyStaleness(
      old, fresh, bundles, makeSyntheses(["a"]),
      new Set(), new Set(), new Set(["src/b.ts"]),
    );
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].wikiPath).toBe("wiki/communities/alpha.md");
    expect(report.stale[0].triggers).toContain("src/b.ts");
  });

  test("community page fresh when an unrelated file changes", () => {
    const old = makeManifest({
      "wiki/communities/alpha.md": makePage({ slug: "alpha", communityId: "a", memberFiles: ["src/a.ts"] }),
    });
    const bundles = [makeBundle("a", ["src/a.ts"])];
    const report = classifyStaleness(
      old, old, bundles, makeSyntheses(["a"]),
      new Set(), new Set(), new Set(["src/other.ts"]),
    );
    expect(report.stale).toHaveLength(0);
  });

  test("architecture page stale when community set shifts", () => {
    const old = makeManifest({
      "wiki/communities/alpha.md": makePage({ slug: "alpha", communityId: "a" }),
      "wiki/architecture.md": makePage({ kind: "architecture", slug: "architecture", title: "Architecture" }),
    });
    const fresh = makeManifest({
      "wiki/beta.md": makePage({ slug: "beta", communityId: "b" }),
      "wiki/architecture.md": makePage({ kind: "architecture", slug: "architecture", title: "Architecture" }),
    });
    const bundles = [makeBundle("b", ["src/b.ts"])];
    const report = classifyStaleness(
      old, fresh, bundles, makeSyntheses(["b"]),
      new Set(), new Set(), new Set(),
    );
    const agg = report.stale.find((s) => s.wikiPath === "wiki/architecture.md");
    expect(agg).toBeDefined();
    expect(agg?.triggers).toContain("community set changed");
  });

  test("architecture page stale when a top-hub file changes", () => {
    const old = makeManifest({
      "wiki/architecture.md": makePage({ kind: "architecture", slug: "architecture", title: "Architecture" }),
    });
    const report = classifyStaleness(
      old, old, [], makeSyntheses([]),
      new Set(["src/core.ts"]), new Set(),
      new Set(["src/core.ts"]),
    );
    const agg = report.stale.find((s) => s.wikiPath === "wiki/architecture.md");
    expect(agg).toBeDefined();
    expect(agg?.triggers).toContain("src/core.ts");
  });

  test("data-flows page stale when community set shifts", () => {
    const old = makeManifest({
      "wiki/data-flows.md": makePage({ kind: "data-flows", slug: "data-flows", title: "Data flows" }),
      "wiki/communities/alpha.md": makePage({ slug: "alpha", communityId: "a" }),
    });
    const fresh = makeManifest({
      "wiki/data-flows.md": makePage({ kind: "data-flows", slug: "data-flows", title: "Data flows" }),
      "wiki/communities/beta.md": makePage({ slug: "beta", communityId: "b" }),
    });
    const bundles = [makeBundle("b", ["src/b.ts"])];
    const report = classifyStaleness(
      old, fresh, bundles, makeSyntheses(["b"]),
      new Set(), new Set(), new Set(),
    );
    const flows = report.stale.find((s) => s.wikiPath === "wiki/data-flows.md");
    expect(flows).toBeDefined();
    expect(flows?.triggers).toContain("community set changed");
  });

  test("data-flows page stale when a top-hub file changes", () => {
    const old = makeManifest({
      "wiki/data-flows.md": makePage({ kind: "data-flows", slug: "data-flows", title: "Data flows" }),
    });
    const report = classifyStaleness(
      old, old, [], makeSyntheses([]),
      new Set(["src/core.ts"]), new Set(),
      new Set(["src/core.ts"]),
    );
    const flows = report.stale.find((s) => s.wikiPath === "wiki/data-flows.md");
    expect(flows).toBeDefined();
    expect(flows?.triggers).toContain("src/core.ts");
  });

  test("architecture page stale when an entry point changes", () => {
    const old = makeManifest({
      "wiki/architecture.md": makePage({ kind: "architecture", slug: "architecture", title: "Architecture" }),
    });
    const report = classifyStaleness(
      old, old, [], makeSyntheses([]),
      new Set(), new Set(["src/cli.ts"]),
      new Set(["src/cli.ts"]),
    );
    const agg = report.stale.find((s) => s.wikiPath === "wiki/architecture.md");
    expect(agg).toBeDefined();
    expect(agg?.triggers).toContain("src/cli.ts");
  });

  test("new page detected when wiki path only in new manifest", () => {
    const old = makeManifest({});
    const fresh = makeManifest({
      "wiki/new.md": makePage({ slug: "new", communityId: "new", order: 3 }),
    });
    const report = classifyStaleness(
      old, fresh, [makeBundle("new", ["src/x.ts"])], makeSyntheses(["new"]),
      new Set(), new Set(), new Set(),
    );
    expect(report.added).toHaveLength(1);
    expect(report.added[0].wikiPath).toBe("wiki/new.md");
  });

  test("removed page detected when wiki path only in old manifest", () => {
    const old = makeManifest({
      "wiki/gone.md": makePage({ slug: "gone", communityId: "gone", title: "Gone" }),
    });
    const fresh = makeManifest({});
    const report = classifyStaleness(
      old, fresh, [], makeSyntheses([]),
      new Set(), new Set(), new Set(),
    );
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0].wikiPath).toBe("wiki/gone.md");
  });

  test("missingSyntheses lists communities absent from SynthesesFile", () => {
    const old = makeManifest({});
    const fresh = makeManifest({});
    const bundles = [makeBundle("a", ["src/a.ts"]), makeBundle("b", ["src/b.ts"])];
    const report = classifyStaleness(
      old, fresh, bundles, makeSyntheses(["a"]),
      new Set(), new Set(), new Set(),
    );
    expect(report.missingSyntheses).toEqual(["b"]);
  });
});
