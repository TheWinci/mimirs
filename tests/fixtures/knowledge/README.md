# Knowledge compatibility fixture

`compact-claims.json` is a static compatibility fixture derived from the six
claims used in the knowledge pilot. It retains their statements, evidence
paths, and two groups of three claims. Experiment-specific knowledge UUIDs
are omitted, and rationales describe source behavior without personal run
notes. Tests create fresh claim IDs and inspect current repository sources.

The fixture checks the default compact response budget, complete claim
visibility, detail/history access, verification state, and read-only journal
behavior. It is not a journal export or an evaluation result.
