---
name: wiki
description: >
  Rebuild a flow-first project wiki using the mimirs wiki MCP tool. Use when
  the user asks to generate, rebuild, refresh, or write the wiki for a codebase.
user-invocable: true
---

# Wiki Rebuild

Use the `wiki` MCP tool as the source of truth. This skill is only a workflow
wrapper; do not invent a separate wiki structure.

## Core Rule

The wiki is flow-first. Create one page for one concrete trigger:

- one HTTP method + route
- one message, event, queue topic, or consumer handler
- one CLI subcommand
- one MCP tool
- one worker, job, schedule, webhook, or server start

Do not bundle all API endpoints into one page. Do not bundle all messages into
one page. Do not create broad architecture, module, entity, glossary, or generic
data-flow pages unless the human explicitly asks for those.

If many flows share files, keep separate pages and connect them with related
flows.

## Workflow

1. Call `index_files()` if the project index is empty or stale.
2. Call `wiki(shape)`.
3. Use the returned prompt and prefetch selectors to create `wiki/_discovery.json`.
4. Validate with `wiki(validate-discovery)`.
5. If validation reports errors, fix `wiki/_discovery.json` and validate again.
6. If validation passes, ask the human whether to continue.
7. If the human says yes, call `wiki(write)`.
8. Read `wiki(discovery)` and split the work by page slug.
9. For each slug, call `wiki(write:page:<slug>)`.
10. Write only the assigned page under `wiki/`.
11. After all page writers finish, call `wiki(validate-pages)` and fix any broken relative `.md` links it reports.

## Discovery Shape

Each flow may include `stateChanges` for project items whose state changes
during the flow. Use this for concrete items such as orders, jobs, files,
index rows, cache entries, sessions, messages, or checkpoints. Record `from`,
`to`, a plain-language `description`, and source evidence when the code proves
the change.

Each page should have:

- a category `kind`, usually matching the referenced flow kind, such as
  `tool`, `command`, `route`, `message`, `job`, or `schedule`
- exactly one `flowIds` item
- a specific slug, such as `routes/post-checkout` or `messages/order-created`

Avoid broad slugs such as `api`, `endpoints`, `messages`, `events`,
`data-flows`, `architecture`, `modules`, or `entities`.

When a flow depends on concrete caller-provided values or external
conditions, add an `inputs` array naming what the caller, environment,
schedule, message, config, or file system provides. Omit `inputs` when there
is no meaningful input.

When a flow has concrete outputs or visible side effects, add an `outputs`
array naming what the flow returns, writes, updates, starts, publishes, logs,
or otherwise changes. Omit `outputs` when there is no meaningful output. Do
not put request parameters, command flags, or tool arguments in `outputs`.
Those are inputs.

## Page Writing

Source-first rule: discovery is a map, not page content. Do not paste
discovery summaries, file lists, or `mustCover` wording into a page. Reopen the
source and turn each required topic into an explanation of verified behavior:
what starts the flow, what code runs, what data moves, what state changes, what
can fail, and what the caller or user observes.

For each page:

- treat the page packet as a map, not the source of truth
- read the source files named in `primaryFiles`, flow `files`, flow
  `evidence`, and `stateChanges` evidence before writing
- follow the source from trigger to observable result, including helper calls
  when the named file delegates the important behavior
- explain concepts before relying on internal names
- explain the single assigned flow in plain language
- include a Mermaid `sequenceDiagram` with `autonumber`
- add a numbered list explaining the diagram steps
- include a compact `Inputs` section when the page has `inputs`
- include a compact `Outputs` section when the page has `outputs`
- include a compact `State changes` section when the flow has `stateChanges`
- treat `mustCover` as the list of required topics for this page; every item
  must be explained in the page body from source-backed behavior
- use sparse root-relative source citations like `src/server.ts:42`
- add `Key source files` when several files matter
- preserve open questions instead of guessing

Before finishing, check every citation, named symbol, diagram step, input,
output, state change, failure case, example, and `mustCover` item against the
source. If a section is compact or dry, reopen the code and add the missing why,
data movement, branch, state change, or user-visible result.
