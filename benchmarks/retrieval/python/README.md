# Python source retrieval check

This small development corpus contains four Python source/stub files and one
Rust file. The three queries and expected owners were written before the first
model run. They cover a function body, a docstring, and a class method, with
other Python and Rust declarations as distractors.

```sh
cargo build
python3 benchmarks/retrieval/python/check.py \
  --binary target/debug/mimirs \
  --model-snapshot /path/to/models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079 \
  --output /tmp/mimirs-python-check
```

Use `--previous-binary /path/to/mimirs-from-df2d56e` to also verify upgrading a
Python fallback index without editing its source or configuration. The previous
binary must support the shared language registry but predate Python analysis.

The script audits exact primary source coverage and saved byte/line ranges,
compares direct and stored inspection, verifies an unchanged reindex, deletes
the working sources, and runs search against their saved snapshots. It records
model, corpus, query, binary, and input hashes. Full embedding inputs and CLI
outputs are saved in the output directory.

[results.json](results.json) records 22 documents with complete source coverage.
All three expected Python owners ranked first among ten returned results.
No query missed its target. The previous binary produced 21 documents, with
Python represented as ownerless paragraphs. Upgrading created named Python
owners, and the following index run reused all five files. Both inspection and
search retained exact evidence after working-file deletion.

These results establish a small retrieval smoke test and source fidelity.
They do not establish quality on unfamiliar repositories. All corpus functions
fit within the model budget; separate Rust tests exercise oversized Python
bodies and Unicode lines through the real tokenizer and embedding backend.

[rust-regression-results.json](rust-regression-results.json) uses the existing
26-file Rust corpus, fixed queries, and pinned model. Its 246 embedding inputs,
input hash, complete source audit, and expected-file ranks `1, 7, 1, 1, 1` match
the language-dispatch baseline. Timings were collected alongside other checks
and are not a performance comparison.
