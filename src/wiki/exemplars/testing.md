<!-- Exemplar: adapt to this project. Every command must come from the
     actual project (package.json scripts, Makefile, etc.). Every
     directory must exist. Skip sections that don't apply. -->

# Testing

<!-- Reuse section: test-structure. Pulls the test file inventory into
     a table. -->

## Structure

<Short paragraph naming the convention: `*.test.ts` alongside source,
`tests/` mirror of `src/`, etc.>

| Directory | What's tested | Type |
|-----------|---------------|------|
| `<path>` | <short description> | <unit/integration/e2e/benchmark> |

## Running Tests

```sh
# Full suite
<command from package.json>

# Single file
<command with path>

# Watch mode (if available)
<command with --watch or equivalent>
```

## Test Patterns

<!-- adapt: include only patterns observed in actual test files. Shared
     fixtures? Setup helpers? Table-driven tests? Skip if no visible
     pattern. -->

### <Pattern name>

<Description of a pattern used across test files.>

```<lang>
<short example from a real test file>
```

## Test Categories

<!-- adapt: include when the project has genuinely distinct test types
     (different directories, different runners, different commands).
     Collapse into a single "Unit Tests" section when that's all there
     is. -->

### Unit Tests

<What they cover. Where they live. How they're structured.>

### Integration Tests

<What they cover. Dependencies (real DB? external service?). Setup.>

## Coverage

<!-- adapt: include only if coverage tooling is configured (c8,
     istanbul, codecov, etc). -->

<How to generate a coverage report. Coverage targets if defined.>

## See also

- [Conventions](conventions.md)
- [Getting Started](getting-started.md)
