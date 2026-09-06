# TS v2 retrieval reference

This reference describes the active search path at
`122674c8bfbbc3549390743f51396c5f0e4e3537`. It is an implementation contract,
not a claim that each policy is optimal. Rust's pre-port q8 revision is
`0b767fde2b870270ef26c2fd3c1f770b1da55fd7`.

`reference.json` contains outputs captured by executing the archived TS code.
The exporter verifies every tracked file under `src/` and `packages/`, plus the
root package manifest and lockfile, against Git blobs before importing it.
It uses controlled two-dimensional vectors to isolate retrieval from inference.
The final document-input cases use the cached production tokenizer without
downloading assets or running model inference. Runtime versions and source
SHA-256 hashes accompany the output.

## Reproduce

Use the extracted, dependency-installed v2 engine prepared by the existing
version-comparison setup. The output must be a new file:

```sh
bun benchmarks/versions/port-reference.ts /tmp/mimirs-three-way/engines/v2 /tmp/reference-new.json
cmp benchmarks/versions/port/reference.json /tmp/reference-new.json
python3 -m unittest discover -s benchmarks/versions -p 'test_*.py'
```

The archived Bun SQLite adapter requires an extension-capable SQLite on macOS.
`reference.json` records the SQLite and Bun versions used. An environment change
may change these metadata fields or native numerical results; investigate the
diff instead of replacing the fixture automatically. Fixture checks require
neither the TS engine nor model files once the output has been captured.

To freeze new baseline artifacts from completed runs, use the existing runner
with explicit `--corpora mimirs excalidraw django --versions rust --repeats 1`
in a separate benchmark root containing the pinned production q8 binary and
the original corpus manifests. Preserve that root's `provenance.json` with
`source_revision` and `binary_sha256`. Reuse the completed TS v2 root:

```sh
python3 benchmarks/versions/port-baseline.py \
  --root /tmp/mimirs-retrieval-port-baseline \
  --reference-root /tmp/mimirs-three-way \
  --output /tmp/verified-port-baseline
```

The collector rejects changed query/corpus definitions, inconsistent saved
scores, mismatched source snapshots, and a non-q8 Rust index. It also checks
production Mimirs rankings against the retained q8 pilot before publishing a
report. Its output directory must not already exist.

## Public entry point

The benchmark calls `openReadOnlyProjectSearch()` and scores
`session.search({query, maxResults: 20}).source`. The session attaches an already
indexed database. Its active path is:

1. `ProjectSearchSession.search` calls `searchIndex` with a source limit of 100.
2. `search` calls `searchCandidates` with a candidate-result limit of 100.
3. Native SQLite retrieval collects and completes semantic and lexical scores.
4. Ranking groups windows into source chunks, applies signals, and groups chunks
   into files. It sorts and keeps at most 100 file candidates.
5. `segmentSearchResults` separates documentation and source, follows strict
   documentation references, and ranks the resulting source files.
6. The session keeps the caller's requested number of source files and filters
   reference relations to returned source paths. Documentation has its own limit.

The session also retrieves fact and relation candidates. With omitted
`perspectiveFusion`, they are observational output and do not change source
ordering. Disabled fusion policies and the alternative exact, window, anchored
file, text-only, and v1-like search modes are not production defaults.

Source anchors in the pinned tree: `src/internals/search/read-only-project-search.ts`,
`project-search.ts:234`, `search.ts:303`, and `document-search.ts:128`.

## Lexical retrieval

`lexicalTerms` first applies NFKC normalization, splits lower-case/digit to
upper-case boundaries and acronym-to-word boundaries, then lowercases with the
`en-US` locale. It extracts Unicode letter/number sequences. One-character
terms are dropped unless they are ASCII decimal digits. Underscores and path
punctuation separate terms. Document term duplicates remain; query terms are
deduplicated.

The three FTS columns contain space-joined terms for path, source-chunk name,
and full source-window text. The table uses FTS5 `unicode61`, contentless storage,
and `contentless_delete`. SQLite applies its own tokenizer after TS preprocessing,
including its default diacritic behavior. Query terms are individually quoted
and joined with `OR`. Punctuation in the user's query is not FTS syntax. A
query producing no terms has no lexical candidates.

Production scores are `-bm25(source_windows_fts, 2.0, 3.0, 1.0)`. Higher scores
are better. Ordering uses BM25, file path, window start, and window id. The
initial lexical limit is 100.

The in-memory `rankLexicalDocuments` helper is not numerically equivalent:
it duplicates weighted field terms and uses a positive-IDF formula rather than
the native FTS5 calculation. Both outputs are saved in the fixture to prevent
accidentally porting the test reference as the production scorer.

Source anchors: `search/lexical-search.ts`, `storage/encoding.ts:53`,
`storage/source-index/lexical.ts`, `storage/source-index/candidates.ts:223`,
and `storage/schema.ts:122`, under `src/internals/`.

## Candidate completion and fusion

The initial semantic query requests the nearest 150 source windows from vec0.
Its score is `1 - distance`. It does not prefilter by a relevance threshold.
No query embedding is requested when the index has no source vectors; lexical
retrieval can still return results.

Completion is enabled in both directions. The union of the initial candidate
sets is the only candidate universe for completion:

- For lexical candidates missing semantic scores, load their vectors and compute
  cosine. A missing vector does not become a zero-vector semantic hit.
- For semantic candidates missing lexical scores, run the original full-corpus
  FTS match restricted to those ids. Nonmatching windows do not get lexical ranks.
- Sort each completed channel again. Completed lists can exceed their initial
  limits. They are not truncated back to 100 and 150.

Ranks are one-based. A missing rank contributes zero. With semantic rank `s`
and lexical rank `l`, fusion uses:

```text
61 * (0.6 / (60 + s) + 0.4 / (60 + l))
```

Source anchors: `storage/source-index/candidates.ts:299`,
`search/search.ts:303`, and `search/scoring.ts:81`.

## Grouping, signals, and ties

The production aggregation is `chunk-file`:

- Group candidate windows by source-chunk id. Use the best semantic rank and
  best lexical rank independently, even when different windows supply them.
- Select a representative window by its own fused score. Keep the union of
  windows, maximum component scores, and representative preview.
- Apply signals to each grouped chunk before grouping files.
- Keep the highest-scored chunk per file and add `0.25 * min(best, second)`
  when another chunk exists. Further chunks do not add another confirmation
  bonus, though their window/chunk metadata is merged.

| Signal | Multiplier | Condition |
| --- | ---: | --- |
| Exact name | 1.2 | Every lexical term in the chunk name occurs in the query |
| Unique symbol | 1.3 | An eligible query identifier is defined in exactly one file |
| Test path | 0.85 | Path matches the TS test-pattern list |
| Generated path | 0.75 | Path matches the project's generated globs |

Exact-name and unique-symbol lookup are gated by semantic weight being below
one. Unique means one distinct file, not one declaration. Eligible identifiers
have capitals, underscores, or a dot, pass the length/stop-word filters, and
are not all-capital constant-like names. SQLite NOCASE lookup is another
distinct normalization step.

The test patterns cover test/tests/spec directories, `__tests__`, `.test.*`,
`.spec.*`, and filenames starting `test_`. `worker_test.go` does not match.
Generated globs normalize slashes and also match at directory suffixes.
The benchmark config supplies an empty generated list.

Final hybrid scores can exceed one; they are neither cosine similarities nor
probabilities. Sort by fused score descending, semantic score descending, path,
window start, then id. The code uses both JS ordinal comparison and
`localeCompare` in different stages. Preserve stage-specific ordering, and
investigate locale-sensitive differences instead of assuming one comparator
fits every stage. The captured runtime fixes the reference environment.

Source anchors: `search/candidates.ts`, `search/signals.ts`,
`search/scoring.ts`, and `search/config.ts`.

## Documentation and displayed evidence

Documentation extensions are md, mdx, markdown, rst, txt, and adoc. Return up
to five documentation files, inspect up to ten ranked documentation files and
six windows per file, accept at most three references per document and ten
references overall. References are explicit paths, file-like Markdown links,
and restricted qualified symbols. Only indexed source paths can resolve.

A referenced source file can inherit 0.6 of the documentation score. Existing
and inherited file hits merge their evidence while keeping the stronger hit.
Reference selection is source ordered; a symbol selects a window whose owning
chunk encloses the definition, with a first-window fallback. It is not a fresh
semantic search inside the referenced file.

The default preview is 96 Unicode code points with whitespace collapsed and
an ellipsis on truncation. A grouped result can carry ranges for multiple
windows while displaying only its representative preview. That preview must
not be described as the complete evidence. The Rust port must retain exact
stored source blocks and identify any omitted display content independently
of ranking. Snapshot identity and raw byte evidence remain Rust guarantees.

Source anchors: `search/documents/config.ts`, `references.ts`, `citations.ts`,
`search/document-search.ts`, and `source/windows.ts:257`.

## Source windows and embedding inputs

TS normalizes source before indexing: it removes an initial BOM and converts
CRLF and lone CR to LF. Its persisted source-window positions are JS UTF-16
code-unit offsets into this normalized text. They are not raw UTF-8 byte offsets.
The fixtures save both original and normalized source, including Unicode/CRLF.
Rust keeps raw snapshots; parity requires an explicit mapping between normalized
retrieval positions and raw source evidence, not copying TS offsets into byte spans.

Top-level source chunks produce nonoverlapping source windows with a preferred
target of 4,000 UTF-16 code units. Top-level gaps are omitted. Child boundaries
and whole lines are preferred for oversized chunks; indivisible lines can exceed
the target. Closing delimiters can remain with the preceding group. Windows
retain their top-level owner. A class can therefore have one window containing
many methods, unlike the pre-port Rust container partitioning.

The active document projection is `File: <relative path>\n<window text>`.
`miniLmPathAverageEmbedder` splits oversized projections into exact source
substrings with the path prefix repeated. Each complete model input fits 256
tokens including special tokens. Overlap walks whole pre-tokenized source
pieces backward until at least 32 tokens are covered while guaranteeing progress.
It is not necessarily exactly 32 tokens. Oversized indivisible pieces fail.

Each unique final document input is embedded independently, then its normalized
384-dimensional float32 vector is reused for duplicates within the call.
Multi-input source windows average their sub-vectors equally and normalize
again. Float32 rounding occurs during accumulation/division. TS's outer storage
batch defaults to 1,024 windows; this does not mean a 1,024-input inference batch.

Queries have no path prefix. Oversized queries follow the separate token-id
window/decode path with 256 tokens and overlap 32, then normalized averaging.
Raw-query/fact embedding uses token-length ordering and batches up to 32.
Document inference is singleton; these paths must not be conflated.

Both versions use q8 MiniLM at Xenova revision
`751bff37182d3f1213fa05d7196b954e230abad9`. TS uses that revision's tokenizer;
pre-port Rust uses the pinned Qdrant tokenizer and 512-token inputs. Equal
weights or vocabulary do not prove identical complete tokenization behavior.

Source anchors: `packages/chunk/src/source-text.ts:14`,
`src/internals/source/windows.ts`, `storage/source-embeddings.ts:121`, and
`embeddings/mini-lm.ts:184`, `:244`, `:307`, `:401` under `src/internals/`.

## Comparison rules

Exact comparisons apply to normalized terms, FTS expressions, input token ids,
candidate membership, grouping, ranks, selected windows, and source text. Database
ids may be remapped by path, owner span, and window ordinal when comparing two
independently built indexes. Stored references must still point to the same code.

For double-precision scalar calculations, start with absolute tolerance `1e-12`
plus relative tolerance `1e-9`. Native cosine has absolute tolerance `1e-6`.
For later real-model comparisons on identical inputs, require per-component
absolute difference at most `1e-5` and cosine at least `0.999999`. These are
predeclared acceptance bounds, not evidence that model parity has been measured.
S1 captures token inputs, not real-model vector parity. A failed bound requires
investigation; never increase it silently to make a comparison pass.

Final rankings are exact on controlled fixtures. On full corpora, any mismatch
needs a stage-specific explanation, including numerical ties. Matching aggregate
recall cannot excuse a different algorithm. Preserve the original query labels
and corrections. File recall does not score answer correctness.

Use Mimirs, Excalidraw, and Django during development. Kubernetes remains deferred.
The q8 baseline is saved separately from the historical float32 results so the
earlier comparison remains reproducible. Single-run baseline timings are
descriptive, not statistically established speedups.

## Semantic input port

`port/stages/s5-inputs.json` compares all 27,295 source windows and 162,266
non-gap source chunks from the retained Mimirs, Excalidraw, and Django indexes.
The tree comparison includes kind, name, normalized UTF-16 bounds, and parent.
Rust also retains gap chunks for raw-source coverage; TS skips gaps in storage.
Both window sets and the non-gap trees match exactly. Reproduce extraction
without model inference with the ignored `source_stage_report` Rust test,
setting `MIMIRS_PORT_BASELINE_DB` to the original Rust index and
`MIMIRS_PORT_SOURCE_REPORT` to a new JSON file. Then run:

```sh
python3 benchmarks/versions/port-source-compare.py REPORT TS_INDEX NEW_OUTPUT
```

`port-model-reference.ts` captures actual calls to the pinned TS pipeline and
final vectors for short and long documents and queries. It verifies the frozen
source hashes and uses cached model assets. Reproduce it as follows:

```sh
bun benchmarks/versions/port-model-reference.ts ENGINE NEW_OUTPUT
cargo test real_model_inputs_and_vectors_match_ts_reference -- --ignored --nocapture
cargo test final_document_inputs_match_ts_text_and_token_ids -- --ignored
cargo test real_workers_match_serial_vectors_and_load_sessions_only_when_needed -- --ignored
```

The token windows need one distinction. Documents include path context and fit
within 256 tokens. Queries first split token IDs at 256 with a 32-token overlap,
then decode each slice and re-encode for inference. Adding special tokens at
that step produces 257- or 258-token inputs in the long-query fixture. The
pipeline tokenizer therefore retains TS's 512-token inference ceiling.

On macOS arm64, ONNX Runtime 1.28 changed q8 outputs despite identical weights
and token IDs. The first document differed by 0.004811 in one component and had
cosine 0.999530. Disabling graph optimizations or changing TS thread counts did
not remove the difference. Direct Rust inference with TS's 1.21 runtime reduced
the maximum component error to 1.49e-8. The distributable 1.22 runtime gives the
same accepted result for every model fixture. Rust pins `ort` rc.10 and its 1.22
runtime, runs each session on one CPU thread, and keeps the existing bounded
worker pool. Pooling uses TS's float64 accumulation and float32 tensor storage.
The original tolerance remains unchanged. Runtime, tokenizer, source policy,
and schema changes all enter index compatibility checks. Results are measured
on the recorded platform; other architectures must run the model check before
claiming equivalent numerical behavior.

The saved Rust q8 baseline remains immutable. It uses its original tokenizer,
runtime, and source documents. Full public indexing costs and final query
rankings belong to the adoption comparison, which uses the same three corpora.

## Adopted production path

The [adoption report](adoption/ADOPTION.md) verifies every source-window vector
and all 262 top-20 rankings on Mimirs, Excalidraw, and Django. Its JSON contains
per-query differences from the original Rust q8 baseline, resource measurements,
and exact-source audits. All TS rank comparisons match and all 27,295 vectors
meet the original tolerance. Kubernetes remains deferred.

Public indexing now constructs TS source windows and embeds their path-aware
token windows. Public search uses the completed lexical/semantic union, ranking
signals, file grouping, documentation segmentation, and reference expansion.
`--limit` counts source files from 1 to 100. Documentation has its separate cap.
The CLI calls the score `relevance`; previews and exact source evidence have
separate fields. Source-chunk inspection previews the same windows before token
splitting. Missing vectors do not remove lexical candidates, while the next index
run detects and repairs incomplete embeddings. Unsupported policies still fail
before search and require reindexing. Generated-path globs come from the current
project config; discovery changes do not replace the saved source snapshot.

Superseded entity retrieval and input construction compile only in tests for
historical fixtures. They are not production strategies or CLI options.
