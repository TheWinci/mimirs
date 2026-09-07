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
