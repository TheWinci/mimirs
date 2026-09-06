# Mixed Rust/Python retrieval check

The corpus is Maturin at `479658ad9bce22c6e4955b2e47182111c166e37c`.
The 16 source-informed questions and implementation targets were prepared before
viewing results. They cover seven Python questions, seven Rust questions, and
two questions requiring code from both languages. This is a development check
on one repository, not a held-out quality estimate.

Clone that revision into a disposable directory, run `mimirs init` and
`mimirs index` with fresh defaults there, then run:

```sh
python3 benchmarks/retrieval/mixed/check.py \
  --binary target/debug/mimirs --project /path/to/maturin \
  --output /tmp/mimirs-mixed-check
```

The script verifies the revision, audits saved embedding text against source,
checks every displayed evidence span against its own chunk, and scores owner
ranks and visible answer snippets separately. Full CLI responses go to the
output directory. The model may need downloading before the first index.

[Results](results.json) contain 272 source files and 2,817 documents. Source
bytes, repeated signatures, and line ranges are exact; every nonblank source
byte has one primary embedding span. Root-only `/target/**` defaults include
five real source files under `src/target/` that the older recursive exclusion
omitted. The wheel-tag targets rank 1 and 3.

Answer code appears in the top ten for 5/7 Python and 6/7 Rust questions.
Neither cross-language question retrieves the complete chain. These owner ranks
match the earlier run on the same corpus and configuration. Showing more chunks
does not improve owner ranking.

The separate `R7` diagnostic requests 64 owners. `unpack_sdist` remains at rank
41, but now displays both matching parts, including the manifest-path branch.
Previously the result cited that branch while displaying only the first part.
Results show at most three candidate documents per owner, with separate evidence.

[Rust regression results](rust-regression-results.json) retain the fixed
26-file corpus and five original queries. Its 246 inputs have the same hash as
the prior Python-slice baseline and ranks remain `1, 7, 1, 1, 1`.
