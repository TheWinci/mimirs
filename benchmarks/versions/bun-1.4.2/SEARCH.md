# Remove full-index audits from search startup

The query-path change reduces Django cold CLI latency from 654.6 to 253.0 ms,
a 61.4% reduction. The updated Rust executable is faster than TS v2 on Bun 1.4.2
on all three measured corpora. All 262 complete saved CLI responses remain
identical, normalizing only the elapsed-time line.

## Paired release measurements

| Corpus | Previous Rust median ms | Updated Rust median ms | TS / Bun 1.4.2 median ms | Rust latency reduction |
| --- | ---: | ---: | ---: | ---: |
| Mimirs | 134.3 | 118.2 | 250.4 | 11.9% |
| Excalidraw | 315.9 | 183.9 | 303.2 | 41.8% |
| Django | 654.6 | 253.0 | 440.6 | 61.4% |

Each value is the median of 30 process invocations on ten fixed queries repeated
three times. Within every query, engine order rotates across the previous Rust
binary, updated Rust binary, and archived TS on Bun 1.4.2. Both Rust binaries use
the same retained index. All commands run sequentially. Model files are cached;
process startup, loading, retrieval, formatting, and exit are included.

The three updated-Rust pass medians are 117.9/118.1/119.4 ms for Mimirs,
185.5/182.5/182.8 ms for Excalidraw, and 253.8/253.0/252.4 ms for Django.
Django's 401.6 ms improvement closely matches the earlier diagnostic's roughly
400 ms of opening and validation work. Retrieval and evidence construction still
depend on corpus content; this change removes the measured database-wide audit
cost from each search, rather than making all search work independent of size.

## Validation policy

Read-only opening still checks the database version and exact schema objects,
including vector shadow tables. Search still validates model identity, dimension,
document-policy metadata, and tokenizer compatibility. Metadata, candidates, and
returned evidence share the existing read transaction.

The existing per-file loaders still validate source analysis, processing policy,
complete document counts, document hashes, ownership, and evidence spans before
anything is printed. They are unchanged.

`PRAGMA integrity_check` and `PRAGMA foreign_key_check` remain on writable opening
of an existing database. After indexing and reconciliation, `storage::audit`
performs those checks plus the full model/policy/coverage audit. Its time appears
under `database_audit` in index profiles. Global policy scans are no longer called
by the search command.

This intentionally changes when unrelated corruption is discovered. Search can
return validated evidence from a good file while damage elsewhere is deferred to
the indexing audit. It is not a full-index health check. SQLite errors encountered
while reading and corruption in returned source/documents still fail the command
without partial output. Stored inspection uses the same compatible read-only
opening and continues validating the analysis it loads.

The new final audit took 0.015 seconds on Mimirs, 0.131 seconds on Excalidraw,
and 0.401 seconds on Django during the unchanged-index checks. The corresponding
whole profiled index commands took 0.176, 0.712, and 2.464 seconds. These are single
correctness runs, not a repeated incremental-index speed comparison. No fresh
index was rerun for this query-only optimization, and no rebuild is required.

## Verification

- `cargo build`, `cargo clippy --all-targets -- -D warnings`, and
  `cargo build --release --locked` pass.
- `cargo test` passes 399 tests; 16 existing opt-in tests remain ignored.
- New regression cases defer an unrelated orphan row or unrelated processing
  policy mismatch to the full audit, while successfully returning valid evidence.
- Returned-file regressions cover processing policy, document count, document
  policy, content hash, malformed evidence, and missing source snapshots. All
  fail without output or index writes. Existing schema/model error tests remain.
- Release verification reproduces all 262 complete CLI responses across Mimirs,
  Excalidraw, and Django, excluding only elapsed time. This includes snippets,
  source hashes, and evidence, not just file ordering.
- Unchanged indexing reuses all 3,627 files with zero embedding calls and completes
  the new full audit. Every one of the 180 timed Rust responses also matches the
  retained original response.

## Provenance and reproduction

The baseline is Rust revision `0e69ce986536a783a4025def82dc1c7024b16d9a`. The candidate
is that revision plus the uncommitted source/test [patch](query-validation.patch).
[Raw results](query-validation.json) record both binary hashes, the patch hash,
all 270 timings, pass medians, release parity, and audit-profile counters.
The TS revision, dependencies, corpus bytes, model assets, and host are unchanged
from the [original comparison](README.md).

The disposable run directory is
`/tmp/mimirs-bun-1.4.2-comparison/query-validation`. It contains the candidate
binary, all stdout/stderr/time files, and complete unchanged-index profiles.
The [comparison driver](query-validation-compare.py) calls the existing version
runner's command and measurement helpers.

The full-output and unchanged-index checks use:

```sh
python3 benchmarks/versions/port-final-check.py \
  --root /tmp/mimirs-bun-1.4.2-comparison \
  --binary /tmp/mimirs-bun-1.4.2-comparison/query-validation/mimirs-rust \
  --output /tmp/mimirs-bun-1.4.2-comparison/query-validation/parity
```

These are cached-model measurements on an active desktop. Kubernetes and a
persistent Rust search API were not measured in this change.
