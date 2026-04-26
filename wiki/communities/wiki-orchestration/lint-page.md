# src/wiki/lint-page.ts

> [Architecture](../../architecture.md) › [Wiki orchestration](../wiki-orchestration.md)
>
> Generated from `b47d98e` · 2026-04-26

## Role

`src/wiki/lint-page.ts` is the zero-LLM, zero-AST, pattern-based lint that the wiki orchestration community runs over every generated page to catch the drifts that show up most often: fabricated file paths, stale constant citations, missing-but-expected coverage, line-range citations that drifted away from their enclosing symbol, hedge words, and Mermaid diagrams that silently break (reserved-keyword node IDs, unquoted labels with punctuation, HTML in participant aliases). It is consumed by `src/tools/wiki-tools.ts` to back the `wiki_lint_page` and `wiki_lint_batch` MCP tools, and by `tests/wiki/lint-page.test.ts` for regression coverage. The file leans only on plain string and regex operations — no DB, no filesystem — so it runs in milliseconds across the whole wiki.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `LintWarningKind` | type | `"missing-file" \| "constant-missing" \| "constant-value-drift" \| "constant-uncited" \| "member-uncited" \| "line-range-drift" \| "citation-symbol-drift" \| "prose-hedge" \| "mermaid-reserved-id" \| "mermaid-unquoted-label" \| "mermaid-html-in-alias"` | The closed set of warning categories the linter can emit. Every check maps to exactly one kind. |
| `PageLintWarning` | interface | `{ kind: LintWarningKind; message: string; line: number; match: string; correctedMatch?: string }` | One emitted warning. `line` is 1-indexed; `match` is the offending token verbatim; `correctedMatch` ships only for warnings that have an authoritative replacement (today only `line-range-drift`), so a batch-fix pass can substitute the token without re-parsing source. |
| `ProjectConstant` | interface | `{ name: string; value: string; file: string }` | A top-level identifier-equals-value declaration — name, raw first-line snippet, owning project-relative file. Drives both the value-drift check (`lintConstants`) and the coverage check (`lintConstantCoverage`). |
| `ChunkRange` | interface | `{ entityName: string \| null; chunkType: string \| null; startLine: number; endLine: number }` | A tree-sitter chunk range from the indexer's chunker. Keyed by path inside `LintPageOptions.chunkRangesByPath`. Language-agnostic — works wherever mimirs indexes. |
| `LintPageOptions` | interface | `{ knownFilePaths?, knownConstants?, expectedConstants?, expectedMembers?, chunkRangesByPath? }` | The five-knob option bag passed by the caller. Each field, when absent, disables exactly one check; when present, each plugs a specific data source (path set, constant map, expected-coverage list, expected-member list, chunk-range map) into the corresponding check. |
| `lintPage` | function | `lintPage(markdown: string, opts: LintPageOptions = {}): PageLintWarning[]` | The single entry point. Splits markdown into lines once, then runs the seven pass functions (`lintPathRefs`, `lintConstants`, `lintConstantCoverage`, `lintMemberCoverage`, `lintCitationSymbols`, `lintHedgeWords`, `lintMermaidBlocks`) in fixed order and returns the accumulated warnings array. |

## Internals

- **`MERMAID_RESERVED_IDS` covers more than the obvious keywords.** The set includes `graph`, `subgraph`, `end`, `flowchart`, `direction`, `classdef`, `class`, `style`, `linkstyle`, `click`, `default`, plus the four-letter direction shorthands `tb`, `td`, `bt`, `rl`, `lr`, `le`. The direction tokens are the ones writers reach for accidentally as node ids (e.g. naming a node `lr` for "left-right"); without them the lint would miss the silent-break cause documented in the user's `feedback_mermaid_reserved_ids` memory. Declared at `src/wiki/lint-page.ts:15-34`.

- **`HEDGE_WORD_RE` is conservative on purpose.** The pattern flags eight token families only — four bare adverbs the linter calls out individually plus four marketing-flavoured stems with their morphological variants. Code fences are toggled by `isFenceLine` so identifier matches inside code samples don't fire (the lint deliberately ignores anything inside fenced code, so a code sample naming an internal variable that happens to share a stem with the hedge list passes through). The reviewer rubric calls out zero hedge hits as the bar for a 10/10 prose score. Declared at `src/wiki/lint-page.ts:171-173`.

- **Symbol-citation drift is intentionally narrow.** `ATTRIBUTED_CITATION_RE` matches three writer conventions only: `` `name()` (path:1-2) ``, `` `name` — path:1-2 ``, and `` `name` at path:1-2 ``. Loose proximity (symbol appears anywhere on the same line as the citation) was rejected because writers cite chains of related symbols in a single sentence, and that loose rule drowned the warning channel in false positives. The check tolerates a 3-line slack — codified in the `CITATION_TOLERANCE_LINES` constant — on either side of the cited range so a citation that's slightly off still counts as a hit; it surfaces up to the first three nearby entity names so a fix pass has actionable substitutes. Declared at `src/wiki/lint-page.ts:207-209`.

- **Path validation runs the basename-fallback dance.** `lintPathRefs` indexes `knownFilePaths` by basename via `buildBasenameIndex`, then `resolvePathRef` first tries a direct hit, then falls back to the basename index when the ref has no `/`. A bare `wiki-tools.ts` resolves to `src/tools/wiki-tools.ts` when exactly one project file shares the basename; ambiguous shorthand (two homonym files) silently passes — the comment notes this is the right call because a writer using `chunker.ts` to mean either of two homonym files is a prose problem, not a path-existence problem. Declared at `src/wiki/lint-page.ts:550-562`.

- **`isPlausiblePath` filters by extension whitelist before regex matching.** `CODE_EXTENSIONS` enumerates roughly 50 real-world extensions (TypeScript, Python, Rust, Go, Markdown, YAML, etc.) so that method-chain tokens with method names that look like extensions don't fire. The rule also rejects refs that begin with a `.` unless followed by `/`, killing bare-extension lists that occasionally appear in docs. Declared at `src/wiki/lint-page.ts:377-389`.

- **Line-range drift is auto-fixable, the others are advisory.** `lintPathRefs` emits `correctedMatch = "path:start-end"` for every `line-range-drift` it produces by calling `findEnclosingChunk` against the indexer-sourced `chunkRangesByPath` map and picking the innermost (tightest) enclosing chunk. `wiki_lint_batch` substitutes the token in place when run with `applyFixes: true`. Every other warning kind ships without a `correctedMatch` — the human (or an LLM rewrite pass) is expected to author the fix. The enclosing-chunk picker is declared at `src/wiki/lint-page.ts:350-364`.

- **`constantValuesMatch` prefers false-negatives over false-positives.** When the source-side snippet can't be parsed (multi-line initialisers, complex destructuring assignments), `extractValueFromSnippet` returns `null` and `constantValuesMatch` returns `true` — the check skips rather than guess. The cited and parsed values are then normalised by stripping whitespace and quotes and lower-casing before comparison; trailing semicolons, commas, and inline comments are stripped from the source first. The lint is advisory, so a missed mismatch is a smaller cost than a false drift warning on every multi-line constant. Declared at `src/wiki/lint-page.ts:524-529`.

- **`CONSTANT_REF_RE` requires SCREAMING_SNAKE_CASE.** The regex matches backticked uppercase identifiers followed by an equals sign and a literal value — lower-case constants and method-style assignments are deliberately ignored to avoid drowning in inline-code noise. The backtick constraint also kills informal glosses like "roughly 70 percent": only verbatim literal citations are checked. Declared at `src/wiki/lint-page.ts:464-470`.

- **Mermaid node-id extraction is heuristic-narrow.** `extractNodeIds` only catches two shapes: a token at line start followed by `[`, `(`, `{`, or `>` (label opener); and tokens on either side of the edge arrows `-->`, `---`, `-.->`, `==>`, `~~~`. Exotic syntax (multi-line node declarations, custom shapes) is missed, but the trade-off is zero false positives — no writer expects a Mermaid diagram with five flagged nodes when only one is actually broken. Declared at `src/wiki/lint-page.ts:749-767`.

- **HTML-in-alias check covers two distinct carriers.** `extractHtmlInAlias` walks the line for `MERMAID_HTML_TOKENS` (the `<br/>`, `<b>`, `<i>`, and `&nbsp;` regexes) inside two contexts: everything after `participant X as ` (the Mermaid 10+ alias position that breaks silently on HTML) and inside `[...]`/`(...)`/`{...}` brackets anywhere on the line. The matched token is echoed verbatim in the warning so the writer sees what they typed. Declared at `src/wiki/lint-page.ts:616-617`.

- **`extractUnquotedLabels` flags only labels with risky chars.** `RISKY_LABEL_CHARS` is the character class for slash, dot, parens, angle brackets, pipe, colon, and whitespace. Bare single-word node ids stay unflagged so the lint doesn't drown in noise from plain identifiers; only labels that would break Mermaid render if left unquoted (paths, dotted identifiers, anything with whitespace or punctuation) trigger. Declared at `src/wiki/lint-page.ts:724-725`.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/tools/wiki-tools.ts](wiki-tools.md)
- [src/wiki/index.ts](index.md)
- [src/wiki/update-log.ts](update-log.md)
- [Wiki orchestration](../wiki-orchestration.md)
