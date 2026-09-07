# TS v2 test coverage map

Reference revision: `122674c8bfbbc3549390743f51396c5f0e4e3537`. This inventories all 52 archived `.test.ts` suites,
including the chunker fixtures, relationship projects, reviewed windows, and two
source-name projection variants registered by loops. It does not count assertion
calls, benchmarks, or the separate `tests/integration/mini-lm-smoke.ts` script.

There are 1014 expanded test cases: 854 covered,
28 missing, and 132 outside the adopted scope.

These counts describe a reviewed correspondence, not a coverage percentage or a
claim of full TS feature parity. Covered means Rust checks the applicable behavior
with the cited assertions. It does not mean every original assertion was copied.
Missing means the TS case has no equivalent regression test demonstrated here;
it does not prove that Rust fails the case. Mixed tests stay missing when an
applicable part lacks coverage. Outside scope includes real feature gaps and
different public contracts, explained below. It does not mean those features
cannot be added. Tests of retired Rust document builders are identified explicitly
and do not establish production input parity.

The [coverage review](TEST-COVERAGE.md) explains priorities and limits.
Classifications are maintained in [test-coverage.json](test-coverage.json).
Regenerate with `python3 benchmarks/versions/port-test-coverage.py`; use `--check`
to detect stale inventory, evidence names, or rendered output.

| TS suite | Covered | Missing | Outside scope |
| --- | ---: | ---: | ---: |
| [bash-facts.test.ts](#bash-factstestts) | 13 | 0 | 0 |
| [c-facts.test.ts](#c-factstestts) | 9 | 0 | 0 |
| [chunk-cli.test.ts](#chunk-clitestts) | 1 | 0 | 42 |
| [chunker.test.ts](#chunkertestts) | 272 | 0 | 0 |
| [cpp-facts.test.ts](#cpp-factstestts) | 11 | 0 | 0 |
| [csharp-facts.test.ts](#csharp-factstestts) | 11 | 0 | 0 |
| [css-facts.test.ts](#css-factstestts) | 7 | 0 | 0 |
| [dart-facts.test.ts](#dart-factstestts) | 15 | 0 | 0 |
| [document-search.test.ts](#document-searchtestts) | 3 | 4 | 0 |
| [elixir-facts.test.ts](#elixir-factstestts) | 11 | 0 | 0 |
| [fact-embeddings.test.ts](#fact-embeddingstestts) | 0 | 0 | 4 |
| [go-facts.test.ts](#go-factstestts) | 10 | 0 | 0 |
| [haskell-facts.test.ts](#haskell-factstestts) | 14 | 0 | 0 |
| [html-facts.test.ts](#html-factstestts) | 8 | 0 | 0 |
| [index-cli.test.ts](#index-clitestts) | 5 | 0 | 5 |
| [index-config.test.ts](#index-configtestts) | 0 | 0 | 7 |
| [index-progress.test.ts](#index-progresstestts) | 1 | 0 | 1 |
| [index-watch.test.ts](#index-watchtestts) | 0 | 0 | 4 |
| [init-cli.test.ts](#init-clitestts) | 2 | 3 | 9 |
| [java-facts.test.ts](#java-factstestts) | 10 | 0 | 0 |
| [javascript-variants.test.ts](#javascript-variantstestts) | 9 | 0 | 0 |
| [kotlin-facts.test.ts](#kotlin-factstestts) | 11 | 0 | 0 |
| [lexical-search.test.ts](#lexical-searchtestts) | 2 | 1 | 0 |
| [lua-facts.test.ts](#lua-factstestts) | 10 | 0 | 0 |
| [markdown-facts.test.ts](#markdown-factstestts) | 7 | 0 | 0 |
| [ocaml-facts.test.ts](#ocaml-factstestts) | 15 | 0 | 0 |
| [perspective-fusion-production.test.ts](#perspective-fusion-productiontestts) | 0 | 0 | 3 |
| [php-facts.test.ts](#php-factstestts) | 11 | 0 | 0 |
| [project-analysis.test.ts](#project-analysistestts) | 3 | 1 | 7 |
| [project-index-lock.test.ts](#project-index-locktestts) | 2 | 1 | 0 |
| [project-index.test.ts](#project-indextestts) | 4 | 0 | 1 |
| [project-layout.test.ts](#project-layouttestts) | 1 | 2 | 0 |
| [project-search.test.ts](#project-searchtestts) | 2 | 0 | 9 |
| [python-facts.test.ts](#python-factstestts) | 10 | 0 | 0 |
| [relation-embeddings.test.ts](#relation-embeddingstestts) | 0 | 0 | 3 |
| [ruby-facts.test.ts](#ruby-factstestts) | 11 | 0 | 0 |
| [rust-facts.test.ts](#rust-factstestts) | 10 | 0 | 0 |
| [scala-facts.test.ts](#scala-factstestts) | 11 | 0 | 0 |
| [search-cli.test.ts](#search-clitestts) | 7 | 0 | 3 |
| [search-relevance.test.ts](#search-relevancetestts) | 1 | 2 | 0 |
| [search.test.ts](#searchtestts) | 12 | 5 | 6 |
| [source-channel-search.test.ts](#source-channel-searchtestts) | 0 | 0 | 2 |
| [source-embeddings.test.ts](#source-embeddingstestts) | 5 | 5 | 15 |
| [source-index.test.ts](#source-indextestts) | 7 | 2 | 10 |
| [source-relationships.test.ts](#source-relationshipstestts) | 108 | 0 | 0 |
| [source-search-candidates.test.ts](#source-search-candidatestestts) | 2 | 2 | 1 |
| [source-windows.test.ts](#source-windowstestts) | 162 | 0 | 0 |
| [text-chunker.test.ts](#text-chunkertestts) | 6 | 0 | 0 |
| [toml-facts.test.ts](#toml-factstestts) | 2 | 0 | 0 |
| [typescript-variants.test.ts](#typescript-variantstestts) | 7 | 0 | 0 |
| [yaml-facts.test.ts](#yaml-factstestts) | 3 | 0 | 0 |
| [zig-facts.test.ts](#zig-factstestts) | 10 | 0 | 0 |

## bash-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

**native-structure**: Rust has explicit structural ownership/name/span checks for this behavior, supplemented by the archived source-window trees. This classification covers the structural assertion, not TS resolved fact fields. Evidence: [native_languages_match_pinned_ts_chunks](../../../tests/unit/native_languages.rs), [check](../../../tests/unit/ts_v2_source/reviewed.rs), [bash_environment_bindings_are_not_persistent_declarations](../../../tests/unit/native_languages.rs), [html_void_tags_do_not_swallow_the_following_elements](../../../tests/unit/native_languages.rs), [lua_assignments_methods_and_function_fields_keep_written_names](../../../tests/unit/native_languages.rs), [zig_containers_tests_and_errors_keep_distinct_names](../../../tests/unit/native_languages.rs), [ocaml_interfaces_bindings_and_functions_use_the_selected_grammar](../../../tests/unit/native_languages.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [treats only literal source commands as imports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L23) | covered | facts |
| [targets prior and recursive functions without resolving PATH calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L38) | covered | facts |
| [binds dynamic commands to prior shell variables](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L52) | covered | facts |
| [owns substitution calls by variables and excludes environment prefixes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L63) | covered | facts |
| [distinguishes readonly declarations from mutable assignments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L74) | covered | native-structure |
| [preserves every executable command in pipelines and control flow](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L89) | covered | facts |
| [routes the .bash extension through the reviewed implementation](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L103) | covered | facts |
| [does not fabricate Bash export facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L111) | covered | facts |
| [BASH-L1 binds loop variables and declaration commands in shell scope](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L119) | covered | facts |
| [BASH-L2 preserves branch bindings and isolates child-process mutations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L139) | covered | facts |
| [BASH-E1 treats literal source as a dependency only before function shadowing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L153) | covered | facts |
| [BASH-L3 follows unconditional function order without leaking branch definitions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L165) | covered | facts |
| [BASH-E2 keeps static command and expanded-variable namespaces distinct](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/bash-facts.test.ts#L181) | covered | facts |

## c-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves system, local, and conditional include spelling](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/c-facts.test.ts#L18) | covered | facts |
| [targets visible prototypes and function definitions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/c-facts.test.ts#L31) | covered | facts |
| [binds parameters, local pointers, global pointers, and member roots](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/c-facts.test.ts#L50) | covered | facts |
| [targets function-like and object-like macros without expansion](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/c-facts.test.ts#L65) | covered | facts |
| [keeps initializer ownership and function-pointer calls precise](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/c-facts.test.ts#L79) | covered | facts |
| [does not fabricate export facts from C linkage](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/c-facts.test.ts#L96) | covered | facts |
| [scopes for initializers and nested blocks without leaking bindings](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/c-facts.test.ts#L100) | covered | facts |
| [respects declaration timing, reassignment, and direct binding forms](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/c-facts.test.ts#L117) | covered | facts |
| [keeps conditional macro definitions branch-local](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/c-facts.test.ts#L140) | covered | facts |

## chunk-cli.test.ts

**chunk-cli**: The TS chunk/analyze commands, JSON and source-facts/tree renderers, and configurable window flags are not the Rust CLI contract. Rust has inspect and inspect --source-chunks. The underlying source-window behavior is covered separately; the TS CLI output is not claimed compatible. Evidence: [src/main.rs](../../../src/main.rs), [tests/inspect.rs](../../../tests/inspect.rs).

**missing-file**: Rust exercises missing-file errors through source reading and inspect CLI behavior, including retaining the path and avoiding project state writes. Evidence: [missing_file_error_names_the_path_and_retains_the_cause](../../../tests/unit/source.rs), [inspection_needs_no_project_and_does_not_write](../../../tests/inspect.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [prints chunk JSON](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L123) | outside scope | chunk-cli |
| [prints the reviewed tree](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L136) | outside scope | chunk-cli |
| [prints the reviewed source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L147) | outside scope | chunk-cli |
| [prints the reviewed source-window tree](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L158) | outside scope | chunk-cli |
| [prints reviewed JavaScript source windows](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L183) | outside scope | chunk-cli |
| [prints reviewed Python source windows](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L208) | outside scope | chunk-cli |
| [prints reviewed Go source windows](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L233) | outside scope | chunk-cli |
| [prints reviewed Batch 1 source windows](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L258) | outside scope | chunk-cli |
| [prints reviewed Batch 2 source windows](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L287) | outside scope | chunk-cli |
| [prints reviewed Batch 3 source windows](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L316) | outside scope | chunk-cli |
| [prints reviewed Batch 4 source windows](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L345) | outside scope | chunk-cli |
| [prints reviewed Batch 5 source-window variants](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L374) | outside scope | chunk-cli |
| [requires source-window options to be internally consistent](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L403) | outside scope | chunk-cli |
| [keeps the reviewed AST extension gate in lockstep with the chunker](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L436) | outside scope | chunk-cli |
| [prints reviewed JavaScript source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L454) | outside scope | chunk-cli |
| [prints reviewed Python source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L465) | outside scope | chunk-cli |
| [prints reviewed Go source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L476) | outside scope | chunk-cli |
| [prints reviewed Rust source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L487) | outside scope | chunk-cli |
| [prints reviewed Java source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L498) | outside scope | chunk-cli |
| [prints reviewed C source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L509) | outside scope | chunk-cli |
| [prints reviewed C++ source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L520) | outside scope | chunk-cli |
| [prints reviewed C# source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L538) | outside scope | chunk-cli |
| [prints reviewed Ruby source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L549) | outside scope | chunk-cli |
| [prints reviewed PHP source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L560) | outside scope | chunk-cli |
| [prints reviewed Scala source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L571) | outside scope | chunk-cli |
| [prints reviewed Kotlin source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L582) | outside scope | chunk-cli |
| [prints reviewed Lua source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L593) | outside scope | chunk-cli |
| [prints reviewed Zig source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L604) | outside scope | chunk-cli |
| [prints reviewed Elixir source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L615) | outside scope | chunk-cli |
| [prints reviewed Bash source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L626) | outside scope | chunk-cli |
| [prints reviewed Haskell source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L637) | outside scope | chunk-cli |
| [prints reviewed OCaml source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L648) | outside scope | chunk-cli |
| [prints reviewed Dart source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L659) | outside scope | chunk-cli |
| [prints reviewed HTML source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L670) | outside scope | chunk-cli |
| [prints reviewed CSS source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L681) | outside scope | chunk-cli |
| [prints the reviewed absence of TOML source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L692) | outside scope | chunk-cli |
| [prints the reviewed absence of YAML source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L710) | outside scope | chunk-cli |
| [prints reviewed Markdown source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L728) | outside scope | chunk-cli |
| [prints the reviewed absence of plain-text source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L739) | outside scope | chunk-cli |
| [reports a missing file](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L757) | covered | missing-file |
| [prints the reviewed project analysis](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L767) | outside scope | chunk-cli |
| [prints the reviewed all-language project analysis](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L780) | outside scope | chunk-cli |
| [reports a missing project directory](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunk-cli.test.ts#L793) | outside scope | chunk-cli |

## chunker.test.ts

**trees**: All 272 original general chunker fixtures and both original goldens are preserved with SHA-256 checks. Production Rust compares every tree node and complete fact array with the pinned TS capture, including parent indices and byte/line spans. Evidence: [check](../../../tests/unit/ts_v2_source/chunker.rs), [facts](../../../tests/unit/ts_v2_source/chunker.rs), [imported_chunker_fixtures_and_both_goldens_keep_their_original_hashes](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [bash/bindings.sh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [bash/control.sh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [bash/extension.bash](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [bash/functions.sh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [bash/imports.sh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [bash/overrides.sh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [bash/scope.sh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [bash/source-shadowing.sh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [bash/variables.sh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/api.h](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/comments.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/conditional-macros.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/control-flow.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/declarations.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/functions.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/includes.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/macros.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/scope.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/shadowing.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [c/types.c](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/api.hpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/calls.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/classes.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/comments.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/conditional-macros.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/control-flow.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/functions.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/preprocessor.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/shadowing.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/templates.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [cpp/types.cpp](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/bindings.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/comments.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/control-flow.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/imports.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/members.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/namespaces.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/overloads.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/primary-constructors.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/scope.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/shadowing.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [csharp/types.cs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [css/assets.css](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [css/at-rules.css](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [css/dynamic.css](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [css/image-set.css](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [css/imports.css](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [css/selectors.css](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/calls.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/combinators.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/comments.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/constructors.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/control-flow.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/functions.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/modern.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/modules.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/part.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/scope.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/shadowing.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [dart/types.dart](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/calls.ex](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/comments.ex](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/control-flow.ex](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/definitions.ex](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/filters.ex](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/imports.ex](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/protocols.ex](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/scope.ex](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/script-scope.exs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [elixir/script.exs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/comments.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/control-flow.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/declarations.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/functions.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/generic-bindings.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/generics.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/imports.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/method-expressions.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/methods.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/scope.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/shadowing.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [go/types.go](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/comments.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/declarations.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/equations.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/functions.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/import-details.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/imports.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/patterns.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/scope.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/shadowing.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/types.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [haskell/where.hs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [html/assets.html](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [html/comments.htm](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [html/document.html](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [html/dynamic.html](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [html/responsive.html](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [html/templates.html](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/classes.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/comments.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/control-flow.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/fields.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/imports.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/methods.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/module-info.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/package-info.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/references.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/scope.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/shadowing.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [java/types.java](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/class-fields.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/classes.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/comments.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/commonjs-chained.cjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/commonjs-exports.cjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/commonjs-reexport.cjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/commonjs-shadowing.cjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/commonjs.cjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/component.jsx](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/default-class.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/default-function.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/default.cjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/esm-module.mjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/function-expressions.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/functions.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/jsx-expressions.jsx](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/modules.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/namespace-export.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [javascript/nesting.js](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [kotlin/comments.kt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [kotlin/control-flow.kt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [kotlin/functions.kt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [kotlin/imports.kt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [kotlin/scope.kt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [kotlin/script-scope.kts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [kotlin/script.kts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [kotlin/shadowing.kt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [kotlin/types.kt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [lua/calls.lua](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [lua/comments.lua](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [lua/control-flow.lua](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [lua/functions.lua](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [lua/loaders.lua](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [lua/modules.lua](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [lua/scope.lua](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [lua/tables.lua](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [markdown/code-links.md](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [markdown/fences.md](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [markdown/headings.markdown](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [markdown/links.md](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [markdown/plain.md](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [markdown/references.md](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [markdown/structure.md](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/bindings.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/calls.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/classes.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/comments.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/functions.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/interface-modules.mli](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/interface.mli](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/module-shadowing.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/modules.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/patterns.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/scope.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/types.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ocaml/visibility.ml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [php/calls.php](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [php/captures.php](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [php/comments.php](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [php/control-flow.php](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [php/functions.php](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [php/imports.php](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [php/members.php](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [php/namespaces.php](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [php/types.php](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/class-fields.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/classes.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/comments.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/conditional-imports.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/evaluation-scope.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/functions.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/imports.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/lexical-bindings.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/nesting.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/patterns-and-walrus.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/rebindings.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/scope.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/stubs.pyi](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [python/type-checking.py](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/calls.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/classes.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/closures.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/comments.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/control_flow.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/imports.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/loaders.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/methods.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/operators.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/redefinitions.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/scope.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [ruby/syntax.rb](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/associated.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/comments.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/control-flow.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/extern-crates.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/functions.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/generics.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/imports.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/macros.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/modules.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/scope.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/shadowing.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/traits.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [rust/types.rs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/calls.scala](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/comments.scala](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/control-flow.scala](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/functions.scala](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/imports.scala](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/packages.scala](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/scala3.scala](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/scope.scala](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/script-scope.sc](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/script.sc](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [scala/types.scala](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [text/paragraphs.txt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [text/semantic-traps.txt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [text/single-line.log](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [text/whitespace.txt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [toml/arrays.toml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [toml/comments.toml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [toml/document.toml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [toml/quoted-keys.toml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [toml/semantic-traps.toml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [toml/values.toml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/blocks.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/classes.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/comments.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/commonjs-chained.cts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/commonjs-exports.cts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/commonjs-reexport.cts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/commonjs-shadowing.cts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/commonjs.cts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/component.tsx](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/declarations.d.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/default-class.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/default-function.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/esm-module.mts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/functions.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/jsx-expressions.tsx](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/modules.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/nesting.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/overloads.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/syntax-traps.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [typescript/types.ts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [yaml/anchors.yaml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [yaml/comments.yaml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [yaml/document.yaml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [yaml/documents.yml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [yaml/flow.yaml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [yaml/scalars.yaml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [yaml/semantic-traps.yaml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [yaml/sequences.yaml](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [zig/control-flow.zig](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [zig/functions.zig](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [zig/imports.zig](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [zig/resources.zig](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [zig/scope.zig](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [zig/shadowing.zig](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [zig/tests.zig](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |
| [zig/types.zig](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/chunker.test.ts#L169) | covered | trees |

## cpp-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves includes and respects macro undefinition](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L18) | covered | facts |
| [projects namespace aliases and using declarations without resolving wildcards](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L28) | covered | facts |
| [binds parameters, members, overload sets, lambdas, and local types](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L43) | covered | facts |
| [resolves free functions and namespace-scope callable variables](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L69) | covered | facts |
| [prefers an exact template specialization](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L84) | covered | facts |
| [targets same-file classes from out-of-class method definitions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L93) | covered | facts |
| [does not fabricate export facts from C++ linkage](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L109) | covered | facts |
| [CXX-L1 scopes control-flow declarations and patterns without leaks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L113) | covered | facts |
| [CXX-L2 respects timing, reassignment, grouped declarations, and negatives](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L146) | covered | facts |
| [CXX-L3 keeps conditional macro definitions branch-local](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L169) | covered | facts |
| [CXX-G1 pins the bundled grammar's C++20 module recovery gap](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/cpp-facts.test.ts#L182) | covered | facts |

## csharp-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves global, static, alias, and namespace using forms](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L18) | covered | facts |
| [binds parameters, fields, aliases, local functions, lambdas, and local types](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L38) | covered | facts |
| [assigns calls in accessors, constructors, destructors, and operators](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L67) | covered | facts |
| [keeps namespace aliases owned by their declaration scope](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L85) | covered | facts |
| [binds class and record primary-constructor parameters](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L95) | covered | facts |
| [does not assign an arbitrary target to an overload set](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L107) | covered | facts |
| [does not fabricate export facts from C# accessibility](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L115) | covered | facts |
| [CS-L1 scopes loops, resources, catches, and patterns without leaks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L119) | covered | facts |
| [CS-L2 handles deconstruction, out variables, query ranges, and extern aliases](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L152) | covered | facts |
| [CS-L3 respects declaration order, grouped declarations, and block scope](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L187) | covered | facts |
| [CS-E1 keeps method groups non-executable](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/csharp-facts.test.ts#L218) | covered | facts |

## css-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves string and url stylesheet imports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/css-facts.test.ts#L20) | covered | facts |
| [preserves static declaration resources and their selector owners](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/css-facts.test.ts#L33) | covered | facts |
| [owns font resources by the enclosing at-rule](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/css-facts.test.ts#L49) | covered | facts |
| [rejects variables, fragments, data URIs, and non-resource functions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/css-facts.test.ts#L58) | covered | facts |
| [does not treat namespace URIs or CSS functions as calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/css-facts.test.ts#L62) | covered | facts |
| [does not fabricate CSS export facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/css-facts.test.ts#L73) | covered | facts |
| [CSS-E1 preserves direct and URL image-set candidates](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/css-facts.test.ts#L81) | covered | facts |

## dart-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

**native-structure-missing**: The original Dart constructors fixture now checks the entire tree and facts, including factories, getters and setters. Dart annotation attachments also match TS. Evidence: [check](../../../tests/unit/ts_v2_source/chunker.rs), [dart_facts](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves imports, prefixes, conditional alternatives, exports, and parts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L24) | covered | facts |
| [binds import prefixes without guessing unprefixed libraries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L54) | covered | facts |
| [keeps fields, constructors, accessors, and methods distinct](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L62) | covered | native-structure-missing |
| [targets same-file constructors through their class chunk](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L80) | covered | facts |
| [targets named top-level closures and local functions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L88) | covered | facts |
| [binds parameters and closure captures without inventing missing names](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L104) | covered | facts |
| [preserves null-aware, chained, nested, and cascade call spelling](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L117) | covered | facts |
| [does not resolve an external constructor from spelling alone](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L139) | covered | facts |
| [excludes constructor-style annotations from runtime calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L147) | covered | facts |
| [emits exports only for explicit library export directives](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L153) | covered | facts |
| [DART-L1 scopes loops, catches, destructuring, and patterns without leaks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L159) | covered | facts |
| [DART-L2 respects initializer timing, reassignment, nested scope, and write negatives](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L199) | covered | facts |
| [DART-E1 applies ordered show/hide combinators to explicit names](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L216) | covered | facts |
| [DART-E2 covers extension types, dot shorthands, and generic calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L240) | covered | facts |
| [DART-S1 retains deferred and hide-only dependencies conservatively](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/dart-facts.test.ts#L264) | covered | facts |

## document-search.test.ts

**doc-explicit**: Strict reference extraction rejects bare symbols and external URLs and retains explicit paths and qualified symbols. Evidence: [strict_reference_forms_do_not_guess_bare_symbols_or_outside_files](../../../tests/unit/storage/hybrid.rs).

**doc-later**: No equivalent regression demonstrates a reference beyond the preview in a lower-ranked document window, best-document-score inheritance from that window, or reference expansion across every aggregated document window. Existing segmentation fixtures cover simpler inputs. Evidence: [document_segmentation_matches_ts_on_equivalent_windows](../../../tests/unit/storage/hybrid.rs), [documentation_is_a_separate_segment_with_exact_reference_evidence](../../../tests/unit/commands/search.rs).

**doc-range**: Rust checks that qualified references have a source range, but does not pin this TS case's exact qualified-definition span. An exact-range regression is still needed. Evidence: [qualified_modules_and_unresolved_reference_caps_follow_ts_policy](../../../tests/unit/storage/hybrid.rs).

**doc-cap**: The command test requests one source result and separately asserts the documentation segment and exact saved reference evidence. Evidence: [documentation_is_a_separate_segment_with_exact_reference_evidence](../../../tests/unit/commands/search.rs).

**doc-active**: References resolve only indexed sources and disappear after invalidation; deleted on-disk content does not replace the saved evidence. Search uses the persisted snapshot rather than TS live discovery. Evidence: [references_only_resolve_indexed_sources_and_preserve_snapshot_evidence](../../../tests/unit/storage/hybrid.rs), [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

| TS test | Status | Assessment |
| --- | --- | --- |
| [extracts only explicit paths and qualified symbols](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/document-search.test.ts#L85) | covered | doc-explicit |
| [reads full document windows when previews omit a reference](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/document-search.test.ts#L95) | missing | doc-later |
| [inherits the document's best score from a lower-ranked cited window](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/document-search.test.ts#L130) | missing | doc-later |
| [returns an exact definition range for a qualified symbol](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/document-search.test.ts#L166) | missing | doc-range |
| [public search keeps docs outside the requested source cap](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/document-search.test.ts#L205) | covered | doc-cap |
| [public search resolves references from every aggregated document window](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/document-search.test.ts#L234) | missing | doc-later |
| [does not resolve references outside the active project paths](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/document-search.test.ts#L290) | covered | doc-active |

## elixir-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves aliases, grouped aliases, imports, requires, and uses](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L24) | covered | facts |
| [binds aliases, selected imports, and required modules](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L41) | covered | facts |
| [targets direct functions without choosing an overloaded clause](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L57) | covered | facts |
| [binds function, anonymous-function, and remote receiver variables](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L70) | covered | facts |
| [excludes definition heads and calls inside type attributes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L90) | covered | facts |
| [does not fabricate Elixir export facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L99) | covered | facts |
| [EX-L1 binds assignment, case, and receive patterns without leaking](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L105) | covered | facts |
| [EX-L2 keeps with and comprehension binders ordered and local](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L116) | covered | facts |
| [EX-L3 keeps named closure targets until direct rebinding and ignores captures](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L130) | covered | facts |
| [EX-E1 retains only and except filters while binding selected imports only](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L138) | covered | facts |
| [EXS-L1 applies explicit script scope without host assumptions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/elixir-facts.test.ts#L158) | covered | facts |

## fact-embeddings.test.ts

**perspectives**: Independent fact/relation embedding stores, optional perspective fusion, and public per-channel search APIs were not adopted. Production ordering uses source windows and documentation reference expansion. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

| TS test | Status | Assessment |
| --- | --- | --- |
| [materializes, incrementally embeds, and searches facts with provenance](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/fact-embeddings.test.ts#L32) | outside scope | perspectives |
| [invalidates only changed or removed files and resets a changed space](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/fact-embeddings.test.ts#L92) | outside scope | perspectives |
| [validates independent fact-search requests](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/fact-embeddings.test.ts#L125) | outside scope | perspectives |
| [accepts persisted structural chunks that project to no source window](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/fact-embeddings.test.ts#L141) | outside scope | perspectives |

## go-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [resolves parameters and local closures](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L18) | covered | facts |
| [does not guess default or dot-import package bindings](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L29) | covered | facts |
| [resolves receiver and package-level function bindings](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L50) | covered | facts |
| [targets named types used as conversions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L66) | covered | facts |
| [resolves instantiated generic functions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L80) | covered | facts |
| [keeps grouped declaration ownership precise](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L89) | covered | facts |
| [GO-L1 scopes control-flow bindings without leaking them](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L97) | covered | facts |
| [GO-L2 respects declaration timing, rebinding, and block boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L134) | covered | facts |
| [GO-L3 binds function, receiver, and local type names](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L164) | covered | facts |
| [GO-E1 targets explicit method expressions without inferring method calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/go-facts.test.ts#L184) | covered | facts |

## haskell-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves qualified, explicit, hiding, and open imports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L29) | covered | facts |
| [binds qualified aliases and explicit imported functions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L44) | covered | facts |
| [records only the outer call for curried application](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L54) | covered | facts |
| [targets recursion and keeps infix operators as calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L59) | covered | facts |
| [binds parameters and recursive let functions with exact ownership](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L72) | covered | facts |
| [does not choose one equation as the target of a multi-equation function](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L86) | covered | facts |
| [targets functions declared in recursive where bindings](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L101) | covered | facts |
| [targets constructors from their explicit local type declarations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L108) | covered | facts |
| [does not choose a typeclass implementation for an unqualified call](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L122) | covered | facts |
| [does not fabricate export facts from Haskell declarations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L129) | covered | facts |
| [HS-L1 scopes case, let, do, and comprehension patterns without leaks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L135) | covered | facts |
| [HS-E1 retains nested import members, operators, and hiding names](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L145) | covered | facts |
| [HS-E2 targets local constructors and generated field selectors](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L177) | covered | facts |
| [HS-L2 lets local declarations shadow imports without choosing equations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/haskell-facts.test.ts#L191) | covered | facts |

## html-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

**native-structure**: Rust has explicit structural ownership/name/span checks for this behavior, supplemented by the archived source-window trees. This classification covers the structural assertion, not TS resolved fact fields. Evidence: [native_languages_match_pinned_ts_chunks](../../../tests/unit/native_languages.rs), [check](../../../tests/unit/ts_v2_source/reviewed.rs), [bash_environment_bindings_are_not_persistent_declarations](../../../tests/unit/native_languages.rs), [html_void_tags_do_not_swallow_the_following_elements](../../../tests/unit/native_languages.rs), [lua_assignments_methods_and_function_fields_keep_written_names](../../../tests/unit/native_languages.rs), [zig_containers_tests_and_errors_keep_distinct_names](../../../tests/unit/native_languages.rs), [ocaml_interfaces_bindings_and_functions_use_the_selected_grammar](../../../tests/unit/native_languages.rs).

**extension-dispatch**: All archived native extensions have fixture evidence and dispatch through the production native analyzer, with exact expected source chunks. Evidence: [every_archived_fixture_and_golden_is_checked_without_changes](../../../tests/unit/ts_v2_source/reviewed.rs), [check](../../../tests/unit/ts_v2_source/reviewed.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves scripts, stylesheets, preloads, and image resources](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/html-facts.test.ts#L20) | covered | facts |
| [preserves media, embedded-document, object, and SVG asset references](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/html-facts.test.ts#L35) | covered | facts |
| [does not invent dependencies for templates, data URIs, navigation, or forms](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/html-facts.test.ts#L52) | covered | facts |
| [does not parse inline script or style text as HTML calls or imports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/html-facts.test.ts#L56) | covered | facts |
| [keeps void and self-closing elements on their actual line](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/html-facts.test.ts#L64) | covered | native-structure |
| [routes the .htm extension through reviewed HTML support](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/html-facts.test.ts#L78) | covered | extension-dispatch |
| [does not fabricate HTML export facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/html-facts.test.ts#L82) | covered | facts |
| [HTML-E1 preserves responsive candidates, rel tokens, and SVG resources](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/html-facts.test.ts#L90) | covered | facts |

## index-cli.test.ts

**index-cli-contract**: Watch/status modes, project-selection arguments, and durable generation-status manifests are absent from the Rust command contract. One-shot indexing and its failures have separate Rust tests. Evidence: [src/main.rs](../../../src/main.rs), [tests/unit/commands/index.rs](../../../tests/unit/commands/index.rs).

**index-init**: Missing configuration and malformed config fail before model creation or database mutation. The CLI requires init to create project state. Evidence: [config_errors_precede_model_creation_and_database_changes](../../../tests/unit/commands/index.rs), [load_reports_a_missing_file](../../../tests/unit/config.rs).

**index-reuse**: Rust verifies initial indexing, reopening/reuse, changed-source replacement, and deletion across the supported language union. Evidence: [the_language_union_shares_reuse_replacement_and_failed_cleanup](../../../tests/unit/commands/index.rs), [reuse_skips_parsing_and_inference_and_preserves_rows](../../../tests/unit/commands/index.rs).

**index-progress**: Rust checks one-shot progress, completed/reused work, redirected output, and terminal updates. Output formatting and progress cadence follow the Rust contract rather than TS text goldens. Evidence: [redirected_output_and_stored_relationships_match_the_contract](../../../tests/unit/commands/index.rs), [batches_update_only_terminal_progress](../../../tests/unit/commands/index.rs), [terminal_redraws_preserve_diagnostics_and_round_elapsed_seconds](../../../tests/unit/commands/index/progress.rs).

**writer-lock**: Rust uses an OS lock to exclude concurrent writers and release ownership on exit. Tests exercise contention in one process and a killed child process. TS malformed lock-file reclamation is not applicable to this mechanism. Evidence: [lock_excludes_another_writer_and_releases_with_its_owner](../../../tests/unit/commands/index/lock.rs), [killed_writer_releases_the_os_lock](../../../tests/unit/commands/index/lock.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [parses one-shot, watch, status, and optional project selection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L150) | outside scope | index-cli-contract |
| [routes one-shot, watch, and status without source mutations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L168) | outside scope | index-cli-contract |
| [rejects removed, duplicate, and invalid command shapes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L201) | outside scope | index-cli-contract |
| [requires init before indexing and leaves missing state absent](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L218) | covered | index-init |
| [indexes incrementally without changing the configured source](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L227) | covered | index-reuse |
| [reports file and embedding progress during a one-shot index](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L254) | covered | index-progress |
| [renders a durable refresh summary with changed and reused work](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L275) | covered | index-progress |
| [does not write behind another indexing writer](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L333) | covered | writer-lock |
| [persists a failed initial generation for status](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L352) | outside scope | index-cli-contract |
| [reports active writer state separately from the persisted generation](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-cli.test.ts#L378) | outside scope | index-cli-contract |

## index-config.test.ts

**config-contract**: TS JSON configuration, absolute source fields, canonical project selection, omitted-field inheritance, and unknown-field rules differ from Rust's project-local TOML config. This is a contract difference, not config compatibility coverage. Evidence: [src/config.rs](../../../src/config.rs), [src/main.rs](../../../src/main.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [atomically materializes absolute project defaults once](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-config.test.ts#L50) | outside scope | config-contract |
| [uses in-memory defaults without pretending the project was initialized](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-config.test.ts#L65) | outside scope | config-contract |
| [inherits omitted fields while retaining the absolute source](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-config.test.ts#L75) | outside scope | config-contract |
| [normalizes glob separators without rewriting the source path](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-config.test.ts#L90) | outside scope | config-contract |
| [rejects malformed JSON and unknown fields](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-config.test.ts#L113) | outside scope | config-contract |
| [requires exactly one absolute source matching the project](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-config.test.ts#L123) | outside scope | config-contract |
| [accepts a symlink alias and returns its canonical source path](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-config.test.ts#L147) | outside scope | config-contract |

## index-progress.test.ts

**index-progress**: Rust checks one-shot progress, completed/reused work, redirected output, and terminal updates. Output formatting and progress cadence follow the Rust contract rather than TS text goldens. Evidence: [redirected_output_and_stored_relationships_match_the_contract](../../../tests/unit/commands/index.rs), [batches_update_only_terminal_progress](../../../tests/unit/commands/index.rs), [terminal_redraws_preserve_diagnostics_and_round_elapsed_seconds](../../../tests/unit/commands/index/progress.rs).

**progress-cadence**: The TS ten-percent redirected milestone policy is not the Rust output contract. Rust tests its phase/completion output and terminal redraws separately. Evidence: [redirected_output_and_stored_relationships_match_the_contract](../../../tests/unit/commands/index.rs), [src/commands/index/progress.rs](../../../src/commands/index/progress.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [renders all indexing and embedding phases in place for terminals](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-progress.test.ts#L21) | covered | index-progress |
| [emits only phase changes, ten-percent milestones, and completion when redirected](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-progress.test.ts#L67) | outside scope | progress-cadence |

## index-watch.test.ts

**index-cli-contract**: Watch/status modes, project-selection arguments, and durable generation-status manifests are absent from the Rust command contract. One-shot indexing and its failures have separate Rust tests. Evidence: [src/main.rs](../../../src/main.rs), [tests/unit/commands/index.rs](../../../tests/unit/commands/index.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [production observer reports source and config changes but ignores state writes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-watch.test.ts#L57) | outside scope | index-cli-contract |
| [coalesces bursts and runs one follow-up for events during refresh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-watch.test.ts#L110) | outside scope | index-cli-contract |
| [indexes, watches one source root, reconciles a change, and shuts down](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-watch.test.ts#L134) | outside scope | index-cli-contract |
| [keeps the last generation when config becomes invalid and recovers](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/index-watch.test.ts#L199) | outside scope | index-cli-contract |

## init-cli.test.ts

**init-contract**: The TS interactive index prompt, explicit project/source arguments, package script registration, canonical source field, and root-ignore editing are not Rust init behavior. Rust creates .mimirs state and prepares the model. Evidence: [src/commands/init.rs](../../../src/commands/init.rs), [src/main.rs](../../../src/main.rs).

**init-preserve**: Repeated init preserves existing config and stored database data; initial init checks the local ignore policy. Evidence: [first_init_creates_the_project_files_and_database](../../../tests/unit/commands/init.rs), [repeated_init_preserves_config_and_database_data](../../../tests/unit/commands/init.rs).

**init-concurrent**: No concurrent-init regression exists. Existing tests cover sequential idempotence only. Evidence: [repeated_init_preserves_config_and_database_data](../../../tests/unit/commands/init.rs).

**init-invalid**: Missing/file project roots and reporting an invalid existing config have no equivalent Rust init regression. Rust currently preserves edited config without validating it during init; test and define that contract explicitly. Evidence: [src/commands/init.rs](../../../src/commands/init.rs), [tests/unit/commands/init.rs](../../../tests/unit/commands/init.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [parses the current or explicitly selected project directory](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L73) | outside scope | init-contract |
| [renders the local next command without repeating the project path](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L81) | outside scope | init-contract |
| [runs the normal index flow when the user accepts the prompt](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L101) | outside scope | init-contract |
| [prints the next command when the user declines indexing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L123) | outside scope | init-contract |
| [rejects source arguments, external state, and duplicate options](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L139) | outside scope | init-contract |
| [creates only project-local initialization state with an absolute source](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L161) | outside scope | init-contract |
| [canonicalizes a symlinked project in the generated config](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L188) | outside scope | init-contract |
| [is idempotent and preserves existing config and ignore policy](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L203) | covered | init-preserve |
| [handles root ignore syntax and a missing final newline](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L226) | outside scope | init-contract |
| [initializes safely under concurrent calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L240) | missing | init-concurrent |
| [does not create state for a missing project or file path](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L256) | missing | init-invalid |
| [preserves and reports an invalid existing config](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L270) | missing | init-invalid |
| [makes the complete local state directory Git-ignored](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L283) | covered | init-preserve |
| [is registered in the package script and top-level CLI](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/init-cli.test.ts#L294) | outside scope | init-contract |

## java-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves regular, wildcard, and static import forms](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L18) | covered | facts |
| [keeps Java method and value namespaces distinct](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L40) | covered | facts |
| [targets local lambdas and binds their parameters](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L59) | covered | facts |
| [avoids arbitrary targets for overloads while resolving unique methods](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L76) | covered | facts |
| [binds implicit compact-constructor parameters](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L91) | covered | facts |
| [does not fabricate export facts from Java visibility](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L99) | covered | facts |
| [JAVA-L1 scopes loops, resources, catches, and patterns without leaks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L103) | covered | facts |
| [JAVA-L2 respects declaration order, grouped declarations, and block scope](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L139) | covered | facts |
| [JAVA-E1 preserves JPMS requires modifiers without inventing module exports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L170) | covered | facts |
| [JAVA-E2 keeps references non-executable and owns anonymous-class calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/java-facts.test.ts#L187) | covered | facts |

## javascript-variants.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves ESM imports, exports, and calls in .mjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/javascript-variants.test.ts#L19) | covered | facts |
| [keeps JSX tags structural while retaining expression calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/javascript-variants.test.ts#L29) | covered | facts |
| [JSX-E1 preserves calls in every reviewed JSX expression context](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/javascript-variants.test.ts#L44) | covered | facts |
| [models literal CommonJS requires and named exports in .cjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/javascript-variants.test.ts#L62) | covered | facts |
| [models module.exports as a CommonJS default export](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/javascript-variants.test.ts#L96) | covered | facts |
| [CJS-E1/E2 covers selected requires and explicit object exports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/javascript-variants.test.ts#L105) | covered | facts |
| [CJS-E2 covers chained and statically computed exports without guessing dynamic APIs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/javascript-variants.test.ts#L138) | covered | facts |
| [CJS-E3 represents whole-module re-exports as named and default forwarding](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/javascript-variants.test.ts#L165) | covered | facts |
| [CJS-L1 suppresses dependencies and exports for shadowed or reassigned globals](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/javascript-variants.test.ts#L177) | covered | facts |

## kotlin-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves direct, aliased, and wildcard imports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L18) | covered | facts |
| [targets same-file functions, types, and named lambdas](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L38) | covered | facts |
| [binds function, lambda, and constructor parameters locally](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L54) | covered | facts |
| [owns calls inside methods, fields, constructors, and companions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L80) | covered | facts |
| [does not double-count trailing lambdas or treat annotations as calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L94) | covered | facts |
| [does not fabricate Kotlin export facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L109) | covered | facts |
| [KT-L1 scopes loops, catches, destructuring, when subjects, and anonymous parameters](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L115) | covered | facts |
| [KT-L2 respects initializer timing, reassignment, nested scope, and write negatives](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L145) | covered | facts |
| [KTS-L1 applies explicit lexical scope without assuming a script host](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L162) | covered | facts |
| [KT-E1 keeps callable references non-executable](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L177) | covered | facts |
| [KT-G1 pins modern syntax that the bundled grammar does not represent](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/kotlin-facts.test.ts#L182) | covered | facts |

## lexical-search.test.ts

**lexical-terms**: Pinned TS lexical fixtures check Unicode normalization, camel case/acronym/snake/path terms and safe FTS query construction. Evidence: [terms_and_safe_queries_match_ts_reference](../../../tests/unit/storage/lexical.rs).

**relevance-cases**: The saved 382-query corpus benchmark is strong retrieval evidence, but these small mixed-intent and duplicate-boilerplate counterexamples are not direct Rust regression tests. Port them with deterministic embeddings. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md), [benchmarks/versions/port/kubernetes/FOUR-CORPUS.md](../../../benchmarks/versions/port/kubernetes/FOUR-CORPUS.md).

**lexical-ties**: Rust checks punctuation-only queries and explicit Bun/UTF-16 collation ties independent of insertion order. Evidence: [lexical_only_search_survives_unavailable_vectors_and_validates_queries](../../../tests/unit/storage/candidates.rs), [channel_collation_matches_bun_and_final_ties_use_utf16](../../../tests/unit/storage/candidates.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [shares Unicode-aware camelCase, acronym, snake_case, and path terms](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lexical-search.test.ts#L19) | covered | lexical-terms |
| [boosts rare chunk names and paths over repeated boilerplate](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lexical-search.test.ts#L37) | missing | relevance-cases |
| [omits punctuation-only queries and resolves ties deterministically](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lexical-search.test.ts#L52) | covered | lexical-ties |

## lua-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

**native-structure**: Rust has explicit structural ownership/name/span checks for this behavior, supplemented by the archived source-window trees. This classification covers the structural assertion, not TS resolved fact fields. Evidence: [native_languages_match_pinned_ts_chunks](../../../tests/unit/native_languages.rs), [check](../../../tests/unit/ts_v2_source/reviewed.rs), [bash_environment_bindings_are_not_persistent_declarations](../../../tests/unit/native_languages.rs), [html_void_tags_do_not_swallow_the_following_elements](../../../tests/unit/native_languages.rs), [lua_assignments_methods_and_function_fields_keep_written_names](../../../tests/unit/native_languages.rs), [zig_containers_tests_and_errors_keep_distinct_names](../../../tests/unit/native_languages.rs), [ocaml_interfaces_bindings_and_functions_use_the_selected_grammar](../../../tests/unit/native_languages.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [extracts only literal require calls as imports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L18) | covered | facts |
| [binds required module aliases without guessing dynamic modules](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L34) | covered | facts |
| [targets local, dotted, and colon-declared functions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L44) | covered | facts |
| [binds parameters, implicit self, and named closures](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L61) | covered | facts |
| [keeps tables as variables and function-valued fields as functions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L79) | covered | native-structure |
| [preserves method, dotted, chained, string, and table call spelling](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L91) | covered | facts |
| [does not fabricate Lua export facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L106) | covered | facts |
| [LUA-L1 scopes numeric, generic, and repeat-loop bindings](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L112) | covered | facts |
| [LUA-L2 respects declaration timing, reassignment, and parallel locals](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L140) | covered | facts |
| [LUA-E1 preserves literal loaders and rejects shadowed loader semantics](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/lua-facts.test.ts#L154) | covered | facts |

## markdown-facts.test.ts

**markdown-facts**: Production Markdown analysis matches every captured resource/import fact, including normalized reference definitions, destinations and ownership. Evidence: [markdown_facts](../../../tests/unit/ts_v2_source/chunker.rs).

**markdown-structure**: The archived Markdown fixtures check exact section ownership and source retention for ATX and Setext headings, fenced code, lists, and quotes, including .markdown dispatch. Evidence: [check](../../../tests/unit/ts_v2_source/reviewed.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves inline links, images, autolinks, and reference definitions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/markdown-facts.test.ts#L20) | covered | markdown-facts |
| [ignores links inside inline and fenced code](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/markdown-facts.test.ts#L39) | covered | markdown-facts |
| [rejects fragments, unsafe schemes, data URIs, and templates](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/markdown-facts.test.ts#L45) | covered | markdown-facts |
| [keeps meaningful section bodies out of whitespace gaps](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/markdown-facts.test.ts#L56) | covered | markdown-structure |
| [routes both Markdown extensions through the dedicated strategy](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/markdown-facts.test.ts#L63) | covered | markdown-structure |
| [does not fabricate Markdown calls or exports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/markdown-facts.test.ts#L74) | covered | markdown-facts |
| [MD-E1 resolves reference uses and normalizes explicit destinations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/markdown-facts.test.ts#L80) | covered | markdown-facts |

## ocaml-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

**native-structure**: Rust has explicit structural ownership/name/span checks for this behavior, supplemented by the archived source-window trees. This classification covers the structural assertion, not TS resolved fact fields. Evidence: [native_languages_match_pinned_ts_chunks](../../../tests/unit/native_languages.rs), [check](../../../tests/unit/ts_v2_source/reviewed.rs), [bash_environment_bindings_are_not_persistent_declarations](../../../tests/unit/native_languages.rs), [html_void_tags_do_not_swallow_the_following_elements](../../../tests/unit/native_languages.rs), [lua_assignments_methods_and_function_fields_keep_written_names](../../../tests/unit/native_languages.rs), [zig_containers_tests_and_errors_keep_distinct_names](../../../tests/unit/native_languages.rs), [ocaml_interfaces_bindings_and_functions_use_the_selected_grammar](../../../tests/unit/native_languages.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves opens, includes, aliases, and local opens](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L29) | covered | facts |
| [binds module aliases without guessing ordinary module lookup](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L51) | covered | facts |
| [targets every member of a mutually recursive binding group](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L64) | covered | facts |
| [respects sequential visibility and explicit recursive bindings](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L76) | covered | facts |
| [targets external declarations and preserves infix applications](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L95) | covered | facts |
| [binds parameters and nested functions with precise ownership](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L110) | covered | facts |
| [keeps values, destructuring, and function-valued bindings distinct](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L124) | covered | facts |
| [binds object receivers locally and same-file class construction exactly](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L138) | covered | facts |
| [targets variant constructors from their explicit local type declarations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L151) | covered | facts |
| [does not treat local opens as proof that a called name exists](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L160) | covered | facts |
| [does not fabricate OCaml export facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L168) | covered | facts |
| [routes interfaces through declaration-only OCaml grammar](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L174) | covered | native-structure |
| [keeps interface dependencies without inventing calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L196) | covered | facts |
| [OCAML-L1 scopes match, function, exception, and tuple patterns](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L210) | covered | facts |
| [OCAML-E1 keeps nested module aliases lexical and non-leaking](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ocaml-facts.test.ts#L219) | covered | facts |

## perspective-fusion-production.test.ts

**perspectives**: Independent fact/relation embedding stores, optional perspective fusion, and public per-channel search APIs were not adopted. Production ordering uses source windows and documentation reference expansion. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

| TS test | Status | Assessment |
| --- | --- | --- |
| [attributes low-authority confirmation without losing citations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/perspective-fusion-production.test.ts#L75) | outside scope | perspectives |
| [hydrates a perspective-only file and reports its channel ranks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/perspective-fusion-production.test.ts#L104) | outside scope | perspectives |
| [rejects invalid policy values](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/perspective-fusion-production.test.ts#L130) | outside scope | perspectives |

## php-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves class, function, const, grouped, and aliased uses](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L18) | covered | facts |
| [keeps literal runtime imports separate from dynamic runtime calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L43) | covered | facts |
| [binds parameters, functions, member roots, and same-file classes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L64) | covered | facts |
| [targets named arrow and anonymous functions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L80) | covered | facts |
| [owns calls in constants and property hooks precisely](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L93) | covered | facts |
| [binds namespace aliases without crossing namespace spans](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L103) | covered | facts |
| [does not fabricate export facts from PHP visibility](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L118) | covered | facts |
| [PHP-L1 retains function-scoped loop, catch, destructuring, and declared globals](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L124) | covered | facts |
| [PHP-L2 respects nested assignment timing, reassignment, and unset](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L146) | covered | facts |
| [PHP-L3 distinguishes arrow capture from explicit and missing closure use](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L161) | covered | facts |
| [PHP-E1 keeps first-class callable references non-executable](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/php-facts.test.ts#L174) | covered | facts |

## project-analysis.test.ts

**discovery**: Rust checks the delivered language/format union, include/exclude selection, useful explicit paths, and default directory exclusions. TS project-analysis rendering is not included. Evidence: [default_discovery_covers_the_v1_v2_union_and_keeps_exclusions](../../../tests/unit/commands/index/walk.rs), [custom_include_selects_another_extension](../../../tests/unit/commands/index/walk.rs), [default_target_exclusion_is_rooted_and_custom_rules_stay_explicit](../../../tests/unit/commands/index/walk.rs).

**discovery-hidden**: Rust covers explicit includes and ignores, but the TS mixed hidden-path/include/exclude example has no equivalent combined regression. Evidence: [tests/unit/commands/index/walk.rs](../../../tests/unit/commands/index/walk.rs).

**discovery-git**: Rust walks with ignore rules and permits named includes to override gitignore; it does not use TS Git-result-only discovery. This is a discovery contract difference. Binary resource relationships are now covered separately. Evidence: [a_named_include_beats_gitignore](../../../tests/unit/commands/index/walk.rs), [src/commands/index/walk.rs](../../../src/commands/index/walk.rs), [src/source.rs](../../../src/source.rs).

**project-analyze**: Rust exposes model-free project relationships and single-file live/stored inspection. The TS combined project analysis report, root-selection API and exact renderer remain a different public contract; underlying language facts and relationships are covered separately. Evidence: [connects_project_code_and_binary_assets_without_setup_or_model](../../../tests/unit/commands/relationships.rs), [relationships](../../../tests/unit/ts_v2_source/relationship_projects.rs).

**resource-assets**: The project command resolves binary resource targets by path without attempting source parsing or creating an index. Evidence: [connects_project_code_and_binary_assets_without_setup_or_model](../../../tests/unit/commands/relationships.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [discovers every reviewed extension and UTF-8 text fallbacks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L33) | covered | discovery |
| [applies the default directory exclusions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L96) | covered | discovery |
| [applies include and exclude globs while allowing useful hidden paths](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L114) | missing | discovery-hidden |
| [respects gitignore before applying config globs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L144) | outside scope | discovery-git |
| [does not fall back to filesystem discovery for an empty Git result](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L166) | outside scope | discovery-git |
| [analyzes and renders a mixed project](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L187) | outside scope | project-analyze |
| [renders every supported language and extension through project analysis](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L204) | outside scope | project-analyze |
| [indexes binary resource targets without parsing them as source](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L243) | covered | resource-assets |
| [renders an empty project](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L265) | outside scope | project-analyze |
| [renders unresolved imports, re-exports, and calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L269) | outside scope | project-analyze |
| [reports a missing project directory](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-analysis.test.ts#L273) | outside scope | project-analyze |

## project-index-lock.test.ts

**writer-lock**: Rust uses an OS lock to exclude concurrent writers and release ownership on exit. Tests exercise contention in one process and a killed child process. TS malformed lock-file reclamation is not applicable to this mechanism. Evidence: [lock_excludes_another_writer_and_releases_with_its_owner](../../../tests/unit/commands/index/lock.rs), [killed_writer_releases_the_os_lock](../../../tests/unit/commands/index/lock.rs).

**writer-owner**: Rust tests contention and release, but has no equivalent regression for an old owner releasing after lock-file replacement. Review the OS-lock contract before porting the TS token-owner case. Evidence: [tests/unit/commands/index/lock.rs](../../../tests/unit/commands/index/lock.rs), [src/commands/index/lock.rs](../../../src/commands/index/lock.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [elects one instance even when contenders share a process](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-index-lock.test.ts#L26) | covered | writer-lock |
| [reclaims a malformed or dead-owner lock](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-index-lock.test.ts#L47) | covered | writer-lock |
| [only releases a lock still owned by the same instance](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-index-lock.test.ts#L69) | missing | writer-owner |

## project-index.test.ts

**index-reuse**: Rust verifies initial indexing, reopening/reuse, changed-source replacement, and deletion across the supported language union. Evidence: [the_language_union_shares_reuse_replacement_and_failed_cleanup](../../../tests/unit/commands/index.rs), [reuse_skips_parsing_and_inference_and_preserves_rows](../../../tests/unit/commands/index.rs).

**indexed-project-contract**: Complete source facts now survive Rust storage across all 272 language fixtures, and stored cross-file results match all 107 projects. These TS tests additionally require analyzeIndexedProject and the combined project renderer/config API, which are not Rust public contracts. Evidence: [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs), [stored_relationships_match_direct_for_every_project](../../../tests/unit/ts_v2_source/relationship_projects.rs).

**index-read-failure**: Failed reads, failed parsing, and reconciliation remove stale snapshots and vectors under the Rust indexing contract. Evidence: [cleanup_removes_deleted_excluded_and_unreadable_files_with_vectors](../../../tests/unit/commands/index.rs), [fatal_parser_error_removes_previous_analysis_and_vectors](../../../tests/unit/commands/index.rs).

**index-interrupted**: Interrupted discovery must not reconcile unseen files; completed earlier publications remain intact. Evidence: [interrupted_parallel_discovery_never_reconciles_unseen_files](../../../tests/unit/commands/index.rs), [embedding_failure_preserves_earlier_commits_and_omits_cleanup](../../../tests/unit/commands/index.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [builds, reopens, and reuses a disposable multi-file index](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-index.test.ts#L58) | covered | index-reuse |
| [persists the common fact model across the reviewed language frontier](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-index.test.ts#L122) | outside scope | indexed-project-contract |
| [uses the project config for direct and persisted analysis](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-index.test.ts#L148) | covered | index-reuse |
| [removes a previously indexed file when its current read fails](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-index.test.ts#L182) | covered | index-read-failure |
| [does not reconcile an interrupted project scan](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-index.test.ts#L210) | covered | index-interrupted |

## project-layout.test.ts

**project-layout**: Local .mimirs placement is tested, but TS canonical-path/symlink behavior and the complete project-layout cases are not demonstrated by equivalent tests. Rust has no persisted absolute source field. Evidence: [first_init_creates_the_project_files_and_database](../../../tests/unit/commands/init.rs), [src/commands/init.rs](../../../src/commands/init.rs).

**init-preserve**: Repeated init preserves existing config and stored database data; initial init checks the local ignore policy. Evidence: [first_init_creates_the_project_files_and_database](../../../tests/unit/commands/init.rs), [repeated_init_preserves_config_and_database_data](../../../tests/unit/commands/init.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [always places state below the canonical source directory](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-layout.test.ts#L33) | missing | project-layout |
| [canonicalizes a symlinked source directory once](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-layout.test.ts#L47) | missing | project-layout |
| [creates only the local state namespace and preserves its contents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-layout.test.ts#L58) | covered | init-preserve |

## project-search.test.ts

**index-reuse**: Rust verifies initial indexing, reopening/reuse, changed-source replacement, and deletion across the supported language union. Evidence: [the_language_union_shares_reuse_replacement_and_failed_cleanup](../../../tests/unit/commands/index.rs), [reuse_skips_parsing_and_inference_and_preserves_rows](../../../tests/unit/commands/index.rs).

**session-contract**: The TS mutable project-search session refreshes source/config and owns queued operations. Rust search reads the indexed snapshot; index explicitly refreshes it. A TS session lifecycle test cannot be counted as Rust snapshot parity. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md), [search_golden_preserves_stored_text_and_ignores_source_and_config_changes](../../../tests/unit/commands/search.rs), [src/main.rs](../../../src/main.rs).

**generated-config**: Search reads current generated-path rules without replacing the saved source snapshot; the command regression changes rules and checks lexical ranking with missing vectors. Evidence: [lexical_results_survive_missing_vectors_and_use_current_generated_rules](../../../tests/unit/commands/search.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [creates, incrementally refreshes, and reopens one project index](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L54) | covered | index-reuse |
| [reads current vector counts after the writer changes shared rows](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L131) | outside scope | session-contract |
| [trusts vectors in a current owned schema without a status manifest](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L152) | outside scope | session-contract |
| [honors config and handles a project with no included sources](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L181) | outside scope | session-contract |
| [does not search rows for files deleted after an earlier refresh](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L233) | outside scope | session-contract |
| [reloads config and stops searching a newly excluded path](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L261) | outside scope | session-contract |
| [reloads generated policy without rebuilding unchanged files](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L299) | covered | generated-config |
| [excludes an old row when current analysis of that path fails](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L353) | outside scope | session-contract |
| [serializes concurrent refresh calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L400) | outside scope | session-contract |
| [validates the root and config before creating an index](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L436) | outside scope | session-contract |
| [closes idempotently after queued work and rejects later calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/project-search.test.ts#L464) | outside scope | session-contract |

## python-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [treats stubs as declarations with imports but no executable calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L22) | covered | facts |
| [distinguishes parameters, annotations, defaults, and imported names](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L37) | covered | facts |
| [resolves nested functions and classes to exact source chunks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L50) | covered | facts |
| [marks imports guarded by TYPE_CHECKING](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L66) | covered | facts |
| [assigns calls in class attributes to field chunks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L80) | covered | facts |
| [PY-L1/L2 binds lambda, comprehension, loop, with, and except names](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L88) | covered | facts |
| [PY-L3 respects global and nonlocal directives without guessing rebound targets](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L129) | covered | facts |
| [PY-E1 keeps conditional imports owned and their shared bindings ambiguous](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L142) | covered | facts |
| [PY-L4 assigns decorator, default, annotation, and base calls to evaluation scope](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L161) | covered | facts |
| [PY-L5 binds annotations, deletion, walrus targets, and match captures](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/python-facts.test.ts#L177) | covered | facts |

## relation-embeddings.test.ts

**perspectives**: Independent fact/relation embedding stores, optional perspective fusion, and public per-channel search APIs were not adopted. Production ordering uses source windows and documentation reference expansion. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

| TS test | Status | Assessment |
| --- | --- | --- |
| [materializes typed edges in both directions and searches provenance](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/relation-embeddings.test.ts#L53) | outside scope | perspectives |
| [reprojects both endpoints after an edge changes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/relation-embeddings.test.ts#L97) | outside scope | perspectives |
| [retrieves fact and relation pools with one query inference](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/relation-embeddings.test.ts#L118) | outside scope | perspectives |

## ruby-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [extracts only receiverless literal require forms as imports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L18) | covered | facts |
| [binds parameters, unique methods, yield, and super](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L36) | covered | facts |
| [targets named lambdas and binds block parameters](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L53) | covered | facts |
| [uses Ruby lexical assignment scope even before the assignment executes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L69) | covered | facts |
| [preserves safe navigation, scope resolution, and chained call spelling](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L79) | covered | facts |
| [does not fabricate export facts from Ruby constants](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L95) | covered | facts |
| [owns operator and setter calls by their exact method names](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L101) | covered | facts |
| [RUBY-L1 binds blocks, numbered parameters, loops, rescue, and patterns](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L111) | covered | facts |
| [RUBY-L2 keeps redefined methods conservative](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L147) | covered | facts |
| [RUBY-E1 retains literal loaders only when standard methods are unshadowed](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L158) | covered | facts |
| [RUBY-E2 preserves operator, index, and setter call syntax](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/ruby-facts.test.ts#L175) | covered | facts |

## rust-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [expands grouped use declarations into complete Rust paths](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L18) | covered | facts |
| [resolves parameters and named local closures](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L48) | covered | facts |
| [honors lexical shadowing and block-local uses](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L59) | covered | facts |
| [targets local types and generic functions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L71) | covered | facts |
| [resolves self parameters and locally defined macros](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L87) | covered | facts |
| [does not fabricate export facts from pub visibility](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L108) | covered | facts |
| [RS-L1 scopes control-flow and destructuring patterns without leaks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L112) | covered | facts |
| [RS-L2 respects let timing, reassignment, and nested block boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L142) | covered | facts |
| [RS-E1 resolves explicit variants and inherent associated calls conservatively](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L169) | covered | facts |
| [RS-E2 preserves extern crate dependencies and aliases](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/rust-facts.test.ts#L190) | covered | facts |

## scala-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves Scala 2/3 selectors, aliases, hides, wildcards, and givens](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L18) | covered | facts |
| [targets curried methods and same-file constructors conservatively](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L50) | covered | facts |
| [targets named lambdas and binds their parameters](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L71) | covered | facts |
| [binds direct Scala 3 aliases and isolates wildcard lookup](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L84) | covered | facts |
| [owns calls inside fields, givens, extensions, and enum methods](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L101) | covered | facts |
| [keeps sequential package clauses nested](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L116) | covered | facts |
| [does not fabricate exports or parameterless calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L129) | covered | facts |
| [SCALA-L1 scopes comprehension, lambda, match, catch, and tuple binders](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L137) | covered | facts |
| [SCALA-L2 respects constructor parameters, timing, and direct reassignment](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L164) | covered | facts |
| [SCALA-E1 keeps eta-expanded and parameterless references non-executable](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L182) | covered | facts |
| [SC-L1 applies explicit lexical scope without assuming a script host](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/scala-facts.test.ts#L188) | covered | facts |

## search-cli.test.ts

**readonly-schema**: Read-only search rejects incompatible schemas without changing the index, reports compatibility errors, and rejects writes. Evidence: [pre_revision_schemas_rebuild_only_on_writable_open](../../../tests/unit/storage/open.rs), [a_future_schema_is_rejected_without_mutation](../../../tests/unit/storage/open.rs), [search_connection_rejects_writes](../../../tests/unit/storage/open.rs), [bad_databases_fail_before_embedding_and_remain_unchanged](../../../tests/unit/commands/search.rs).

**search-citations**: Rust checks compact result output against goldens and exact stored text, including multiple chunks, later windows, and deleted source snapshots. Evidence: [search_golden_preserves_stored_text_and_ignores_source_and_config_changes](../../../tests/unit/commands/search.rs), [multiple_matching_chunks_show_later_answer_from_deleted_snapshot](../../../tests/unit/commands/search.rs).

**search-cli-contract**: Legacy TS short/long argument forms, package scripts, configurable presentation, and TS warning text are not the Rust CLI contract. Evidence: [src/main.rs](../../../src/main.rs), [tests/search_cli.rs](../../../tests/search_cli.rs).

**search-empty**: Empty indexes skip embedder construction and return successful, empty output. Evidence: [empty_search_prints_only_the_result_summary](../../../tests/search_cli.rs), [empty_indexes_skip_embedder_creation](../../../tests/unit/commands/search.rs).

**search-errors**: Rust tests invalid arguments before database access, embedding failures without stdout, and CLI errors on stderr with a nonzero exit. Evidence: [invalid_arguments_fail_before_database_access_even_with_an_empty_index](../../../tests/unit/commands/search.rs), [embedding_failures_leave_stdout_empty_and_preserve_the_index](../../../tests/unit/commands/search.rs), [search_errors_use_stderr_and_nonzero_exit](../../../tests/search_cli.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [directs older read-only schemas through the explicit index command](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L175) | covered | readonly-schema |
| [directs newer read-only schemas through a Mimirs upgrade](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L191) | covered | readonly-schema |
| [opens the owned database read-only without requiring status](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L200) | covered | readonly-schema |
| [renders exact window and parent citations with compact previews](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L241) | covered | search-citations |
| [parses the legacy short and long command shapes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L341) | outside scope | search-cli-contract |
| [runs the shared session and keeps an empty result successful](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L377) | covered | search-empty |
| [writes preparation and retrieval warnings only to stderr](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L399) | outside scope | search-cli-contract |
| [rejects malformed arguments before opening a session](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L442) | covered | search-errors |
| [reports runtime failures without a stack](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L473) | covered | search-errors |
| [package script exposes search and missing arguments exit with usage](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-cli.test.ts#L489) | outside scope | search-cli-contract |

## search-relevance.test.ts

**relevance-cases**: The saved 382-query corpus benchmark is strong retrieval evidence, but these small mixed-intent and duplicate-boilerplate counterexamples are not direct Rust regression tests. Port them with deterministic embeddings. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md), [benchmarks/versions/port/kubernetes/FOUR-CORPUS.md](../../../benchmarks/versions/port/kubernetes/FOUR-CORPUS.md).

**file-grouping**: Differential fixtures check chunk/file fusion, and command regressions check sibling chunks and later windows retain their exact saved citations. Evidence: [chunk_and_file_grouping_match_ts_reference](../../../tests/unit/storage/ranking.rs), [native_grouping_and_reranking_match_ts_reference](../../../tests/unit/storage/candidates.rs), [multiple_matching_chunks_show_later_answer_from_deleted_snapshot](../../../tests/unit/commands/search.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [retrieves identifier, prose, and non-TypeScript intent through the full path](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-relevance.test.ts#L58) | missing | relevance-cases |
| [distinct behavior outranks duplicated audit boilerplate](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-relevance.test.ts#L117) | missing | relevance-cases |
| [merges sibling windows and source chunks into one file citation](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search-relevance.test.ts#L138) | covered | file-grouping |

## search.test.ts

**completed-fusion**: Captured TS candidates compare incomplete and completed channel membership, scores and fusion, followed by native grouping/reranking. These checks run without a model. Evidence: [completed_channels_and_fusion_match_ts_reference](../../../tests/unit/storage/candidates.rs), [native_grouping_and_reranking_match_ts_reference](../../../tests/unit/storage/candidates.rs).

**search-missing**: Related Rust differential tests exist, but this specific adversarial score, duplication, malformed-candidate, or query-validation scenario is not demonstrated by an equivalent active-path test. Preserve it as a test gap. Evidence: [tests/unit/storage/candidates.rs](../../../tests/unit/storage/candidates.rs), [tests/unit/commands/search.rs](../../../tests/unit/commands/search.rs).

**lexical-ties**: Rust checks punctuation-only queries and explicit Bun/UTF-16 collation ties independent of insertion order. Evidence: [lexical_only_search_survives_unavailable_vectors_and_validates_queries](../../../tests/unit/storage/candidates.rs), [channel_collation_matches_bun_and_final_ties_use_utf16](../../../tests/unit/storage/candidates.rs).

**signals**: Rust compares TS identifier/path signals and explicitly tests distinct-file symbol uniqueness, ambiguity, and signal order. The separate constant-exclusion scenario remains missing. Evidence: [signal_identifiers_and_paths_match_ts_reference](../../../tests/unit/storage/ranking.rs), [unique_symbol_counts_distinct_files_and_signals_precede_confirmation](../../../tests/unit/storage/ranking.rs).

**alternate-policy**: The test targets an optional TS exact/text/v1-like/name-projection policy or caller tuning API that was not adopted. Current policy and candidate caps are fixed; retired Rust test-only builders do not count as production support. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

**unique-constant-gap**: Rust checks duplicate names within and across files and multiplier order. There is no equivalent assertion that a constant with the queried name does not earn unique-definition confirmation. Evidence: [unique_symbol_counts_distinct_files_and_signals_precede_confirmation](../../../tests/unit/storage/ranking.rs).

**generated-config**: Search reads current generated-path rules without replacing the saved source snapshot; the command regression changes rules and checks lexical ranking with missing vectors. Evidence: [lexical_results_survive_missing_vectors_and_use_current_generated_rules](../../../tests/unit/commands/search.rs).

**file-grouping**: Differential fixtures check chunk/file fusion, and command regressions check sibling chunks and later windows retain their exact saved citations. Evidence: [chunk_and_file_grouping_match_ts_reference](../../../tests/unit/storage/ranking.rs), [native_grouping_and_reranking_match_ts_reference](../../../tests/unit/storage/candidates.rs), [multiple_matching_chunks_show_later_answer_from_deleted_snapshot](../../../tests/unit/commands/search.rs).

**search-empty**: Empty indexes skip embedder construction and return successful, empty output. Evidence: [empty_search_prints_only_the_result_summary](../../../tests/search_cli.rs), [empty_indexes_skip_embedder_creation](../../../tests/unit/commands/search.rs).

**query-validation**: Rust rejects bad query arguments before storage/inference and validates dimensions and non-finite backend outputs. TS configurable embedder identity APIs are outside the public contract. Evidence: [invalid_arguments_fail_before_database_access_even_with_an_empty_index](../../../tests/unit/commands/search.rs), [vector_dimension_is_validated](../../../tests/unit/embedding.rs), [non_finite_values_are_rejected](../../../tests/unit/embedding.rs).

**storage-migration**: TS historical v1-v8 SQLite migrations, configurable embedding dimensions, and in-place vector-store rotation do not describe the Rust schema. Rust explicitly rebuilds recognized old schemas and uses a pinned embedding space. Evidence: [recognized_v1_is_rebuilt_and_open_reports_each_outcome](../../../tests/unit/storage/open.rs), [pre_revision_schemas_rebuild_only_on_writable_open](../../../tests/unit/storage/open.rs), [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

| TS test | Status | Assessment |
| --- | --- | --- |
| [pins the selected completed-score production fusion](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L60) | covered | completed-fusion |
| [ranks every finite cosine score and returns exact compact citations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L69) | missing | search-missing |
| [uses a stable path and range tie-break independent of insertion order](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L166) | covered | lexical-ties |
| [keeps duplicate source text as independently cited results](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L188) | missing | search-missing |
| [fuses identifier evidence by rank without replacing cosine evidence](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L221) | covered | completed-fusion |
| [applies the measured exact-name signal](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L269) | covered | signals |
| [demotes conventional test paths without boosting source directories](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L299) | covered | signals |
| [demotes configured generated paths in native and exact search](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L336) | outside scope | alternate-policy |
| [matches generated globs at the root or a directory suffix](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L396) | covered | signals |
| [confirms unique definition names but ignores ambiguity and constants](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L408) | missing | unique-constant-gap |
| [isolates path/name FTS from text-only and v1-like projections](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L483) | outside scope | alternate-policy |
| [returns a reconciled lexical-only hit without embedding the query](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L523) | covered | generated-config |
| [does not invoke scalar cosine while retrieving FTS candidates](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L560) | missing | search-missing |
| [keeps shared and semantic native candidate tuning independent](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L591) | outside scope | alternate-policy |
| [completes missing channel scores across the retrieved candidate union](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L623) | covered | completed-fusion |
| [production search merges source chunks into one file with exact ranges](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L710) | covered | file-grouping |
| [exact and native production search aggregate the same file ranges](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L765) | outside scope | alternate-policy |
| [keeps SQLite scalar ranking aligned with the exact reference](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L824) | outside scope | alternate-policy |
| [skips zero-magnitude candidates after file reconciliation](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L876) | missing | search-missing |
| [does not embed a query when there are no compatible candidates](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L900) | covered | search-empty |
| [validates requests and presentation before embedding](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L920) | covered | query-validation |
| [rejects malformed query embeddings](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L970) | covered | query-validation |
| [rejects malformed embedder identities before inference](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/search.test.ts#L1005) | outside scope | storage-migration |

## source-channel-search.test.ts

**perspectives**: Independent fact/relation embedding stores, optional perspective fusion, and public per-channel search APIs were not adopted. Production ordering uses source windows and documentation reference expansion. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

| TS test | Status | Assessment |
| --- | --- | --- |
| [returns pre-fusion semantic and BM25 file rankings separately](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-channel-search.test.ts#L34) | outside scope | perspectives |
| [validates requests before inference](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-channel-search.test.ts#L70) | outside scope | perspectives |

## source-embeddings.test.ts

**alternate-policy**: The test targets an optional TS exact/text/v1-like/name-projection policy or caller tuning API that was not adopted. Current policy and candidate caps are fixed; retired Rust test-only builders do not count as production support. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

**input-parity**: Pinned tokenizer and q8 model fixtures compare actual path-prefixed document and query inputs and vectors. These two tests are ignored by default and need an explicit cached-assets run. Evidence: [final_document_inputs_match_ts_text_and_token_ids](../../../tests/unit/embedding/ts_v2.rs), [real_model_inputs_and_vectors_match_ts_reference](../../../tests/unit/embedding/ts_v2.rs).

**embedding-progress**: Rust verifies phase and batch progress, but the TS nested-inference progress/restart and monotonicity cases have no direct equivalent assertion. Evidence: [batches_update_only_terminal_progress](../../../tests/unit/commands/index.rs), [documents_keep_order_across_256_item_batches_and_report_progress](../../../tests/unit/embedding.rs).

**embedding-batches**: Rust tests ordering and reuse, but the TS source persistence batch/page-boundary cases are not directly covered. The old 256-item generic document batch test alone does not cover the active source-window staging path. Evidence: [documents_keep_order_across_256_item_batches_and_report_progress](../../../tests/unit/embedding.rs), [bounded_pipeline_runs_files_concurrently_and_commits_in_source_order](../../../tests/unit/commands/index.rs).

**embedding-dedup**: TS raw/name-projection cross-file deduplication and duplicate-path disambiguation policies are not the adopted path-average document policy. Evidence: [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

**storage-migration**: TS historical v1-v8 SQLite migrations, configurable embedding dimensions, and in-place vector-store rotation do not describe the Rust schema. Rust explicitly rebuilds recognized old schemas and uses a pinned embedding space. Evidence: [recognized_v1_is_rebuilt_and_open_reports_each_outcome](../../../tests/unit/storage/open.rs), [pre_revision_schemas_rebuild_only_on_writable_open](../../../tests/unit/storage/open.rs), [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

**index-read-failure**: Failed reads, failed parsing, and reconciliation remove stale snapshots and vectors under the Rust indexing contract. Evidence: [cleanup_removes_deleted_excluded_and_unreadable_files_with_vectors](../../../tests/unit/commands/index.rs), [fatal_parser_error_removes_previous_analysis_and_vectors](../../../tests/unit/commands/index.rs).

**storage-reopen**: File-backed reopen and row preservation are explicitly tested. Source chunks, windows, raw evidence and replacement survive SQL round trips. Evidence: [reopening_a_database_preserves_data](../../../tests/unit/storage/open.rs), [ts_source_chunks_roundtrip_and_keep_raw_evidence_through_replacement](../../../tests/unit/storage/hybrid.rs).

**embedding-resume**: Rust checks that failed embedding leaves earlier file commits intact, omits cleanup, and discards abandoned staged work on reopening. Rust publishes whole files, so TS per-window partial publication is not promised. Evidence: [embedding_failure_preserves_earlier_commits_and_omits_cleanup](../../../tests/unit/commands/index.rs), [abandoned_stages_are_discarded_while_committed_files_remain_reusable](../../../tests/unit/storage_staging.rs).

**embedding-stale**: TS checks a source-row version during in-flight embedding. Rust workers intentionally publish the immutable read snapshot even when disk content changes, with staged generation validation. The lifecycle contract differs. Evidence: [parallel_workers_publish_the_read_snapshot_after_disk_changes](../../../tests/unit/commands/index.rs), [conflicting_generations_duplicates_and_missing_mappings_are_rejected](../../../tests/unit/storage_staging.rs).

**embedding-atomic**: Malformed vectors and staged publication failures cannot commit a partial replacement. Rust validates backend count/dimensions/finiteness and rolls back failed publication. Evidence: [backend_result_count_is_validated](../../../tests/unit/embedding.rs), [vector_dimension_is_validated](../../../tests/unit/embedding.rs), [non_finite_values_are_rejected](../../../tests/unit/embedding.rs), [failed_publication_rolls_back_the_entire_replacement](../../../tests/unit/storage_staging.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [projects source names deterministically without changing anonymous text](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L75) | outside scope | alternate-policy |
| [versions projected documents while leaving query inference raw](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L96) | outside scope | alternate-policy |
| [uses path-average document inference while leaving query inference raw](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L132) | covered | input-parity |
| [forwards in-flight document inference progress within a persistence batch](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L180) | missing | embedding-progress |
| [keeps embedding progress monotonic when nested inference restarts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L225) | missing | embedding-progress |
| [path projection keeps identical text in different files distinct](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L266) | missing | embedding-batches |
| [embeds exact window text in deterministic batches and skips it later](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L304) | missing | embedding-batches |
| [infers duplicate raw inputs once across candidate pages and stores every vector](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L359) | outside scope | embedding-dedup |
| [path-labels only exact projected inputs duplicated across paths](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L387) | outside scope | embedding-dedup |
| [duplicate-path grouping uses the complete base name projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L429) | outside scope | embedding-dedup |
| [reconciles persisted input policy changes without a prior manifest](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L461) | outside scope | embedding-dedup |
| [reconciles duplicate membership and resumes without repeating vectors](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L496) | outside scope | embedding-dedup |
| [deduplicates equal source-name projected inputs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L568) | outside scope | embedding-dedup |
| [deduplicates equal labeled source-name projected inputs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L568) | outside scope | embedding-dedup |
| [keeps identical raw text with different source-name inputs distinct](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L587) | outside scope | embedding-dedup |
| [keeps identical raw text with different labeled source-name inputs distinct](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L587) | outside scope | embedding-dedup |
| [pages candidates without changing order or inference batches](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L614) | missing | embedding-batches |
| [requires candidate pages to preserve whole inference batches](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L652) | outside scope | alternate-policy |
| [regenerates changed windows and replaces a previous model in place](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L667) | outside scope | storage-migration |
| [embeds and counts only files retained by reconciliation](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L706) | covered | index-read-failure |
| [round trips vectors through a file-backed database](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L745) | covered | storage-reopen |
| [rotates the sole vec0 store when embedding dimensions change](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L766) | outside scope | storage-migration |
| [resumes after a later batch fails without repeating completed work](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L798) | covered | embedding-resume |
| [rejects a stale vector when its source window changes during inference](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L845) | outside scope | embedding-stale |
| [rejects a malformed batch without writing any of its vectors](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-embeddings.test.ts#L871) | covered | embedding-atomic |

## source-index.test.ts

**storage-schema**: Rust tests initialization, current schema, foreign keys, newer-schema rejection and immutable read-only compatibility failures. Evidence: [a_new_database_reaches_the_current_schema](../../../tests/unit/storage/open.rs), [an_opened_connection_enables_foreign_keys](../../../tests/unit/storage/open.rs), [a_future_schema_is_rejected_without_mutation](../../../tests/unit/storage/open.rs).

**storage-migration**: TS historical v1-v8 SQLite migrations, configurable embedding dimensions, and in-place vector-store rotation do not describe the Rust schema. Rust explicitly rebuilds recognized old schemas and uses a pinned embedding space. Evidence: [recognized_v1_is_rebuilt_and_open_reports_each_outcome](../../../tests/unit/storage/open.rs), [pre_revision_schemas_rebuild_only_on_writable_open](../../../tests/unit/storage/open.rs), [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

**storage-missing**: The matching TS corruption/recovery/binary-index scenario is not demonstrated by an equivalent active-path regression. Related storage validation tests are insufficient to call this case covered. Evidence: [tests/unit/storage/open.rs](../../../tests/unit/storage/open.rs), [tests/unit/storage_documents.rs](../../../tests/unit/storage_documents.rs), [tests/unit/storage/save.rs](../../../tests/unit/storage/save.rs).

**signals**: Rust compares TS identifier/path signals and explicitly tests distinct-file symbol uniqueness, ambiguity, and signal order. The separate constant-exclusion scenario remains missing. Evidence: [signal_identifiers_and_paths_match_ts_reference](../../../tests/unit/storage/ranking.rs), [unique_symbol_counts_distinct_files_and_signals_precede_confirmation](../../../tests/unit/storage/ranking.rs).

**storage-reopen**: File-backed reopen and row preservation are explicitly tested. Source chunks, windows, raw evidence and replacement survive SQL round trips. Evidence: [reopening_a_database_preserves_data](../../../tests/unit/storage/open.rs), [ts_source_chunks_roundtrip_and_keep_raw_evidence_through_replacement](../../../tests/unit/storage/hybrid.rs).

**normalized-identity**: TS reuses rows for equal normalized text. Rust retains the raw snapshot and hashes raw content for exact citations; BOM/line-ending edits can require replacement. Evidence: [content_hash_detects_same_length_edit_with_same_timestamp](../../../tests/unit/commands/index.rs), [ts_source_chunks_roundtrip_and_keep_raw_evidence_through_replacement](../../../tests/unit/storage/hybrid.rs).

**atomic-replace**: Rust verifies atomic replacement and rollback of analysis, documents, vectors, and source evidence. Database IDs are implementation details rather than a public cross-language identity contract. Evidence: [failed_publication_rolls_back_the_entire_replacement](../../../tests/unit/storage_staging.rs), [ts_source_chunks_roundtrip_and_keep_raw_evidence_through_replacement](../../../tests/unit/storage/hybrid.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [initializes once and enables foreign keys](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L86) | covered | storage-schema |
| [rejects a database created by newer code](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L101) | covered | storage-schema |
| [closes a read-only database after a schema mismatch](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L110) | covered | storage-schema |
| [migrates version one and refreshes its missing facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L138) | outside scope | storage-migration |
| [migrates and backfills the FTS projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L170) | outside scope | storage-migration |
| [rebuilds an equal-size lexical projection after migration](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L194) | outside scope | storage-migration |
| [migrates inline v4 vectors into vec0 without retaining a copy](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L222) | outside scope | storage-migration |
| [migrates a legacy vec0 table to minimal vector storage](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L261) | outside scope | storage-migration |
| [migrates a v7 index with case-insensitive chunk-name lookup](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L298) | outside scope | storage-migration |
| [reconciles and drops the retired active-path projection from v8](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L313) | outside scope | storage-migration |
| [clears vector and input state when the embedding space changes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L340) | outside scope | storage-migration |
| [recovers a missing vector table for the current space](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L392) | missing | storage-missing |
| [finds unique named chunks among reconciled files](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L421) | covered | signals |
| [round trips a reviewed window tree through SQL joins](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L445) | covered | storage-reopen |
| [retains IDs for unchanged normalized content](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L496) | outside scope | normalized-identity |
| [keeps the file ID while atomically replacing changed analysis](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L523) | covered | atomic-replace |
| [replaces windows when projection settings change](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L556) | outside scope | storage-migration |
| [persists across a file-backed database reopen](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L580) | covered | storage-reopen |
| [does not create a file row for binary input](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-index.test.ts#L602) | missing | storage-missing |

## source-relationships.test.ts

**relationships**: All 107 original multi-file projects compare complete imports, re-exports, calls, unresolved facts and original rendered goldens with pinned TS output. Coverage includes binary resource paths, Go modules, aliases, ambiguity and cycles. Saved analyses produce identical relationships, independent of file enumeration order. Evidence: [relationships](../../../tests/unit/ts_v2_source/relationship_projects.rs), [parses_plain_and_quoted_go_module_directives](../../../tests/unit/ts_v2_source/relationship_projects.rs), [stored_relationships_match_direct_for_every_project](../../../tests/unit/ts_v2_source/relationship_projects.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [bash/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [bash/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [bash/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [bash/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [c/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [c/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [c/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [c/system](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [cpp/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [cpp/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [cpp/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [cpp/system](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [csharp/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [csharp/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [csharp/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [csharp/overload](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [css/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [css/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [css/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [dart/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [dart/conditional](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [dart/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [dart/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [dart/part_uri](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [elixir/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [elixir/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [elixir/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [elixir/overload](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [elixir/script](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [go/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [go/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [go/no-module](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [haskell/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [haskell/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [haskell/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [haskell/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [haskell/overload](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [html/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [html/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [html/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [java/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [java/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [java/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [java/overload](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [javascript/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [javascript/commonjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [javascript/commonjs-forwarding](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [javascript/jsx](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [javascript/mjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [javascript/scope](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [kotlin/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [kotlin/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [kotlin/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [kotlin/overload](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [kotlin/script](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [lua/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [lua/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [lua/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [lua/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [markdown/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [markdown/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [markdown/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [mixed/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ocaml/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ocaml/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ocaml/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ocaml/interface](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ocaml/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ocaml/overload](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [php/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [php/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [php/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [php/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [python/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [python/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [python/conditional-imports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [python/cycle](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [python/relative](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [python/stubs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ruby/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ruby/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ruby/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [ruby/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [rust/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [rust/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [rust/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [scala/ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [scala/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [scala/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [scala/overload](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [scala/script](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [text/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [toml/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/barrel](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/barrel-ambiguity](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/barrel-cycle](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/commonjs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/commonjs-forwarding](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/directory-index](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/mts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/scope](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [typescript/tsx](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [yaml/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [zig/basic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [zig/external](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [zig/missing](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L58) | covered | relationships |
| [parses plain and quoted Go module directives](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-relationships.test.ts#L96) | covered | relationships |

## source-search-candidates.test.ts

**storage-missing**: The matching TS corruption/recovery/binary-index scenario is not demonstrated by an equivalent active-path regression. Related storage validation tests are insufficient to call this case covered. Evidence: [tests/unit/storage/open.rs](../../../tests/unit/storage/open.rs), [tests/unit/storage_documents.rs](../../../tests/unit/storage_documents.rs), [tests/unit/storage/save.rs](../../../tests/unit/storage/save.rs).

**storage-reopen**: File-backed reopen and row preservation are explicitly tested. Source chunks, windows, raw evidence and replacement survive SQL round trips. Evidence: [reopening_a_database_preserves_data](../../../tests/unit/storage/open.rs), [ts_source_chunks_roundtrip_and_keep_raw_evidence_through_replacement](../../../tests/unit/storage/hybrid.rs).

**embedding-atomic**: Malformed vectors and staged publication failures cannot commit a partial replacement. Rust validates backend count/dimensions/finiteness and rolls back failed publication. Evidence: [backend_result_count_is_validated](../../../tests/unit/embedding.rs), [vector_dimension_is_validated](../../../tests/unit/embedding.rs), [non_finite_values_are_rejected](../../../tests/unit/embedding.rs), [failed_publication_rolls_back_the_entire_replacement](../../../tests/unit/storage_staging.rs).

**storage-migration**: TS historical v1-v8 SQLite migrations, configurable embedding dimensions, and in-place vector-store rotation do not describe the Rust schema. Rust explicitly rebuilds recognized old schemas and uses a pinned embedding space. Evidence: [recognized_v1_is_rebuilt_and_open_reports_each_outcome](../../../tests/unit/storage/open.rs), [pre_revision_schemas_rebuild_only_on_writable_open](../../../tests/unit/storage/open.rs), [benchmarks/versions/port/CONTRACT.md](../../../benchmarks/versions/port/CONTRACT.md).

| TS test | Status | Assessment |
| --- | --- | --- |
| [classifies missing embeddings without failing valid candidates](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-search-candidates.test.ts#L50) | missing | storage-missing |
| [returns deterministic citations after a file-backed reopen](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-search-candidates.test.ts#L113) | covered | storage-reopen |
| [diagnoses an orphan instead of presenting an incomplete citation](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-search-candidates.test.ts#L148) | missing | storage-missing |
| [rejects malformed vectors before vec0 can persist them](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-search-candidates.test.ts#L175) | covered | embedding-atomic |
| [rejects invalid requested embedding identities](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-search-candidates.test.ts#L202) | outside scope | storage-migration |

## source-windows.test.ts

**windows**: Every archived source-window fixture is unchanged. Rust compares the full tree, parent indices, byte and line spans, owning window indices, original displayed golden, exact source coverage, repeatability, and BOM/CRLF variants at three target sizes. Evidence: [check](../../../tests/unit/ts_v2_source/reviewed.rs), [language](../../../tests/unit/ts_v2_source/reviewed.rs).

**window-edges**: The TS compact-preview and indivisible-line examples are checked directly, as is rejection of a zero window target. Rust uses usize for target sizes and exposes no caller-configurable preview-size option; TS preview argument validation is not a shared public contract. Evidence: [preview_and_soft_target_edges_match_ts](../../../tests/unit/ts_v2_source/reviewed.rs), [src/main.rs](../../../src/main.rs).

**window-inventory**: The manifest checks all 84 fixtures and goldens, original SHA-256 hashes, every archived native extension, and the three required projection targets. Evidence: [every_archived_fixture_and_golden_is_checked_without_changes](../../../tests/unit/ts_v2_source/reviewed.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [typescript/small-function.ts matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [typescript/oversized-function.ts matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [typescript/nested-class.ts matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [typescript/module-blocks.ts matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [typescript/comments.ts matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [javascript/small-function.js matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [javascript/oversized-class.js matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [javascript/module-comments.js matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [python/small-function.py matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [python/oversized-class.py matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [python/nested-function.py matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [python/module-comments.py matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [go/small-function.go matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [go/oversized-function.go matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [go/types-and-methods.go matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [go/comments.go matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [rust/impl-and-functions.rs matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [rust/modules-comments.rs matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [java/nested-class.java matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [java/module-comments.java matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [c/structs-and-functions.c matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [c/preprocessor-comments.c matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [cpp/namespace-class.cpp matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [cpp/templates-comments.cpp matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [csharp/namespace-class.cs matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [csharp/modern-types-comments.cs matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [ruby/module-class.rb matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [ruby/loaders-comments.rb matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [php/namespace-class.php matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [php/runtime-comments.php matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [scala/package-class.scala matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [scala/modern-comments.scala matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [kotlin/package-class.kt matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [kotlin/modern-comments.kt matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [lua/table-module.lua matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [lua/loaders-comments.lua matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [zig/container.zig matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [zig/imports-comments.zig matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [elixir/module-functions.ex matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [elixir/imports-comments.ex matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [bash/functions.sh matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [bash/source-comments.sh matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [haskell/module-functions.hs matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [haskell/imports-comments.hs matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [ocaml/module-class.ml matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [ocaml/opens-comments.ml matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [dart/class-extensions.dart matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [dart/imports-comments.dart matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [html/document.html matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [html/comments-assets.html matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [css/selectors.css matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [css/at-rules-comments.css matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [toml/config.toml matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [toml/array-tables.toml matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [yaml/service.yaml matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [yaml/anchors-comments.yaml matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [markdown/guide.md matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [markdown/fences-lists.md matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [text/notes.txt matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [text/wrapped-paragraph.txt matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [typescript/component.tsx matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [typescript/esm-module.mts matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [typescript/commonjs.cts matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [typescript/declarations.d.ts matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [javascript/component.jsx matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [javascript/esm-module.mjs matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [javascript/commonjs.cjs matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [python/stubs.pyi matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [scala/report.sc matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [kotlin/report.kts matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [elixir/report.exs matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [bash/report.bash matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [ocaml/report.mli matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [c/report.h matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [cpp/implementation.cc matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [cpp/format.cxx matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [cpp/declarations.hpp matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [cpp/status.hh matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [html/report.htm matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [yaml/documents.yml matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [markdown/setext.markdown matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [text/events.log matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [text/README matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [text/report.notes matches its reviewed projection](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L91) | covered | windows |
| [keeps a small source chunk as one window](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L117) | covered | windows |
| [uses nested boundaries without creating overlapping child documents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L123) | covered | windows |
| [excludes top-level gaps but retains module-level source blocks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L134) | covered | windows |
| [preserves attached, standalone, and trailing comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L145) | covered | windows |
| [is deterministic](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L152) | covered | windows |
| [keeps full text while returning a compact preview](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L160) | covered | window-edges |
| [allows one indivisible line to exceed the soft target](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L171) | covered | window-edges |
| [rejects invalid target and preview sizes](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L182) | covered | window-edges |
| [splits a nested class without creating method documents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L202) | covered | windows |
| [retains ESM declarations, a standalone comment, and an eager call](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L211) | covered | windows |
| [keeps decorators and class methods under one non-overlapping parent](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L234) | covered | windows |
| [uses nested function definitions as boundaries, not documents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L245) | covered | windows |
| [retains docstrings, standalone comments, and module-level calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L259) | covered | windows |
| [splits an oversized function while retaining declaration context](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L283) | covered | windows |
| [keeps Go methods as independent top-level parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L293) | covered | windows |
| [attaches doc comments and preserves a standalone comment](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L308) | covered | windows |
| [uses impl methods as boundaries under one non-overlapping parent](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L325) | covered | windows |
| [keeps use items, constants, doc comments, and standalone comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L337) | covered | windows |
| [uses methods and a nested record as class window boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L357) | covered | windows |
| [keeps package docs, grouped imports, enums, and comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L368) | covered | windows |
| [keeps includes and typedefs separate from function windows](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L388) | covered | windows |
| [retains preprocessor conditionals as meaningful parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L404) | covered | windows |
| [uses namespace members and class members as module boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L425) | covered | windows |
| [keeps templates, conditionals, and comments as reviewed parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L437) | covered | windows |
| [uses namespace and class members as module boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L457) | covered | windows |
| [keeps file-scoped namespace contents under the namespace parent](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L469) | covered | windows |
| [uses nested classes and methods as module boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L486) | covered | windows |
| [keeps runtime loaders as blocks without losing comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L495) | covered | windows |
| [keeps the open tag separate from namespace-owned declarations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L515) | covered | windows |
| [retains runtime imports, constants, docs, and comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L525) | covered | windows |
| [preserves indentation with package-owned class boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L546) | covered | windows |
| [keeps Scala 3 enums, givens, extensions, and comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L555) | covered | windows |
| [uses class members as package-owned boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L573) | covered | windows |
| [keeps sealed types, data objects, extensions, and comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L582) | covered | windows |
| [keeps table methods as independent top-level parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L600) | covered | windows |
| [keeps require bindings, doc comments, and standalone comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L620) | covered | windows |
| [uses nested container declarations and functions as struct boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L641) | covered | windows |
| [keeps imports as constants and retains documentation comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L650) | covered | windows |
| [uses module functions as non-overlapping boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L671) | covered | windows |
| [keeps aliases, imports, attributes, docs, and comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L680) | covered | windows |
| [keeps functions and script-level commands as independent parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L698) | covered | windows |
| [keeps the shebang with an attached source directive](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L711) | covered | windows |
| [keeps signatures separate while using where bindings as boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L732) | covered | windows |
| [attaches Haddock to the signature and preserves comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L751) | covered | windows |
| [uses class methods as module-owned boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L767) | covered | windows |
| [keeps opens, aliases, values, docs, and comments distinct](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L776) | covered | windows |
| [uses class members as boundaries and retains extensions](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L797) | covered | windows |
| [keeps imports, constants, async functions, docs, and comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L812) | covered | windows |
| [uses nested elements as boundaries under the document element](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L834) | covered | windows |
| [attaches leading comments to elements and preserves final comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L844) | covered | windows |
| [keeps selectors as independent retrieval parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L865) | covered | windows |
| [uses nested at-rules as boundaries and preserves comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L877) | covered | windows |
| [keeps root properties separate and tables as retrieval parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L898) | covered | windows |
| [keeps repeated array tables as distinct source chunks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L912) | covered | windows |
| [uses nested mappings and sequences as document-owned boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L933) | covered | windows |
| [retains anchors, merge keys, block scalars, and comments](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L943) | covered | windows |
| [uses nested headings as section boundaries under one document](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L962) | covered | windows |
| [retains fenced code, lists, and block quotes verbatim](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L971) | covered | windows |
| [keeps separated paragraphs as independent retrieval parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L993) | covered | windows |
| [splits an oversized paragraph only at whole-line boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1002) | covered | windows |
| [keeps TSX expressions inside their owning component function](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1025) | covered | windows |
| [retains distinct ESM and CommonJS module structures](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1034) | covered | windows |
| [keeps declaration-only signatures as meaningful parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1042) | covered | windows |
| [keeps JSX markup and expression callbacks with the component](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1063) | covered | windows |
| [retains ESM exports and CommonJS assignment blocks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1071) | covered | windows |
| [keeps stub declarations and overloads without implementations](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1083) | covered | windows |
| [keeps Scala and Kotlin script statements as meaningful blocks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1099) | covered | windows |
| [keeps Elixir script execution outside its module owner](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1108) | covered | windows |
| [retains Bash shebangs, sourced files, functions, and execution](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1118) | covered | windows |
| [keeps OCaml interface declarations as named source parents](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1129) | covered | windows |
| [keeps a C include guard as the header retrieval owner](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1150) | covered | windows |
| [reviews every alternate C++ source and header extension](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1160) | covered | windows |
| [keeps .htm nested elements under its document element](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1183) | covered | windows |
| [keeps separate YAML documents as separate owners](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1191) | covered | windows |
| [recognizes Setext sections through .markdown](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1199) | covered | windows |
| [reviews known, extensionless, and unknown text paths](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1215) | covered | windows |
| [has fixture evidence for every chunker extension](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1229) | covered | window-inventory |
| [keeps a human-reviewable golden beside every fixture](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/source-windows.test.ts#L1246) | covered | window-inventory |

## text-chunker.test.ts

**text-normalization**: All archived text fixtures check paragraph/gap spans, full leaf coverage, determinism, and BOM/CRLF normalization through production analysis. Evidence: [check](../../../tests/unit/ts_v2_source/reviewed.rs), [language](../../../tests/unit/ts_v2_source/reviewed.rs).

**text-cases**: Rust checks empty text, whitespace-only gaps, arbitrary extensions and no semantic inference from code-looking prose. All archived text fixtures are additionally compared in full. Evidence: [text_fallback_preserves_whitespace_and_never_infers_semantics](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [splits nonblank paragraphs while preserving whitespace gaps](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/text-chunker.test.ts#L14) | covered | text-normalization |
| [normalizes BOM and CRLF before deterministic paragraph chunking](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/text-chunker.test.ts#L31) | covered | text-normalization |
| [treats space-only and tab-only lines as whitespace gaps](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/text-chunker.test.ts#L39) | covered | text-cases |
| [keeps empty text empty](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/text-chunker.test.ts#L49) | covered | text-cases |
| [does not infer facts from code-looking prose, paths, or URLs](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/text-chunker.test.ts#L57) | covered | text-cases |
| [routes arbitrary text extensions through the same fallback](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/text-chunker.test.ts#L61) | covered | text-cases |

## toml-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [does not invent imports or calls from tool-specific property names](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/toml-facts.test.ts#L14) | covered | facts |
| [does not interpret paths and inline tables as source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/toml-facts.test.ts#L18) | covered | facts |

## typescript-variants.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [preserves ESM imports, exports, and calls in .mts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/typescript-variants.test.ts#L19) | covered | facts |
| [keeps JSX elements structural and extracts only expression calls](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/typescript-variants.test.ts#L37) | covered | facts |
| [TSX-E1 preserves calls in every reviewed JSX expression context](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/typescript-variants.test.ts#L51) | covered | facts |
| [models TypeScript CommonJS imports and export assignment in .cts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/typescript-variants.test.ts#L69) | covered | facts |
| [CJS-E1/E2 applies selected requires and object exports to .cts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/typescript-variants.test.ts#L93) | covered | facts |
| [CJS-E2/E3 applies chained exports and exact re-exports to .cts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/typescript-variants.test.ts#L124) | covered | facts |
| [CJS-L1 applies CommonJS global shadowing and reassignment rules to .cts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/typescript-variants.test.ts#L156) | covered | facts |

## yaml-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

**extension-dispatch**: All archived native extensions have fixture evidence and dispatch through the production native analyzer, with exact expected source chunks. Evidence: [every_archived_fixture_and_golden_is_checked_without_changes](../../../tests/unit/ts_v2_source/reviewed.rs), [check](../../../tests/unit/ts_v2_source/reviewed.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [does not invent imports or calls from schema-specific keys](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/yaml-facts.test.ts#L14) | covered | facts |
| [does not interpret anchors, aliases, tags, or URLs as source facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/yaml-facts.test.ts#L18) | covered | facts |
| [routes both YAML extensions through reviewed support](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/yaml-facts.test.ts#L22) | covered | extension-dispatch |

## zig-facts.test.ts

**facts**: All fixtures used by the archived language fact and JS/TS variant suites are included in the 272-case corpus. Rust production dispatch compares the complete import/export/call model, owners, bindings, targets and UTF-8 spans with pinned TS output. TOML/YAML/text explicitly retain empty fact arrays. Evidence: [facts](../../../tests/unit/ts_v2_source/chunker.rs), [text_and_configuration_have_no_semantic_facts](../../../tests/unit/ts_v2_source/chunker.rs), [every_language_fact_survives_raw_offsets_and_storage_round_trips](../../../tests/unit/ts_v2_source/chunker.rs).

**native-structure**: Rust has explicit structural ownership/name/span checks for this behavior, supplemented by the archived source-window trees. This classification covers the structural assertion, not TS resolved fact fields. Evidence: [native_languages_match_pinned_ts_chunks](../../../tests/unit/native_languages.rs), [check](../../../tests/unit/ts_v2_source/reviewed.rs), [bash_environment_bindings_are_not_persistent_declarations](../../../tests/unit/native_languages.rs), [html_void_tags_do_not_swallow_the_following_elements](../../../tests/unit/native_languages.rs), [lua_assignments_methods_and_function_fields_keep_written_names](../../../tests/unit/native_languages.rs), [zig_containers_tests_and_errors_keep_distinct_names](../../../tests/unit/native_languages.rs), [ocaml_interfaces_bindings_and_functions_use_the_selected_grammar](../../../tests/unit/native_languages.rs).

| TS test | Status | Assessment |
| --- | --- | --- |
| [extracts literal imports and C includes without guessing dynamic imports](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L18) | covered | facts |
| [binds imported namespaces and cImport aliases](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L34) | covered | facts |
| [targets direct functions and binds parameters and locals](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L43) | covered | facts |
| [owns calls inside declarations, methods, tests, and comptime blocks](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L60) | covered | facts |
| [keeps Zig container declarations distinct](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L76) | covered | native-structure |
| [does not fabricate Zig export facts](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L91) | covered | facts |
| [ZIG-L1 scopes payload captures without leaking them](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L97) | covered | facts |
| [ZIG-L2 respects declaration timing, reassignment, and block boundaries](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L119) | covered | facts |
| [ZIG-E1 preserves literal embedded resources without guessing dynamic paths](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L140) | covered | facts |
| [ZIG-G1 pins the bundled grammar's destructuring recovery gap](https://github.com/TheWinci/mimirs/blob/122674c8bfbbc3549390743f51396c5f0e4e3537/tests/zig-facts.test.ts#L155) | covered | facts |
