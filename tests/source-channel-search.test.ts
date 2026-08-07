import { describe, expect, test } from "bun:test";

import type { Embedder } from
  "../src/internals/embeddings/embedder.ts";
import { searchSourceChannels } from
  "../src/internals/search/source-channel-search.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";

const embedder: Embedder = {
  model: "test/source-channels",
  revision: "1",
  variant: "controlled",
  dimensions: 2,
  embed: async () => [new Float32Array([1, 0])],
};

async function add(
  index: SourceIndex,
  path: string,
  source: string,
  vector: Float32Array,
): Promise<void> {
  await index.indexFile(path, source);
  const window = index.loadWindows(path)[0]!;
  index.storeWindowEmbeddings(embedder, [{
    windowId: window.id,
    textHash: window.textHash,
    vector,
  }]);
}

describe("independent production source channels", () => {
  test("returns pre-fusion semantic and BM25 file rankings separately", async () => {
    const index = SourceIndex.open();
    try {
      await add(
        index,
        "semantic.ts",
        "export function unrelated() { return true; }\n",
        new Float32Array([1, 0]),
      );
      await add(
        index,
        "lexical.ts",
        "export function needleBehavior() { return true; }\n",
        new Float32Array([0, 1]),
      );
      const response = await searchSourceChannels(index, {
        query: "needleBehavior",
        maxResults: 10,
      }, { embedder });
      expect(response.semantic.map((value) => value.path)).toEqual([
        "semantic.ts",
        "lexical.ts",
      ]);
      expect(response.lexical.map((value) => value.path)).toEqual([
        "lexical.ts",
      ]);
      expect(response.semantic[0]).toMatchObject({
        channel: "semantic",
        score: 1,
      });
      expect(response.lexical[0]).toMatchObject({ channel: "lexical" });
    } finally {
      index.close();
    }
  });

  test("validates requests before inference", async () => {
    const index = SourceIndex.open();
    try {
      await expect(searchSourceChannels(index, {
        query: " ",
        maxResults: 1,
      }, { embedder })).rejects.toThrow("must not be empty");
      await expect(searchSourceChannels(index, {
        query: "query",
        maxResults: 0,
      }, { embedder })).rejects.toThrow("positive integer");
    } finally {
      index.close();
    }
  });
});
