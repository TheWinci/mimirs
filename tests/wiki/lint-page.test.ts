import { describe, test, expect } from "bun:test";
import { lintPage, type ChunkRange } from "../../src/wiki/lint-page";

describe("lintPage — Mermaid reserved-id detection", () => {
  test("flags reserved keyword used as bare node id", () => {
    const md = [
      "```mermaid",
      "graph TD",
      "  graph --> foo",
      "  foo --> end",
      "```",
    ].join("\n");
    const warnings = lintPage(md);
    const reserved = warnings.filter((w) => w.kind === "mermaid-reserved-id").map((w) => w.match);
    expect(reserved).toContain("graph");
    expect(reserved).toContain("end");
  });

  test("does not flag the `graph TD` directive line itself", () => {
    const md = [
      "```mermaid",
      "graph TD",
      "  a --> b",
      "```",
    ].join("\n");
    const warnings = lintPage(md);
    expect(warnings.filter((w) => w.kind === "mermaid-reserved-id")).toHaveLength(0);
  });

  test("flags reserved id in leading-label form `subgraph[Label]`", () => {
    const md = [
      "```mermaid",
      "flowchart LR",
      "  subgraph[Label]",
      "```",
    ].join("\n");
    const warnings = lintPage(md);
    const reserved = warnings.filter((w) => w.kind === "mermaid-reserved-id").map((w) => w.match);
    expect(reserved).toContain("subgraph");
  });

  test("ignores fenced non-mermaid code blocks", () => {
    const md = [
      "```ts",
      "const graph = new Graph();",
      "graph.addNode('end');",
      "```",
    ].join("\n");
    expect(lintPage(md)).toEqual([]);
  });

  test("case-insensitive match on reserved words", () => {
    const md = [
      "```mermaid",
      "flowchart LR",
      "  Graph --> Node",
      "```",
    ].join("\n");
    const warnings = lintPage(md);
    expect(warnings.filter((w) => w.kind === "mermaid-reserved-id")).toHaveLength(1);
    expect(warnings[0].match).toBe("Graph");
  });
});

describe("lintPage — Mermaid HTML-in-alias detection", () => {
  test("flags <br/> inside participant alias (real bug from review)", () => {
    const md = [
      "```mermaid",
      "sequenceDiagram",
      '  participant Tail as startConversationTail<br/>("src/conversation/indexer.ts")',
      "  Tail ->> DB: insert",
      "```",
    ].join("\n");
    const warnings = lintPage(md);
    const html = warnings.filter((w) => w.kind === "mermaid-html-in-alias");
    expect(html).toHaveLength(1);
    expect(html[0].match.toLowerCase()).toContain("<br");
  });

  test("flags <br/> inside bracketed label", () => {
    const md = [
      "```mermaid",
      "flowchart LR",
      '  A["first<br/>second"] --> B',
      "```",
    ].join("\n");
    const warnings = lintPage(md);
    const html = warnings.filter((w) => w.kind === "mermaid-html-in-alias");
    expect(html.length).toBeGreaterThanOrEqual(1);
  });

  test("flags &nbsp; and <b> tokens", () => {
    const md = [
      "```mermaid",
      "sequenceDiagram",
      '  participant P as "name&nbsp;suffix"',
      '  participant Q as <b>bold</b>',
      "```",
    ].join("\n");
    const warnings = lintPage(md);
    const html = warnings.filter((w) => w.kind === "mermaid-html-in-alias");
    expect(html.length).toBeGreaterThanOrEqual(2);
  });

  test("does not flag HTML outside mermaid fences", () => {
    const md = "Prose with <br/> in it — should not flag.";
    const warnings = lintPage(md);
    expect(warnings.filter((w) => w.kind === "mermaid-html-in-alias")).toHaveLength(0);
  });

  test("does not flag clean mermaid diagram", () => {
    const md = [
      "```mermaid",
      "sequenceDiagram",
      '  participant Tail as "startConversationTail"',
      "  Tail ->> DB: insert",
      "```",
    ].join("\n");
    const warnings = lintPage(md);
    expect(warnings.filter((w) => w.kind === "mermaid-html-in-alias")).toHaveLength(0);
  });
});

describe("lintPage — path validation", () => {
  test("flags backticked path not in project", () => {
    const md = "See `src/ghost.ts` for details.";
    const warnings = lintPage(md, { knownFilePaths: new Set(["src/real.ts"]) });
    expect(warnings.map((w) => w.match)).toContain("src/ghost.ts");
    expect(warnings[0].kind).toBe("missing-file");
  });

  test("accepts backticked path that exists", () => {
    const md = "See `src/real.ts`.";
    const warnings = lintPage(md, { knownFilePaths: new Set(["src/real.ts"]) });
    expect(warnings).toEqual([]);
  });

  test("ignores non-path backtick content", () => {
    const md = "Call `foo()` or pass `options`.";
    const warnings = lintPage(md, { knownFilePaths: new Set() });
    expect(warnings).toEqual([]);
  });

  test("flags colon line-range on missing file", () => {
    const md = "See src/nope.ts:10-20 for context.";
    const warnings = lintPage(md, { knownFilePaths: new Set(["src/real.ts"]) });
    expect(warnings.map((w) => w.match)).toContain("src/nope.ts");
  });

  test("skips path validation entirely when knownFilePaths omitted", () => {
    const md = "See `src/nope.ts` at line 42.";
    const warnings = lintPage(md);
    expect(warnings.filter((w) => w.kind === "missing-file")).toHaveLength(0);
  });

  test("skips paths inside fenced code blocks", () => {
    const md = [
      "```ts",
      "import { x } from './src/ghost.ts';",
      "```",
    ].join("\n");
    const warnings = lintPage(md, { knownFilePaths: new Set(["src/real.ts"]) });
    expect(warnings).toEqual([]);
  });
});

describe("lintPage — false-positive suppression", () => {
  test("ignores method chains that look like paths", () => {
    const md = [
      "Call `db.search` to query, handle with `log.warn` on failure.",
      "Parse config with `JSON.parse` and read `process.argv`.",
      "Filter via `files.hash` then check `cli.log`.",
    ].join("\n");
    const warnings = lintPage(md, { knownFilePaths: new Set(["src/real.ts"]) });
    expect(warnings.filter((w) => w.kind === "missing-file")).toHaveLength(0);
  });

  test("ignores bare extension lists", () => {
    const md = "Supported: `.ts`, `.tsx`, `.js`, `.jsx`. Also written as `.ts/.tsx/.js/.jsx`.";
    const warnings = lintPage(md, { knownFilePaths: new Set(["src/real.ts"]) });
    expect(warnings.filter((w) => w.kind === "missing-file")).toHaveLength(0);
  });

  test("still flags paths with real extensions even when short", () => {
    const md = "See `a.ts` and `b.md`.";
    const warnings = lintPage(md, { knownFilePaths: new Set(["a.ts"]) });
    expect(warnings.map((w) => w.match)).toContain("b.md");
    expect(warnings.map((w) => w.match)).not.toContain("a.ts");
  });

  test("colon-range skips method-chain tokens", () => {
    const md = "Covered in db.search:42-50 (not a file).";
    const warnings = lintPage(md, { knownFilePaths: new Set(["src/real.ts"]) });
    expect(warnings.filter((w) => w.kind === "missing-file")).toHaveLength(0);
  });

  test("accepts relative-prefixed paths", () => {
    const md = "See `./src/real.ts`.";
    const warnings = lintPage(md, { knownFilePaths: new Set(["./src/real.ts"]) });
    expect(warnings).toEqual([]);
  });

  test("bare-filename ref resolves to project file with same basename", () => {
    const md = "Touched `wiki-tools.ts` in this change.";
    const warnings = lintPage(md, {
      knownFilePaths: new Set(["src/tools/wiki-tools.ts"]),
    });
    expect(warnings.filter((w) => w.kind === "missing-file")).toHaveLength(0);
  });

  test("bare-filename ref still warns when no basename match", () => {
    const md = "Touched `ghost.ts` in this change.";
    const warnings = lintPage(md, {
      knownFilePaths: new Set(["src/tools/wiki-tools.ts"]),
    });
    expect(warnings.map((w) => w.match)).toContain("ghost.ts");
  });

  test("ambiguous bare-filename (multiple matches) does not warn", () => {
    const md = "See `chunker.ts` for details.";
    const warnings = lintPage(md, {
      knownFilePaths: new Set(["src/indexing/chunker.ts", "src/other/chunker.ts"]),
    });
    expect(warnings.filter((w) => w.kind === "missing-file")).toHaveLength(0);
  });
});

describe("lintPage — path:N-M references", () => {
  test("still flags missing file on a path:N-M citation", () => {
    const md = "See `src/nope.ts:10-20` for context.";
    const warnings = lintPage(md, { knownFilePaths: new Set(["src/real.ts"]) });
    expect(warnings.filter((w) => w.kind === "missing-file")).toHaveLength(1);
  });

  test("does not flag range-value issues — line ranges are advisory only", () => {
    const md = "See `src/real.ts:900-9999`.";
    const warnings = lintPage(md, { knownFilePaths: new Set(["src/real.ts"]) });
    // No invalid-line-range, no path-range-drift — line ranges are not
    // validated. Path existence is the only check on `path:N-M`.
    expect(warnings.map((w) => w.kind)).not.toContain("missing-file");
  });
});

describe("lintPage — constant value check", () => {
  test("flags a cited constant that doesn't exist in the project", () => {
    const md = "Tuned via `FAKE_THRESHOLD = 0.9`.";
    const warnings = lintPage(md, {
      knownConstants: new Map([[
        "REAL_THRESHOLD",
        { name: "REAL_THRESHOLD", value: "0.5", file: "src/config.ts" },
      ]]),
    });
    const missing = warnings.filter((w) => w.kind === "constant-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].match).toBe("FAKE_THRESHOLD");
  });

  test("flags a value drift against the source snippet", () => {
    const md = "Default is `DEFAULT_HYBRID_WEIGHT = 0.5`.";
    const warnings = lintPage(md, {
      knownConstants: new Map([[
        "DEFAULT_HYBRID_WEIGHT",
        {
          name: "DEFAULT_HYBRID_WEIGHT",
          value: "export const DEFAULT_HYBRID_WEIGHT = 0.7;",
          file: "src/search/hybrid.ts",
        },
      ]]),
    });
    const drift = warnings.filter((w) => w.kind === "constant-value-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0].message).toContain("src/search/hybrid.ts");
  });

  test("matches despite type annotations and punctuation noise", () => {
    const md = "See `BATCH_LIMIT = 499`.";
    const warnings = lintPage(md, {
      knownConstants: new Map([[
        "BATCH_LIMIT",
        { name: "BATCH_LIMIT", value: "const BATCH_LIMIT: number = 499;", file: "src/db/graph.ts" },
      ]]),
    });
    expect(warnings.filter((w) => w.kind === "constant-value-drift")).toHaveLength(0);
  });

  test("ignores non-backticked mentions (e.g. prose glosses)", () => {
    const md = "Default weight is roughly 0.9 in practice.";
    const warnings = lintPage(md, {
      knownConstants: new Map([[
        "DEFAULT_HYBRID_WEIGHT",
        { name: "DEFAULT_HYBRID_WEIGHT", value: "0.7", file: "src/search/hybrid.ts" },
      ]]),
    });
    expect(warnings).toEqual([]);
  });

  test("skips check inside fenced code blocks", () => {
    const md = ["```ts", "const FOO = 1;", "```"].join("\n");
    const warnings = lintPage(md, {
      knownConstants: new Map([[
        "FOO",
        { name: "FOO", value: "2", file: "src/x.ts" },
      ]]),
    });
    expect(warnings).toEqual([]);
  });

  test("does not flag lower-case or mixed-case identifiers", () => {
    const md = "Use `foo = 1` somewhere.";
    const warnings = lintPage(md, {
      knownConstants: new Map([[
        "BAR",
        { name: "BAR", value: "2", file: "src/x.ts" },
      ]]),
    });
    expect(warnings).toEqual([]);
  });
});

describe("lintPage — constant coverage check", () => {
  test("flags tunables not cited anywhere on the page", () => {
    const md = "Page prose without any backticked constants.";
    const warnings = lintPage(md, {
      expectedConstants: [
        { name: "DEFAULT_HYBRID_WEIGHT", value: "0.7", file: "src/search/hybrid.ts" },
        { name: "GENERATED_DEMOTION", value: "0.75", file: "src/search/hybrid.ts" },
      ],
    });
    const uncited = warnings.filter((w) => w.kind === "constant-uncited").map((w) => w.match);
    expect(uncited).toContain("DEFAULT_HYBRID_WEIGHT");
    expect(uncited).toContain("GENERATED_DEMOTION");
  });

  test("citations in value form are recognised as coverage", () => {
    const md = "Default is `DEFAULT_HYBRID_WEIGHT = 0.7`, demoted by `GENERATED_DEMOTION = 0.75`.";
    const warnings = lintPage(md, {
      expectedConstants: [
        { name: "DEFAULT_HYBRID_WEIGHT", value: "0.7", file: "src/search/hybrid.ts" },
        { name: "GENERATED_DEMOTION", value: "0.75", file: "src/search/hybrid.ts" },
      ],
    });
    expect(warnings.filter((w) => w.kind === "constant-uncited")).toHaveLength(0);
  });

  test("bare-name citations (without `= value`) still count as coverage", () => {
    const md = "Uses `DEFAULT_HYBRID_WEIGHT` as the blend factor.";
    const warnings = lintPage(md, {
      expectedConstants: [
        { name: "DEFAULT_HYBRID_WEIGHT", value: "0.7", file: "src/search/hybrid.ts" },
      ],
    });
    expect(warnings.filter((w) => w.kind === "constant-uncited")).toHaveLength(0);
  });

  test("citations inside fenced code blocks count as coverage", () => {
    const md = ["```ts", "const GENERATED_DEMOTION = 0.75;", "```"].join("\n");
    const warnings = lintPage(md, {
      expectedConstants: [
        { name: "GENERATED_DEMOTION", value: "0.75", file: "src/search/hybrid.ts" },
      ],
    });
    expect(warnings.filter((w) => w.kind === "constant-uncited")).toHaveLength(0);
  });

  test("partial coverage flags only the missing names", () => {
    const md = "We use `DEFAULT_HYBRID_WEIGHT = 0.7` but don't mention the other.";
    const warnings = lintPage(md, {
      expectedConstants: [
        { name: "DEFAULT_HYBRID_WEIGHT", value: "0.7", file: "src/search/hybrid.ts" },
        { name: "GENERATED_DEMOTION", value: "0.75", file: "src/search/hybrid.ts" },
      ],
    });
    const uncited = warnings.filter((w) => w.kind === "constant-uncited").map((w) => w.match);
    expect(uncited).toEqual(["GENERATED_DEMOTION"]);
  });

  test("empty expected list skips the check entirely", () => {
    const md = "No constants here.";
    const warnings = lintPage(md, { expectedConstants: [] });
    expect(warnings).toEqual([]);
  });

  test("absent option skips the check entirely", () => {
    const md = "No constants here.";
    const warnings = lintPage(md);
    expect(warnings).toEqual([]);
  });
});

describe("lintPage — line-range drift", () => {
  const ranges: ChunkRange[] = [
    { entityName: "foo", chunkType: "function", startLine: 10, endLine: 40 },
    { entityName: "bar", chunkType: "function", startLine: 50, endLine: 120 },
  ];
  const chunkRangesByPath = new Map<string, ChunkRange[]>([["src/a.ts", ranges]]);
  const knownFilePaths = new Set(["src/a.ts"]);

  test("flags a cited range drifted from the enclosing chunk and ships corrected value", () => {
    const md = "See `src/a.ts:10-35` for the details.";
    const warnings = lintPage(md, { knownFilePaths, chunkRangesByPath });
    const drift = warnings.filter((w) => w.kind === "line-range-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0].match).toBe("src/a.ts:10-35");
    expect(drift[0].correctedMatch).toBe("src/a.ts:10-40");
  });

  test("no warning when the cited range matches the chunk exactly", () => {
    const md = "Look at `src/a.ts:50-120`.";
    const warnings = lintPage(md, { knownFilePaths, chunkRangesByPath });
    expect(warnings.filter((w) => w.kind === "line-range-drift")).toHaveLength(0);
  });

  test("picks the innermost enclosing chunk when ranges nest", () => {
    const nested: ChunkRange[] = [
      { entityName: "outer", chunkType: "class", startLine: 1, endLine: 200 },
      { entityName: "inner", chunkType: "method", startLine: 80, endLine: 110 },
    ];
    const md = "Check `src/a.ts:80-99`.";
    const warnings = lintPage(md, {
      knownFilePaths,
      chunkRangesByPath: new Map([["src/a.ts", nested]]),
    });
    const drift = warnings.filter((w) => w.kind === "line-range-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0].correctedMatch).toBe("src/a.ts:80-110");
  });

  test("skips when no chunk encloses the cited start line", () => {
    const md = "Orphan citation `src/a.ts:300-350`.";
    const warnings = lintPage(md, { knownFilePaths, chunkRangesByPath });
    expect(warnings.filter((w) => w.kind === "line-range-drift")).toHaveLength(0);
  });

  test("absent chunkRangesByPath skips the check", () => {
    const md = "Stale `src/a.ts:10-35`.";
    const warnings = lintPage(md, { knownFilePaths });
    expect(warnings.filter((w) => w.kind === "line-range-drift")).toHaveLength(0);
  });
});

describe("lintPage — member coverage", () => {
  test("flags a member file that never appears as a backticked citation", () => {
    const md = "Only mentions `src/a.ts` and `src/b.ts`.";
    const warnings = lintPage(md, {
      expectedMembers: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    const uncited = warnings.filter((w) => w.kind === "member-uncited").map((w) => w.match);
    expect(uncited).toEqual(["src/c.ts"]);
  });

  test("citation inside a fenced code block counts as a mention", () => {
    const md = [
      "Some prose with no path.",
      "",
      "```ts",
      "import { x } from '`src/c.ts`';",
      "```",
    ].join("\n");
    const warnings = lintPage(md, {
      expectedMembers: ["src/c.ts"],
    });
    expect(warnings.filter((w) => w.kind === "member-uncited")).toHaveLength(0);
  });

  test("fires one warning per missing member", () => {
    const md = "No members cited.";
    const warnings = lintPage(md, {
      expectedMembers: ["src/a.ts", "src/b.ts"],
    });
    const uncited = warnings.filter((w) => w.kind === "member-uncited").map((w) => w.match);
    expect(new Set(uncited)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });

  test("empty expected list skips the check", () => {
    expect(lintPage("anything", { expectedMembers: [] })).toEqual([]);
  });

  test("absent option skips the check", () => {
    expect(lintPage("anything")).toEqual([]);
  });

  test("unrelated path-like text that is not a full backtick match still fires", () => {
    // `src/a.ts` in prose without backticks — not a citation.
    const md = "see src/a.ts for details";
    const warnings = lintPage(md, {
      expectedMembers: ["src/a.ts"],
    });
    const uncited = warnings.filter((w) => w.kind === "member-uncited");
    expect(uncited).toHaveLength(1);
  });
});

describe("lintPage — hedge / marketing words", () => {
  test("flags each hedge word in prose", () => {
    const md = [
      "The system is basically a search engine.",
      "It just works seamlessly with the powerful indexer.",
      "We leverage tree-sitter for robust parsing.",
    ].join("\n");
    const warnings = lintPage(md).filter((w) => w.kind === "prose-hedge");
    const matches = warnings.map((w) => w.match.toLowerCase());
    expect(matches).toContain("basically");
    expect(matches).toContain("just");
    expect(matches).toContain("seamlessly");
    expect(matches).toContain("powerful");
    expect(matches).toContain("leverage");
    expect(matches).toContain("robust");
  });

  test("does not fire inside fenced code blocks", () => {
    const md = [
      "```ts",
      "const leverageScore = computeLeverage(graph);",
      "// just a comment",
      "```",
    ].join("\n");
    const warnings = lintPage(md).filter((w) => w.kind === "prose-hedge");
    expect(warnings).toHaveLength(0);
  });

  test("clean prose produces zero hits", () => {
    const md = "The indexer chunks files via tree-sitter and writes embeddings.";
    expect(lintPage(md).filter((w) => w.kind === "prose-hedge")).toHaveLength(0);
  });
});

describe("lintPage — citation symbol drift", () => {
  const knownFilePaths = new Set(["src/embeddings/embed.ts"]);
  const chunkRangesByPath = new Map<string, ChunkRange[]>([
    [
      "src/embeddings/embed.ts",
      [
        { entityName: "configureEmbedder", chunkType: "function", startLine: 34, endLine: 42 },
        { entityName: "getEmbedder", chunkType: "function", startLine: 60, endLine: 80 },
      ],
    ],
  ]);

  test("flags symbol attributed to wrong line range", () => {
    const md = "The bootstrap calls `getEmbedder()` (src/embeddings/embed.ts:34-42).";
    const warnings = lintPage(md, { knownFilePaths, chunkRangesByPath });
    const drift = warnings.filter((w) => w.kind === "citation-symbol-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0].match).toContain("getEmbedder");
    expect(drift[0].message).toContain("configureEmbedder");
  });

  test("passes when symbol matches the cited range", () => {
    const md = "The bootstrap calls `configureEmbedder` (src/embeddings/embed.ts:34-42).";
    const warnings = lintPage(md, { knownFilePaths, chunkRangesByPath });
    expect(warnings.filter((w) => w.kind === "citation-symbol-drift")).toHaveLength(0);
  });

  test("supports `at path:line` form", () => {
    const md = "See `getEmbedder` at src/embeddings/embed.ts:34.";
    const warnings = lintPage(md, { knownFilePaths, chunkRangesByPath });
    expect(warnings.filter((w) => w.kind === "citation-symbol-drift")).toHaveLength(1);
  });

  test("tolerates ±3 line drift around the cited range", () => {
    const md = "The bootstrap calls `configureEmbedder` (src/embeddings/embed.ts:36-40).";
    const warnings = lintPage(md, { knownFilePaths, chunkRangesByPath });
    expect(warnings.filter((w) => w.kind === "citation-symbol-drift")).toHaveLength(0);
  });

  test("skips when chunk ranges are unavailable", () => {
    const md = "The bootstrap calls `wrongName()` (src/embeddings/embed.ts:34-42).";
    const warnings = lintPage(md, { knownFilePaths });
    expect(warnings.filter((w) => w.kind === "citation-symbol-drift")).toHaveLength(0);
  });

  test("does not fire on loose mentions far from the citation", () => {
    const md =
      "The function `getEmbedder()` is the entry point. The other helpers live in src/embeddings/embed.ts:34-42.";
    const warnings = lintPage(md, { knownFilePaths, chunkRangesByPath });
    expect(warnings.filter((w) => w.kind === "citation-symbol-drift")).toHaveLength(0);
  });
});
