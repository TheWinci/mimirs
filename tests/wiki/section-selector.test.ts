import { describe, test, expect } from "bun:test";
import { selectSections, exemplarPathFor } from "../../src/wiki/section-selector";
import type { PageContentCache } from "../../src/wiki/types";

function ctx(relatedPagesCount = 0, linkMapSize = 0) {
  return { relatedPagesCount, linkMapSize };
}

describe("selectSections", () => {
  test("overview always matches for every kind", () => {
    const sections = selectSections("module", undefined, {}, ctx());
    const overview = sections.find((s) => s.name === "overview");
    expect(overview).toBeDefined();
    expect(overview!.matched).toBe(true);
  });

  test("public-api matches when exports ≥ 1 on module pages", () => {
    const p: PageContentCache = { exports: [{ name: "foo", type: "function", signature: "foo()" }] };
    const sections = selectSections("module", undefined, p, ctx());
    const api = sections.find((s) => s.name === "public-api");
    expect(api?.matched).toBe(true);
  });

  test("public-api skipped (but present) when exports empty", () => {
    const sections = selectSections("module", undefined, {}, ctx());
    const api = sections.find((s) => s.name === "public-api");
    expect(api).toBeDefined();
    expect(api!.matched).toBe(false);
  });

  test("per-file-breakdown gates on files ≥ 3 AND exports ≥ 5", () => {
    const p: PageContentCache = {
      files: ["a.ts", "b.ts", "c.ts"],
      exports: Array.from({ length: 5 }, (_, i) => ({ name: `e${i}`, type: "function", signature: "" })),
    };
    const sections = selectSections("module", undefined, p, ctx());
    const pfb = sections.find((s) => s.name === "per-file-breakdown");
    expect(pfb?.matched).toBe(true);
  });

  test("key-exports-table is mutually exclusive with per-file-breakdown", () => {
    const p: PageContentCache = {
      files: ["a.ts", "b.ts", "c.ts"],
      exports: Array.from({ length: 5 }, (_, i) => ({ name: `e${i}`, type: "function", signature: "" })),
    };
    const sections = selectSections("module", undefined, p, ctx());
    const pfb = sections.find((s) => s.name === "per-file-breakdown");
    const ket = sections.find((s) => s.name === "key-exports-table");
    expect(pfb?.matched).toBe(true);
    expect(ket?.matched).toBe(false);
  });

  test("dependency-graph vs dependency-table split at 3 total edges", () => {
    const small: PageContentCache = { dependencies: ["a"], dependents: ["b"] };
    const small_sections = selectSections("module", undefined, small, ctx());
    expect(small_sections.find((s) => s.name === "dependency-table")?.matched).toBe(true);
    expect(small_sections.find((s) => s.name === "dependency-graph")?.matched).toBe(false);

    const big: PageContentCache = {
      dependencies: ["a", "b"],
      dependents: ["c"],
    };
    const big_sections = selectSections("module", undefined, big, ctx());
    expect(big_sections.find((s) => s.name === "dependency-graph")?.matched).toBe(true);
    expect(big_sections.find((s) => s.name === "dependency-table")?.matched).toBe(false);
  });

  test("module-inventory is eligible for architecture but not plain module pages", () => {
    const arch = selectSections("aggregate", "architecture", { modules: [{ name: "m", fileCount: 1, exportCount: 1, fanIn: 0, fanOut: 0, entryFile: null }] }, ctx());
    const mod = selectSections("module", undefined, {}, ctx());
    expect(arch.find((s) => s.name === "module-inventory")).toBeDefined();
    expect(mod.find((s) => s.name === "module-inventory")).toBeUndefined();
  });

  test("see-also matches when link map is non-empty", () => {
    const sections = selectSections("module", undefined, {}, ctx(0, 2));
    expect(sections.find((s) => s.name === "see-also")?.matched).toBe(true);
  });

  test("loads example bodies from sections/*.md", () => {
    const sections = selectSections("module", undefined, {}, ctx());
    const overview = sections.find((s) => s.name === "overview");
    expect(overview?.exampleBody.length).toBeGreaterThan(0);
    // body should not contain the front-matter delimiter
    expect(overview?.exampleBody.startsWith("---")).toBe(false);
  });
});

describe("exemplarPathFor", () => {
  test("returns path for each aggregate focus", () => {
    for (const focus of ["architecture", "data-flows", "getting-started", "conventions", "testing", "index"] as const) {
      const p = exemplarPathFor("aggregate", focus);
      expect(p).toBeDefined();
      expect(p!.endsWith(`${focus}.md`)).toBe(true);
    }
  });

  test("returns undefined for module/file kinds", () => {
    expect(exemplarPathFor("module", undefined)).toBeUndefined();
    expect(exemplarPathFor("file", "module-file")).toBeUndefined();
  });

  test("returns undefined for unknown foci", () => {
    expect(exemplarPathFor("aggregate", "module-file")).toBeUndefined();
  });
});
