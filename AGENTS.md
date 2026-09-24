## Scope discipline

- Implement only the requested slice and changes strictly necessary for it.
- Questions about code request explanations, not edits.
- Suggestions such as “maybe we should” are discussion, not authorization.
- Do not add speculative features, abstractions, recovery policies, or future-proofing.
- Preserve agreed module responsibilities unless explicitly asked to change them.
- Before editing, state the intended scope in one sentence. Do not expand it silently.
- Before finishing, review the diff and remove changes unrelated to the request.
- When explaining a decision, explain the existing behavior without proposing extra features unless asked.

## Readability and simplicity

- Prefer straightforward code over clever or densely packed expressions.
- Use one-liners only when they are easier to understand than multiple steps.
- Give variables and functions names that describe their purpose; avoid
  abbreviations such as `tx` and `rx` when a meaningful name is available.
- Name intermediate values when doing so makes an expression easier to follow.
- Keep each function focused on one responsibility.
- Prefer concrete code over abstractions until a current requirement justifies them.
- Accept small amounts of duplication when extracting a helper would obscure intent.
- Comment on reasons and non-obvious constraints, not what the code already says.

## Responsibilities

- Commands orchestrate: load configuration, connect components, and manage lifecycle.
- File discovery, matching, watching, and indexing belong in their respective modules.
- Keep error propagation straightforward with `?`; add recovery behavior only when requested.

## Rust conventions in this repo

Each rule is one line. The line under it says when the rule bends.

**Borrow what comes in. Own what goes out.**
`&str` and `&Path` parameters, `String` and `PathBuf` returns. Return a borrow only when it is a view of an input, and say why.

**Errors travel with `?`. They stop in `main`.**
`anyhow::Result` everywhere. No `unwrap` or `expect` outside tests. Reach for `thiserror` when a caller must branch on the error kind.

**The struct is the CLI.**
`clap` derive. Flags, defaults, and help text live on the field, so `--help`
cannot drift from the code.

**One command, one file, one `run`.**
`src/commands/<name>.rs` exposing `pub fn run(...) -> anyhow::Result<()>`. Split the file when a command grows past one screen, not before.

**`main` parses and dispatches. Nothing else.**
Logic in a handler is testable. Logic in `main` needs a process to reach it.

**The last expression is the return.**
No trailing `return Ok(());`. Use `return` only to leave early.

**Edition 2024.**
New dependency needs a reason in the commit body.

## Commands

| Action | Command |
|---|---|
| Build | `cargo build` |
| Run | `cargo run -- <subcommand>` |
| Lint | `cargo clippy --all-targets` |
| Format | `cargo fmt` |
| Test | `cargo test` |

Run `cargo fmt` before every commit.

## Commits

Use Conventional Commits. Write a terse subject and a short reason. One commit for each slice.

Do not add a `Co-Authored-By` trailer or any other attribution trailer. The author of the commit is the user.