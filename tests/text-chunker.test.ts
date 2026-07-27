import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, leaves } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "text");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

describe("plain-text fallback", () => {
  test("splits nonblank paragraphs while preserving whitespace gaps", async () => {
    const value = await result("paragraphs.txt");
    expect(
      value.chunks.map((current) => [
        current.kind,
        current.startLine,
        current.endLine,
      ]),
    ).toEqual([
      ["paragraph", 1, 2],
      ["gap", 3, 3],
      ["paragraph", 4, 4],
      ["gap", 5, 6],
      ["paragraph", 7, 7],
    ]);
  });

  test("normalizes BOM and CRLF before deterministic paragraph chunking", async () => {
    const value = await chunk("notes.txt", "\ufeffone\r\n\r\ntwo\r");
    expect([...leaves(value.chunks)].map((leaf) => leaf.text).join("")).toBe(
      "one\n\ntwo\n",
    );
    expect(value).toMatchObject({ language: "text", strategy: "paragraph" });
  });

  test("treats space-only and tab-only lines as whitespace gaps", async () => {
    const value = await chunk("spaced.txt", "one\n  \n\t\ntwo");
    expect(value.chunks.map((current) => current.kind)).toEqual([
      "paragraph",
      "gap",
      "paragraph",
    ]);
    expect(value.chunks[1]?.text).toBe("  \n\t\n");
  });

  test("keeps empty text empty", async () => {
    expect(await chunk("empty.txt", "")).toMatchObject({
      language: "text",
      chunks: [],
      facts: [],
    });
  });

  test("does not infer facts from code-looking prose, paths, or URLs", async () => {
    expect((await result("semantic-traps.txt")).facts).toEqual([]);
  });

  test("routes arbitrary text extensions through the same fallback", async () => {
    expect(await result("single-line.log")).toMatchObject({
      language: "text",
      strategy: "paragraph",
    });
  });
});
