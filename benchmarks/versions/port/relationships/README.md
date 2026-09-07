# Cross-file relationship reference

Pinned TS revision: `122674c8bfbbc3549390743f51396c5f0e4e3537`.

`reference.json` records all 107 projects from `tests/source-relationships.test.ts`,
across 26 language/format groups and the mixed-language group. Each case includes
all project paths, Go module metadata, selected source analyses, complete
relationships and unresolved facts, and hashes of every original project file
and relationship golden. Binary assets remain original bytes.

Regenerate from an installed checkout of the pinned TS revision into a new file:

```sh
bun benchmarks/versions/port-relationships-reference.ts /path/to/pinned-v2 /tmp/relationships-reference.json
```

The exporter verifies pinned source, test and renderer hashes. It requires all
107 original relationship goldens to match before writing a capture. Fact,
owner and target offsets convert from TS UTF-16 units to UTF-8 bytes. The
original fixtures and goldens live under `tests/fixtures/ts-v2-relationships`
and `tests/goldens/ts-v2-relationships`.

`tests/unit/ts_v2_source/relationship_projects.rs` compares every project's trees,
facts, typed relationships and original text golden through production Rust.
It also checks all hashes, Go module parsing, SQLite round trips and reversed
file enumeration. Additional assertions cover JS/TS extension precedence and
`.d.ts` fallback using the pinned language registry's order.

Resolution follows the TS rules for local paths, packages, modules, aliases,
re-exports and callable symbols. Ambiguous or unsupported calls stay unresolved.
This is syntax-based resolution, without compiler type checking, dependency
installation, runtime execution or macro expansion. Text/TOML/YAML deliberately
have no semantic relationships. Lua resolves module imports but does not infer
calls through values returned by those modules.

`mimirs relationships` exposes this connector without an index or model.
`--json` includes all fact and target evidence. The command reads current files;
stored single-file facts are available through `mimirs inspect FILE --stored`.
