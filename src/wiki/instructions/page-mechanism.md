You are writing one wiki mechanism page from validated discovery data.

Assigned page slug: `{{slug}}`

Your job is to write `wiki/{{slug}}.md`. A mechanism page documents ONE shared internal subsystem — something many flows call but that is nobody's entry point. It exists so the explanation lives in one place: flow pages link here instead of each re-explaining the same internals.

Start here:

1. Read the page item included in this prompt.
2. Read every file named in `page.primaryFiles`. These are the owning modules of this mechanism.
3. Read the listed `flows[]` to understand which entry-point behaviors call this mechanism and what they need from it.
4. Use `wiki(prefetch:map:<path>)`, `wiki(prefetch:annotations:<path>)`, `read_relevant`, `search`, `depends_on`, `depended_on_by`, `search_symbols`, and `find_usages` to verify structure before writing.
5. Read the existing flow pages this mechanism page will link to, so the links are accurate and use the right slugs.

{{writing-contract}}
For the assigned mechanism page:

- Write to `wiki/<slug>.md`.
- Use the page `title` as the H1.
- Open with one paragraph that says what problem this mechanism solves and which kinds of flows rely on it.
- Explain this one subsystem in depth: the problem it solves, the algorithm or data movement step by step, the invariants it maintains and where each is enforced, the failure modes and what callers observe when they hit, and the seams to change it (where to add a stage, swap a strategy, tune a threshold).
- Link to at least two flow pages that use this mechanism by relative markdown link (for example `[search tool](../tools/search.md)`). Only link flow pages whose source actually calls into this mechanism's `primaryFiles`. These links are what let flow pages defer here instead of duplicating the explanation.
- Cite the owning module(s) with root-relative paths and line ranges inline (for example `src/search/hybrid.ts:42-80`). Spread citations across the body, not in a single dump.
- A diagram is optional but encouraged. A `flowchart` of the mechanism's stages usually fits best; sequence diagrams belong on flow pages. In Mermaid labels use `<br>` for line breaks — never `\n`, which renders literally. Never use a reserved word (`graph`, `subgraph`, `end`, `class`, `state`, `click`) as a node id; suffix it instead.
- Cover every item in `page.mustCover` with source-backed explanation.
- Write for a maintainer deciding where to change code. Prefer concrete, actionable specifics over smooth narrative: name the exact seam to edit, state each invariant and where it is enforced, and reproduce exhaustive reference material where it earns its place — the full stage order, every tunable constant with its value, the complete fallback chain. Do not abstract a concrete mechanism into a generic description; if a behavior is a specific contract, keep the contract, not a paraphrase of it.
- Do not re-document the calling flows. What a flow does with the result belongs on that flow's page; this page covers what happens inside the mechanism.
- Add an `Open questions` section only when `openQuestions` is non-empty.
- Add a short `Key source files` section at the end listing each cited root-relative file path and its role in this mechanism.

Self-check before finishing:

1. Re-read the page paragraph by paragraph.
2. Confirm every inline citation `src/foo.ts:42` or `src/foo.ts:10-20` points at code that actually shows what the surrounding sentence claims. Fix wrong line numbers from the real source; only remove a citation when no equivalent exists.
3. Confirm every function, type, constant, threshold, file path, or flag you named exists in the referenced source.
4. Confirm the owning module is cited with line ranges and at least two flow pages that really call this mechanism are linked. If not, go back and add the missing material from source rather than padding.
5. If the page includes a diagram, confirm every node or edge in it is grounded in real code.
6. For each `mustCover` item, confirm the explanation comes from verified source behavior, not from rephrasing the packet summary.
7. Prefer correcting over deleting. A shorter accurate page beats a longer one with invented structure.

{{self-check}}
