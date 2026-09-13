<div align="center">

<img src="https://raw.githubusercontent.com/TheWinci/mimirs/e30e4b62385b827b953c00a4a283b787707018cc/mimirs-logo-2.png" width="200" alt="mimirs">

# MIMIRS

**Local engineering context for coding agents.**

</div>

Mimirs retrieves source code and recorded engineering knowledge, checks their
support against the current checkout, and returns bounded context for an agent's
task. It combines local hybrid search, source analysis and explicit knowledge
history. It does not call an LLM internally.

The Rust version is an experimental preview. The proof of concept supports trying
it on real engineering work; cost savings across projects and long-term knowledge
maintenance are still being evaluated.

## Try it

Build and install from this checkout with Rust and Git available:

```sh
cargo install --path . --locked
```

From the project you want to investigate:

```sh
mimirs init
mimirs index
mimirs context "streaming indexing failure searchable snapshots retry ownership"
```

Initialization prepares the local embedding model and may download its assets.
The default context budget is 16,000 UTF-8 bytes. Results distinguish indexed
source from current files and recorded claims from their evidence status.
Knowledge is optional; source retrieval works without it.

## Reuse engineering knowledge

```sh
mimirs knowledge setup --repository example/project
mimirs knowledge learn "The complete statement you checked" \
  --evidence src/reader.rs --actor reviewer
mimirs context "reader behavior"
```

Record claims after checking their evidence. Matching evidence covers the declared
support, including any explicitly attached dependencies. It does not establish
semantic truth or verify dependencies that were never recorded. Optional Rust declaration anchors, supplied with `--anchor`, can narrow support to
a named declaration so unrelated file edits need not flag the claim.

Maintenance is a separate user-initiated flow. `mimirs knowledge maintenance` lists
claims needing attention; a claim ID opens evidence and changes. Explicit review
reaffirms the statement. Replacement records a changed statement and preserves its
history. Ordinary context requests require neither operation.

Review and replacement require a clean checkout on the configured default branch.
Inspect a claim with `mimirs knowledge maintenance CLAIM_ID`, save that response
outside the checkout, and pass it with `--assessment` to `review-assessed` or
`replace`. Use `--reviewed` only after checking the statement and its complete
support. A stale assessment requires a fresh inspection. Use `--promote` explicitly
when making provisional knowledge portable.

Use `mimirs context "your task" --knowledge off` to skip knowledge loading and
assessment for a request.

## Keep context available

```sh
mimirs watch
mimirs mcp --root /absolute/path/to/project
```

Watch runs in the foreground and updates source, analysis, vectors, relationships
and mechanical knowledge assessments. It does not start an LLM or author reviews.
The local MCP server exposes five tools: `context`, `maintenance`, `learn`, `review`
and `replace`.

Use `search`, `inspect` and `relationships` independently when you need source-only
results. Knowledge sharing uses explicit `publish` and `pull` operations with a
filesystem registry. Configure it with:

```sh
mimirs knowledge setup --repository example/project --registry /path/to/registry
```

Checkouts must use the same logical repository identity; exchange Git history
separately. `mimirs status` reads local
activity and historical outcomes without running a model or assessing source.

## Command help and development

Built-in help covers the supported commands and their options:

```sh
mimirs --help
mimirs knowledge setup --help
mimirs knowledge maintenance --help
mimirs knowledge review-assessed --help
mimirs knowledge replace --help
mimirs mcp --help
```

Build and run the default tests with `cargo build --locked` and `cargo test --locked`.
Tests that require optional model assets remain ignored by default. The source
package contains the implementation, tests and this README. Extended local docs,
runnable examples, research and agent configuration are excluded.

## Why the name

In Norse myth, Odin preserved Mímir's head and consulted it for counsel. The name
reflects the aim: engineering knowledge that remains useful beyond one session.

## License

Apache-2.0
