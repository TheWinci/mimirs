import { describe, test, expect } from "bun:test";
import {
  renderSynthesisPrompt,
  requiredSectionsFor,
  mergeRequiredSections,
  validateSynthesisPayload,
} from "../../src/wiki/community-synthesis";
import type { CommunityBundle, SectionSpec } from "../../src/wiki/types";

function makeBundle(overrides: Partial<CommunityBundle> = {}): CommunityBundle {
  return {
    communityId: overrides.communityId ?? "c0",
    memberFiles: overrides.memberFiles ?? ["src/a.ts"],
    exports: overrides.exports ?? [],
    tunables: overrides.tunables ?? [],
    topMemberLoc: overrides.topMemberLoc ?? 0,
    memberLoc: overrides.memberLoc ?? {},
    tunableCount: overrides.tunableCount ?? (overrides.tunables?.length ?? 0),
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

describe("renderSynthesisPrompt — Tunables section", () => {
  test("omits section when no tunables", () => {
    const prompt = renderSynthesisPrompt(makeBundle(), "## Catalog\n", []);
    expect(prompt).not.toContain("## Tunables");
  });

  test("emits section with full snippet when tunables present", () => {
    const bundle = makeBundle({
      tunables: [
        { name: "GRAPH_BOOST", type: "constant", file: "src/hybrid.ts", snippet: "const GRAPH_BOOST = 0.05;" },
        { name: "STOP_WORDS", type: "constant", file: "src/stop.ts", snippet: "const STOP_WORDS = [\n  \"a\",\n  \"the\",\n];" },
      ],
      tunableCount: 2,
    });
    const prompt = renderSynthesisPrompt(bundle, "## Catalog\n", []);
    expect(prompt).toContain("## Tunables (2)");
    expect(prompt).toContain("GRAPH_BOOST");
    expect(prompt).toContain("0.05");
    expect(prompt).toContain("STOP_WORDS");
    expect(prompt).toContain("\"the\"");
  });

  test("indicates truncation when tunableCount exceeds shown", () => {
    const bundle = makeBundle({
      tunables: [
        { name: "X", type: "constant", file: "src/a.ts", snippet: "const X = 1;" },
      ],
      tunableCount: 50,
    });
    const prompt = renderSynthesisPrompt(bundle, "## Catalog\n", []);
    expect(prompt).toContain("## Tunables (1 shown of 50)");
  });
});

describe("requiredSectionsFor — predicates", () => {
  test("no required sections for trivial single-file bundle", () => {
    const req = requiredSectionsFor(makeBundle());
    expect(req).toHaveLength(0);
  });

  test("per-file-breakdown required when files>=3 && exports>=5", () => {
    const bundle = makeBundle({
      memberFiles: ["a.ts", "b.ts", "c.ts"],
      exports: Array.from({ length: 5 }, (_, i) => ({
        name: `fn${i}`,
        type: "function",
        file: "a.ts",
        signature: `fn${i}()`,
      })),
    });
    const ids = requiredSectionsFor(bundle).map((r) => r.entry.id);
    expect(ids).toContain("per-file-breakdown");
  });

  test("per-file-breakdown NOT required when only 2 files", () => {
    const bundle = makeBundle({
      memberFiles: ["a.ts", "b.ts"],
      exports: Array.from({ length: 6 }, (_, i) => ({
        name: `fn${i}`,
        type: "function",
        file: "a.ts",
        signature: `fn${i}()`,
      })),
    });
    const ids = requiredSectionsFor(bundle).map((r) => r.entry.id);
    expect(ids).not.toContain("per-file-breakdown");
  });

  test("lifecycle-flow required when files>=2", () => {
    const bundle = makeBundle({ memberFiles: ["a.ts", "b.ts"] });
    const ids = requiredSectionsFor(bundle).map((r) => r.entry.id);
    expect(ids).toContain("lifecycle-flow");
  });

  test("internals required when topMemberLoc>=400", () => {
    const bundle = makeBundle({ topMemberLoc: 500 });
    const ids = requiredSectionsFor(bundle).map((r) => r.entry.id);
    expect(ids).toContain("internals");
  });

  test("internals required when tunableCount>=8", () => {
    const bundle = makeBundle({ tunableCount: 8 });
    const ids = requiredSectionsFor(bundle).map((r) => r.entry.id);
    expect(ids).toContain("internals");
  });

  test("internals required when files>=10", () => {
    const bundle = makeBundle({
      memberFiles: Array.from({ length: 10 }, (_, i) => `f${i}.ts`),
    });
    const ids = requiredSectionsFor(bundle).map((r) => r.entry.id);
    expect(ids).toContain("internals");
  });

  test("known-issues required when annotations present", () => {
    const bundle = makeBundle({
      annotations: [{ file: "a.ts", line: 1, note: "bug" }],
    });
    const ids = requiredSectionsFor(bundle).map((r) => r.entry.id);
    expect(ids).toContain("known-issues");
  });

  test("tuning-knobs required when tunables>=1", () => {
    const bundle = makeBundle({ tunableCount: 1 });
    const ids = requiredSectionsFor(bundle).map((r) => r.entry.id);
    expect(ids).toContain("tuning-knobs");
  });
});

describe("renderSynthesisPrompt — REQUIRED sections block", () => {
  test("omits REQUIRED block when no predicates fire", () => {
    const prompt = renderSynthesisPrompt(makeBundle(), "## Catalog\n", []);
    expect(prompt).not.toContain("## REQUIRED sections");
  });

  test("renders REQUIRED block with catalog shape when predicate fires", () => {
    const bundle = makeBundle({
      memberFiles: ["a.ts", "b.ts", "c.ts"],
      exports: Array.from({ length: 5 }, (_, i) => ({
        name: `fn${i}`,
        type: "function",
        file: "a.ts",
        signature: `fn${i}()`,
      })),
    });
    const prompt = renderSynthesisPrompt(bundle, "## Catalog\n", []);
    expect(prompt).toContain("## REQUIRED sections");
    expect(prompt).toContain("Per-file breakdown");
    expect(prompt).toContain("catalog id: `per-file-breakdown`");
    expect(prompt).toContain("Why required:");
  });
});

describe("mergeRequiredSections", () => {
  function mkReq(id: string, title: string) {
    return {
      entry: { id, title, purpose: "p", shape: "s", exampleBody: "e" },
      reason: "r",
    };
  }

  test("injects missing required by title match", () => {
    const proposed: SectionSpec[] = [{ title: "Overview", purpose: "x" }];
    const { merged, injected } = mergeRequiredSections(proposed, [
      mkReq("per-file-breakdown", "Per-file breakdown"),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[1].title).toBe("Per-file breakdown");
    expect(injected).toEqual(["per-file-breakdown"]);
  });

  test("does not duplicate when proposed already has title (case-insensitive)", () => {
    const proposed: SectionSpec[] = [
      { title: "per-file breakdown", purpose: "x" },
    ];
    const { merged, injected } = mergeRequiredSections(proposed, [
      mkReq("per-file-breakdown", "Per-file breakdown"),
    ]);
    expect(merged).toHaveLength(1);
    expect(injected).toEqual([]);
  });

  test("preserves original order and appends missing to end", () => {
    const proposed: SectionSpec[] = [
      { title: "A", purpose: "x" },
      { title: "B", purpose: "y" },
    ];
    const { merged } = mergeRequiredSections(proposed, [
      mkReq("internals", "Internals"),
    ]);
    expect(merged.map((s) => s.title)).toEqual(["A", "B", "Internals"]);
  });
});

describe("validateSynthesisPayload — required injection", () => {
  const basePayload = {
    communityId: "c0",
    name: "Test",
    slug: "test",
    purpose: "p",
    sections: [{ title: "Overview", purpose: "x" }],
  };

  test("injects missing required section into validated output", () => {
    const bundle = makeBundle({
      memberFiles: ["a.ts", "b.ts"],
    });
    const required = requiredSectionsFor(bundle);
    const result = validateSynthesisPayload(
      basePayload,
      "c0",
      new Set(),
      required,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const titles = result.value.sections.map((s) => s.title);
    expect(titles).toContain("How it works");
    expect(result.injected).toContain("lifecycle-flow");
  });

  test("does not inject when proposed already has required title", () => {
    const bundle = makeBundle({
      memberFiles: ["a.ts", "b.ts"],
    });
    const required = requiredSectionsFor(bundle);
    const payload = {
      ...basePayload,
      sections: [
        { title: "How it works", purpose: "flow" },
      ],
    };
    const result = validateSynthesisPayload(
      payload,
      "c0",
      new Set(),
      required,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.injected).toEqual([]);
  });

  test("returns injected=[] when no required sections fire", () => {
    const result = validateSynthesisPayload(
      basePayload,
      "c0",
      new Set(),
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.injected).toEqual([]);
  });
});

