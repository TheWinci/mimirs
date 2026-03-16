import { describe, test, expect, beforeAll } from "bun:test";
import { embed, embedBatchMerged, getEmbedder, getTokenizer, EMBEDDING_DIM } from "../../src/embeddings/embed";

// Load model once for all tests
beforeAll(async () => {
  await getEmbedder();
});

describe("embed", () => {
  test("returns Float32Array of correct dimension", async () => {
    const vec = await embed("test text");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBEDDING_DIM);
    expect(EMBEDDING_DIM).toBe(384);
  });

  test("output is normalized (magnitude ≈ 1.0)", async () => {
    const vec = await embed("some sample text for normalization check");
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(Math.abs(magnitude - 1.0)).toBeLessThan(0.01);
  });

  test("model loads once (singleton)", async () => {
    const model1 = await getEmbedder();
    const model2 = await getEmbedder();
    expect(model1).toBe(model2);
  });

  test("similar texts produce closer vectors than dissimilar texts", async () => {
    const vecA = await embed("TypeScript programming with Bun runtime");
    const vecB = await embed("JavaScript development with Bun");
    const vecC = await embed("Cooking Italian pasta recipes");

    const simAB = cosine(vecA, vecB);
    const simAC = cosine(vecA, vecC);

    expect(simAB).toBeGreaterThan(simAC);
  });

  test("handles empty string input", async () => {
    const vec = await embed("");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBEDDING_DIM);
  });
});

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Already normalized, so dot product = cosine similarity
}

// Generate a text that reliably exceeds 256 tokens
function makeLongText(): string {
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) {
    lines.push(`function handler${i}(request: Request, response: Response): Promise<void> {`);
    lines.push(`  const data = await fetchDataFromDatabase(request.params.id);`);
    lines.push(`  response.json({ success: true, data });`);
    lines.push(`}`);
  }
  return lines.join("\n");
}

describe("embedBatchMerged", () => {
  test("short text produces valid 384d normalized vector", async () => {
    const [vec] = await embedBatchMerged(["short text"]);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBEDDING_DIM);
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(Math.abs(mag - 1.0)).toBeLessThan(0.01);
  });

  test("oversized text produces valid 384d normalized vector", async () => {
    const longText = makeLongText();
    // Verify it actually exceeds 256 tokens
    const tok = await getTokenizer();
    const tokenCount = Array.from(tok.encode(longText)).length;
    expect(tokenCount).toBeGreaterThan(256);

    const [vec] = await embedBatchMerged([longText]);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBEDDING_DIM);
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(Math.abs(mag - 1.0)).toBeLessThan(0.01);
  });

  test("mixed batch all produce valid vectors", async () => {
    const results = await embedBatchMerged([
      "short text",
      makeLongText(),
      "another short one",
    ]);
    expect(results.length).toBe(3);
    for (const vec of results) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(EMBEDDING_DIM);
    }
  });

  test("merged embedding differs from truncated for oversized text", async () => {
    const longText = makeLongText();
    const truncated = await embed(longText);
    const [merged] = await embedBatchMerged([longText]);
    const sim = cosine(truncated, merged);
    // Should be related but not identical — model sees different content
    expect(sim).toBeLessThan(0.99);
    expect(sim).toBeGreaterThan(0.5);
  });

  test("merged embedding better captures tail content", async () => {
    const longText = makeLongText();
    const tok = await getTokenizer();
    const ids = Array.from(tok.encode(longText));

    // Extract a phrase from past the truncation point
    const tailIds = ids.slice(260, 290);
    const tailSnippet = tok.decode(tailIds, { skip_special_tokens: true }).trim();

    const queryEmb = await embed(tailSnippet);
    const truncatedEmb = await embed(longText);
    const [mergedEmb] = await embedBatchMerged([longText]);

    const simTruncated = cosine(queryEmb, truncatedEmb);
    const simMerged = cosine(queryEmb, mergedEmb);

    // Merged should have higher similarity to tail content
    expect(simMerged).toBeGreaterThan(simTruncated);
  });
});
