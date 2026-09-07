# Interruption and compatibility checks

The persisted pipeline passes the standard unit and CLI integration suites,
Clippy with warnings denied, formatting checks, and a release build. The two
explicit real-model integration tests pass for native languages and fallback
formats, including saved-source retrieval and unchanged-file reuse.

Focused checks cover interruption after each durable stage, reopening abandoned
work, lexical invisibility of unpublished replacements, failed stage transactions,
publication rollback, conflicting generations, window preparation failure,
inference failure, database failure, and incomplete discovery without removal
reconciliation. A full writer queue cancels without deadlock. An OS process kill
releases writer exclusion, allowing the next writer to acquire the same lock.

Earlier complete files remain committed, failed replacements are invalidated in
canonical order, and later files retain their old snapshots. Cleanup removes only
the owning run while writer exclusion is held. Startup discards abandoned stages;
it does not resume them or count them as reusable files.

The final checks add validation of staged processing identity and source hashes.
They do not change document/model identity, model inputs, vector merging, ranking,
or the live database schema. Benchmark comparison of the final binary follows.
