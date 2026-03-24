import { describe, test, expect } from "bun:test";
import { parseFile } from "../../src/indexing/parse";
import { join } from "path";
import { readFileSync } from "fs";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

function parse(filename: string) {
  const filePath = join(FIXTURES, filename);
  const raw = readFileSync(filePath, "utf-8");
  return parseFile(filePath, raw);
}

describe("parseFile", () => {
  test("extracts frontmatter fields from MD", () => {
    const result = parse("sample.md");
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.name).toBe("sample-doc");
    expect(result.frontmatter!.description).toBe(
      "A sample document for testing"
    );
    expect(result.frontmatter!.type).toBe("reference");
    expect(result.frontmatter!.tags).toEqual(["testing", "sample", "markdown"]);
  });

  test("builds weighted text with frontmatter prepended", () => {
    const result = parse("sample.md");
    expect(result.content).toContain("sample-doc");
    expect(result.content).toContain("description: A sample document");
    expect(result.content).toContain("type: reference");
    expect(result.content).toContain("tags: testing, sample, markdown");
    expect(result.content).toContain("## Introduction");
  });

  test("returns null frontmatter for non-MD files", () => {
    const result = parse("sample.txt");
    expect(result.frontmatter).toBeNull();
    expect(result.extension).toBe(".txt");
    expect(result.content).toContain("plain text file");
  });

  test("returns null frontmatter for MD without frontmatter", () => {
    const result = parse("no-frontmatter.md");
    expect(result.frontmatter).toBeNull();
    expect(result.content).toContain("# Plain Markdown");
  });

  test("handles empty files gracefully", () => {
    const result = parse("empty.md");
    expect(result.content).toBe("");
    expect(result.frontmatter).toBeNull();
  });

  test("handles files with only frontmatter (no body)", () => {
    const result = parse("frontmatter-only.md");
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.name).toBe("metadata-only");
    // Content should still have the weighted frontmatter text
    expect(result.content).toContain("metadata-only");
    expect(result.content).toContain("description:");
  });

  test("sets correct extension", () => {
    const md = parse("sample.md");
    expect(md.extension).toBe(".md");

    const ts = parse("sample.ts");
    expect(ts.extension).toBe(".ts");

    const txt = parse("sample.txt");
    expect(txt.extension).toBe(".txt");
  });
});
