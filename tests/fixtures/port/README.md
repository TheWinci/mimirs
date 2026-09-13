# Port compatibility fixtures

Captured outputs from the Mimirs TypeScript implementation at revision
`122674c8bfbbc3549390743f51396c5f0e4e3537`. These seven files are byte-for-byte
copies of the corresponding reference fixtures originally maintained under
`benchmarks/versions/port/`. Their embedded revision, runtime, source hashes,
and tolerances remain unchanged. They contain controlled source examples and
expected outputs, not task sessions or measured benchmark runs.

The source-window, chunker, and relationship references use the existing source
fixtures and goldens under `tests/fixtures` and `tests/goldens`. The model
reference is used only by the existing opt-in cached-model compatibility test.
Default tests do not require the TypeScript checkout or model inference.

Original relative path and SHA-256:

- `reference.json`: `ef1faaf2a508d2830aa078544a734a18458b9ddd2a94b0aba60f8564b1c29c90`
- `model-reference.json`: `cf2f1c6f892a2a922289bfdf6e11c703fcbb29ca5f7e3e5e2c8b1d22a62bd00b`
- `languages/reference.json`: `91935cdcff9a3a2653ea50a7c691fc699a334e06ce94715e9cf88b8d32988e32`
- `languages/inputs.json`: `e7faecf3998e758f5dec8ab9ce487ba4935e7dc63874f68c02736f78c0b96975`
- `source-windows/reference.json`: `554abab955a7b10778320016b1813dfa3bd6b33d00657bc1af473d2ba6fa27ce`
- `relationships/reference.json`: `4dd1e3704bf39b2c2bb60115d741c7dd35984654ee33d905e41a131b13e46707`
- `chunker/reference.json`: `7d9a5af619c52713ae384ca66edbea5357a871943073c80e20d336e06848b8ee`
