# Wiki instructions

These markdown files hold the prose the `wiki` tool serves while generating a
project wiki. Editing them customizes how *this project's* wiki is written.

- They **override** the defaults shipped inside mimirs. A file here wins; delete
  it to fall back to the packaged default (and to keep getting updates to that
  default on upgrade).
- They are under `.mimirs/`, which is gitignored by default. Un-ignore them if
  you want to share your wiki conventions with your team.

## Files

- `discovery.md` — rules for building `wiki/_discovery.json` (the `shape` step).
- `write.md` — how to split page-writing work (the `write` step).
- `writing-contract.md` — the shared source-first contract, included in every page prompt.
- `self-check.md` — the shared final self-check, included in every page prompt.
- `page-flow.md` — the prompt for a single backend flow page (route, command, tool, message, job).
- `page-screen.md` — the prompt for a single frontend UI screen page.
- `page-overview.md` — the prompt for a bird's-eye overview page.
- `page-mechanism.md` — the prompt for a shared-internal-subsystem page (`mechanisms/<name>`).
- `changelog.md` — the prompt for writing one `wiki/CHANGELOG.md` entry (the `changelog` step).
- `update.md` — the prompt for an incremental update: decide which pages a code/instruction change made stale and regenerate only those (the `update` step).

## Tokens

`{{...}}` placeholders are filled in by the tool when it serves a file:

- `{{writing-contract}}` / `{{self-check}}` (in the `page-*.md` files) — replaced
  with the contents of `writing-contract.md` and `self-check.md`. This is why the
  shared blocks live in their own files: edit one, and every page inherits it.
- `{{slug}}` (in the `page-*.md` files) — the page being written.
- `{{schemaVersion}}` (in `discovery.md`) — the current discovery schema version.
- `{{currentCommit}}` / `{{date}}` (in `changelog.md`) — the source commit the
  wiki was generated from and today's date, for the entry header.
- `{{kind}}`, `{{kindDescription}}`, `{{diagramGuidance}}`, `{{diagramSelfCheck}}`
  (in `page-overview.md`) — overview pages vary by kind (architecture,
  data-model, configuration, …). These values are chosen in code from the
  overview kind, so editing the prose around them is safe but the set of kinds
  and the diagram-exempt rule are not configurable here.

Keep the tokens intact when you edit; a removed `{{writing-contract}}` drops the
shared contract from that page.
