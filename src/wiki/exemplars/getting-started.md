<!-- Exemplar: adapt to this project. Pull every command from the actual
     package.json / Makefile / shell scripts — do not invent commands.
     If a step is not applicable (e.g. the project has no build step),
     skip it entirely. -->

# Getting Started

<!-- adapt: one paragraph describing what the project is and who should
     read this page — a newcomer opening the repo for the first time. -->

## Prerequisites

<!-- adapt: actual runtime + versions from .nvmrc, .tool-versions,
     package.json engines, go.mod, Cargo.toml, etc. -->

- <runtime> <version> — <why required>
- <tool> — <why required>

## Install

```sh
<install command from package.json / README>
```

## Run

```sh
<primary run command>
```

<!-- adapt: include only commands that actually exist. Omit sections
     that don't apply (no tests? skip Test). -->

## Test

```sh
<test command>

# single file
<test command with path>
```

## Project Layout

<!-- Reuse section: module-inventory. Use the same table the
     architecture page uses, with links to module pages. -->

| Module | Purpose |
|--------|---------|
| [<Name>](../modules/<name>/index.md) | <one-line> |

## Key Concepts

<!-- adapt: 3-5 domain concepts a newcomer should understand first.
     Pull from cross-cutting symbols and module names. Skip this section
     if the domain is self-evident from the module names. -->

- **<Concept>** — <1-sentence definition, linking to the primary page
  where it's documented>.

## Known Issues

<!-- Reuse section: known-issues. Include only real issues surfaced
     from the code or annotations. -->

- **<Issue>** — <symptom + where it's tracked>.

## See also

- [Architecture](../architecture.md)
- [Conventions](conventions.md)
- [Testing](testing.md)
