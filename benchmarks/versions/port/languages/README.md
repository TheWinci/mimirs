# Language reference fixtures

`inputs.json` contains small source examples for the 19 native languages missing
after retrieval adoption. `reference.json` records actual TS v2 output at
`122674c8bfbbc3549390743f51396c5f0e4e3537`. Offsets are UTF-8 bytes in normalized
source, converted from TS UTF-16 positions. The generator verifies the pinned
source hashes before calling the reference chunker. These fixtures test source
representation; they are not a new retrieval benchmark corpus.

Regenerate into a new file with:

```sh
bun benchmarks/versions/port-languages-reference.ts /path/to/pinned-v2 /tmp/languages.json
```

The requested coverage is the union of v1 and TS v2. Native syntax coverage comes
from TS v2's `parsing/parser.ts` and `types.ts`, including the OCaml interface
grammar for `.mli`. V1's `src/indexing/chunker.ts` additionally recognizes `.hxx`,
`.scss`, `.less`, `.zon`, `.zsh`, `.lhs`, Markdown/MDX, text, Swift, fish, HCL,
Protobuf, GraphQL, Go modules, XML, JSON, SQL, Bruno, Makefiles, Dockerfiles,
Jenkinsfiles, Vagrantfiles, Gemfiles, Rakefiles, Brewfiles and Procfiles.

Recognition does not imply a dedicated grammar. Unsupported dialects and
formats retain explicit text fallback and exact source evidence. `.hxx` can
use the C++ grammar. Literate Haskell, Zsh, SCSS and Less must not be advertised
as native Haskell, Bash or CSS parsing without dialect-specific verification.

Each native language must also pass normalization, malformed-source, large-item,
ownership and stored-source lifecycle checks. Existing configurations keep
their include/exclude patterns; new defaults broaden discovery as support lands.


The completed expansion has 36 TS reference examples, including the OCaml
interface dialect and focused declaration edge cases. `verification.json`
records source-tree/input parity on all three original development corpora and
exact reproduction of all 262 accepted CLI responses by the release binary.
All 3,627 retained analyses and 27,295 documents compare equal, including source
ownership and evidence. Their accepted vectors are unchanged byte for byte.

`port-language-reuse.rs` is an explicit benchmark-only probe. It checks a
**disposable SQLite backup**, with a policy read from a newly initialized empty
project. It requires unchanged embedding/retrieval policy suffixes and equal
analysis/documents before committing compatibility metadata. It never runs
inference. Use SQLite's backup API, not a plain copy of a potentially live WAL
database. Then `port-final-check.py` checks unchanged reuse and CLI responses.
Production indexes use the normal rebuild path; this probe is not a migration.

The same real-model lifecycle check passed for each added native language, with
both OCaml dialects. An additional check covers 25 fallback formats with distinct
content and exact saved evidence. Near-duplicate numeric identifiers remain a
ranking limitation; these focused checks do not establish broad answer quality.
