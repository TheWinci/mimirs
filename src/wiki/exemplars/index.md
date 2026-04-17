<!-- Exemplar: adapt to this project. The index is structural, not
     narrative — assembled from the manifest. Every link must resolve;
     every listed page must actually exist in the manifest. Skip any
     group (Hubs, Key Types, Guides) whose data is empty. -->

# <Project Name>

<!-- adapt: one-line description of what the project does. Not a
     paragraph — one line. -->

<One-line description>

## Quick Links

<!-- adapt: include when the wiki has > 10 pages. Pick the 3-5
     highest-traffic pages for newcomers. -->

- [Getting Started](guides/getting-started.md) — setup and first run
- [Architecture](architecture.md) — high-level system design
- [<top module>](modules/<name>/index.md) — <one-line>

## Architecture & Design

| Page | Description |
|------|-------------|
| [Architecture](architecture.md) | <one-line> |
| [Data Flows](data-flows.md) | <one-line> |

## Modules

<!-- adapt: one row per generated module page. Module names are actual
     directory names, not inventions. -->

| Module | Description |
|--------|-------------|
| [<Name>](modules/<name>/index.md) | <one-line> |

## Guides

<!-- adapt: include only guides that were actually generated (check the
     manifest). Skip the heading if nothing qualifies. -->

| Guide | Description |
|-------|-------------|
| [Getting Started](guides/getting-started.md) | setup and first run |
| [Conventions](guides/conventions.md) | patterns observed across the codebase |
| [Testing](guides/testing.md) | how to run and structure tests |

---

*Generated from <N> indexed files (<M> chunks) on <timestamp>.*
