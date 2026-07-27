# Mimirs

Mimirs is a Bun-first tool for project facts, semantic search, and project memory.

## Repository layout

- `src/cli` contains commands and terminal renderers.
- `src/internals` contains indexing, project, search, source, storage, and embedding code.
- `packages/chunk` contains the `@winci/bun-chunk` workspace package.
- `tests` contains Bun tests, fixtures, goldens, helpers, and integration tests.
- `benchmarks` contains retrieval and performance evaluations.

## Development rules

- Use Bun for package management, scripts, and tests.
- Keep TypeScript in strict mode.
- Include `.ts` extensions in relative imports.
- Preserve byte-exact source ranges and deterministic result order.
- Add or update tests for each behavior change.
- Update fixtures and goldens only when the intended parser output changes.
- Do not edit files below `.mimirs`; Mimirs generates this project state.

## Writing

- Write documentation, comments, plans, and user-facing prose in clear,
  direct technical English.
- Keep commands, identifiers, file names, error messages, and quotations exact.

## Commands

Install dependencies:

```sh
bun install
```

Run all tests:

```sh
bun test
```

Run one test file:

```sh
bun test tests/<name>.test.ts
```

Check TypeScript:

```sh
bunx tsc --noEmit
```

Run the command-line interface:

```sh
bun run analyze .
bun run chunk -f src/internals/source/chunk.ts
bun run index status -d .
bun run search -q "question" -d .
```

Run the real embedding model smoke test only when the change affects model loading:

```sh
bun run test:embedding-model
```

The smoke test can download model files to `~/.cache/mimirs/models`.

## Verification

After a code change, run the smallest relevant test first. Then run:

```sh
bun test
bunx tsc --noEmit
```

For benchmark changes, run the related benchmark and inspect its generated report.

## Commits

- Use Conventional Commits for commit messages.
- Do not commit unless the user asks.
- Do not add co-author or tool-generated trailers.
