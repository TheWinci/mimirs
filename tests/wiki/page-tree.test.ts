import { describe, test, expect } from "bun:test";
import { buildPageTree } from "../../src/wiki/page-tree";
import type {
  DiscoveryResult,
  ClassifiedInventory,
  CommunityBundle,
  SynthesesFile,
  SynthesisPayload,
} from "../../src/wiki/types";

function makeBundle(
  id: string,
  overrides: Partial<CommunityBundle> = {},
): CommunityBundle {
  return {
    communityId: id,
    memberFiles: overrides.memberFiles ?? [],
    exports: overrides.exports ?? [],
    tunables: overrides.tunables ?? [],
    topMemberLoc: overrides.topMemberLoc ?? 0,
    memberLoc: overrides.memberLoc ?? {},
    tunableCount: overrides.tunableCount ?? 0,
    exportCount: overrides.exportCount ?? (overrides.exports?.length ?? 0),
    externalConsumers: [],
    externalDependencies: [],
    consumersByFile: overrides.consumersByFile ?? {},
    dependenciesByFile: overrides.dependenciesByFile ?? {},
    recentCommits: [],
    annotations: [],
    topRankedFile: null,
    memberPreviews: [],
    pageRank: overrides.pageRank ?? {},
    cohesion: overrides.cohesion ?? 1,
    nearbyDocs: [],
  };
}

/**
 * Build a bundle where every member file has the given LOC. Use to force the
 * size-based split trigger on/off in tests.
 */
function bundleWithMembers(
  id: string,
  files: string[],
  locPerFile: number,
  extra: Partial<CommunityBundle> = {},
): CommunityBundle {
  const memberLoc = Object.fromEntries(files.map((f) => [f, locPerFile]));
  return makeBundle(id, {
    memberFiles: files,
    memberLoc,
    topMemberLoc: locPerFile,
    ...extra,
  });
}

function makeDiscovery(): DiscoveryResult {
  return {
    fileCount: 0,
    chunkCount: 0,
    lastIndexed: null,
    modules: [],
    graphData: {
      fileLevel: { level: "file", nodes: [], edges: [] },
      directoryLevel: { level: "directory", directories: [], edges: [] },
    },
    warnings: [],
  };
}

function makeClassified(): ClassifiedInventory {
  return { symbols: [], files: [], warnings: [] };
}

function makePayload(overrides: Partial<SynthesisPayload> = {}): SynthesisPayload {
  return {
    communityId: overrides.communityId ?? "c0",
    name: overrides.name ?? "Test Community",
    slug: overrides.slug ?? "test-community",
    purpose: overrides.purpose ?? "A test community.",
    kind: overrides.kind ?? "community",
    sections: overrides.sections ?? [
      { title: "Overview", purpose: "What it is" },
    ],
  };
}

function makeSyntheses(payloads: SynthesisPayload[], members: Record<string, string[]> = {}): SynthesesFile {
  const out: SynthesesFile = { version: 1, payloads: {}, memberSets: {} };
  for (const p of payloads) {
    out.payloads[p.communityId] = p;
    out.memberSets[p.communityId] = members[p.communityId] ?? [];
  }
  return out;
}

describe("buildPageTree", () => {
  test("always emits architecture + data-flows + getting-started aggregate pages at wiki root", () => {
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), makeSyntheses([]), "abc");
    const paths = Object.keys(manifest.pages);
    expect(paths).toContain("wiki/architecture.md");
    expect(paths).toContain("wiki/data-flows.md");
    expect(paths).toContain("wiki/getting-started.md");
  });

  test("community pages live under wiki/communities/<slug>.md", () => {
    const syntheses = makeSyntheses([
      makePayload({ communityId: "a", slug: "alpha", name: "Alpha" }),
      makePayload({ communityId: "b", slug: "beta", name: "Beta" }),
    ]);
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc");
    expect(Object.keys(manifest.pages)).toContain("wiki/communities/alpha.md");
    expect(Object.keys(manifest.pages)).toContain("wiki/communities/beta.md");
    // Ensure no flat path and no deeper nesting.
    expect(manifest.pages["wiki/alpha.md"]).toBeUndefined();
    expect(manifest.pages["wiki/communities/cli/alpha.md"]).toBeUndefined();
  });

  test("depth tracks member-file count", () => {
    const members = {
      big: Array.from({ length: 15 }, (_, i) => `src/big/f${i}.ts`),
      mid: Array.from({ length: 5 }, (_, i) => `src/mid/f${i}.ts`),
      small: ["src/small/f.ts"],
    };
    const syntheses = makeSyntheses(
      [
        makePayload({ communityId: "big", slug: "big" }),
        makePayload({ communityId: "mid", slug: "mid" }),
        makePayload({ communityId: "small", slug: "small" }),
      ],
      members,
    );
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc");
    expect(manifest.pages["wiki/communities/big.md"].depth).toBe("full");
    expect(manifest.pages["wiki/communities/mid.md"].depth).toBe("standard");
    expect(manifest.pages["wiki/communities/small.md"].depth).toBe("brief");
  });

  test("community pages use kind from the synthesis payload", () => {
    const syntheses = makeSyntheses([
      makePayload({ communityId: "a", slug: "alpha", kind: "community" }),
      makePayload({ communityId: "b", slug: "runtime", kind: "runtime" }),
    ]);
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc");
    expect(manifest.pages["wiki/communities/alpha.md"].kind).toBe("community");
    expect(manifest.pages["wiki/communities/runtime.md"].kind).toBe("runtime");
  });

  test("community pages order precede aggregate pages", () => {
    const syntheses = makeSyntheses([
      makePayload({ communityId: "a", slug: "alpha" }),
    ]);
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc");
    const sorted = Object.entries(manifest.pages).sort(([, a], [, b]) => a.order - b.order);
    const aggregateIdx = sorted.findIndex(([, p]) => p.kind === "architecture");
    const communityIdx = sorted.findIndex(([, p]) => p.kind === "community");
    expect(communityIdx).toBeGreaterThanOrEqual(0);
    expect(aggregateIdx).toBeGreaterThanOrEqual(0);
    expect(communityIdx).toBeLessThan(aggregateIdx);
  });

  test("manifest version is 3 and cluster round-trips", () => {
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), makeSyntheses([]), "abc", "symbols");
    expect(manifest.version).toBe(3);
    expect(manifest.cluster).toBe("symbols");
    expect(manifest.lastGitRef).toBe("abc");
  });

  test("aggregate pages link to all community pages", () => {
    const syntheses = makeSyntheses([
      makePayload({ communityId: "a", slug: "alpha" }),
      makePayload({ communityId: "b", slug: "beta" }),
    ]);
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc");
    const arch = manifest.pages["wiki/architecture.md"];
    expect(arch.relatedPages).toContain("wiki/communities/alpha.md");
    expect(arch.relatedPages).toContain("wiki/communities/beta.md");
    const flows = manifest.pages["wiki/data-flows.md"];
    expect(flows.relatedPages).toContain("wiki/communities/alpha.md");
    expect(flows.relatedPages).toContain("wiki/architecture.md");
  });

  test("community pages back-link to all aggregates", () => {
    const syntheses = makeSyntheses([
      makePayload({ communityId: "a", slug: "alpha" }),
    ]);
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc");
    const page = manifest.pages["wiki/communities/alpha.md"];
    expect(page.relatedPages).toContain("wiki/architecture.md");
    expect(page.relatedPages).toContain("wiki/data-flows.md");
    expect(page.relatedPages).toContain("wiki/getting-started.md");
  });

  test("warns when no syntheses supplied", () => {
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), makeSyntheses([]), "abc");
    expect(manifest.warnings.some((w) => w.includes("No syntheses"))).toBe(true);
  });

  test("data-flows page seeds sequence-diagram-oriented sections with full depth", () => {
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), makeSyntheses([]), "abc");
    const flows = manifest.pages["wiki/data-flows.md"];
    expect(flows.kind).toBe("data-flows");
    expect(flows.depth).toBe("full");
    expect(flows.sections.length).toBeGreaterThan(0);
    expect(flows.sections.map((s) => s.title)).toContain("Flow 1");
  });
});

describe("buildPageTree — depth-auto signals", () => {
  test("small community escalates to full when topMemberLoc > 400", () => {
    const members = { a: ["src/a.ts", "src/b.ts"] };
    const syntheses = makeSyntheses([makePayload({ communityId: "a", slug: "alpha" })], members);
    const bundles = [makeBundle("a", { topMemberLoc: 500 })];
    const manifest = buildPageTree(
      makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles,
    );
    expect(manifest.pages["wiki/communities/alpha.md"].depth).toBe("full");
  });

  test("small community escalates to full when tunableCount > 8", () => {
    const members = { a: ["src/a.ts", "src/b.ts"] };
    const syntheses = makeSyntheses([makePayload({ communityId: "a", slug: "alpha" })], members);
    const bundles = [makeBundle("a", { tunableCount: 10 })];
    const manifest = buildPageTree(
      makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles,
    );
    expect(manifest.pages["wiki/communities/alpha.md"].depth).toBe("full");
  });

  test("signals under thresholds leave file-count-based depth intact", () => {
    const members = {
      a: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], // 5 → standard
    };
    const syntheses = makeSyntheses([makePayload({ communityId: "a", slug: "alpha" })], members);
    const bundles = [makeBundle("a", { topMemberLoc: 200, tunableCount: 3 })];
    const manifest = buildPageTree(
      makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles,
    );
    expect(manifest.pages["wiki/communities/alpha.md"].depth).toBe("standard");
  });

  test("missing bundle falls back to member-count rule", () => {
    const members = { a: Array.from({ length: 12 }, (_, i) => `src/${i}.ts`) };
    const syntheses = makeSyntheses([makePayload({ communityId: "a", slug: "alpha" })], members);
    const manifest = buildPageTree(
      makeDiscovery(), makeClassified(), syntheses, "abc", "files", [],
    );
    expect(manifest.pages["wiki/communities/alpha.md"].depth).toBe("full");
  });
});

describe("buildPageTree — size-based sub-page split", () => {
  test("does NOT split without a bundle (no LOC signal → no size-based trigger)", () => {
    const memberFiles = Array.from({ length: 10 }, (_, i) => `src/x/${i}.ts`);
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "x", slug: "x" })],
      { x: memberFiles },
    );
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc");
    const subs = Object.values(manifest.pages).filter((p) => p.kind === "community-file");
    expect(subs).toHaveLength(0);
  });

  test("does NOT split a small-LOC community even with many members", () => {
    // 10 × 50 LOC = 500 total, 0 big members → stays monolithic.
    const memberFiles = Array.from({ length: 10 }, (_, i) => `src/x/${i}.ts`);
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "x", slug: "x" })],
      { x: memberFiles },
    );
    const bundles = [bundleWithMembers("x", memberFiles, 50)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const subs = Object.values(manifest.pages).filter((p) => p.kind === "community-file");
    expect(subs).toHaveLength(0);
  });

  test("splits when total LOC >= SPLIT_TOTAL_LOC; smalls stay on parent", () => {
    // 25 × 250 LOC = 6250 — trips SPLIT_TOTAL_LOC (5000) but every file is
    // small (< BIG_FILE_LOC=500) so NO sub-pages are created. Parent absorbs
    // them via per-file-breakdown.
    const memberFiles = Array.from({ length: 25 }, (_, i) => `src/x/${i}.ts`);
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "x", slug: "x" })],
      { x: memberFiles },
    );
    const bundles = [bundleWithMembers("x", memberFiles, 250)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const subs = Object.values(manifest.pages).filter((p) => p.kind === "community-file");
    expect(subs).toHaveLength(0);
  });

  test("big members (LOC >= BIG_FILE_LOC) get own sub-page; small members stay on parent", () => {
    const bigFiles = ["src/big-a.ts", "src/big-b.ts", "src/big-c.ts", "src/big-d.ts"];
    const smallFiles = Array.from({ length: 5 }, (_, i) => `src/util/small-${i}.ts`);
    const memberFiles = [...bigFiles, ...smallFiles];
    const memberLoc: Record<string, number> = {};
    for (const f of bigFiles) memberLoc[f] = 800;
    for (const f of smallFiles) memberLoc[f] = 100;
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "c", slug: "c" })],
      { c: memberFiles },
    );
    const bundles = [makeBundle("c", {
      memberFiles,
      memberLoc,
      topMemberLoc: 800,
    })];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const subs = Object.entries(manifest.pages)
      .filter(([, p]) => p.kind === "community-file")
      .map(([path, p]) => ({ path, p }));

    // One sub-page per big file; every sub-page holds exactly one member.
    expect(subs).toHaveLength(4);
    for (const s of subs) {
      expect(s.p.memberFiles).toHaveLength(1);
    }
    const singleMembers = subs.flatMap((s) => s.p.memberFiles);
    expect(new Set(singleMembers)).toEqual(new Set(bigFiles));
  });

  test("big-member trigger fires at SPLIT_BIG_MEMBER_COUNT even when total LOC is modest", () => {
    // 4 × 600 LOC = 2400 total (under SPLIT_TOTAL_LOC=5000) but 4 big members →
    // SPLIT_BIG_MEMBER_COUNT trips.
    const memberFiles = ["src/big-a.ts", "src/big-b.ts", "src/big-c.ts", "src/big-d.ts"];
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "c", slug: "c" })],
      { c: memberFiles },
    );
    const bundles = [bundleWithMembers("c", memberFiles, 600)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const subs = Object.values(manifest.pages).filter((p) => p.kind === "community-file");
    expect(subs.length).toBe(4);
  });

  test("per-file exports count can promote a small-LOC file to big", () => {
    // File is 80 LOC but exports 9 things → promoted to big (BIG_FILE_EXPORTS=8).
    // Need 4 bigs total to trip SPLIT_BIG_MEMBER_COUNT=4, so include three
    // 600-LOC bigs alongside.
    const memberFiles = [
      "src/heavy-api.ts",
      "src/big-b.ts",
      "src/big-c.ts",
      "src/big-d.ts",
    ];
    const memberLoc: Record<string, number> = {
      "src/heavy-api.ts": 80,
      "src/big-b.ts": 600,
      "src/big-c.ts": 600,
      "src/big-d.ts": 600,
    };
    const exports = Array.from({ length: 9 }, (_, i) => ({
      name: `export${i}`,
      type: "function",
      file: "src/heavy-api.ts",
      signature: "",
    }));
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "c", slug: "c" })],
      { c: memberFiles },
    );
    const bundles = [makeBundle("c", { memberFiles, memberLoc, exports, topMemberLoc: 600 })];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const heavy = Object.values(manifest.pages).find(
      (p) => p.kind === "community-file" && p.memberFiles[0] === "src/heavy-api.ts",
    );
    expect(heavy).toBeDefined();
    expect(heavy!.memberFiles).toEqual(["src/heavy-api.ts"]);
  });

  test("split parent gets Sub-pages section", () => {
    // 4 × 600 LOC bigs → trips SPLIT_BIG_MEMBER_COUNT=4; parent gets sub-page index.
    const memberFiles = ["src/big-a.ts", "src/big-b.ts", "src/big-c.ts", "src/big-d.ts"];
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "x", slug: "x" })],
      { x: memberFiles },
    );
    const bundles = [bundleWithMembers("x", memberFiles, 600)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const parent = manifest.pages["wiki/communities/x.md"];
    expect(parent.sections.some((s) => /^sub-?pages\b/i.test(s.title))).toBe(true);
  });

  test("split parent escalates to full depth", () => {
    const memberFiles = ["src/big-a.ts", "src/big-b.ts", "src/big-c.ts", "src/big-d.ts"];
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "x", slug: "x" })],
      { x: memberFiles },
    );
    const bundles = [bundleWithMembers("x", memberFiles, 600)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    expect(manifest.pages["wiki/communities/x.md"].depth).toBe("full");
  });

  test("un-split community does NOT get Sub-pages section", () => {
    const memberFiles = ["src/a.ts", "src/b.ts"];
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "a", slug: "a" })],
      { a: memberFiles },
    );
    const bundles = [bundleWithMembers("a", memberFiles, 50)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const parent = manifest.pages["wiki/communities/a.md"];
    expect(parent.sections.some((s) => /^sub-?pages\b/i.test(s.title))).toBe(false);
  });

  test("parent community page links to its sub-pages", () => {
    // 4 × 600 LOC → trips SPLIT_BIG_MEMBER_COUNT=4.
    const memberFiles = ["src/big-a.ts", "src/big-b.ts", "src/big-c.ts", "src/big-d.ts"];
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "db", slug: "db" })],
      { db: memberFiles },
    );
    const bundles = [bundleWithMembers("db", memberFiles, 600)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const parent = manifest.pages["wiki/communities/db.md"];
    const subPaths = Object.keys(manifest.pages).filter(
      (p) => p.startsWith("wiki/communities/db/"),
    );
    expect(subPaths.length).toBeGreaterThan(0);
    for (const sp of subPaths) {
      expect(parent.relatedPages).toContain(sp);
    }
  });

  test("sub-page slug falls back to dashified path on basename collision", () => {
    // 4 × 600 LOC → trips SPLIT_BIG_MEMBER_COUNT=4. All bigs collide on basename.
    const memberFiles = [
      "src/db/index.ts",
      "src/cli/index.ts",
      "src/core/index.ts",
      "src/util/index.ts",
    ];
    const syntheses = makeSyntheses(
      [makePayload({ communityId: "clash", slug: "clash" })],
      { clash: memberFiles },
    );
    const bundles = [bundleWithMembers("clash", memberFiles, 600)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const subPaths = Object.keys(manifest.pages).filter((p) =>
      p.startsWith("wiki/communities/clash/"),
    );
    expect(subPaths).toHaveLength(4);
    expect(new Set(subPaths).size).toBe(4);
  });
});

describe("buildPageTree — Sub-pages section dedup", () => {
  test("does not duplicate existing Sub-pages section from synthesis", () => {
    // 4 × 600 LOC bigs → split; parent would otherwise append Sub-pages section.
    const memberFiles = ["src/big-a.ts", "src/big-b.ts", "src/big-c.ts", "src/big-d.ts"];
    const syntheses = makeSyntheses(
      [
        makePayload({
          communityId: "a",
          slug: "alpha",
          sections: [
            { title: "Overview", purpose: "x" },
            { title: "Sub-pages", purpose: "already here" },
          ],
        }),
      ],
      { a: memberFiles },
    );
    const bundles = [bundleWithMembers("a", memberFiles, 600)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const titles = manifest.pages["wiki/communities/alpha.md"].sections.map((s) => s.title);
    expect(titles.filter((t) => t === "Sub-pages")).toHaveLength(1);
  });

  test("legacy 'Members' title also dedups against Sub-pages", () => {
    const memberFiles = ["src/big-a.ts", "src/big-b.ts", "src/big-c.ts", "src/big-d.ts"];
    const syntheses = makeSyntheses(
      [
        makePayload({
          communityId: "a",
          slug: "alpha",
          sections: [
            { title: "Overview", purpose: "x" },
            { title: "Members", purpose: "already here" },
          ],
        }),
      ],
      { a: memberFiles },
    );
    const bundles = [bundleWithMembers("a", memberFiles, 600)];
    const manifest = buildPageTree(makeDiscovery(), makeClassified(), syntheses, "abc", "files", bundles);
    const titles = manifest.pages["wiki/communities/alpha.md"].sections.map((s) => s.title);
    expect(titles.some((t) => /^sub-?pages\b/i.test(t))).toBe(false);
  });
});

/**
 * Build a discovery stub whose file-level edges encode a given community
 * adjacency. `community` maps `communityId → files`; `links` is an array
 * of `[fromId, toId, count]` triples. Edges are emitted between the first
 * file of each community so the meta-graph derived by `computeMetaEdges`
 * matches `count` exactly.
 */
function discoveryWith(
  community: Record<string, string[]>,
  links: [string, string, number][],
): DiscoveryResult {
  const nodes = Object.values(community)
    .flat()
    .map((path) => ({ path, exports: [], fanIn: 0, fanOut: 0, isEntryPoint: false }));
  const edges: { from: string; to: string; source: string }[] = [];
  for (const [fromId, toId, count] of links) {
    const fromFile = community[fromId]?.[0];
    const toFile = community[toId]?.[0];
    if (!fromFile || !toFile) continue;
    for (let i = 0; i < count; i++) {
      edges.push({ from: fromFile, to: toFile, source: "import" });
    }
  }
  return {
    fileCount: nodes.length,
    chunkCount: 0,
    lastIndexed: null,
    modules: [],
    graphData: {
      fileLevel: { level: "file", nodes, edges },
      directoryLevel: { level: "directory", directories: [], edges: [] },
    },
    warnings: [],
  };
}

describe("buildPageTree — cross-community sibling links", () => {
  test("community page gains top-weighted siblings as relatedPages", () => {
    const members = {
      a: ["src/a/x.ts"],
      b: ["src/b/x.ts"],
      c: ["src/c/x.ts"],
      d: ["src/d/x.ts"],
    };
    // `a` links most often to `b` (10), then `c` (4), then `d` (1).
    const discovery = discoveryWith(members, [
      ["a", "b", 10],
      ["a", "c", 4],
      ["a", "d", 1],
    ]);
    const syntheses = makeSyntheses(
      [
        makePayload({ communityId: "a", slug: "alpha" }),
        makePayload({ communityId: "b", slug: "beta" }),
        makePayload({ communityId: "c", slug: "gamma" }),
        makePayload({ communityId: "d", slug: "delta" }),
      ],
      members,
    );
    const manifest = buildPageTree(discovery, makeClassified(), syntheses, "abc");
    const alpha = manifest.pages["wiki/communities/alpha.md"];
    expect(alpha.relatedPages).toContain("wiki/communities/beta.md");
    expect(alpha.relatedPages).toContain("wiki/communities/gamma.md");
    expect(alpha.relatedPages).toContain("wiki/communities/delta.md");
  });

  test("siblings are capped at MAX_SIBLING_COMMUNITIES (3) — lowest-weight drops", () => {
    const members = {
      a: ["src/a/x.ts"],
      b: ["src/b/x.ts"],
      c: ["src/c/x.ts"],
      d: ["src/d/x.ts"],
      e: ["src/e/x.ts"],
    };
    const discovery = discoveryWith(members, [
      ["a", "b", 100],
      ["a", "c", 50],
      ["a", "d", 10],
      ["a", "e", 1],
    ]);
    const syntheses = makeSyntheses(
      [
        makePayload({ communityId: "a", slug: "alpha" }),
        makePayload({ communityId: "b", slug: "beta" }),
        makePayload({ communityId: "c", slug: "gamma" }),
        makePayload({ communityId: "d", slug: "delta" }),
        makePayload({ communityId: "e", slug: "epsilon" }),
      ],
      members,
    );
    const manifest = buildPageTree(discovery, makeClassified(), syntheses, "abc");
    const alpha = manifest.pages["wiki/communities/alpha.md"];
    // Top-3 siblings: beta, gamma, delta. Epsilon (lowest weight) dropped.
    expect(alpha.relatedPages).toContain("wiki/communities/beta.md");
    expect(alpha.relatedPages).toContain("wiki/communities/gamma.md");
    expect(alpha.relatedPages).toContain("wiki/communities/delta.md");
    expect(alpha.relatedPages).not.toContain("wiki/communities/epsilon.md");
  });

  test("sibling edges are symmetric — b sees a even when only a→b is in the edge list", () => {
    const members = { a: ["src/a/x.ts"], b: ["src/b/x.ts"] };
    const discovery = discoveryWith(members, [["a", "b", 5]]);
    const syntheses = makeSyntheses(
      [
        makePayload({ communityId: "a", slug: "alpha" }),
        makePayload({ communityId: "b", slug: "beta" }),
      ],
      members,
    );
    const manifest = buildPageTree(discovery, makeClassified(), syntheses, "abc");
    expect(manifest.pages["wiki/communities/beta.md"].relatedPages)
      .toContain("wiki/communities/alpha.md");
  });

  test("community without cross-community edges gets no sibling links", () => {
    const members = { a: ["src/a/x.ts"], b: ["src/b/x.ts"] };
    const discovery = discoveryWith(members, []);
    const syntheses = makeSyntheses(
      [
        makePayload({ communityId: "a", slug: "alpha" }),
        makePayload({ communityId: "b", slug: "beta" }),
      ],
      members,
    );
    const manifest = buildPageTree(discovery, makeClassified(), syntheses, "abc");
    const alpha = manifest.pages["wiki/communities/alpha.md"];
    // Only aggregate links, no sibling.
    expect(alpha.relatedPages).not.toContain("wiki/communities/beta.md");
  });
});
