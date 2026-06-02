# CLI: eval

`mimirs eval` answers one question: does this project's search index actually help an agent find the right files? It runs the same set of tasks twice — once with semantic search turned on, once with it turned off — and prints a side-by-side report so you can see the difference. It is a measurement tool, not part of normal indexing or serving. You reach for it when you want evidence that the index is worth its cost, or when you are tuning search and want to confirm a change improved (or regressed) retrieval quality.

The command reads a JSON file of tasks you wrote, runs each task through the real hybrid search against the on-disk index, compares the files search surfaced against the files you said a good answer should reference, and reports averages plus a per-task breakdown. With `--out` it also writes every individual run to a JSON file so you can inspect exactly what search returned for each task.

## How it runs

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant CLI as dispatch (src/cli/index.ts)
    participant Cmd as evalCommand
    participant Svc as runEval / runEvalTask
    participant Search as search (hybrid.ts)
    participant DB as RagDB
    participant FS as JSON file

    User->>CLI: mimirs eval tasks.json --top 8 --out traces.json
    CLI->>Cmd: evalCommand(args, getFlag)
    Cmd->>Cmd: require &lt;file&gt; arg, resolve --dir / --top / --out
    Cmd->>FS: loadEvalTasks(tasks.json)
    FS-->>Cmd: EvalTask[]
    loop each task
        Cmd->>Svc: runEvalTask(task, "with-rag")
        Svc->>Search: search(task.task, db, topK, 0, hybridWeight, generated)
        Search->>DB: vector + BM25 query
        DB-->>Search: ranked chunks
        Search-->>Svc: DedupedResult[]
        Cmd->>Svc: runEvalTask(task, "without-rag")
        Svc-->>Cmd: empty-result trace
    end
    Svc-->>Cmd: EvalSummary (stats + traces)
    Cmd->>User: formatEvalReport(summary) to stdout
    opt --out given
        Cmd->>FS: saveEvalTraces(summary.traces, outPath)
        Cmd->>User: "Traces saved to ..."
    end
    Cmd->>DB: db.close()
```

1. The user runs `mimirs eval <file>` with optional flags. The top-level dispatcher matches the `eval` case and calls `evalCommand(args, getFlag)`; `getFlag` is a small helper that scans `args` for a flag name and returns the next token (`src/cli/index.ts:149-151`, `src/cli/index.ts:85-88`).
2. The handler requires a task file as the first positional argument. `args[1]` is the file path (`args[0]` is the literal word `eval`). If it is missing, the command prints the usage line and exits with code 1 (`src/cli/commands/eval.ts:9-13`).
3. It resolves the project directory from `--dir` (default `.`), reads the optional `--out` path, opens the index with `new RagDB(dir)`, loads the project config, and resolves the result count. `--top` is parsed by `intFlag`, which rejects non-integer input and enforces a minimum of 1; when `--top` is absent it falls back to `config.benchmarkTopK` (default 5) (`src/cli/commands/eval.ts:15-19`).
4. `loadEvalTasks` reads and parses the task file, validating that it is a JSON array and that every entry has both a `task` and a `grading` string (`src/search/eval.ts:40-55`).
5. For each task, `runEval` calls `runEvalTask` twice — once in the `with-rag` condition and once in the `without-rag` condition — and pushes both traces (`src/search/eval.ts:101-105`).
6. In the `with-rag` condition, `runEvalTask` loads the config again and calls the real hybrid `search` with the task text as the query, the resolved `topK`, a zero score threshold, the configured hybrid weight, and the generated-file patterns (`src/search/eval.ts:73-77`).
7. The hybrid `search` runs a vector query plus a BM25 query against the SQLite index, merges the scores, and returns results deduplicated to one entry per file path (`src/search/hybrid.ts:330-376`).
8. The `without-rag` condition skips search entirely. The `if (condition === "with-rag")` block never runs, so the result set stays empty — this simulates an agent that has no index to lean on (`src/search/eval.ts:70-77`).
9. After all tasks run, `runEval` splits the traces by condition, computes averages and a file hit rate for each side with its local `computeStats` helper, and returns an `EvalSummary` (`src/search/eval.ts:107-141`).
10. The handler prints `formatEvalReport(summary)` to stdout — the side-by-side table plus the per-task breakdown (`src/cli/commands/eval.ts:25`).
11. If `--out` was given, `saveEvalTraces` writes the full trace array as pretty-printed JSON to the resolved path, and the handler prints a confirmation line (`src/cli/commands/eval.ts:27-30`).
12. Finally the database handle is closed (`src/cli/commands/eval.ts:32`).

## The task file

The task file is a JSON array you author. Each entry describes a job an agent might do and how a human would judge a good answer. `loadEvalTasks` is strict about shape: the top level must be an array, and each entry must have a truthy `task` and a truthy `grading`, or it throws with a message naming the offending entry (`src/search/eval.ts:44-52`).

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `task` | string | yes | The work to do, phrased as a question or instruction. This exact string is also used as the search query in the with-RAG condition. |
| `grading` | string | yes | Human-readable criteria for what a good answer looks like. The command never scores against this — it is echoed into the report so a reviewer can judge by eye. |
| `expectedFiles` | string[] | no | Files a correct answer should reference. Drives the file hit rate metric. Entries without this field are skipped when computing the rate. |

A minimal file looks like this:

```json
[
  {
    "task": "How does the CLI parse numeric flags?",
    "grading": "Mentions intFlag and that bad input throws CliFlagError instead of NaN.",
    "expectedFiles": ["src/cli/flags.ts"]
  },
  {
    "task": "Where is the eval report formatted?",
    "grading": "Points at formatEvalReport and the with/without-RAG columns."
  }
]
```

## The A/B model

The "A/B" here is not two different search algorithms. It is search versus nothing. The `with-rag` condition is the live retrieval path; the `without-rag` condition is a deliberate baseline that returns zero results. The point is to quantify what the agent loses when the index is unavailable — how many relevant files it would have seen, and how often the expected files would have surfaced. Because `without-rag` always returns nothing, its average results, average files, and file hit rate are all zero by construction; the interesting numbers are all on the with-RAG side, and the baseline column simply makes the contrast explicit (`src/search/eval.ts:70-77`).

Each run is captured as an `EvalTrace`: the task text, its grading, the condition, the raw `DedupedResult[]` from search, the list of file paths those results point at, a search count (1 for with-RAG, 0 for without-RAG), and the wall-clock duration in milliseconds measured with `performance.now()` (`src/search/eval.ts:13-21`, `src/search/eval.ts:79-90`).

## How the metrics are computed

`runEval` computes four numbers per condition inside its local `computeStats` helper (`src/search/eval.ts:110-133`):

| Metric | How it is computed |
| --- | --- |
| Avg results | Sum of `searchResults.length` across the condition's traces, divided by trace count. |
| Avg files found | Sum of `filesReferenced.length`, divided by trace count. For this command these match avg results, since each deduplicated result is one file. |
| File hit rate | Among only the tasks that declared `expectedFiles`, the fraction where at least one expected file matched a returned file. |
| Avg latency (ms) | Average of each trace's `durationMs`. |

The file hit rate match is intentionally forgiving. An expected file counts as found if it equals a returned path, or if either string ends with the other (`src/search/eval.ts:124-126`). That suffix logic lets a short expected path like `flags.ts` match a fuller returned path like `src/cli/flags.ts` (and vice versa), so you do not have to know the exact path form the index stores. Tasks without `expectedFiles` are skipped entirely when computing the rate, and if no task declares expected files the rate is reported as 0 rather than dividing by zero (`src/search/eval.ts:117-130`).

One subtlety: `computeStats` indexes the trace set positionally against the task list (`traceSet[i]` lines up with `tasks[i]`). This holds because `runEval` pushes one with-RAG trace and one without-RAG trace per task in task order, and the filter that splits them preserves that order (`src/search/eval.ts:101-130`).

## Inputs

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `<file>` | positional path | yes | Path to the JSON task array. Resolved to an absolute path before loading. Missing argument prints usage and exits 1 (`src/cli/commands/eval.ts:9-13`, `src/cli/commands/eval.ts:21`). |
| `--dir D` | path | no | Project directory whose index to evaluate against. Defaults to the current directory and is resolved to an absolute path (`src/cli/commands/eval.ts:15`). |
| `--top N` | integer | no | Number of search results per task in the with-RAG condition. Must be an integer >= 1; defaults to `config.benchmarkTopK` (5). Bad values throw a flag error and exit non-zero (`src/cli/commands/eval.ts:19`, `src/config/index.ts:34`). |
| `--out F` | path | no | When present, writes the full per-task trace array to this JSON file after the report (`src/cli/commands/eval.ts:16`, `src/cli/commands/eval.ts:27-30`). |

## Outputs

| Output | Where it lands / shape / description |
| --- | --- |
| A/B eval report | Printed to stdout. A header with task count, a two-column table (With RAG vs Without RAG) of avg results, avg files found, file hit rate, and avg latency, followed by a per-task breakdown listing each task, the basenames of files found, and its grading text (`src/search/eval.ts:143-167`). |
| Traces JSON file | Written only when `--out` is given. Pretty-printed (2-space) JSON array of every `EvalTrace`, including the raw search results for each task (`src/search/eval.ts:169-171`). |

The report is built entirely as strings in `formatEvalReport`; columns are aligned with fixed `padStart` widths, the hit rate is shown as a whole-number percentage, and latency is rounded to whole milliseconds (`src/search/eval.ts:148-152`). The per-task breakdown iterates only the with-RAG traces and shows each result file as a basename (so `src/cli/flags.ts` displays as `flags.ts`), or `(none)` when search returned nothing (`src/search/eval.ts:155-164`).

## State changes

| Name | Before | After | Why it matters |
| --- | --- | --- | --- |
| Eval traces file (`--out` path) | No file (or whatever was there) | A JSON file containing every per-task trace | This is the only durable artifact the command produces. Everything else is printed and lost when the terminal scrolls; the trace file lets you diff retrieval quality across runs or feed the raw results into another tool. |

The write happens through `saveEvalTraces`, called by the handler only when `--out` was supplied. It serializes `summary.traces` and overwrites the target path with no merge or append — a second run to the same path replaces the file (`src/cli/commands/eval.ts:27-30`, `src/search/eval.ts:169-171`). The index database itself is not modified by this command; `eval` only reads from it and then closes the handle.

## Branches and failure cases

- **Missing task file argument.** No `args[1]` means the command prints `Usage: mimirs eval <file> [--dir D] [--top N] [--out F]` and exits with code 1 before opening anything (`src/cli/commands/eval.ts:10-13`).
- **Task file not valid JSON.** `loadEvalTasks` calls `JSON.parse` with no guard, so malformed JSON throws and the command aborts (`src/search/eval.ts:41-42`).
- **Top level is not an array.** `loadEvalTasks` throws `Eval file must be a JSON array of { task, grading } objects` (`src/search/eval.ts:44-46`).
- **Entry missing `task` or `grading`.** Each entry is validated; a missing field throws an error that includes the offending entry as JSON (`src/search/eval.ts:48-52`).
- **Bad `--top` value.** A non-integer or out-of-range value raises `CliFlagError`, which the dispatcher catches to print a clear message and exit 1 instead of crashing with an opaque error (`src/cli/flags.ts:40-53`, `src/cli/index.ts:101-104`).
- **`--out` omitted.** The trace file write and its confirmation line are skipped; only the report is printed (`src/cli/commands/eval.ts:27-30`).
- **No `expectedFiles` on any task.** The file hit rate is reported as 0% for both conditions because there is nothing to score against (`src/search/eval.ts:130`).
- **Empty index or no matches.** Search can legitimately return zero results for a task; that trace records an empty file list, and the per-task breakdown shows `(none)` (`src/search/eval.ts:158-160`).
- **`without-rag` always empty.** This is not a failure but a fixed branch: the with-RAG block is skipped, leaving the result set empty by design (`src/search/eval.ts:73-77`).

## Example

```text
$ mimirs eval tasks.json --top 8 --out traces.json
Running A/B eval with 2 tasks against /Users/you/project...

A/B Eval results (2 tasks):

                     With RAG    Without RAG
  Avg results:            6.5            0.0
  Avg files found:        6.5            0.0
  File hit rate:          100%             0%
  Avg latency:            42ms             0ms

Per-task breakdown:
  "How does the CLI parse numeric flags?"
    files found: flags.ts, index.ts
    grading: Mentions intFlag and that bad input throws CliFlagError instead of NaN.
  "Where is the eval report formatted?"
    files found: eval.ts
    grading: Points at formatEvalReport and the with/without-RAG columns.

Traces saved to traces.json
```

The numbers above are illustrative; the column labels, the `(none)` fallback, the percentage and `ms` formatting, and the per-task layout match what `formatEvalReport` emits.

## How it compares to benchmark

`eval` shares its `--dir` and `--top` defaults (`benchmarkTopK`) with the benchmarking commands, but it answers a different question. [benchmark](benchmark.md) measures retrieval quality of a single configuration against a labeled query set; [benchmark-models](benchmark-models.md) sweeps several embedding models and compares them. `eval` instead contrasts the live index against a no-index baseline to show what the agent would lose without RAG at all.

## Key source files

- `src/cli/index.ts` — top-level dispatcher; routes the `eval` command and defines `getFlag`; catches `CliFlagError` to turn bad flags into a clean exit.
- `src/cli/commands/eval.ts` — the command handler: argument and flag parsing, opening the index, orchestrating load/run/report/save, and closing the database.
- `src/search/eval.ts` — the evaluation logic: `loadEvalTasks`, `runEvalTask`, `runEval`, `formatEvalReport`, `saveEvalTraces`, and the `EvalTask`/`EvalTrace`/`EvalSummary` types.
- `src/search/hybrid.ts` — the `search` function the with-RAG condition calls, and the `DedupedResult` shape it returns.
- `src/config/index.ts` — supplies `benchmarkTopK` (the `--top` default), `hybridWeight`, and the generated-file patterns passed into search.
- `src/cli/flags.ts` — `intFlag` and `CliFlagError`, used to validate `--top`.
