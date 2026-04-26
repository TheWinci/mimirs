import { describe, test, expect } from "bun:test";
import { scopeBundleToFiles } from "../../src/wiki/content-prefetch";
import type { CommunityBundle } from "../../src/wiki/types";

function makeBundle(overrides: Partial<CommunityBundle> = {}): CommunityBundle {
  return {
    communityId: overrides.communityId ?? "c0",
    memberFiles: overrides.memberFiles ?? ["src/a.ts", "src/b.ts", "src/c.ts"],
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

describe("scopeBundleToFiles — sub-page importer attribution", () => {
  test("scoped externalConsumers covers only the sub-page's files", () => {
    const parent = makeBundle({
      memberFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      externalConsumers: ["other/x.ts", "other/y.ts", "other/z.ts"],
      consumersByFile: {
        "src/a.ts": ["other/x.ts"],
        "src/b.ts": ["other/y.ts"],
        "src/c.ts": ["other/z.ts"],
      },
    });
    const scoped = scopeBundleToFiles(parent, ["src/a.ts", "src/b.ts"], "/proj");
    expect(scoped.externalConsumers).toEqual(["other/x.ts", "other/y.ts"]);
    expect(scoped.consumersByFile).toEqual({
      "src/a.ts": ["other/x.ts"],
      "src/b.ts": ["other/y.ts"],
    });
  });

  test("scoped externalDependencies follows the file subset", () => {
    const parent = makeBundle({
      memberFiles: ["src/a.ts", "src/b.ts"],
      externalDependencies: ["lib/p.ts", "lib/q.ts"],
      dependenciesByFile: {
        "src/a.ts": ["lib/p.ts"],
        "src/b.ts": ["lib/q.ts"],
      },
    });
    const scoped = scopeBundleToFiles(parent, ["src/b.ts"], "/proj");
    expect(scoped.externalDependencies).toEqual(["lib/q.ts"]);
    expect(scoped.dependenciesByFile).toEqual({ "src/b.ts": ["lib/q.ts"] });
  });

  test("dedups when two scoped files share an importer", () => {
    const parent = makeBundle({
      memberFiles: ["src/a.ts", "src/b.ts"],
      consumersByFile: {
        "src/a.ts": ["other/x.ts"],
        "src/b.ts": ["other/x.ts"],
      },
    });
    const scoped = scopeBundleToFiles(parent, ["src/a.ts", "src/b.ts"], "/proj");
    expect(scoped.externalConsumers).toEqual(["other/x.ts"]);
  });

  test("missing per-file map entries fall through to empty", () => {
    const parent = makeBundle({
      memberFiles: ["src/a.ts"],
      consumersByFile: {},
      dependenciesByFile: {},
    });
    const scoped = scopeBundleToFiles(parent, ["src/a.ts"], "/proj");
    expect(scoped.externalConsumers).toEqual([]);
    expect(scoped.consumersByFile).toEqual({ "src/a.ts": [] });
  });
});
