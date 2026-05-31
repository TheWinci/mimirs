You are writing one wiki page from validated discovery data.

Assigned page slug: `{{slug}}`

Your job is to write `wiki/{{slug}}.md`. Do not edit other wiki pages. Do not redo the whole discovery process. Use the page packet and referenced flows as a map, then read the referenced source before writing.

Start here:

1. Read the page item included in this prompt.
2. Read the referenced flows included in this prompt.
3. Read the source files named in `page.primaryFiles`, `flows[].files`, `flows[].evidence`, and `flows[].stateChanges[].evidence`. Follow the flow from trigger to observable result before writing.
4. Use `wiki(prefetch:map:<path>)` and `wiki(prefetch:annotations:<path>)` for focused context.
5. Use mimirs tools such as `read_relevant`, `search`, `depends_on`, `depended_on_by`, `search_symbols`, and `find_usages` when the named files point to helper code or when you need exact code context.

{{writing-contract}}
For the assigned page:

- Write to `wiki/<slug>.md`.
- Use the page `title` as the H1.
- Do not write a discovery transcript or a summary card. Write a useful engineering page for someone trying to understand, debug, or safely change this flow.
- Do not write from the page packet alone. The packet tells you where to look; the page should explain behavior you verified in the referenced source.
- Let the page length follow the flow. A tiny wrapper may be short; a flow with branching, state changes, background work, or cross-file handoffs should be much deeper.
- Add detail when it explains behavior: why the step exists, what data moves, what state changes, what can fail, and what the caller observes.
- Do not pad. Every extra paragraph should be backed by code evidence or should clarify a real consequence for users, agents, stored state, or maintainers.
- Explain what this one flow does in plain language, including when someone would use it and what problem it solves.
- Include a Mermaid diagram, and choose the type that conveys the most about this flow rather than defaulting to one shape:
  - `sequenceDiagram` (with `autonumber`) — when the flow is an exchange between participants over time: a caller, a handler, a store, a response. This fits most request/response, message, and job flows.
  - `flowchart` — when the value is in the branches, not the call order: a command dispatcher or router, a decision tree, a multi-mode switch, or a staged pipeline. If a sequence diagram would collapse many distinct branches into one box, use a flowchart instead.
  - `stateDiagram-v2` — when the flow moves an item through a lifecycle of states.
  Pick the single form that best shows how this flow actually works; do not force a sequence diagram onto branching logic. In Mermaid labels use `<br>` for line breaks — never `\n`, which renders as a literal backslash-n. Never use a reserved word (`graph`, `subgraph`, `end`, `class`, `state`, `click`) as a node or participant id; suffix it (for example `endNode`) instead.
- Below the diagram, add a short ordered list that walks through it — each step of a sequence diagram, each branch or node of a flowchart, or each transition of a state diagram — with more context than the diagram labels carry.
- Add an `Inputs` section when the page has `inputs`, formatted as a Markdown table with columns name, type, required, and description. Cover every item in that array, focusing on what the caller, environment, schedule, message, config, or file system provides to the flow.
- Add an `Outputs` section when the page has `outputs`, formatted as a Markdown table with columns output and where it lands / shape / description. Cover every item in that array, focusing on what the flow returns, writes, updates, starts, publishes, or otherwise changes.
- When the page compares this flow against a sibling flow (this tool vs that tool, this command vs that command) or lists a fixed set (models, exit codes, command grammar, allowed types), use a Markdown table rather than prose bullets. Tables scan faster and are the preferred format for any small comparison or enumeration.
- Add a `State changes` section when the referenced flows include `stateChanges`. Name each item, show the before and after state, explain why the change matters, and cite the code that performs the change.
- Add a `Branches and failure cases` section and enumerate every branch you can verify in source: empty-result paths, missing-input handling, optional flags, lock/query-only modes, startup phases, abort or cancellation, and error handling. Prefer listing every real branch over summarizing a few.
- Add an `Example` section when useful. For MCP tools, show example arguments JSON. For CLI pages, show an example command. For server-start pages, show the lifecycle phases.
- Example output blocks are illustrative, not factual. If you show a sample output, the shape and field names should match what the command actually emits, but specific values such as file paths, line numbers, ids, timestamps, or hashes should be either obviously synthetic (`src/example.ts:42`, `<commit-sha>`) or verified against current source. Do not paste real-looking paths or identifiers that you have not just confirmed exist.
- Treat `mustCover` as the list of required topics for this page. Every item in `page.mustCover` must be explained in the page body, with source-backed detail when possible.
- Use citations sparingly. Cite the main source location for each section, surprising behavior, non-obvious constraint, or important cross-file handoff. Do not cite every sentence or every diagram step.
- Prefer one root-relative inline-code citation per paragraph or bullet when several claims come from nearby code, for example `src/server.ts:42` or `src/search/hybrid.ts:10`. Do not use Markdown links for source-file citations.
- Add a short `Key source files` section when a page touches several files, listing each important root-relative file path and what role it plays.
- Mention important `openQuestions` instead of hiding uncertainty.
- Only link to related pages whose subject is named in `relatedFlows`, appears as a caller or callee of `primaryFiles`, or is otherwise structurally connected in source. Do not invent thematic relationships.
- Keep the page focused on its assigned `slug`, `flowIds`, and `primaryFiles`.

Self-check before finishing:

1. Re-read the page you just wrote, paragraph by paragraph.
2. For each inline citation like `src/foo.ts:42` or `src/foo.ts:10-20`, open that file and confirm the cited range actually contains what the surrounding sentence claims. When it does not match, first try to find the real location in the source and correct the line number; only remove the citation if no such location exists.
3. For each function, type, constant, command, flag, or tool name you named in the body, confirm it exists in the referenced source. When it does not, search the source for the real name and replace the invented one; only delete the claim if no real equivalent exists.
4. For each diagram element (a sequence step, a flowchart branch or node, or a state transition) and each item in the list below it, confirm there is source evidence for it. When one is wrong but the underlying behavior is real, rewrite it to match the code; only remove it when no backing behavior exists.
5. For each `mustCover` item, confirm the page explains it from verified source behavior, not from rephrasing the packet summary. When the explanation is thin or wrong, reopen the source and rewrite it from what the code actually does.
6. For each state change, input, and output you described, confirm it matches the discovery entry and the cited code. When they disagree, correct the page to match the code; only drop the item when no evidence supports it at all.
7. Prefer correcting over deleting. Reach for the source first and fix the claim. Delete only when the source shows no matching behavior. A shorter accurate page beats a longer page with invented detail, but an accurate page that explains the real behavior beats both.

{{self-check}}