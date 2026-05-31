You are writing one wiki overview page from validated discovery data.

Assigned page slug: `{{slug}}`
Overview kind: `{{kind}}`

Your job is to write `wiki/{{slug}}.md`. This is a bird's-eye overview, not a flow page. It should explain {{kindDescription}} by tying together multiple flows.

Start here:

1. Read the page item included in this prompt.
2. Read every file named in `page.primaryFiles`. These are the load-bearing source files for this overview.
3. Read the listed `flows[]` to understand which entry-point behaviors this overview ties together.
4. Use `wiki(prefetch:map:<path>)`, `wiki(prefetch:annotations:<path>)`, `read_relevant`, `search`, `depends_on`, `depended_on_by`, `search_symbols`, and `find_usages` to verify structure before writing.
5. Read the existing flow pages this overview will link to, so the links are accurate and use the right slugs.

{{writing-contract}}
For the assigned overview page:

- Write to `wiki/<slug>.md`.
- Use the page `title` as the H1.
- Open with one paragraph that says what this overview covers and who it helps. Do not repeat the per-flow detail that lives on flow pages.
{{diagramGuidance}}
- Cite at least three source files with root-relative paths and line ranges inline (for example `src/server.ts:42-80`). Spread citations across the body, not in a single dump.
- Link to at least two flow pages by relative markdown link (for example `[mimirs serve](cli/serve.md)`). Only link to flow pages whose subject is structurally connected to this overview's `primaryFiles` or to the kind's topic.
- Cover every item in `page.mustCover` with source-backed explanation.
- Write for a maintainer deciding where to change code. Prefer concrete, actionable specifics over smooth narrative: name the exact seam to edit (for example "add a tool by adding a `registerX` import plus one call in `src/tools/index.ts`"), state each invariant and where it is enforced, and reproduce exhaustive reference material where it earns its place — a full config-field table with read sites, every shutdown trigger, the complete schema. Do not abstract a concrete mechanism into a generic description; if a behavior is a specific contract, keep the contract, not a paraphrase of it.
- Explain how the pieces hang together and why. Name the contracts, the boundaries, and the invariants. Do not list symbols, do not dump types, do not paste import statements.
- Add an `Open questions` section only when `openQuestions` is non-empty.
- Add a short `Key source files` section at the end listing each cited root-relative file path and its role in this overview.
- Do not write a sequence-of-events numbered list. That format belongs on flow pages. Use narrative paragraphs grouped by the natural sub-topics of this overview.
- Keep the page focused on its assigned `kind`. Do not drift into flow-level detail; defer to the linked flow pages for that.

Self-check before finishing:

1. Re-read the page paragraph by paragraph.
2. Confirm every inline citation `src/foo.ts:42` or `src/foo.ts:10-20` points at code that actually shows what the surrounding sentence claims. Fix wrong line numbers from the real source; only remove a citation when no equivalent exists.
3. Confirm every function, type, table, file path, env var, or service name you named exists in the referenced source.
4. Confirm at least three distinct source files are cited and at least two flow pages are linked. If not, go back and add the missing material from source rather than padding.
{{diagramSelfCheck}}
6. For each `mustCover` item, confirm the explanation comes from verified source behavior, not from rephrasing the packet summary.
7. Prefer correcting over deleting. A shorter accurate overview beats a longer one with invented structure.

{{self-check}}