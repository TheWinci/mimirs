# Testing

mimirs uses Bun's built-in test runner — no separate framework, no transpile step. Tests mirror the `src/` layout under `tests/`, every file ends in `.test.ts`, and every test suite that touches the index creates a fresh temp directory via `tests/helpers.ts` so runs stay isolated. Benchmarks (expensive, model-heavy) live separately under `benchmarks/` and are run only by `bun run test` — scoped runs avoid them entirely.

## Structure

Mirrored layout: a file at `src/<module>/<file>.ts` is tested by `tests/<module>/<file>.test.ts`. Feature-level and cross-module concerns land under `tests/features/`. There's no co-location (`*.test.ts` next to source) — Bun's runner picks up files under `tests/` when pointed there.

| Directory | What's tested | Type |
|-----------|---------------|------|
| `tests/cli/` | Argv dispatch, CLI output formatting | Unit |
| `tests/config/` | `loadConfig`, Zod schema, self-heal on malformed JSON | Unit |
| `tests/conversation/` | `parseTurns`, `buildTurnText`, tail indexing, dedupe by `(sessionId, turnIndex)` | Integration (real DB, real JSONL fixtures) |
| `tests/db/` | `RagDB` facade surface: upsert, search, FTS sync, transactions | Integration |
| `tests/embeddings/` | Singleton configuration, `embedBatch` determinism, dim = 384 | Integration (loads real MiniLM ONNX model) |
| `tests/features/` | Annotations, checkpoints, git-context, git-history end-to-end | Integration |
| `tests/graph/` | Two-pass resolver, `getGraph`, `getSubgraph`, `getImportersOf` | Integration |
| `tests/indexing/` | Walk, AST chunker, parse, watcher debounce, line-number assignment | Integration |
| `tests/search/` | Hybrid scoring, analytics, benchmark/eval harnesses, symbol search, FTS edge-cases | Integration |
| `tests/tools/` | MCP server registration, `generate_wiki` tool surface | Integration |
| `tests/wiki/` | 4-phase pipeline: discovery, categorization, page-tree, section-selector | Unit (no DB; pure data) |
| `tests/fixtures/` | Shared input files (`sample.ts`, `large.md`, `frontmatter-only.md`) | Fixtures |
| `benchmarks/` | Indexing throughput, chunker strategies, parent-grouping — **not** part of default runs | Benchmark |

## Running Tests

```sh
# Single file (what you want day-to-day — fast)
bun test tests/search/hybrid-search.test.ts
bun test tests/indexing/indexer.test.ts
bun test tests/wiki/page-tree.test.ts

# A whole sub-tree
bun test tests/db/
bun test tests/features/

# Full suite including benchmarks — slow; only for CI / pre-release
bun run test
```

The `bun run test` script wraps `bun test tests/` and suppresses exit code `133`, a known Bun crash on Apple Silicon during process cleanup (upstream: `github.com/oven-sh/bun/issues/19917`). If tests pass but the process exits 133, the script treats it as success and prints a note.

## Test Patterns

### Temp-directory fixtures

Every integration test starts with `createTempDir()` and ends with `cleanupTempDir(dir)` — there is no shared global DB. `writeFixture(dir, relativePath, content)` drops a file into the temp dir at a given path, creating parent directories as needed. `tests/helpers.ts` has fan-in 65 because almost every suite uses it.

```ts
// tests/indexing/indexer.test.ts — canonical shape
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";

let dir: string;
beforeEach(async () => { dir = await createTempDir(); });
afterEach(async () => { await cleanupTempDir(dir); });

test("indexes a single file", async () => {
  await writeFixture(dir, "src/foo.ts", "export const x = 1;");
  const db = new RagDB(dir);
  await indexDirectory(dir, db, loadConfig(dir));
  expect(db.getStatus().totalFiles).toBe(1);
  db.close();
});
```

### Real DB, not mocks

Integration tests open a real `RagDB` against a real on-disk SQLite file in the temp dir, with `sqlite-vec` and FTS5 loaded. The upside is tests catch schema-init issues, trigger mis-wiring, and vec-dim mismatches that a mocked DB would silently accept. The cost is ~50-200 ms per suite for schema creation, which Bun's parallel runner absorbs.

### Real embedder where it matters

`tests/embeddings/`, `tests/search/`, and `tests/conversation/` load the actual MiniLM-L6-v2 model (one-time cost per process, cached by `@huggingface/transformers`). Tests that only need the DB surface use deterministic stand-in vectors. The test for `getEmbeddingDim()` asserts `384` — the invariant that prevents schema/model drift.

## Test Categories

### Unit Tests

Live under `tests/wiki/`, `tests/config/`, `tests/cli/` — anything that operates on plain data with no DB. These are the fastest suites and are the ones to run in tight edit loops.

### Integration Tests

Everything else: any suite that opens `RagDB`, walks a directory, runs an embedder, or drives the MCP server. They need a temp dir and the `sqlite-vec` extension (so they fail fast if the macOS SQLite setup is wrong). This is by design — see [Conventions](conventions.md) for the "real DB, not mocks" rationale.

## Coverage

mimirs doesn't ship a coverage tool in `package.json`. Bun supports `--coverage` natively, so on-demand coverage is:

```sh
bun test --coverage tests/search/
```

No coverage target is enforced — the project uses recall-based search benchmarks (see `BENCHMARKS.md`) as its primary quality signal instead.

## See also

- [Architecture](../architecture.md)
- [Data Flows](../data-flows.md)
- [Getting Started](getting-started.md)
- [Conventions](conventions.md)
- [Index](../index.md)
