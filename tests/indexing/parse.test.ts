import { describe, test, expect } from "bun:test";
import { parseFile } from "../../src/indexing/parse";
import { join } from "path";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("parseFile", () => {
  test("extracts frontmatter fields from MD", async () => {
    const result = await parseFile(join(FIXTURES, "sample.md"));
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.name).toBe("sample-doc");
    expect(result.frontmatter!.description).toBe(
      "A sample document for testing"
    );
    expect(result.frontmatter!.type).toBe("reference");
    expect(result.frontmatter!.tags).toEqual(["testing", "sample", "markdown"]);
  });

  test("builds weighted text with frontmatter prepended", async () => {
    const result = await parseFile(join(FIXTURES, "sample.md"));
    expect(result.content).toContain("sample-doc");
    expect(result.content).toContain("description: A sample document");
    expect(result.content).toContain("type: reference");
    expect(result.content).toContain("tags: testing, sample, markdown");
    expect(result.content).toContain("## Introduction");
  });

  test("returns null frontmatter for non-MD files", async () => {
    const result = await parseFile(join(FIXTURES, "sample.txt"));
    expect(result.frontmatter).toBeNull();
    expect(result.extension).toBe(".txt");
    expect(result.content).toContain("plain text file");
  });

  test("returns null frontmatter for MD without frontmatter", async () => {
    const result = await parseFile(join(FIXTURES, "no-frontmatter.md"));
    expect(result.frontmatter).toBeNull();
    expect(result.content).toContain("# Plain Markdown");
  });

  test("handles empty files gracefully", async () => {
    const result = await parseFile(join(FIXTURES, "empty.md"));
    expect(result.content).toBe("");
    expect(result.frontmatter).toBeNull();
  });

  test("handles files with only frontmatter (no body)", async () => {
    const result = await parseFile(join(FIXTURES, "frontmatter-only.md"));
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.name).toBe("metadata-only");
    // Content should still have the weighted frontmatter text
    expect(result.content).toContain("metadata-only");
    expect(result.content).toContain("description:");
  });

  test("sets correct extension", async () => {
    const md = await parseFile(join(FIXTURES, "sample.md"));
    expect(md.extension).toBe(".md");

    const ts = await parseFile(join(FIXTURES, "sample.ts"));
    expect(ts.extension).toBe(".ts");

    const txt = await parseFile(join(FIXTURES, "sample.txt"));
    expect(txt.extension).toBe(".txt");
  });
});
