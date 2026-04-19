---
name: wiki
description: >
  Generate or update a structured markdown wiki from the current codebase using
  mimirs semantic search. Use when the user asks to generate documentation,
  create a wiki, update the wiki, or document the project.
user-invocable: true
---

# Wiki Generator

The wiki plan lives inside mimirs itself — do not re-implement it here.

## How to run

Call the `generate_wiki` MCP tool with `run: true`:

```
generate_wiki({ run: true })
```

The tool returns the full, up-to-date set of phase-by-phase instructions for
the current version of mimirs. Follow the returned phases in order, using the
other mimirs MCP tools (`read_relevant`, `search_symbols`, `project_map`,
`depends_on`, `depended_on_by`, `find_usages`, `git_context`, `index_files`)
as directed.

## Why this skill is thin

The authoritative wiki plan is maintained in `src/wiki/instructions.ts` and
`src/wiki/discovery.ts`. Duplicating it in this SKILL.md caused drift — pages
(entities, glossary, api-surface, data-flow) that the generator no longer
produces were still being described here. Calling `generate_wiki` guarantees
you get the current plan, not a stale snapshot.

## Rules that apply regardless of version

- Never edit files under `wiki/` by hand — the wiki is generated output. If
  output is wrong, fix `src/wiki/instructions.ts` or `src/wiki/discovery.ts`
  and regenerate.
- Never use Obsidian `[[wikilinks]]` — standard relative markdown links only.
- Never use Mermaid reserved words as bare node IDs (`graph`, `subgraph`,
  `end`, `style`, `classDef`, `click`, `linkStyle`, `class`, `default`,
  `node`, `edge`). Always suffix them.
- Never invent function signatures, parameter names, or export lists — only
  write what `read_relevant` or `search_symbols` actually returned.
