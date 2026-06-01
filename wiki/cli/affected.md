# CLI: affected

`mimirs affected` answers one practical question for CI and pre-commit hooks: *given this set of changed files, which test files should I run?* Instead of running the whole suite on every change, you hand it the files that changed and it returns only the test files that could be affected — the ones that import the changed files, directly or through a chain of imports. It is the scriptable, non-interactive counterpart to the "Tests to run" section of the [`impact`](../tools/impact.md) tool: same underlying importer walk, but driven from the command line and shaped for piping into a test runner.

The command reads the changed files three different ways, walks the import graph to find every test downstream of them, and prints the result in whichever shape the surrounding script needs.

## How it runs

```mermaid
flowchart TD
  startNode([mimirs affected]) --> mode{how are<br>files given?}
  mode -->|--stdin| stdin[read stdin lines<br>resolve vs cwd]
  mode -->|positional args| args[resolve args<br>vs cwd]
  mode -->|none| git{git repo?}
  git -->|no| failNode[error + exit 1]
  git -->|yes| diff[git diff --name-only HEAD<br>resolve vs git root]
  diff --> emptyChk{diff empty?}
  emptyChk -->|yes| noChange[print 'No changed files' / empty json]
  stdin --> walk
  args --> walk
  emptyChk -->|no| walk[affectedTests:<br>transitive importer closure<br>kept if test path]
  walk --> outMode{output mode}
  outMode -->|--json| jsonOut[print full result json]
  outMode -->|--quiet| quietOut[print bare test paths]
  outMode -->|default| textOut[note unknowns +<br>count + indented list]
```

1. **Mode select.** The command first decides where the changed file list comes from, checking `--stdin`, then positional arguments, then falling back to git (`src/cli/commands/affected.ts:38-61`).
2. **`--stdin`.** It reads all of standard input, splits it into trimmed non-empty lines, and resolves each against the current working directory. This is the mode for `git diff --name-only | mimirs affected --stdin` (`src/cli/commands/affected.ts:39-41`).
3. **Positional args.** If no `--stdin` but file arguments were given, those are resolved against the working directory (`src/cli/commands/affected.ts:42-43`).
4. **Git auto-detect.** With no input at all, it finds the git root and runs `git diff --name-only HEAD` to get the working-tree changes, resolving each path against the git root (`src/cli/commands/affected.ts:44-61`).
5. **Empty / no-repo guards.** If there is no git root, it errors and exits non-zero; if the diff is empty, it prints a "no changed files" message (or empty JSON) and returns (`src/cli/commands/affected.ts:46-59`).
6. **The walk.** `affectedTests` opens the index, maps the changed files to file ids, walks their transitive importers, and keeps the ones that are test files (`src/cli/commands/affected.ts:63-65`, `src/graph/trace.ts:546-571`).
7. **Output.** The result is printed as JSON, as bare paths (`--quiet`), or as the default human-readable summary (`src/cli/commands/affected.ts:67-86`).

## Input modes in detail

The three input modes are mutually exclusive and checked in a fixed order, so the behavior is predictable in a script.

| mode | trigger | how paths resolve | typical use |
| --- | --- | --- | --- |
| stdin | `--stdin` present | each line resolved against `process.cwd()` | `git diff --name-only \| mimirs affected --stdin` |
| arguments | positional files, no `--stdin` | each arg resolved against `process.cwd()` | `mimirs affected src/a.ts src/b.ts` |
| git auto-detect | no `--stdin`, no positional files | each line resolved against the git root | `mimirs affected` inside a repo |

Positional collection skips flags and the `--dir` value so they aren't mistaken for filenames: the loop starts after the subcommand token, consumes the argument following `--dir`, and ignores anything starting with `--` (`src/cli/commands/affected.ts:27-36`). The git path resolves against the *git root* rather than the cwd because `git diff --name-only` reports repo-root-relative paths; the other two modes resolve against the cwd because that is what a human or a pipe naturally supplies (`src/cli/commands/affected.ts:41`, `src/cli/commands/affected.ts:43`, `src/cli/commands/affected.ts:60`).

## The importer closure, filtered to tests

The matching is done by `affectedTests` (`src/graph/trace.ts:546-571`). It first builds a map from file id to path from the project graph, then resolves each changed absolute path to an indexed file id with `getFileByPath`. Paths that exist in the index become the `changed` set and feed the walk; paths not in the index are collected separately as `unknown` and skipped (`src/graph/trace.ts:554-562`).

The walk itself is `transitiveImporters`: starting from the changed file ids, it repeatedly asks `getImportersOf` for every file that imports a file already in the closure, adding new ones until nothing new appears (`src/graph/trace.ts:488-504`). This is the file-level reverse-dependency graph — the same edges [`dependents`](../tools/dependents.md) reads, walked transitively. Because the closure is a visited set, it terminates without a depth cap. Finally, every file id in the closure whose path is a test file — decided by the shared `isTestPath` patterns (`tests/`, `__tests__/`, `spec/`, `test_`, or a `.test.`/`.spec.` suffix) — is kept as an affected test (`src/graph/trace.ts:565-567`, `src/utils/test-paths.ts:9-19`). The result is three sorted, project-relative lists: `changed`, `unknown`, and `tests`.

## Output modes

| flag | what prints | intended consumer |
| --- | --- | --- |
| `--json` | the full `{ changed, unknown, tests }` object, pretty-printed | another program parsing the result |
| `--quiet` | one bare test path per line, nothing else | piping straight into a test runner |
| (none) | unknown-file note, a count line, then indented test paths | a human reading the terminal |

The default output is the most informative: when any input files were not in the index it prints a `Note: N file(s) not in the index, skipped: …` line so a stale index doesn't silently swallow inputs, then either "No affected test files found." or a count line followed by the indented test list (`src/cli/commands/affected.ts:75-86`). `--json` and `--quiet` are checked before that and return early — `--json` emits the whole result (including `unknown`), `--quiet` emits only the bare test paths with no notes or headers, which is exactly what a `$(...)` substitution or an `xargs` pipe wants (`src/cli/commands/affected.ts:67-74`).

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `files` | positional strings | no | Changed file paths, resolved against the working directory. When present (and `--stdin` absent) they are the input set (`src/cli/commands/affected.ts:42-43`). |
| `--stdin` | flag | no | Read changed paths from standard input, one per line, resolved against the working directory (`src/cli/commands/affected.ts:39-41`). |
| `--json` | flag | no | Print the full result object as pretty JSON (`src/cli/commands/affected.ts:67-70`). |
| `--quiet` | flag | no | Print only bare test file paths, one per line (`src/cli/commands/affected.ts:71-74`). |
| `--dir` | string | no | Project directory whose index to query; resolved to an absolute path. Defaults to `.` (`src/cli/commands/affected.ts:21`). |

When no `files`, `--stdin`, and the directory is a git repo, the input is auto-detected from `git diff --name-only HEAD` (`src/cli/commands/affected.ts:44-61`).

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| Affected test file list | Written to stdout. `--json`: the `{ changed, unknown, tests }` object (`src/cli/commands/affected.ts:67-70`). `--quiet`: bare test paths, one per line (`src/cli/commands/affected.ts:71-74`). Default: an optional unknown-files note, then either "No affected test files found." or an `N test file(s) affected by M changed file(s):` count line with indented paths (`src/cli/commands/affected.ts:75-86`). |

The command opens the index read-only and closes it after the walk (`src/cli/commands/affected.ts:63-65`); it writes nothing back, so it changes no persistent state.

## Branches and failure cases

- **stdin mode.** `--stdin` reads and splits standard input; empty or whitespace-only lines are dropped (`src/cli/commands/affected.ts:39-41`, `src/cli/commands/affected.ts:88-93`).
- **Argument mode.** Positional files (with `--dir`'s value and other flags filtered out) become the input set (`src/cli/commands/affected.ts:27-36`, `src/cli/commands/affected.ts:42-43`).
- **Git auto-detect.** With no explicit input, the working-tree diff against HEAD supplies the files (`src/cli/commands/affected.ts:44-61`).
- **Not a git repo and no input.** `findGitRoot` returns null; the command prints an error telling the user to pass files, pipe with `--stdin`, or run inside a repo, then exits with code 1 (`src/cli/commands/affected.ts:46-52`).
- **Empty diff.** When git reports no changed files, the command prints empty JSON (with `--json`) or a "No changed files" line (unless `--quiet`) and returns without opening the index (`src/cli/commands/affected.ts:55-59`).
- **Unknown files.** Input paths not found in the index are reported in the default output's `Note:` line and included in `--json` under `unknown`; they contribute nothing to the walk (`src/graph/trace.ts:559-561`, `src/cli/commands/affected.ts:75-77`).
- **No affected tests.** When the closure contains no test files, the default output prints "No affected test files found." and `--quiet` prints nothing (`src/cli/commands/affected.ts:78-81`).
- **JSON / quiet short-circuit.** Both are handled before the human-readable branch and return immediately, so the unknown-files note and count line never appear in those modes (`src/cli/commands/affected.ts:67-74`).

## Example

Run the tests touched by your current uncommitted changes, piping bare paths into the test runner:

```sh
mimirs affected --quiet | xargs bun test
```

Or feed an explicit diff and inspect the structured result:

```sh
git diff --name-only main | mimirs affected --stdin --json
```

Default human-readable output looks like this (paths are synthetic):

```
Note: 1 file(s) not in the index, skipped: docs/notes.md
2 test files affected by 1 changed file:
  tests/example/search.test.ts
  tests/example/index.test.ts
```

## Key source files

- `src/cli/commands/affected.ts` — the command: input-mode selection, git fallback, output formatting (`src/cli/commands/affected.ts:20-93`).
- `src/graph/trace.ts` — `affectedTests` resolves changed paths and filters the closure to tests; `transitiveImporters` walks the importer graph (`src/graph/trace.ts:488-571`).
- `src/utils/test-paths.ts` — `isTestPath` and the patterns that decide what counts as a test file.
- `src/tools/git-tools.ts` — `findGitRoot` and `runGit`, used for the git auto-detect mode (`src/tools/git-tools.ts:6-17`).
- `src/cli/index.ts` — dispatches the `affected` subcommand to `affectedCommand` (`src/cli/index.ts:140-141`).
