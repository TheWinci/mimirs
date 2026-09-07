# TS v2 coverage review

This review compares the current Rust language-analysis and relationship port
with TS revision `122674c8bfbbc3549390743f51396c5f0e4e3537`.
The [complete map](TEST-MAP.md) gives every archived test a classification,
reason, pinned TS source link, and Rust evidence. Classifications live in
[test-coverage.json](test-coverage.json).

## What the port establishes

The [source-window corpus](source-windows/README.md) preserves all 84 original
fixtures and goldens. Production Rust checks exact trees and windows at the
reviewed target, 80 units and 4,000 units, plus repeatability and BOM/CRLF variants.

The [general chunker corpus](chunker/README.md) preserves all 272 fixtures and
544 original tree/fact goldens. These include every fixture used by the language
fact and JS/TS variant suites. Rust compares the full tree and semantic fact
model, including imports, exports, call bindings, owners, targets and exact
UTF-8 spans. All 272 also pass BOM/CRLF offset checks and complete SQLite round
trips. Native annotation attachment and Dart invocation handling were fixed
where the broader fixtures exposed differences.

The [relationship corpus](relationships/README.md) preserves all 107 projects
and original rendered goldens. Production Rust checks complete resolved and
unresolved imports, re-exports and calls, including resources, aliases, cycles,
ambiguity, Go module paths and mixed-language resolution. Project trees and
facts also match. Saving and loading every project's analyses, or reversing
file enumeration, leaves its relationships unchanged. Additional regressions
pin JS/TS extension precedence and declaration-file fallback.

The model-free `mimirs relationships` command exposes current-project analysis.
It reads selected source files, treats binary resources as paths, and honors
project config. Single-file facts are visible through live and stored inspect.
Corruption tests reject invalid fact spans, owners and call targets both before
writes and after loading a modified payload. Analyzer versions invalidate older
snapshots, so existing projects must run `mimirs index` again.

These are comparisons with the pinned TS implementation, not compiler-level
correctness guarantees. The same conservative limits apply to dynamic receivers,
external packages, ambiguous symbols and macro expansion.

## Remaining applicable test gaps

The map now lists 854 covered cases, 28 missing cases and 132 outside scope,
across 1,014 expanded TS cases in 52 suites. All general chunker, language fact,
variant, source-window, text-chunker and relationship cases have Rust evidence.
The remaining missing cases concern retrieval, indexing, storage and project
lifecycle behavior:

- Later documentation windows, score inheritance and exact qualified-reference
  ranges.
- Retrieval counterexamples involving mixed queries, duplicated boilerplate,
  constants, unusual scores and malformed candidate rows.
- Source persistence batch/page boundaries and nested inference progress.
- Concurrent initialization, project-root/config errors, hidden-path discovery,
  lock replacement and additional storage corruption/recovery scenarios.

Missing means the review does not demonstrate an equivalent regression. It does
not prove that Rust fails that case. These remaining gaps do not require adding
more language extractors or relationship resolvers.

## Contracts outside this port

The user selected language analysis and relationships. Watch/status modes,
mutable project-search sessions, independent fact/relation embedding stores and
optional retrieval policies remain outside that scope. The Rust TOML config,
explicit indexing, saved-source search and schema rebuild policy also differ
from the TS public contracts. The TS combined project report and historical
CLI presentation are not claimed compatible with the Rust commands.

The [retrieval contract](CONTRACT.md) still governs production search. New
semantic facts and cross-file relationships do not add ranking channels.
Older test-only document builders do not establish production input parity.

The existing [four-corpus report](kubernetes/FOUR-CORPUS.md) records matching
382 retrieval rankings and 161,658 vectors at its stated build. This port does
not rerun that benchmark or establish answer correctness.

## Verification

- `cargo test`: 397 passed, 16 ignored by default.
- Explicit cached checks: two native/fallback retrieval lifecycle tests and two
  pinned tokenizer/model parity tests passed.
- `cargo build`, `cargo clippy --all-targets`, `cargo fmt --check` and
  `git diff --check` pass.
- The 29 archived language, variant, text, chunker, window and relationship
  suites pass all 794 TS tests against the pinned source.
- Exporters verify pinned TS source/test hashes and original rendered goldens
  before producing captures. Rust verifies every imported fixture/golden hash.

To check the inventory, classifications, evidence names and generated report:

```sh
python3 benchmarks/versions/port-test-coverage.py --check
```

This checks consistency, not the correctness of the reviewed classifications.
The inventory excludes benchmark scripts and the separate MiniLM smoke script.
