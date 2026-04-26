import { describe, test, expect } from "bun:test";
import {
  communityReadBreadcrumbs,
  suggestedQueriesFor,
} from "../../src/tools/wiki-tools";
import { semanticQueriesFor } from "../../src/wiki/semantic-queries";
import type { PagePayload, CommunityBundle } from "../../src/wiki/types";

function makeBundle(
  overrides: Partial<CommunityBundle> = {},
): CommunityBundle {
  return {
    communityId: overrides.communityId ?? "c0",
    memberFiles: overrides.memberFiles ?? [],
    exports: overrides.exports ?? [],
    tunables: overrides.tunables ?? [],
    topMemberLoc: overrides.topMemberLoc ?? 0,
    memberLoc: overrides.memberLoc ?? {},
    tunableCount: overrides.tunableCount ?? 0,
    exportCount: overrides.exportCount ?? (overrides.exports?.length ?? 0),
    externalConsumers: overrides.externalConsumers ?? [],
    externalDependencies: overrides.externalDependencies ?? [],
    consumersByFile: overrides.consumersByFile ?? {},
    dependenciesByFile: overrides.dependenciesByFile ?? {},
    recentCommits: overrides.recentCommits ?? [],
    annotations: overrides.annotations ?? [],
    topRankedFile: overrides.topRankedFile ?? null,
    memberPreviews: overrides.memberPreviews ?? [],
    pageRank: overrides.pageRank ?? {},
    cohesion: overrides.cohesion ?? 1,
    nearbyDocs: overrides.nearbyDocs ?? [],
  };
}

function makePayload(overrides: Partial<PagePayload> = {}): PagePayload {
  return {
    wikiPath: overrides.wikiPath ?? "wiki/communities/x.md",
    kind: overrides.kind ?? "community",
    slug: overrides.slug ?? "x",
    title: overrides.title ?? "X",
    purpose: overrides.purpose ?? "p",
    depth: overrides.depth ?? "standard",
    sections: overrides.sections ?? [],
    prefetched: overrides.prefetched ?? {},
    relatedPages: overrides.relatedPages ?? [],
    linkMap: overrides.linkMap ?? {},
  };
}

describe("communityReadBreadcrumbs", () => {
  test("returns [] for non-community payload", () => {
    const payload = makePayload({ kind: "architecture" });
    expect(communityReadBreadcrumbs(payload)).toEqual([]);
  });

  test("returns [] when bundle has no members", () => {
    const payload = makePayload({
      prefetched: { community: makeBundle({ memberFiles: [] }) },
    });
    expect(communityReadBreadcrumbs(payload)).toEqual([]);
  });

  test("excludes topRankedFile from breadcrumbs", () => {
    const bundle = makeBundle({
      memberFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      topRankedFile: "src/a.ts",
    });
    const payload = makePayload({ prefetched: { community: bundle } });
    const paths = communityReadBreadcrumbs(payload).map((b) => b.path);
    expect(paths).toEqual(["src/b.ts", "src/c.ts"]);
  });

  test("includes all members when topRankedFile is null", () => {
    const bundle = makeBundle({
      memberFiles: ["src/a.ts", "src/b.ts"],
      topRankedFile: null,
    });
    const payload = makePayload({ prefetched: { community: bundle } });
    expect(communityReadBreadcrumbs(payload)).toHaveLength(2);
  });

  test("each breadcrumb has a non-empty reason", () => {
    const bundle = makeBundle({
      memberFiles: ["src/a.ts", "src/b.ts"],
      topRankedFile: "src/a.ts",
    });
    const payload = makePayload({ prefetched: { community: bundle } });
    const bc = communityReadBreadcrumbs(payload);
    expect(bc[0].reason).toContain("Read");
  });
});

describe("suggestedQueriesFor", () => {
  test("community-file kind emits Read entry per member file", () => {
    const bundle = makeBundle({ memberFiles: ["src/a.ts", "src/b.ts"] });
    const payload = makePayload({
      kind: "community-file",
      prefetched: { community: bundle },
    });
    const queries = suggestedQueriesFor(payload);
    expect(queries).toHaveLength(2);
    expect(queries[0].tool).toBe("Read");
    expect(queries.map((q) => q.query)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("community-file with no members falls back to title", () => {
    const payload = makePayload({
      kind: "community-file",
      title: "src/x.ts",
      prefetched: { community: makeBundle({ memberFiles: [] }) },
    });
    const queries = suggestedQueriesFor(payload);
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toBe("src/x.ts");
  });

  test("non-community-file kinds return empty list", () => {
    for (const kind of ["community", "architecture", "data-flows", "getting-started", "wat"]) {
      const payload = makePayload({ kind, title: "X" });
      expect(suggestedQueriesFor(payload)).toEqual([]);
    }
  });
});

describe("semanticQueriesFor", () => {
  test("architecture kind covers entry + cross-cutting", () => {
    const queries = semanticQueriesFor("architecture");
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries.join(" ")).toMatch(/entry point/);
    expect(queries.join(" ")).toMatch(/cross-cutting/);
  });

  test("community kind covers API + tunables + errors", () => {
    const queries = semanticQueriesFor("community");
    expect(queries).toHaveLength(3);
    expect(queries.join(" ")).toMatch(/public API/);
    expect(queries.join(" ")).toMatch(/tunable/);
    expect(queries.join(" ")).toMatch(/error/);
  });

  test("getting-started kind covers setup + CLI + issues", () => {
    const queries = semanticQueriesFor("getting-started");
    expect(queries).toHaveLength(3);
    expect(queries.join(" ")).toMatch(/setup/);
    expect(queries.join(" ")).toMatch(/CLI/);
    expect(queries.join(" ")).toMatch(/known issues/);
  });

  test("unknown kind returns empty list", () => {
    expect(semanticQueriesFor("wat")).toEqual([]);
  });
});
