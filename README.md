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

`2.0.0-alpha.0` is an early Rust rewrite and is not usable yet.

The stable release is the TypeScript implementation on npm:

```sh
npm install -g mimirs
```

## License

Apache-2.0
## Rust indexing and retrieval

Build the Rust CLI with `cargo build`. In a project, run `mimirs init`, then
`mimirs index`. The default config includes Rust files. Indexing runs the local
MiniLM embedding model; its first use can download model files.

The caller prepares the search query. Distill the request into a short description
of the relevant behavior or symptom. Preserve identifiers and constraints supplied
in the request. Remove unrelated conversation and avoid guessed internal names.
Mimirs embeds the supplied query directly, without an internal LLM rewrite.

```sh
mimirs search 'valid_username check for trailing newline' --limit 5
```

Raw nonblank source lines remain the default embedding input. To try descriptions
of extracted Rust facts and written relations, set this in `.mimirs/config.toml`
and run `mimirs index`:

```toml
retrieval = "facts"
```

Set `retrieval = "raw"` and reindex to return to raw inputs. Search follows the
stored index policy, even if config changes before indexing. Policy changes clear
old output before replacement. A failed replacement cannot expose the file's old
facts or vectors. Recognized older alpha database schemas rebuild on writable
open; read-only inspection and search require a current schema.

Facts descriptions include entity identity, written signatures, attached docs,
comments owned by that entity, and syntax occurrences. They split at clause
boundaries to fit the backend tokenizer limit, retaining source evidence for each
part. Calls and references remain unresolved. There is no type inference, macro
expansion, cross-file call graph, or generated behavior summary. Rust files without
extracted evidence produce no facts documents. Custom non-Rust includes keep raw
line embeddings.

Facts search returns one result per entity, using its best matching document
score. It includes the matching description, indexed snapshot hash, entity lines,
and evidence byte ranges. It can expand candidate retrieval to 4096 documents per
vector table; exceptionally many duplicate parts can yield fewer results than
requested. Entity ordinals identify only that saved snapshot.

```sh
mimirs inspect src/example.rs --documents
mimirs inspect src/example.rs --stored
mimirs inspect src/example.rs --stored --documents
```

The first command previews descriptions without a model. The stored forms read
saved source and facts, so they work after the current source changes or disappears.
Stored descriptions are rendered from the indexed analysis; token-split matching
inputs appear in search results. Exact source remains in the index as evidence.

Facts currently remain an explicit option because the initial Rust comparison
showed retrieval regressions. See [the reproducible comparison](benchmarks/retrieval/README.md)
for requests, results, costs, and limitations.
