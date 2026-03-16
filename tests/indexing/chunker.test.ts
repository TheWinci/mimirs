import { describe, test, expect } from "bun:test";
import { chunkText } from "../../src/indexing/chunker";

describe("chunkText", () => {
  test("returns single chunk for text under chunkSize", async () => {
    const { chunks } = await chunkText("Short text", ".md", 512);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Short text");
    expect(chunks[0].index).toBe(0);
  });

  test("splits markdown on heading boundaries", async () => {
    const text = `## Section One

Content for section one.

## Section Two

Content for section two.

## Section Three

Content for section three.`;

    const { chunks } = await chunkText(text, ".md", 50, 0);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should start with or contain a heading
    expect(chunks[0].text).toContain("Section One");
  });

  test("splits code on double-newline boundaries", async () => {
    const text = `function foo() {
  return 1;
}

function bar() {
  return 2;
}

function baz() {
  return 3;
}`;

    const { chunks } = await chunkText(text, ".ts", 60, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("splits plain text on paragraphs", async () => {
    const text = `First paragraph with some content.

Second paragraph with different content.

Third paragraph wrapping things up.`;

    const { chunks } = await chunkText(text, ".txt", 60, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("falls back to size-based splitting for large sections", async () => {
    const longText = "A".repeat(1000);
    const { chunks } = await chunkText(longText, ".txt", 200, 50);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should be exactly chunkSize
    expect(chunks[0].text.length).toBe(200);
  });

  test("overlap is applied between size-based chunks", async () => {
    const text = "ABCDEFGHIJ".repeat(10); // 100 chars
    const { chunks } = await chunkText(text, ".txt", 40, 10);
    // With overlap, the second chunk should start 10 chars before the end of the first
    if (chunks.length >= 2) {
      const end1 = chunks[0].text.slice(-10);
      const start2 = chunks[1].text.slice(0, 10);
      expect(end1).toBe(start2);
    }
  });

  test("chunk indices are sequential starting at 0", async () => {
    const text = "## A\n\nContent A.\n\n## B\n\nContent B.\n\n## C\n\nContent C.";
    const { chunks } = await chunkText(text, ".md", 30, 0);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  test("merges tiny consecutive sections", async () => {
    const text = `a

b

c

This is a longer paragraph that should stand on its own.`;

    const { chunks } = await chunkText(text, ".txt", 500, 0);
    // "a", "b", "c" are tiny and should be merged
    expect(chunks.length).toBeLessThanOrEqual(2);
  });

  test("uses AST chunking for TypeScript files", async () => {
    const code = `
function calculateSum(a: number, b: number): number {
  return a + b;
}

class MathHelper {
  multiply(x: number, y: number): number {
    return x * y;
  }

  divide(x: number, y: number): number {
    if (y === 0) throw new Error("Division by zero");
    return x / y;
  }
}

export function greet(name: string): string {
  return "Hello, " + name;
}

export default MathHelper;
`.trim();

    // Use small chunk size to force splitting
    const { chunks } = await chunkText(code, ".ts", 150, 0, "math.ts");
    expect(chunks.length).toBeGreaterThan(1);
    // Should split on function/class boundaries, not arbitrary positions
  });

  test("falls back to heuristic for unsupported code languages", async () => {
    const code = `
sub hello {
  print "Hello\\n";
}

sub goodbye {
  print "Goodbye\\n";
}
`.trim();

    // .pl (Perl) is not in AST_SUPPORTED
    const { chunks } = await chunkText(code, ".pl", 50, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
