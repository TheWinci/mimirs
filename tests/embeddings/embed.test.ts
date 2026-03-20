import { describe, test, expect, beforeAll } from "bun:test";
import { embed, getEmbedder, EMBEDDING_DIM } from "../../src/embeddings/embed";

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
