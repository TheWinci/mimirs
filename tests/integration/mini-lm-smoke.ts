import assert from "node:assert/strict";

import {
  embedPathAveragedWithMiniLm,
  embedWithMiniLm,
  getMiniLmPipeline,
  getMiniLmTokenizer,
  MINI_LM_DIMENSIONS,
  MINI_LM_MODEL,
  MINI_LM_REVISION,
  MINI_LM_VARIANT,
  miniLmEmbedder,
  preparePathAverageMiniLmInputs,
} from "../../src/internals/embeddings/mini-lm.ts";
import { search } from "../../src/internals/search/search.ts";
import {
  embedSourceWindows,
  miniLmPathAverageEmbedder,
} from
  "../../src/internals/storage/source-embeddings.ts";
import { SourceIndex } from
  "../../src/internals/storage/source-index.ts";

function magnitude(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) squared += value * value;
  return Math.sqrt(squared);
}

const longText = Array.from({ length: 50 }, (_, index) =>
  `export function handler${index}(request: Request): Promise<Response> {\n` +
  `  return processRequest(request, ${index});\n` +
  `}`
).join("\n\n");

assert.equal(miniLmEmbedder.model, MINI_LM_MODEL);
assert.equal(miniLmEmbedder.revision, MINI_LM_REVISION);
assert.equal(miniLmEmbedder.variant, MINI_LM_VARIANT);
assert.equal(miniLmEmbedder.dimensions, MINI_LM_DIMENSIONS);
assert.equal(MINI_LM_DIMENSIONS, 384);

const tokenizer = await getMiniLmTokenizer();
assert.ok(Array.from(tokenizer.encode(longText)).length > 256);
const firstPipeline = await getMiniLmPipeline();
const vectors = await miniLmEmbedder.embed([
  "export function ping(): string { return 'pong'; }",
  longText,
]);

const pathShort =
  "File: packages/server/ping.ts\n" +
  "export function ping(): string { return 'pong'; }";
const pathLong = "File: packages/server/handlers.ts\n" + longText;
const pathPlans = await preparePathAverageMiniLmInputs([pathShort, pathLong]);
const pathPlansWithoutOverlap = await preparePathAverageMiniLmInputs(
  [pathLong],
  0,
);
assert.equal(pathPlans[0]?.length, 1);
assert.ok(pathPlans[1]!.length > 1);
assert.ok(pathPlansWithoutOverlap[0]!.length <= pathPlans[1]!.length);
await assert.rejects(
  preparePathAverageMiniLmInputs([pathLong], 256),
  /tokenWindowOverlap must be an integer from 0 to 255/,
);
for (const input of pathPlans.flat()) {
  assert.ok(input.startsWith("File: "));
  assert.ok(Array.from(tokenizer.encode(input)).length <= 256);
}
assert.ok(pathPlans[1]!.every((input) =>
  input.startsWith("File: packages/server/handlers.ts\n")
));
const pathAlone = await embedPathAveragedWithMiniLm([pathLong]);
const pathGrouped = await embedPathAveragedWithMiniLm([pathShort, pathLong]);
let observedNoOverlapInputs = 0;
const pathWithoutOverlap = await embedPathAveragedWithMiniLm([pathLong], {
  tokenWindowOverlap: 0,
  onInferenceInputs: (count) => {
    observedNoOverlapInputs += count;
  },
});
assert.equal(
  observedNoOverlapInputs,
  new Set(pathPlansWithoutOverlap[0]).size,
);
assert.deepEqual(Array.from(pathAlone[0]!), Array.from(pathGrouped[1]!));
assert.ok(Math.abs(magnitude(pathAlone[0]!) - 1) < 0.01);
assert.ok(Math.abs(magnitude(pathWithoutOverlap[0]!) - 1) < 0.01);
const rawQuery = await miniLmEmbedder.embed(["where is ping handled"]);
const productionQuery = await miniLmPathAverageEmbedder.embed([
  "where is ping handled",
]);
assert.deepEqual(
  Array.from(rawQuery[0]!),
  Array.from(productionQuery[0]!),
);

const variedInputs = Array.from({ length: 40 }, (_, index) =>
  `${"context ".repeat(index % 10)}export const value${index} = ${index};`
);
const orderedVectors = await embedWithMiniLm(variedInputs, {
  bucketByTokenLength: false,
});
const bucketedVectors = await embedWithMiniLm(variedInputs, {
  bucketByTokenLength: true,
});
assert.equal(bucketedVectors.length, variedInputs.length);
for (let index = 0; index < variedInputs.length; index++) {
  const ordered = orderedVectors[index]!;
  const bucketed = bucketedVectors[index]!;
  assert.equal(bucketed.length, MINI_LM_DIMENSIONS);
  let similarity = 0;
  for (let dimension = 0; dimension < ordered.length; dimension++) {
    similarity += ordered[dimension]! * bucketed[dimension]!;
  }
  assert.ok(similarity > 0.98, `bucketed vector ${index} changed identity`);
}

assert.equal(await getMiniLmPipeline(), firstPipeline);
assert.equal(vectors.length, 2);
for (const vector of vectors) {
  assert.ok(vector instanceof Float32Array);
  assert.equal(vector.length, MINI_LM_DIMENSIONS);
  assert.ok(Array.from(vector).every(Number.isFinite));
  assert.ok(Math.abs(magnitude(vector) - 1) < 0.01);
}

const index = SourceIndex.open();
try {
  await index.indexFile(
    "ping.ts",
    "export function ping(): string { return 'pong'; }\n",
  );
  await index.indexFile(
    "security/redact.py",
    `def redact_authorization_header(headers: dict[str, str]) -> dict[str, str]:
    """Remove bearer credentials before request headers enter diagnostic logs."""
    sanitized = headers.copy()
    if "Authorization" in sanitized:
        sanitized["Authorization"] = "Bearer [REDACTED]"
    return sanitized
`,
  );
  await index.indexFile(
    "server/shutdown.go",
    `package server

// GracefulShutdown drains in-flight HTTP requests before the process exits.
func GracefulShutdown(server *http.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return server.Shutdown(ctx)
}
`,
  );
  await index.indexFile(
    "payments/retry.ts",
    `/** Retry a card charge with capped exponential backoff. */
export async function retryCardCharge(paymentId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await submitCardCharge(paymentId); return; }
    catch { await Bun.sleep(Math.min(2 ** attempt * 100, 5_000)); }
  }
}
`,
  );
  const first = await embedSourceWindows(index);
  assert.ok(first.total >= 4);
  assert.equal(first.embedded, first.total);
  const stored = index.loadWindows("ping.ts")[0]?.embedding;
  assert.ok(stored);
  assert.equal(stored.vector.length, MINI_LM_DIMENSIONS);
  const second = await embedSourceWindows(index, miniLmPathAverageEmbedder, {
    previousIdentity: first,
  });
  assert.equal(second.embedded, 0);
  assert.equal(second.unchanged, first.total);

  const prose = await search(index, {
    query: "Where are bearer authorization credentials removed before logging?",
    maxResults: 3,
  });
  assert.ok(
    prose.source.some((result) => result.path === "security/redact.py"),
    "expected the authorization redaction implementation in the top 3",
  );

  const longQuery = Array.from(
    { length: 70 },
    () => "Find the code that drains in-flight HTTP requests during graceful shutdown.",
  ).join(" ");
  assert.ok(Array.from(tokenizer.encode(longQuery)).length > 256);
  const oversizedQuery = await search(index, {
    query: longQuery,
    maxResults: 3,
  });
  assert.ok(
    oversizedQuery.source.some((result) => result.path === "server/shutdown.go"),
    "expected graceful shutdown in the top 3 for an oversized query",
  );
} finally {
  index.close();
}

console.log(
  `verified ${MINI_LM_MODEL}@${MINI_LM_REVISION}: ` +
    `short/oversized embeddings and natural-language top-k relevance -> ` +
    `${MINI_LM_DIMENSIONS} normalized dimensions`,
);
