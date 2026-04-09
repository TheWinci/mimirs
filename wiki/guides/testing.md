# Testing

## Running Tests

```sh
bun run test
```

> **Important:** Use `bun run test`, not `bun test`. The `run` variant is configured in `package.json` to target only the `tests/` directory, avoiding benchmarks.

## Test Structure

Tests mirror the `src/` layout:

```
tests/
  search/
    hybrid-search.test.ts   # tests src/search/hybrid.ts
    find-usages.test.ts     # tests find_usages functionality
    read-relevant.test.ts   # tests chunk-level search
    benchmark.test.ts       # tests benchmark infrastructure
  db/
    ...
  indexing/
    ...
  helpers.ts                 # shared test utilities
  fixtures/                  # sample files for indexing tests
```

## Helpers

`tests/helpers.ts` provides utilities for test isolation:

| Helper | Purpose |
|---|---|
| `createTempDir()` | Creates a temporary directory for a test run |
| `cleanupTempDir()` | Removes the temp directory after the test |
| `indexTestFiles()` | Creates a temp [RagDB](../entities/rag-db.md) instance and indexes fixture files |

Each test gets its own SQLite database in a temp directory, so tests run in full isolation.

## Fixtures

Test fixtures live in `tests/fixtures/`:

| File | Purpose |
|---|---|
| `sample.md` | Standard Markdown file |
| `sample.ts` | Standard TypeScript file |
| `sample.txt` | Plain text file |
| `large.md` | Large Markdown file for chunking boundary tests |
| `frontmatter-only.md` | Edge case -- file with only YAML frontmatter |
| `no-frontmatter.md` | Edge case -- Markdown without frontmatter |

## Test Philosophy

- **Integration-heavy**: Most tests create real [RagDB](../entities/rag-db.md) instances backed by real SQLite databases with real [embeddings](../glossary.md#embedding). There are few mocks.
- The embedding model is loaded once via `getEmbedder()` in `beforeAll` and shared across tests in each file.

## Known Issues

- **Bun crash on macOS Silicon**: Bun may crash during process cleanup after all tests pass ([oven-sh/bun#19917](https://github.com/oven-sh/bun/issues/19917)). This is a Bun runtime bug, not a test failure -- all assertions have already completed by the time the crash occurs.

## See Also

- [Conventions](conventions.md) -- coding standards and the `bun run test` rule
- [Getting Started](getting-started.md) -- project setup and prerequisites
- [Glossary](../glossary.md) -- terminology reference
