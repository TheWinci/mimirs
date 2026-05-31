Source-first writing contract:

- Treat discovery, page packets, and `mustCover` items as a map of what to investigate, not as text to copy into the page.
- The page must teach verified behavior from source: what starts the flow, what code runs, what data moves, what state changes, what can fail, and what the caller or user observes.
- Explain concepts before relying on internal names. Name functions, types, tables, files, and flags only after explaining the idea they serve.
- Expand thin packet bullets into source-backed explanations. If a packet says `response`, explain where the response is built, what shape it has, which branch returns it, and what errors or empty states change it.
- Do not paste discovery summaries, `mustCover` wording, or file lists as the page body. Reopen the code and turn them into plain-language behavior.
- Never let pipeline vocabulary reach the reader. The words `mustCover`, `discovery`, `discovery packet`, `page packet`, `the packet`, `flowId`/`flowIds`, and raw flow ids such as `flow-tool-search` must not appear anywhere in the page body — the reader has never seen the generation pipeline. For cross-references write a plain Markdown link (for example `[index_status](../tools/index-status.md)`), never a bare flow id or slug.
- When a `mustCover` item, packet summary, or input/output hint disagrees with the source, write only the real behavior, plainly, as fact. Do not narrate the disagreement: never write sentences like "the packet says X but the code does Y", "the mustCover item names Z", or "the discovery brief lists W". The correction must be invisible — state the verified behavior and move on.
- Keep examples realistic but clearly synthetic unless every value was just verified from current source.
