import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GetDB, resolveProject } from "./index";

const WIKI_INSTRUCTIONS = `# Wiki Generator

Generate a structured, cross-linked markdown wiki from the current codebase
using local-rag MCP tools. The wiki is built by querying the semantic index —
not by bulk-reading source files.

## Output Structure

\`\`\`
wiki/
  _manifest.json        # Tracks pages, source files, git ref for incremental updates
  index.md              # Landing page with one-line summaries per entry
  log.md                # Append-only changelog of wiki operations
  architecture.md       # High-level overview
  data-flow.md          # How data moves through the system
  api-surface.md        # Public API / entry points / CLI commands
  glossary.md           # Domain terms and project-specific jargon
  modules/
    <module>/
      index.md          # Module overview
      internals.md      # Internal implementation details (optional, large modules)
  entities/
    <entity-name>.md    # Key symbols (classes, widely-used functions, central types)
  guides/
    getting-started.md  # What you need to know to start working in this codebase
    conventions.md      # Patterns, naming, error handling approaches found in the code
    testing.md          # How tests are structured, what's covered
\`\`\`

## Rules

- **Links**: Use standard relative markdown links only (\`[Name](../entities/foo.md)\`). Never use Obsidian \`[[wikilinks]]\`.
- **Filenames**: Kebab-case always (\`hybrid-search.md\`, not \`HybridSearch.md\`).
- **Cross-references**: Every page must have a "See Also" section linking to related pages.
- **Diagrams**: Use Mermaid.js fenced blocks. Include all relevant nodes — completeness over brevity. Use subgraphs to group when diagrams are large. Use \`graph TD\` for hierarchies, \`graph LR\` for pipelines, \`sequenceDiagram\` for flows, \`classDiagram\` for entity relationships.
- **Mermaid reserved words**: Never use Mermaid keywords as bare node IDs. Reserved words include: \`graph\`, \`subgraph\`, \`end\`, \`style\`, \`classDef\`, \`click\`, \`linkStyle\`, \`class\`, \`default\`, \`node\`, \`edge\`. Always suffix them (e.g., \`depGraph\`, \`graphTools\`, \`endNode\`).
- **Over-fetch**: Use higher \`top\` values than defaults (see per-phase instructions). Missing context produces shallow pages.
- **No bulk reads**: Always use local-rag tools (\`read_relevant\`, \`search_symbols\`, \`project_map\`, etc.) to gather information. Do not Read entire source files.
- **No guessing signatures**: When documenting function signatures, parameter names, method names, or units — only write what \`read_relevant\` or \`search_symbols\` actually returned. If a chunk shows \`function foo(query: string, db: RagDB, topK: number)\`, write exactly that. Never invent parameter names, reorder parameters, or assume units (e.g., "tokens" vs "characters") without seeing the source.
- **Verify exports**: When listing a module's key exports, cross-check against \`search_symbols(symbol: "<module-prefix>", type: "export")\` results. Do not list functions that weren't in the results. Do not rename functions to what they "probably" are.

---

## Phase 0: Mode Detection

Check if \`wiki/_manifest.json\` exists by trying to read it.

- If it does **not** exist → run **full generation** (phases 1–6).
- If it **does** exist → run **incremental update** (phase 7).

---

## Phase 1: Discover Structure

Gather the information needed to plan the wiki.

1. Call \`server_info()\`. If 0 files are indexed, call \`index_files()\` first.
2. Call \`git_context()\` to get the current HEAD ref (store this for the manifest).
3. Call \`project_map(zoom: "directory", maxNodes: 100)\` to identify top-level modules.
4. Call \`project_map(maxNodes: 100)\` for the file-level dependency graph.
5. Call \`search_analytics()\` to identify documentation gaps.

From the results, build a list of:
- Top-level modules (directories with multiple files and clear responsibilities)
- Entry point files
- Key relationships between modules

---

## Phase 2: Architecture Pages

Generate the three top-level architecture documents.

1. Call \`read_relevant("project architecture entry points main modules", top: 20)\`.
2. Call \`read_relevant("configuration setup initialization", top: 20)\`.
3. Call \`read_relevant("data flow request handling pipeline processing", top: 20)\`.
4. Call \`read_relevant("public API exports CLI commands endpoints", top: 20)\`.

Then write:

### \`wiki/architecture.md\`

\`\`\`markdown
# Architecture

## Overview
One-paragraph project summary.

## Module Map
How modules relate to each other.

(Mermaid dependency graph generated from project_map — use graph TD, one node
per module, edges showing import direction)

## Entry Points
Where execution starts, what the public API surface is.

## Configuration
How the project is configured, key config files and options.

## Design Decisions
Key architectural choices and their rationale.
\`\`\`

### \`wiki/data-flow.md\`

\`\`\`markdown
# Data Flow

## Overview
How data enters, moves through, and exits the system.

## Primary Flows
Each major flow as a section with a Mermaid sequence diagram.

## Error Paths
How errors propagate through the system.
\`\`\`

### \`wiki/api-surface.md\`

\`\`\`markdown
# API Surface

## Public API
Exported functions, classes, endpoints grouped by module.

## CLI Commands
If applicable — command names, arguments, behavior.

## Configuration Options
Public-facing config keys and what they control.
\`\`\`

---

## Phase 3: Module Pages

For **each top-level module** identified in Phase 1:

1. Call \`project_map(focus: "<module-entry-file>", maxNodes: 100)\` for internal structure.
2. Call \`depends_on("<module-entry>")\` and \`depended_on_by("<module-entry>")\`.
3. Call \`read_relevant("<module-name> purpose responsibilities", top: 15)\`.
4. Call \`search_symbols(symbol: "<module-prefix>", exact: false, type: "export", top: 30)\` to discover exports.

Then write \`wiki/modules/<module-name>/index.md\`:

\`\`\`markdown
# <Module Name>

## Purpose
What this module does and why it exists.

## Structure
(Mermaid graph of internal file dependencies — use graph LR, one node per file,
edges showing internal imports)

## Files
- \\\`path/to/file.ts\\\` — brief description of what it does

## Key Exports
- \\\`functionName\\\` — what it does
- \\\`ClassName\\\` — what it represents

## Dependencies
What this module imports from other modules (with links to their module pages).

## Dependents
What other modules depend on this one (with links to their module pages).

## See Also
- Links to related module pages and entity pages for key exports
\`\`\`

If the module has **10+ files or 15+ exports**, also write
\`wiki/modules/<module-name>/internals.md\` with a detailed breakdown of internal
implementation: file-by-file descriptions, internal data flow, private helpers,
and implementation patterns.

---

## Phase 4: Entity Pages

### Discovery

First, discover entity candidates:

1. Call \`search_symbols(exact: false, type: "class", top: 30)\`.
2. Call \`search_symbols(exact: false, type: "interface", top: 30)\`.
3. For each candidate, call \`find_usages(symbol: "<name>", top: 50)\` and count call sites.
4. Select entities matching the heuristic:
   - Exported symbols used by **3+ files**
   - All classes and interfaces
   - Central types that appear in multiple modules
   - **Skip**: internal helpers, one-off utilities, test fixtures

### Generation

For each selected entity:

1. Call \`search_symbols(symbol: "<name>", exact: true)\` for the definition.
2. Call \`find_usages(symbol: "<name>", top: 50)\` for all call sites.
3. Call \`read_relevant("<name> implementation behavior", top: 10)\` for deeper context.

Then write \`wiki/entities/<entity-name>.md\`:

\`\`\`markdown
# <Entity Name>

## Definition
Where it's defined and what it is (function, class, type, etc).

## Signature
The interface / function signature.

## Relationships
(Mermaid class/ER diagram — only if entity has relationships: implements,
extends, references other entities. Skip this section for standalone functions.)

## Behavior
How it works, key logic, important details.

## Usage
Where it's used — call sites grouped by module, with links to module pages.

## See Also
- Link to parent module page
- Links to related entity pages
\`\`\`

---

## Phase 5: Guides + Reference Pages

1. Call \`read_relevant("getting started setup development environment", top: 15)\`.
2. Call \`read_relevant("patterns conventions error handling naming", top: 15)\`.
3. Call \`read_relevant("tests testing structure coverage", top: 15)\`.
4. Call \`search_symbols(type: "type", top: 50)\` and \`search_symbols(type: "enum", top: 50)\` for domain terms.

Then write:

### \`wiki/guides/getting-started.md\`

\`\`\`markdown
# Getting Started

## Prerequisites
What you need installed, what accounts/access you need.

## Project Structure
Quick orientation — what lives where (link to architecture.md for details).

## Key Concepts
Domain concepts you need to understand before diving in (link to glossary.md).

## Common Tasks
How to run, test, build, deploy.
\`\`\`

### \`wiki/guides/conventions.md\`

\`\`\`markdown
# Conventions

## Naming
Naming patterns found in the codebase.

## Error Handling
How errors are created, propagated, and handled.

## Patterns
Recurring code patterns and idioms.

## File Organization
How files and modules are structured.
\`\`\`

### \`wiki/guides/testing.md\`

\`\`\`markdown
# Testing

## Structure
How tests are organized (directories, naming, grouping).

## Running Tests
Commands and options.

## Patterns
Common test patterns used in this codebase.

## Coverage
What's well-tested, what's not.
\`\`\`

### \`wiki/glossary.md\`

\`\`\`markdown
# Glossary

| Term | Definition |
|------|-----------|
| TermName | What it means in this project's context |
\`\`\`

Populate with domain-specific types, enums, and jargon found via \`search_symbols\`.

---

## Phase 6: Index + Finalize

### \`wiki/index.md\`

Write the landing page with one-line summaries for every page:

\`\`\`markdown
# <Project Name> Wiki

<One-paragraph project summary.>

## Architecture
- [Architecture Overview](architecture.md) — high-level structure and design decisions
- [Data Flow](data-flow.md) — how data moves through the system
- [API Surface](api-surface.md) — public entry points and interfaces

## Modules
- [Module Name](modules/module-name/index.md) — one-line summary of purpose

## Key Entities
- [EntityName](entities/entity-name.md) — one-line summary

## Guides
- [Getting Started](guides/getting-started.md) — onboarding for new contributors
- [Conventions](guides/conventions.md) — patterns and practices in this codebase
- [Testing](guides/testing.md) — test structure and coverage

## Reference
- [Glossary](glossary.md) — domain terms and project jargon
\`\`\`

### \`wiki/log.md\`

Append an entry:

\`\`\`markdown
## <DATE> — Full generation
Generated N module pages, M entity pages, 3 guides, 1 glossary.
Source: <HEAD ref>. Index: X files, Y chunks.
\`\`\`

### \`wiki/_manifest.json\`

Write the manifest tracking every generated page:

\`\`\`json
{
  "version": 1,
  "generatedAt": "<timestamp>",
  "lastGitRef": "<HEAD ref from Phase 1>",
  "pages": {
    "architecture.md": {
      "generatedAt": "<timestamp>",
      "sourceFiles": ["<files that informed this page>"]
    }
  }
}
\`\`\`

Each page entry records which source files contributed to it, so incremental
updates can determine which pages to regenerate when source files change.

### Re-index

Call \`index_files()\` so the wiki pages themselves become searchable via local-rag.

---

## Phase 7: Incremental Update

Run this phase when \`wiki/_manifest.json\` already exists.

1. Read \`wiki/_manifest.json\` to get \`lastGitRef\` and page→source mappings.
2. Call \`git_context(since: "<lastGitRef>")\` to get all changed files.
3. If **>30% of indexed files** have changed, fall back to full regeneration (phases 1–6).
4. Map changed source files → affected wiki pages using the manifest's \`sourceFiles\` mappings.
5. Detect new modules or files that have no wiki page → queue them for generation.
6. Detect deleted source files → remove orphaned wiki pages and clean up any links to them.
7. Regenerate only affected pages using the same tool calls and templates as phases 2–5, scoped to just the affected pages.
8. Always regenerate \`wiki/index.md\` (cheap, keeps TOC current).
9. Append to \`wiki/log.md\`:

\`\`\`markdown
## <DATE> — Incremental update
Updated: <list of pages>. Added: <new pages>. Removed: <deleted pages>.
Trigger: N files changed since <lastGitRef>.
Source: <new HEAD ref>.
\`\`\`

10. Update \`wiki/_manifest.json\` with new timestamps, git ref, and source file mappings.
11. Call \`index_files()\` to re-index updated wiki pages.`;

export function registerWikiTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "generate_wiki",
    "Generate or update a structured markdown wiki for the codebase. Call with run: true to immediately execute all phases (recommended). Returns step-by-step instructions that use local-rag tools (read_relevant, search_symbols, project_map, etc.) to build wiki pages in wiki/. When run is true, follow every phase without waiting for user input. Supports incremental updates when wiki/_manifest.json already exists.",
    {
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      run: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, instructs the agent to immediately execute all phases without waiting for further user input"),
    },
    async ({ directory, run }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);
      const status = ragDb.getStatus();

      let preamble: string;
      if (status.totalFiles === 0) {
        preamble = "⚠ The index is empty — run `index_files()` first, then follow the instructions below.\n\n";
      } else if (run) {
        preamble = `Index: ${status.totalFiles} files, ${status.totalChunks} chunks.\n\n**ACTION REQUIRED: Follow the phases below step by step. Start with Phase 0 now. Do not wait for further user input. Execute all tool calls described in each phase, write the wiki files, and continue until Phase 6 (or Phase 7 for incremental updates) is complete.**\n\n`;
      } else {
        preamble = `Index: ${status.totalFiles} files, ${status.totalChunks} chunks. Ready to generate.\n\n`;
      }

      return {
        content: [{ type: "text" as const, text: preamble + WIKI_INSTRUCTIONS }],
      };
    }
  );
}
