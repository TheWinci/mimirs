# CLAUDE.md

mimirs 2.x is a rewrite of the TypeScript tool in Rust. The user knows the
problem domain well and is learning Rust. Optimize every response for both
goals: ship a small working slice, and teach the Rust in it.

## How we work

Work in the smallest slice that runs and gives value. A slice is:

- One command, one flag, or one struct — not a subsystem.
- Compilable and runnable at the end (`cargo run -- <cmd>`).
- Reviewable in one screen of diff.

Rules:

1. Propose the slice before you write the code. State what works after it.
2. Write the slice. Do not add abstraction for a future slice.
3. Run `cargo build` and `cargo clippy`. Report the real output.
4. Explain the Rust. See "Teaching" below.
5. Stop. Let the user read, ask, and decide the next slice.

Do not chain slices without the user. Do not refactor code outside the slice.
If you see a problem elsewhere, name it in one line and continue.

## Teaching

After each slice, add a short section that explains the Rust that is new in
that diff. Keep it to what the diff contains.

- Name the concept (ownership, borrow, `?`, trait, lifetime, enum matching).
- Say why this code needs it here.
- Compare to TypeScript when the comparison is exact. Say where it breaks.
- Show the alternative that you rejected and the reason.

Do not explain a concept twice. Assume the user retains earlier slices.
Do not explain general programming. The user is a senior engineer.

When the user asks "why", answer with the language rule, not with style
preference.

### Land it as a rule

End every explanation with the memorable one-line rule, in bold. The user
keeps the rule; the detail around it fades. Example:

> **Borrow what comes in. Own what goes out.**

Write the rule as an imperative that is short enough to recall at the
keyboard. Add one line under it for the case where the rule bends. Do not
give three rules for one concept — find the single line that covers it.

The detail comes first and the rule comes last. Do not lead with the rule and
then justify it.

## Rust conventions in this repo

Each rule is one line. The line under it says when the rule bends.

**Borrow what comes in. Own what goes out.**
`&str` and `&Path` parameters, `String` and `PathBuf` returns. Return a
borrow only when it is a view of an input, and say why.

**Errors travel with `?`. They stop in `main`.**
`anyhow::Result` everywhere. No `unwrap` or `expect` outside tests. Reach for
`thiserror` when a caller must branch on the error kind.

**The struct is the CLI.**
`clap` derive. Flags, defaults, and help text live on the field, so `--help`
cannot drift from the code.

**One command, one file, one `run`.**
`src/commands/<name>.rs` exposing `pub fn run(...) -> anyhow::Result<()>`.
Split the file when a command grows past one screen, not before.

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

## Plans

`plans/README.md` indexes every plan and names the slice that comes next. The
plan in `plans/current/` carries the decisions that explain the commits, so
read it before proposing a slice. Do not restate a plan's contents here — this
file holds the method, and the plan holds the work.

## Commits

Use Conventional Commits. One commit for each slice.

The subject says what changed. The body says why, and only why. The diff
already says what changed, so do not repeat the diff in prose.

Do not write:

- A list of the changed files or functions.
- A restatement of the subject in a longer form.
- A description of code that the reader can see in the diff.
- A summary of the next slice or of future work.

Write the body only when the reason is not obvious from the subject. If the
subject carries the reason, omit the body.

Do not add a `Co-Authored-By` trailer or any other attribution trailer. The
author of the commit is the user.

