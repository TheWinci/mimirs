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

Run these commands from the project root. Fresh config includes Rust `.rs`,
Python `.py` and `.pyi`, TypeScript `.ts`, `.mts`, `.cts`, and `.tsx`,
JavaScript `.js`, `.mjs`, `.cjs`, and `.jsx`, and Go `.go` files. This includes
`.d.ts` declarations. `node_modules` and common Python environment directories `.venv`,
`venv`, and `__pycache__` are excluded. Customize `include` and `exclude` in
`.mimirs/config.toml` for your project.
`init` preserves an existing config. The first model use can download files;
indexing and search then use the local cache.

Indexing embeds one source chunk per call with a CPU budget for the whole worker
pool. By default it uses one-third of available logical CPUs, rounded down, with
at least one worker. Set an absolute maximum in `.mimirs/config.toml`:

```toml
embedding_workers = 3
```

Each worker uses one inference thread. Larger values are clamped to available
CPUs; zero and non-integer values are invalid. Remove the entry to restore the
automatic default. This controls concurrency, not a hard CPU percentage. Workers
finish the current file before indexing moves on, and changing this setting
does not require rebuilding unchanged files. Each active worker needs its own
model session; sessions are created only as files need more workers and reused.
Search embeds its single query with one worker.

Tree-sitter identifies Rust items for embedding. Small functions and methods
stay whole, including attached docs and attributes, with a short file and
containing type/module prefix. Modules, impls, and traits contribute their own
source around child items without duplicating the child bodies. Imports,
comments, macro bodies, and incomplete source remain searchable. Embedding
inputs preserve source spellings, operators, and literals. Ordinary comments
outside items stay separate and can rank ahead of the code they describe; Rust
doc comments attach to their item.

Python classes partition around methods and nested classes. Functions and methods
retain their bodies, decorators, and docstrings, including any nested definitions.
Method inputs include the enclosing class name. Imports, assignments, and ordinary
comments stay in surrounding source chunks. Stub overloads keep separate owners
even when their names repeat. Python analysis stores declaration scopes,
signatures, decorator and docstring facts, and parse diagnostics. It does not
resolve imports or calls. No Python installation or language server is required.

TypeScript and JavaScript classes and namespaces partition around declarations.
Functions, methods, interfaces, aliases, enums, class fields, and module-level
variable declarations keep their source bodies. Bound arrow functions and JSX
stay in their initializer's chunk. Export and `declare` prefixes, decorators,
and adjacent JSDoc comments stay with the declaration. Overloads have separate
owners; anonymous exports, destructuring, and multi-binding declarations remain
unnamed. Imports, re-exports, ordinary comments, and incomplete syntax stay
searchable. Analysis records written names, containment, signatures, and parse
diagnostics without resolving imports, calls, or types. The grammars ship in the
binary. No Node.js installation or language server is required.

Go functions and receiver methods retain their written headers and bodies.
Methods remain file-level owners, with the receiver in their source signature.
Types, aliases, variables and constants keep their full declarations. Groups
partition around individual specs, preserving group documentation, keywords and
separators in the group's source. A multi-name spec has one unnamed owner.
Contiguous leading comments attach to their declaration; blank lines and trailing
comments stop attachment. Struct fields, interface elements, local declarations
and function literals remain inside the containing declaration.

Go imports, package comments, build constraints and cgo preambles remain source.
Mimirs does not load packages, evaluate build tags or expand `iota` and omitted
constant expressions. Tests and platform-specific files follow the include and
exclude rules; `vendor` stays excluded by default. No Go installation is required.
The pinned grammar can report recoverable separator diagnostics for compact
parenthesized declarations. Inspection exposes those diagnostics, and indexing
retains the original source.

Large items split on source lines, repeating their signature. A single oversized
line splits at tokenizer and UTF-8 boundaries. Every complete input, including
context and special tokens, fits the backend's 512-token limit. File context
and repeated signatures each use at most a quarter of that budget. These are
initial splitting limits, not measured optima.

Included files without a supported parser use paragraph chunks and the same
token-limited splitting. They receive no inferred syntax facts. A physical line
is a split boundary for overflow, not an embedding unit.

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

Search ranks each entity by its best matching document and displays up to three
matching documents. Each block contains the exact embedded text and its own
source evidence ranges. The best match appears first; other selected documents
follow in source order. Results identify the indexed snapshot and entity location.
When the cap omits matching candidates, the result reports their count. It does
not fetch every part of the entity.
Ownerless source blocks group into one result per file. Candidate retrieval can
expand to 4,096 documents; many parts belonging to the same entity can yield
fewer results than requested. Entity ordinals identify only the saved snapshot.
A failed replacement cannot return that file's old source or vectors.

The caller prepares the query. Distill the request into a short description of
the relevant behavior or symptom, preserving supplied identifiers and constraints.
Mimirs embeds the query directly. Both documents and queries use q8 MiniLM weights
from `Xenova/all-MiniLM-L6-v2`, file `onnx/model_quantized.onnx`, at revision
`751bff37182d3f1213fa05d7196b954e230abad9`. Tokenizer files remain pinned to
`Qdrant/all-MiniLM-L6-v2-onnx` at revision
`5f1b8cd78bc4fb444dd171e59b18f3a3af89a079`, with a 512-token limit.
Stored embeddings remain 384-dimensional float32 vectors.

### Measuring indexing time

```sh
cargo build --release
mimirs index --profile .mimirs/index-first.json
mimirs index --profile .mimirs/index-reuse.json
```

`--profile` writes a new local JSON report and refuses to overwrite an existing
file. Keep reports outside included source paths. The report records exclusive
phase wall times, unassigned time, file/byte/document counts, embedding call
sizes, and per-file costs. Per-file times overlap the aggregate phases; do not
add them together. Nested work is subtracted from its enclosing phase.

`model_assets` includes cache lookup or downloads and asset reads.
`model_startup` measures tokenizer and ONNX session creation. `embedding`
includes FastEmbed's internal tokenization, inference, and pooling. Batch counts
refer to calls made by mimirs, not sampled CPU work. Timings stop before report
serialization. Ordinary index output and saved embeddings keep their format.
An index error writes `complete: false` and the error when the report can be
saved. Abrupt process termination may prevent a report from being written.

Use `--model-cache /path/to/separate-cache` to measure model acquisition without
clearing the normal cache. `init` ordinarily prepares the model first, so a
cold-cache index experiment includes work that a user may already have waited
for during `init`. It does not measure package installation or compilation.

The [index timing check](benchmarks/index/README.md) describes the controlled
release-build scenarios and the evidence for the next optimization.

### Updating an existing alpha index

The q8 default requires re-embedding existing float32 indexes. Run `mimirs index`
to rebuild them for index version 9. Search rejects old indexes until rebuilt.

Source chunks are the single embedding strategy. Remove the obsolete `retrieval`
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
