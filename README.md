<div align="center">

<img src="https://raw.githubusercontent.com/TheWinci/mimirs/e30e4b62385b827b953c00a4a283b787707018cc/mimirs-logo-2.png" width="200" alt="mimirs">

# mimirs

**Local-first persistent project memory and semantic search with graph for AI coding agents.**

</div>

---


## Why the name

In Norse myth, Odin preserved the head of Mímir and consulted it for
counsel long after Mímir died. Knowledge that outlives the moment, and
answers when asked.

That is the idea. An agent should not rediscover your codebase every
session.

## Mission

Coding agents burn most of their budget re-reading files they have
already read. `mimirs` gives them a durable, local index of a project —
semantic search over AST-aware chunks (tree-sitter), plus memory that
persists across sessions.

Everything runs on your machine. No API keys, no code leaves the repo.

## Status

`2.0.0-alpha.0` is an early Rust rewrite with a working indexing and search CLI.
MCP serving is not implemented yet.

The stable release is the TypeScript implementation on npm:

```sh
npm install -g mimirs
```

## License

Apache-2.0

## Indexing and retrieval

```sh
cargo build
mimirs init
mimirs index
mimirs search 'valid_username check for trailing newline' --limit 5
```

Run these commands from the project root. Fresh config includes the
[languages and formats supported by v1 and TS v2](docs/languages.md), with
native grammars for 24 languages plus Markdown sections and explicit text
fallback. Common dependency, environment and build directories are excluded.
Customize `include` and `exclude` in `.mimirs/config.toml` for your project.
`init` preserves an existing config. The first model use can download files;
indexing and search then use the local cache.

Indexing embeds one token window per call with a CPU budget for the whole worker
pool. By default it uses one-third of available logical CPUs, rounded down, with
at least one worker. Set an absolute maximum in `.mimirs/config.toml`:

```toml
embedding_workers = 3
```

Each worker uses one inference thread. Larger values are clamped to available
CPUs; zero and non-integer values are invalid. Remove the entry to restore the
automatic default. This controls inference concurrency, not a hard CPU percentage.
A reader/parser worker and a window preparation worker run alongside inference.
A separate merger collects ordered vectors, and one writer owns SQLite
mutations. Database writes can overlap the next file's preparation and inference.
Each inference worker owns a model session. Its thread and session persist across
files. The pool
starts when a file needs embeddings. Changing the worker setting does not
require rebuilding unchanged files. Search embeds its query with one worker.

Indexing allows at most twice the worker count in-flight files. Read-ahead pauses
when reservations for active files reach a 32 MiB target. Each file reserves
64 times its source and path bytes plus 64 KiB for expanded analysis, windows,
and results. The reservation follows the file through all stages. An oversized
file runs alone. These conservative estimates are not a total memory cap.
Files commit in discovery order. On failure, earlier commits remain, the failed
replacement is invalidated, and later queued results are discarded. In-flight
model calls finish before indexing returns. The scheduling change preserves
existing index compatibility and singleton inference inputs.

File discovery streams through a bounded channel while indexing runs. Until
discovery finishes, progress reports completed files without inventing a final
total. Paths still publish in the same canonical order as a fully sorted walk.

Intermediate results commit to `.mimirs/staging.db`: discovered work, source and
analysis, documents and window mappings, then merged vectors. The writer drains
these stages while inference continues. Complete files replace their searchable
rows atomically in `.mimirs/index.db`. Staging has its own schema version and does
not change document or model identities. Unchanged files reuse their live data.

During incremental indexing, the writer releases unused database cache after
publication so the separate reader can check unchanged files efficiently.

One OS writer lock covers indexing and cleanup. Published stages are deleted;
abandoned stages are discarded on the next indexing run. Incomplete files are
recomputed from source. Automatic resume from intermediate stages is not enabled.
Profiling reports serialized staging payload bytes and peak database/journal disk
use separately from the published index size. Per-channel payload estimates can
include shared messages; the admission reservation counts each file once.

Native tree-sitter grammars identify retrieval chunks for the
[languages listed here](docs/languages.md#native-syntax). They ship in the binary and
need no language servers or language runtimes. Written declarations, attached
comments, decorators, imports, and incomplete source remain searchable. Retrieval
follows TS v2's chunk boundaries, including collapsed import groups and overloads.
The saved analysis retains its own entity boundaries and syntax facts.

Top-level retrieval chunks form source windows targeting 4,000 UTF-16 units.
Large chunks split at child or source-line boundaries. A long physical line may
exceed that target. Markdown headings form nested sections; included unsupported
text uses paragraph chunks and receives no inferred syntax facts. Supported
Markdown section parsing covers `.md`, `.markdown` and `.mdx`.

Each document adds `File: path` context. MiniLM inputs split into 256-token
windows with a 32-token overlap, repeating the path context. The document vector
is the normalized average of those window vectors. Embedding text removes a
leading BOM and normalizes newlines. Saved evidence always retains the original
UTF-8 bytes, including CRLF. Embedding context is never presented as source.

Go package comments, build constraints, cgo preambles, and receiver signatures
remain available. Mimirs does not load packages, evaluate build tags, or expand
`iota`. Tests and platform-specific files follow the include and exclude rules;
`vendor` stays excluded by default. Recoverable grammar errors appear in inspection
and do not discard the original source.

Rust indexing also stores entities, facts, scopes, diagnostics, and the source
snapshot. That structured analysis stays separate from embedding text. Syntax
relations describe ownership, containment, and written occurrences; calls and
references remain unresolved. Search does not traverse a dependency graph or
rank by those relations. There is no type inference or macro expansion.

```sh
mimirs inspect src/example.rs
mimirs inspect src/example.rs --source-chunks
mimirs inspect src/example.rs --stored
mimirs inspect src/example.rs --stored --source-chunks
```

Inspection needs no model. The plain form reports analysis and syntax relations;
`--source-chunks` previews source chunks before token splitting. Stored forms
use the indexed snapshot even after the working file changes or disappears.
Included unsupported text can also be inspected and is identified as text fallback.

Search combines the first 150 semantic candidates with the first 100 lexical
candidates, completes their missing channel scores, and applies TS v2's weighted
reciprocal-rank fusion. Name matches, unique definitions, test paths, and generated
paths affect ranking before files are grouped. `relevance` is this combined score,
not cosine similarity. The `generated` config accepts path globs and defaults to
an empty list. Search reads these rules from the current config.

`--limit` selects 1 to 100 source files, default 5. Each file has a short preview
and exact source blocks for the selected windows, with byte ranges, lines, owners,
and the indexed snapshot hash. The preview is separate from that evidence.
Selected windows from multiple declarations can appear in one file result.
Documentation has a separate segment of up to five files. Strict links and
qualified references in those documents can add indexed source results.
Missing compatible document vectors still permit lexical retrieval; the next
index run repairs incomplete vectors. Incompatible model or source policies
require rebuilding. A failed replacement cannot return that file's old source.

The caller prepares the query. Distill the request into a short description of
the relevant behavior or symptom, preserving supplied identifiers and constraints.
Long queries split at 256 token IDs with a 32-token overlap, then decode and
re-encode for inference. This can add special tokens beyond 256, so the inference
ceiling remains 512. Documents and queries use q8 MiniLM weights and tokenizer
files from `Xenova/all-MiniLM-L6-v2` at revision
`751bff37182d3f1213fa05d7196b954e230abad9`, with `onnx/model_quantized.onnx`.
The pinned ONNX Runtime 1.22 reproduces the TS reference vectors within the
[recorded tolerance](benchmarks/versions/port/CONTRACT.md). Stored embeddings
remain 384-dimensional float32 vectors.

### Measuring indexing time

```sh
cargo build --release
mimirs index --profile .mimirs/index-first.json
mimirs index --profile .mimirs/index-reuse.json
```

`--profile` writes a new local JSON report and refuses to overwrite an existing
file. Keep reports outside included source paths. The report records exclusive
phase wall times, unassigned time, file/byte/document counts, embedding call
sizes, queue peaks, and per-file costs. Per-file wall times include time waiting
in the queue and can overlap each other. Do not add them together. Phase times
measure exclusive coordinator work; nested work is subtracted from its enclosing
phase.

Profile version 3 adds `queues`, with item counts, total, mean, median, 95th
percentile, and maximum residence in seconds. Channel residence starts after a
send is accepted and ends at dequeue. Inference residence starts at submission
and ends separately when each window is dispatched to a worker. The `admission`
entry measures a file's request-to-grant delay at the capacity gate. Cancelled
items that never dequeue are excluded. Channel counts include control messages;
writer counts include intermediate stages as well as file completions.
Percentiles use nearest rank and retain one timing sample per item only while
profiling is enabled. Queue totals overlap across items and stages and must not
be added to estimate elapsed indexing time.

Stage input/output wait counters measure worker idle time and producer blocking,
not item residence. `inference_completion.input_wait_seconds` measures the
merger waiting for submitted vectors; older reports labelled this time as
`windows.output_wait_seconds`.

`model_assets` includes cache lookup or downloads and asset reads.
`model_startup` measures tokenizer and ONNX session creation. `embedding_prepare`
measures token-window planning and job submission. `embedding_wait` measures only
the coordinator's wait for vectors. Background inference also runs during other
phases, so this wait is not total inference time. Batch counts record singleton
model calls, including calls that started before cancellation. Timings stop before report
serialization. Ordinary index output and saved embeddings keep their format.
An index error writes `complete: false` and the error when the report can be
saved. Abrupt process termination may prevent a report from being written.

Profile version 2 also records `stages`: active time, input/output wait time,
item counts, and queued item/payload peaks. Inference active and idle times sum
the persistent workers from pool startup through shutdown. They can exceed
elapsed process time. Inference activity includes tokenization, model execution,
and pooling; it is not a sample of CPU usage. Nested phase stacks are local to
each thread. With concurrent stages, phase totals are summed thread work and
must not be added to process wall time.

Use `--model-cache /path/to/separate-cache` to measure model acquisition without
clearing the normal cache. `init` ordinarily prepares the model first, so a
cold-cache index experiment includes work that a user may already have waited
for during `init`. It does not measure package installation or compilation.

The [index timing check](benchmarks/index/README.md) describes the controlled
release-build scenarios and the evidence for the next optimization.

### Updating an existing alpha index

The q8 default requires re-embedding existing float32 indexes. Run `mimirs index`
to rebuild them for index version 9. Search rejects old indexes until rebuilt.

The TS v2 retrieval port is the single supported search policy. Schema 11,
normalized token inputs, and the pinned inference runtime require a rebuild of
previous indexes. Run `mimirs index`; existing include/exclude rules remain. Remove the obsolete `retrieval`
key from `.mimirs/config.toml`, preserving your `include` and `exclude` rules,
then run `mimirs index`. Recognized older alpha indexes rebuild when opened for
writing. Search and stored inspection reject them with reindex guidance.
Analyzer or language-mapping changes also require `mimirs index` to rebuild the
index, including unchanged files previously handled as text fallback.

To enable Python in an existing project, add `"**/*.py"` and `"**/*.pyi"` to
`include` in `.mimirs/config.toml`, retain your other includes and exclusions, and
run `mimirs index`. Add `"**/.venv/**"`, `"**/venv/**"`, and `"**/__pycache__/**"`
to `exclude` if your config does not already exclude those directories. `init`
preserves the contents of your existing config.

To enable TypeScript and JavaScript in an existing project, add `"**/*.ts"`,
`"**/*.mts"`, `"**/*.cts"`, `"**/*.tsx"`, `"**/*.js"`, `"**/*.mjs"`, `"**/*.cjs"`,
and `"**/*.jsx"` to `include`. Retain your other rules, exclude
`"**/node_modules/**"`, and run `mimirs index`. The new analyzer registry requires
a rebuild of the index, including files already handled by Rust and Python.

To enable Go in an existing project, add `"**/*.go"` to `include`, retain your
other includes and exclusions, and run `mimirs index`. Registering Go changes the
shared analyzer policy, so this upgrade rebuilds the whole index once. Ordinary
source edits remain incremental.

Fresh configs exclude only the root `/target/**` build directory. Older configs
using `"**/target/**"` also exclude source directories such as `src/target/`.
Replace that entry with `"/target/**"` to include nested source, then run
`mimirs index`. Add explicit exclusions for nested or custom build outputs,
for example `"/crates/tool/target/**"`. This does not discover Cargo workspaces
automatically. Existing configs retain their rules until you edit them.

The old `inspect --documents` facts-description preview has been removed.

This simplifies the implementation without establishing a general retrieval
quality improvement. The five development queries and source-fidelity audit are
recorded in the [retrieval check](benchmarks/retrieval/README.md).

The [Python retrieval check](benchmarks/retrieval/python/README.md) records the
first Python source and mixed-language search verification.

The [TypeScript and JavaScript retrieval check](benchmarks/retrieval/javascript/README.md)
covers dialects, fallback upgrades, mixed-language indexing, and visible answers.

The [Go retrieval check](benchmarks/retrieval/go/README.md) records declaration
groups, receiver methods, fallback upgrades and mixed-language search results.

See [language support](docs/languages.md) for the complete extension list, grammar
versions, fallback behavior and instructions for existing projects.
