import { describe, test, expect } from "bun:test";
import { buildPagePayload } from "../../src/wiki/page-payload";
import type { PageManifest, ContentCache, ManifestPage } from "../../src/wiki/types";

function page(partial: Partial<ManifestPage> & Pick<ManifestPage, "title" | "slug">): ManifestPage {
  return {
    kind: "community",
    purpose: "—",
    sections: [],
    depth: "standard",
    memberFiles: [],
    relatedPages: [],
    order: 0,
    ...partial,
  };
}

function manifest(pages: Record<string, ManifestPage>): PageManifest {
  return {
    version: 3,
    generatedAt: "2026-04-23",
    lastGitRef: "deadbee",
    pageCount: Object.keys(pages).length,
    pages,
    warnings: [],
  };
}

describe("buildPagePayload — breadcrumbs", () => {
  test("empty for top-level architecture page", () => {
    const m = manifest({
      "wiki/architecture.md": page({ title: "Architecture", slug: "architecture", kind: "architecture", order: 0 }),
    });
    const p = buildPagePayload(0, m, {} as ContentCache);
    expect(p.breadcrumbs).toEqual([]);
  });

  test("two-level trail: architecture › community parent", () => {
    const m = manifest({
      "wiki/architecture.md": page({ title: "Architecture", slug: "architecture", kind: "architecture", order: 0 }),
      "wiki/communities/db-layer.md": page({ title: "Database Layer", slug: "db-layer", order: 1 }),
      "wiki/communities/db-layer/graph.md": page({
        title: "src/db/graph.ts",
        slug: "graph",
        kind: "community-file",
        order: 2,
      }),
    });
    const p = buildPagePayload(2, m, {} as ContentCache);
    expect(p.breadcrumbs.map((c) => c.title)).toEqual(["Architecture", "Database Layer"]);
    expect(p.breadcrumbs[0].relPath).toBe("../../architecture.md");
    expect(p.breadcrumbs[1].relPath).toBe("../db-layer.md");
  });

  test("top-level community page gets the architecture crumb back to the root", () => {
    // Regression: archPath used a bare `architecture.md` key while the
    // manifest stores `wiki/architecture.md`, so the architecture crumb
    // never prepended for community-level pages.
    const m = manifest({
      "wiki/architecture.md": page({ title: "Architecture", slug: "architecture", kind: "architecture", order: 0 }),
      "wiki/communities/search-runtime.md": page({
        title: "Search Runtime",
        slug: "search-runtime",
        kind: "community",
        order: 1,
      }),
    });
    const p = buildPagePayload(1, m, {} as ContentCache);
    expect(p.breadcrumbs.map((c) => c.title)).toEqual(["Architecture"]);
    expect(p.breadcrumbs[0].relPath).toBe("../architecture.md");
  });

  test("skips missing parent segments", () => {
    const m = manifest({
      "wiki/architecture.md": page({ title: "Architecture", slug: "architecture", kind: "architecture", order: 0 }),
      "wiki/communities/wiki-pipeline/community-synthesis.md": page({
        title: "community-synthesis.ts",
        slug: "community-synthesis",
        order: 1,
      }),
    });
    const p = buildPagePayload(1, m, {} as ContentCache);
    expect(p.breadcrumbs.map((c) => c.title)).toEqual(["Architecture"]);
  });
});

describe("buildPagePayload — payload metadata", () => {
  test("ships generatedFrom from manifest lastGitRef", () => {
    const m = manifest({
      "wiki/architecture.md": page({ title: "Architecture", slug: "architecture", kind: "architecture", order: 0 }),
    });
    const p = buildPagePayload(0, m, {} as ContentCache);
    expect(p.generatedFrom).toBe("deadbee");
  });

  test("ships kind-specific semantic queries for community pages", () => {
    const m = manifest({
      "wiki/communities/foo.md": page({ title: "Foo", slug: "foo", kind: "community", order: 0 }),
    });
    const p = buildPagePayload(0, m, {} as ContentCache);
    expect(p.semanticQueries).toContain("public API and exported function signatures");
  });

  test("community-file kind gets drill-down queries", () => {
    const m = manifest({
      "wiki/communities/foo/bar.md": page({
        title: "bar.ts",
        slug: "bar",
        kind: "community-file",
        order: 0,
      }),
    });
    const p = buildPagePayload(0, m, {} as ContentCache);
    expect(p.semanticQueries).toContain("every export const and tunable literal in this file");
  });

  test("unknown kinds get an empty semantic-query list", () => {
    const m = manifest({
      "wiki/misc.md": page({ title: "Misc", slug: "misc", kind: "weird-kind", order: 0 }),
    });
    const p = buildPagePayload(0, m, {} as ContentCache);
    expect(p.semanticQueries).toEqual([]);
  });
});

describe("buildPagePayload — preRendered blocks", () => {
  test("breadcrumb is empty string on top-level pages", () => {
    const m = manifest({
      "wiki/architecture.md": page({ title: "Architecture", slug: "architecture", kind: "architecture", order: 0 }),
    });
    const p = buildPagePayload(0, m, {} as ContentCache);
    expect(p.preRendered.breadcrumb).toBe("");
  });

  test("breadcrumb renders as `>` blockquote trail for sub-pages", () => {
    const m = manifest({
      "wiki/architecture.md": page({ title: "Architecture", slug: "architecture", kind: "architecture", order: 0 }),
      "wiki/communities/db-layer.md": page({ title: "Database Layer", slug: "db-layer", order: 1 }),
      "wiki/communities/db-layer/graph.md": page({
        title: "src/db/graph.ts",
        slug: "graph",
        kind: "community-file",
        order: 2,
      }),
    });
    const p = buildPagePayload(2, m, {} as ContentCache);
    expect(p.preRendered.breadcrumb).toBe(
      "> [Architecture](../../architecture.md) › [Database Layer](../db-layer.md)",
    );
  });

  test("seeAlso renders a ## See also heading with title-sorted related-page bullets", () => {
    const m = manifest({
      "wiki/architecture.md": page({ title: "Architecture", slug: "architecture", kind: "architecture", order: 0 }),
      "wiki/communities/alpha.md": page({
        title: "Alpha",
        slug: "alpha",
        kind: "community",
        order: 1,
        relatedPages: ["wiki/architecture.md", "wiki/communities/beta.md"],
      }),
      "wiki/communities/beta.md": page({ title: "Beta", slug: "beta", kind: "community", order: 2 }),
    });
    const p = buildPagePayload(1, m, {} as ContentCache);
    expect(p.preRendered.seeAlso).toBe(
      "## See also\n\n- [Architecture](../architecture.md)\n- [Beta](beta.md)",
    );
  });

  test("seeAlso is empty string when a page has no related pages", () => {
    const m = manifest({
      "wiki/communities/solo.md": page({
        title: "Solo",
        slug: "solo",
        kind: "community",
        order: 0,
        relatedPages: [],
      }),
    });
    const p = buildPagePayload(0, m, {} as ContentCache);
    expect(p.preRendered.seeAlso).toBe("");
  });

  test("seeAlso skips related paths missing from the manifest", () => {
    const m = manifest({
      "wiki/communities/alpha.md": page({
        title: "Alpha",
        slug: "alpha",
        kind: "community",
        order: 0,
        relatedPages: ["wiki/communities/ghost.md"],
      }),
    });
    const p = buildPagePayload(0, m, {} as ContentCache);
    expect(p.preRendered.seeAlso).toBe("");
  });
});
