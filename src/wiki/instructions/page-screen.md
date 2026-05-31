You are writing one wiki page for a frontend UI screen from validated discovery data.

Assigned page slug: `{{slug}}`

Your job is to write `wiki/{{slug}}.md`. This is a screen page, not a backend flow page. A screen lives over time, renders a component tree, and reacts to user interactions, so the page shape is different from request/response flow pages. Do not edit other wiki pages. Do not redo the whole discovery process.

Start here:

1. Read the page item and the referenced screen flow included in this prompt.
2. Read the source files named in `page.primaryFiles`, `flows[].files`, `flows[].evidence`, `flows[].interactions[].evidence`, and `flows[].stateChanges[].evidence`. Trace mount, render, and each interaction in the source before writing.
3. Use mimirs tools such as `read_relevant`, `search`, `project_map`, `depends_on`, `depended_on_by`, `search_symbols`, and `find_usages` to map the component tree, find state owners, and locate API call sites.

{{writing-contract}}
For the assigned page:

- Write to `wiki/<slug>.md`.
- Use the page `title` as the H1.
- Open with one short paragraph: what this screen is, where it lives (route path or mount point), and what the user can do on it. Cite the route registration or mount site with a root-relative inline citation such as `src/app/routes.ts:42`.
- Add a `Mount-time flow` section with a Mermaid sequence diagram (use `autonumber`). Cover what happens from route match or mount through first paint: route params parsed, props read, store slices subscribed, server data fetched, first render. Below the diagram, add a numbered list explaining each step with source citations. In every Mermaid diagram on this page, use `<br>` for label line breaks — never `\n`, which renders literally — and never use a reserved word (`graph`, `subgraph`, `end`, `class`, `state`, `click`) as a node id; suffix it instead.
- Add a `Component tree` section with a Mermaid `graph` diagram of the rendered tree. Include every component that materially owns or consumes state, fetches data, or handles a user interaction. Do not cap the depth — render the full structure even when it is large; readers can scroll. The shape is a guide, not a contract: single-page apps often have one root with many flat siblings, and that is fine — do not force a deeper hierarchy than the code has. Where applicable, annotate nodes with `(owns: ...)` for the state they define and `(consumes: ...)` for store slices, contexts, or refs they read. These annotations carry most of the signal when the diagram itself is flat; treat them as required whenever a node owns or consumes external state. Below the diagram, add short bullets only for nodes that need explanation; do not narrate the whole tree.
- Add an `Interactions` section. For every entry in `flows[].interactions[]`, add an `###` sub-section using the interaction `name` as the heading. Each sub-section must include: the concrete trigger, a short Mermaid sequence diagram tracing handler → state change → API call → store update → re-render, source citations for the handler and any mutation or API call, and a one-line note on what the user sees afterwards. Triggers do not have to be clicks: keyboard shortcuts registered via `document.addEventListener` or hotkey hooks, window-level events such as `hashchange`, `focus`, `blur`, `visibilitychange`, `beforeunload`, and same-page URL mutations all count as legitimate trigger sources for an interaction. Name the concrete event source in the trigger line (for example "keydown Alt+Shift+D on document", "window hashchange event"). If an interaction has error or empty states grounded in source, mention them inline in its sub-section, not in a separate failures section. When the handler implementation lives outside `primaryFiles` (for example in a sibling package or in the upstream library this screen embeds), still cite it; describe the screen's *use* of that handler, not its full implementation.
- Add a `State surface` section as a table with columns `Name | Scope | Owner`, listing each state slice this screen reads or writes. `Scope` is local, store, server-cache, url, persisted (localStorage / IndexedDB), or other. `Owner` is the file and symbol that defines or initializes it. Only include slices grounded in source.
- Add an `API surface` section as a table with columns `Endpoint | Transport | Call site`. List each backend endpoint or external integration this screen makes. `Endpoint` is the path, URL, topic, or channel as it appears in source (do not invent base URLs). `Transport` covers the wire kind, not just HTTP — examples: `GET`, `POST`, `WebSocket`, `SSE`, `Firebase RTDB`, `Firebase Storage`, `IndexedDB`, `postMessage`, `GraphQL query`. Use whatever label honestly describes the integration. `Call site` is a root-relative file path and line such as `src/screens/checkout/api.ts:42`. Do not link to backend flow pages; the path string is enough.
- Add an `Entry points and transitions` section with two short lists: `In` (how users or other code reach this screen) and `Out` (where the screen sends them). Cover route-level navigation (router push/replace, `<Link>` components), URL mutations done from this screen (`window.location.hash`, `history.pushState`, `replaceState`), window-level handoffs (`window.open`, parent-window `postMessage`), and inbound triggers from URL hashes, query strings, or deep links when the screen is no-router. Cite the call sites. Omit either list when there is none.
- Do not add `Inputs`, `Outputs`, `Branches and failure cases`, or `State changes` sections; the shape above replaces them for screen pages. If the discovery entry has `stateChanges`, fold them into the relevant interaction sub-section or the `State surface` table where they fit.
- Add a short `Key source files` section at the end listing each important root-relative file path and its role (route registration, top-level component, child component, store, API client).
- Treat `mustCover` as the list of required topics. Every item in `page.mustCover` must be explained somewhere in the page body, with source-backed detail.
- Use citations sparingly. Cite the main source location for each section, each interaction handler, each API call, and any surprising behavior. Prefer one root-relative inline-code citation per paragraph or bullet such as `src/screens/checkout/page.tsx:42`. Do not use Markdown links for source-file citations.
- Mention important `openQuestions` instead of hiding uncertainty.

Self-check before finishing:

1. Re-read the page paragraph by paragraph.
2. For each inline citation like `src/foo.tsx:42` or `src/foo.tsx:10-20`, open the file and confirm the cited range actually contains what the surrounding sentence claims. Fix wrong line numbers from the real source; only remove a citation when no equivalent exists.
3. Confirm every component, hook, store slice, endpoint, and handler you named exists in the referenced source. Replace invented names with the real ones.
4. Confirm each node in the component-tree diagram is a real component reachable from this screen's root, and each interaction sub-section corresponds to a real handler in source. Rewrite or remove nodes and interactions that do not match the code.
5. Confirm the `State surface` and `API surface` tables match what the code actually does: each row is grounded in a real read, write, or request you can point at.
6. For each `mustCover` item, confirm the page explains it from verified source behavior, not from rephrasing the packet summary.
7. Prefer correcting over deleting. Reach for the source first and fix the claim. Delete only when the source shows no matching behavior.

{{self-check}}