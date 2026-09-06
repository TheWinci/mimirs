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
## Rust indexing and retrieval

```sh
cargo build
mimirs init
mimirs index
mimirs search 'valid_username check for trailing newline' --limit 5
```

Run these commands from the project root. Fresh config includes Rust files;
customize `include` and `exclude` in `.mimirs/config.toml` for other text files.
`init` preserves an existing config. The first model use can download files;
indexing and search then use the local cache.

Tree-sitter identifies Rust items for embedding. Small functions and methods
stay whole, including attached docs and attributes, with a short file and
containing type/module prefix. Modules, impls, and traits contribute their own
source around child items without duplicating the child bodies. Imports,
comments, macro bodies, and incomplete source remain searchable. Embedding
inputs preserve source spellings, operators, and literals. Ordinary comments
outside items stay separate and can rank ahead of the code they describe; Rust
doc comments attach to their item.

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

Search returns each entity's best matching document, with the exact embedded
text, indexed snapshot hash, entity location, and source evidence ranges.
Ownerless source blocks group into one result per file. Candidate retrieval can
expand to 4,096 documents; many parts belonging to the same entity can yield
fewer results than requested. Entity ordinals identify only the saved snapshot.
A failed replacement cannot return that file's old source or vectors.

The caller prepares the query. Distill the request into a short description of
the relevant behavior or symptom, preserving supplied identifiers and constraints.
Mimirs embeds the query directly. Both documents and queries use MiniLM from
Qdrant/all-MiniLM-L6-v2-onnx at revision
`5f1b8cd78bc4fb444dd171e59b18f3a3af89a079`.

### Updating an existing alpha index

Source chunks are the single embedding strategy. Remove the obsolete `retrieval`
key from `.mimirs/config.toml`, preserving your `include` and `exclude` rules,
then run `mimirs index`. Recognized older alpha indexes rebuild when opened for
writing. Search and stored inspection reject them with reindex guidance.
Analyzer or language-mapping changes also require `mimirs index` to rebuild the
index, including unchanged files previously handled as text fallback.
The old `inspect --documents` facts-description preview has been removed.

This simplifies the implementation without establishing a general retrieval
quality improvement. The five development queries and source-fidelity audit are
recorded in the [retrieval check](benchmarks/retrieval/README.md).
