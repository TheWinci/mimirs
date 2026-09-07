# Language support

Fresh configs include the union of v1 and TS v2 languages and formats. Existing
configs keep their include/exclude rules. To enable an extension, add its glob,
for example `"**/*.java"`, to `include` in `.mimirs/config.toml`, then run
`mimirs index`. Add `"**/Dockerfile"` and `"**/Dockerfile.*"` for named build files.
The analyzer registry changed, so previous indexes require a rebuild. Search
rejects stale indexes with instructions to reindex.

## Native syntax

All parsers ship in the binary. No language runtime, language server or compiler
is needed. Each file is parsed once. The same declaration query supplies source
owners and retrieval chunks; normalized parser offsets map back to exact saved
UTF-8 evidence. Analysis also records signatures, leading comments and parse
diagnostics. Incomplete source remains searchable.

| Language | Extensions | Grammar |
| --- | --- | --- |
| Rust | .rs | 0.24.2 |
| Python | .py, .pyi | 0.25.0 |
| JavaScript / JSX | .js, .jsx, .mjs, .cjs | 0.25.0 |
| TypeScript / TSX | .ts, .tsx, .mts, .cts | 0.23.2 |
| Go | .go | 0.25.0 |
| Java | .java | 0.23.5 |
| C | .c, .h | 0.24.1 |
| C++ | .cpp, .cc, .cxx, .hpp, .hh, .hxx | 0.23.4 |
| C# | .cs | 0.23.1 |
| Ruby | .rb | 0.23.1 |
| PHP | .php | 0.24.2 |
| Scala | .scala, .sc | 0.24.0 |
| HTML | .html, .htm | 0.23.2 |
| CSS | .css | 0.25.0 |
| Kotlin | .kt, .kts | Kotlin NG 1.1.0 |
| Lua | .lua | 0.4.1 |
| Zig | .zig | 1.1.2 |
| Elixir | .ex, .exs | 0.3.5 |
| Bash | .sh, .bash | 0.25.1 |
| TOML | .toml | TOML NG 0.7.0 |
| YAML | .yaml, .yml | 0.7.1 |
| Haskell | .hs | 0.23.1 |
| OCaml | .ml, .mli | 0.24.2, implementation/interface |
| Dart | .dart | Dart Orchard 0.6.0 |

Extension matching is case-sensitive. `.h` uses C; C++ headers use `.hpp`, `.hh`
or `.hxx`. `.mli` uses a separate OCaml interface grammar. HTML retains inline
script/style content inside HTML chunks. Native support does not imply type
checking, classpath loading, macro expansion or cross-file name resolution.

The pinned Kotlin grammar reports errors for some compact companion-object
forms. Diagnostics expose partial parsing; source is retained. Dart Orchard
preserves the node structure used by TS v2's Dart queries, verified by fixtures.

## Markdown and text formats

`.md`, `.markdown` and `.mdx` use nested Markdown headings with paragraph fallback.
MDX retains JSX as source; it does not infer JSX declarations.

These additional v1 formats use explicit text fallback with paragraph and
source-line windows. They receive exact evidence but no inferred syntax owners:

| Formats | Extensions or names |
| --- | --- |
| Plain text | `.txt` |
| Swift, fish, HCL, Protobuf, GraphQL | `.swift`, `.fish`, `.tf`, `.proto`, `.graphql`, `.gql` |
| Modules, data, queries and API collections | `.mod`, `.xml`, `.json`, `.sql`, `.bru` |
| Additional dialects | `.scss`, `.less`, `.zon`, `.zsh`, `.lhs` |
| Build and task files | Makefile, GNUmakefile, Dockerfile, Jenkinsfile, Vagrantfile, Gemfile, Rakefile, Brewfile, Procfile |

Named-file recognition is case-insensitive. Dockerfile and Jenkinsfile also
recognize a dot suffix such as `Dockerfile.dev`; this takes precedence over an
apparent extension such as `Dockerfile.ts`. Fresh discovery includes common
capitalized names and lowercase variants. The matching virtual extensions,
such as `.makefile` and `.dockerfile`, are also included. Other text files can be
included explicitly and use the same fallback.

This preserves format coverage while using the accepted TS v2 retrieval policy.
It does not port v1's separate SQL, JSON, Makefile, Dockerfile or Bruno splitters.
Native SCSS, Less, Zsh, ZON and literate Haskell parsing are not claimed.

## Verification

[Reference fixtures](../benchmarks/versions/port/languages/README.md) compare
native names, hierarchy and source boundaries with actual pinned TS v2 output.
Repository checks also cover Unicode, BOM/CRLF mapping, incomplete syntax,
repeated names, large input, stored inspection, unchanged reuse, edits, deletion
and failed replacement. Focused cached-model tests retrieve archive code among
an unrelated Rust file. These are correctness checks, not new benchmark corpora.
