import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingIdentity } from
  "../src/internals/embeddings/embedder.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";

const IDENTITY: EmbeddingIdentity = {
  model: "test/search",
  revision: "1",
  variant: "normalized",
  dimensions: 4,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function addFile(index: SourceIndex, path: string): Promise<number> {
  await index.indexFile(
    path,
    `export function ${path.replace(/\W/g, "_")}() { return true; }\n`,
  );
  return index.loadWindows(path)[0]!.id;
}

function setVector(
  index: SourceIndex,
  windowId: number,
  identity: EmbeddingIdentity,
  vector: Float32Array,
): void {
  const row = index.database.query<{ text_hash: string }, [number]>(
    "SELECT text_hash FROM source_windows WHERE id = ?",
  ).get(windowId)!;
  index.storeWindowEmbeddings(identity, [{
    windowId,
    textHash: row.text_hash,
    vector,
  }]);
}

describe("semantic candidate storage", () => {
  test("classifies missing embeddings without failing valid candidates", async () => {
    const index = SourceIndex.open();
    try {
      const valid = await addFile(index, "a-valid.ts");
      await addFile(index, "b-missing.ts");
      const incompatible = await addFile(index, "c-incompatible.ts");
      const zero = await addFile(index, "d-zero.ts");
      const secondValid = await addFile(index, "e-valid.ts");

      setVector(index, valid, IDENTITY, new Float32Array([1, 0, 0, 0]));
      setVector(index, incompatible, IDENTITY,
        new Float32Array([0, 1, 0, 0]));
      setVector(index, zero, IDENTITY, new Float32Array(4));
      setVector(index, secondValid, IDENTITY,
        new Float32Array([0, 0, 0, 1]));

      const result = index.readSemanticCandidates(IDENTITY);
      expect(result.candidates.map((candidate) => candidate.path)).toEqual([
        "a-valid.ts",
        "c-incompatible.ts",
        "d-zero.ts",
        "e-valid.ts",
      ]);
      expect(result.diagnostics).toEqual({
        total: 5,
        compatible: 4,
        missingEmbedding: 1,
        incompleteEmbedding: 0,
        incompatibleEmbedding: 0,
        malformedEmbedding: 0,
        orphaned: 0,
      });

      result.candidates[0]!.vector[0] = 99;
      expect(Array.from(
        index.readSemanticCandidates(IDENTITY).candidates[0]!.vector,
      )).toEqual([1, 0, 0, 0]);

      expect(index.reconcileFiles(new Set(["a-valid.ts", "b-missing.ts"])))
        .toEqual(["c-incompatible.ts", "d-zero.ts", "e-valid.ts"]);
      const reconciled = index.readSemanticCandidates(IDENTITY);
      expect(reconciled.candidates.map((candidate) => candidate.path)).toEqual([
        "a-valid.ts",
      ]);
      expect(reconciled.diagnostics).toEqual({
        total: 2,
        compatible: 1,
        missingEmbedding: 1,
        incompleteEmbedding: 0,
        incompatibleEmbedding: 0,
        malformedEmbedding: 0,
        orphaned: 0,
      });
      expect(index.reconcileFiles(new Set())).toEqual([
        "a-valid.ts",
        "b-missing.ts",
      ]);
      expect(index.readSemanticCandidates(IDENTITY).diagnostics.total).toBe(0);
    } finally {
      index.close();
    }
  });

  test("returns deterministic citations after a file-backed reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mimirs-search-candidates-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "index.sqlite");
    const writer = SourceIndex.open(databasePath);
    const zeta = await addFile(writer, "zeta.ts");
    const alpha = await addFile(writer, "alpha.ts");
    setVector(writer, zeta, IDENTITY, new Float32Array([0, 1, 0, 0]));
    setVector(writer, alpha, IDENTITY, new Float32Array([1, 0, 0, 0]));
    const expected = writer.readSemanticCandidates(IDENTITY).candidates.map(
      ({ vector, ...candidate }) => ({ ...candidate, vector: Array.from(vector) }),
    );
    writer.close();

    const reader = SourceIndex.open(databasePath);
    try {
      const actual = reader.readSemanticCandidates(IDENTITY).candidates.map(
        ({ vector, ...candidate }) => ({ ...candidate, vector: Array.from(vector) }),
      );
      expect(actual).toEqual(expected);
      expect(actual.map((candidate) => candidate.path)).toEqual([
        "alpha.ts",
        "zeta.ts",
      ]);
      for (const candidate of actual) {
        expect(candidate.startOffset).toBe(candidate.sourceChunk.startOffset);
        expect(candidate.endOffset).toBe(candidate.sourceChunk.endOffset);
        expect(candidate.startLine).toBe(1);
        expect(candidate.endLine).toBe(1);
      }
    } finally {
      reader.close();
    }
  });

  test("diagnoses an orphan instead of presenting an incomplete citation", async () => {
    const index = SourceIndex.open();
    try {
      const windowId = await addFile(index, "orphan.ts");
      setVector(index, windowId, IDENTITY,
        new Float32Array([1, 0, 0, 0]));
      index.database.exec("PRAGMA foreign_keys = OFF");
      index.database.exec("DELETE FROM source_chunks");
      index.database.exec("PRAGMA foreign_keys = ON");

      expect(index.readSemanticCandidates(IDENTITY)).toEqual({
        candidates: [],
        diagnostics: {
          total: 1,
          compatible: 0,
          missingEmbedding: 0,
          incompleteEmbedding: 0,
          incompatibleEmbedding: 0,
          malformedEmbedding: 0,
          orphaned: 1,
        },
      });
    } finally {
      index.close();
    }
  });

  test("rejects malformed vectors before vec0 can persist them", async () => {
    const index = SourceIndex.open();
    try {
      const windowId = await addFile(index, "malformed.ts");
      expect(() => setVector(
        index,
        windowId,
        IDENTITY,
        new Float32Array([1, 2, 3]),
      )).toThrow("has 3 dimensions; expected 4");
      expect(() => setVector(
        index,
        windowId,
        IDENTITY,
        new Float32Array([1, 2, Number.NaN, 4]),
      )).toThrow("contains a non-finite value");
      expect(index.readSemanticCandidates(IDENTITY).diagnostics).toMatchObject({
        total: 1,
        compatible: 0,
        missingEmbedding: 1,
        malformedEmbedding: 0,
      });
    } finally {
      index.close();
    }
  });

  test("rejects invalid requested embedding identities", () => {
    const index = SourceIndex.open();
    try {
      expect(() => index.readSemanticCandidates({
        ...IDENTITY,
        model: " ",
      })).toThrow("identity model must not be empty");
      expect(() => index.readSemanticCandidates({
        ...IDENTITY,
        dimensions: 0,
      })).toThrow("dimensions must be a positive integer");
      expect(index.readSemanticCandidates(IDENTITY)).toEqual({
        candidates: [],
        diagnostics: {
          total: 0,
          compatible: 0,
          missingEmbedding: 0,
          incompleteEmbedding: 0,
          incompatibleEmbedding: 0,
          malformedEmbedding: 0,
          orphaned: 0,
        },
      });
    } finally {
      index.close();
    }
  });
});
