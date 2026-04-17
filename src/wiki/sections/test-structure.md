---
name: test-structure
useWhen: Testing page or any page whose prefetched `testFiles` list has ≥1 entry. Lists the test directories and what lives where — not a full file dump.
---

## Test Structure

<Short paragraph naming the convention: `*.test.ts` alongside source,
`tests/` mirror of `src/`, separate `benchmarks/` directory, etc.>

| Directory | What's tested | Type |
|-----------|---------------|------|
| `<path>` | <short description> | <unit/integration/e2e/benchmark> |
