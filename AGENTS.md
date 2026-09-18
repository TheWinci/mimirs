Follow YAGNI principles, and prefer one-liner solutions

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