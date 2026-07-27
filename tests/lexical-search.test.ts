import { describe, expect, test } from "bun:test";

import {
  lexicalTerms,
  rankLexicalDocuments,
  type LexicalDocument,
} from "../src/internals/search/lexical-search.ts";

function document(
  id: number,
  path: string,
  name: string | null,
  text: string,
): LexicalDocument {
  return { id, path, name, text, startOffset: 0 };
}

describe("lexical search", () => {
  test("shares Unicode-aware camelCase, acronym, snake_case, and path terms", () => {
    expect(lexicalTerms("HTTPServer getDependsOn snake_case src/db/index.ts Łódź"))
      .toEqual([
        "http",
        "server",
        "get",
        "depends",
        "on",
        "snake",
        "case",
        "src",
        "db",
        "index",
        "ts",
        "łódź",
      ]);
  });

  test("boosts rare chunk names and paths over repeated boilerplate", () => {
    const ranked = rankLexicalDocuments("initCommand project setup", [
      document(1, "src/shared/log.ts", "recordEvent", "project event setup"),
      document(
        2,
        "src/cli/commands/init.ts",
        "initCommand",
        "export async function initCommand() { return setupProject(); }",
      ),
      document(3, "src/other.ts", "setup", "project setup setup setup"),
    ]);
    expect(ranked.map((result) => result.id)).toEqual([2, 3, 1]);
    expect(ranked.every((result) => result.score > 0)).toBe(true);
  });

  test("omits punctuation-only queries and resolves ties deterministically", () => {
    const documents = [
      document(2, "zeta.ts", "shared", "shared"),
      document(1, "alpha.ts", "shared", "shared"),
    ];
    expect(rankLexicalDocuments("--- 🧭", documents)).toEqual([]);
    expect(rankLexicalDocuments("shared", documents).map((result) => result.id))
      .toEqual([1, 2]);
    expect(rankLexicalDocuments("shared", documents)).toEqual(
      rankLexicalDocuments("shared", documents),
    );
  });
});
