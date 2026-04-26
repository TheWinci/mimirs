/**
 * Curated catalog of section shapes used as building blocks during community
 * synthesis (step 4 of the Louvain-led wiki pipeline).
 *
 * The LLM receives this catalog alongside a community bundle and picks,
 * adapts, or invents sections. When it picks a catalog entry, the `shape`
 * field is copied into the synthesis payload so step 5 (page writing) knows
 * how to structure that section without re-reading the catalog.
 *
 * Not content to reuse — examples to base shape decisions on.
 */
export interface SectionCatalogEntry {
  id: string;
  title: string;
  purpose: string;
  shape: string;
  exampleBody: string;
}

export const SECTION_CATALOG: SectionCatalogEntry[] = [
  {
    id: "entry-points",
    title: "Entry points",
    purpose: "List the public surface a consumer reaches first",
    shape: "bulleted list of exports with 1-line purpose each",
    exampleBody: "- `indexFiles(dir)` — top-level scan + embed\n- `search(query)` — semantic query over the index",
  },
  {
    id: "lifecycle-flow",
    title: "How it works",
    purpose:
      "Trace the runtime flow across the community's files — a caller triggers work that fans out through internal files to a sink. The diagram shows who calls whom; the numbered steps say what happens at each hop. Required for any multi-file community.",
    shape:
      "A `sequenceDiagram` mermaid block showing the real participants (use concrete file/function names, not placeholders), followed by a numbered prose list citing specific files and line ranges for each step. Skip only when the community is a static utility bag with no runtime flow.",
    exampleBody:
      "```mermaid\nsequenceDiagram\n  participant caller as CLI\n  participant parser as parser.ts\n  participant resolver as resolver.ts\n  participant emitter as emitter.ts\n  caller->>parser: parse(input)\n  parser->>resolver: AST\n  resolver->>emitter: typed AST\n  emitter-->>caller: output\n```\n\n1. **Parse** — `parser.ts:parse()` tokenises input into an AST.\n2. **Resolve** — `resolver.ts:resolve()` attaches type info.\n3. **Emit** — `emitter.ts:emit()` writes the final output.",
  },
  {
    id: "dependency-graph",
    title: "Dependencies and consumers",
    purpose:
      "Show who this community imports from and who imports it, at a glance. Required whenever the community has a meaningful edge count so readers can see the blast radius before touching code.",
    shape:
      "A `flowchart LR` mermaid block with an `Upstream` subgraph (external dependencies), the community name as the central node, and a `Downstream` subgraph (external consumers). Use real file/module names, not placeholders. Follow the diagram with a compact bulleted list: `Depends on:` and `Depended on by:` pointing to wiki pages where they exist.",
    exampleBody:
      "```mermaid\nflowchart LR\n  subgraph Upstream[Depends On]\n    db[db/index.ts]\n    utils[utils/paths.ts]\n  end\n  self[This community]\n  subgraph Downstream[Depended On By]\n    tools[tools/mcp.ts]\n    cli[cli/main.ts]\n  end\n  db --> self\n  utils --> self\n  self --> tools\n  self --> cli\n```\n\n- **Depends on:** `db/`, `utils/paths.ts`\n- **Depended on by:** `tools/mcp.ts`, `cli/main.ts`",
  },
  {
    id: "data-shapes",
    title: "Data shapes",
    purpose: "Define the core types or records that flow through the module",
    shape: "code blocks of type definitions, each followed by 1-2 sentences of intent",
    exampleBody: "```ts\ninterface Chunk { id: string; content: string; embedding: Float32Array }\n```\nOne row per semantic unit. `embedding` is populated lazily on first search.",
  },
  {
    id: "failure-modes",
    title: "Failure modes",
    purpose: "Call out how things break, what the module does about it, and what callers must handle",
    shape: "bulleted list of failure modes, each with cause / behavior / caller action",
    exampleBody: "- **Index missing** — `search` returns `[]`; caller should surface an empty-state UI, not an error.\n- **Embedding model OOM** — batch is retried at half size; persistent failure throws `EmbedError`.",
  },
  {
    id: "integration-points",
    title: "Integration points",
    purpose: "Show where this module plugs into the rest of the system",
    shape: "subsections per integration target, each with direction (imports-from / imported-by) and purpose",
    exampleBody: "### `db/` (imports)\nReads chunks via `getChunks(fileId)`; writes embeddings back with `upsertEmbedding`.\n\n### `tools/` (imported by)\nMCP tool handlers call `search()` to serve `mimirs_search`.",
  },
  {
    id: "key-invariants",
    title: "Invariants",
    purpose: "State the rules the module relies on internally and that callers must preserve",
    shape: "bulleted list, each invariant phrased as a declarative rule",
    exampleBody: "- Every chunk has exactly one embedding once indexed.\n- File paths stored in the DB are project-relative, never absolute.",
  },
  {
    id: "tuning-knobs",
    title: "Tuning",
    purpose: "Parameters or config flags that change behavior without code edits",
    shape: "table: name / default / effect / when to change",
    exampleBody: "| Knob | Default | Effect | When to change |\n|------|---------|--------|---------------|\n| `BATCH_SIZE` | 64 | Embed batch | Lower on small GPUs |\n| `RESOLUTION` | 1.0 | Louvain granularity | Raise for more, smaller communities |",
  },
  {
    id: "concrete-walkthrough",
    title: "Worked example",
    purpose: "Trace a realistic input end-to-end through the module",
    shape: "prose narrative with interleaved code snippets and file references",
    exampleBody: "Searching for `\"embed init\"`:\n\n1. `search()` (`search.ts:42`) embeds the query via the same model used at index time.\n2. `db.vectorSearch()` (`db/vec.ts:88`) runs KNN against the stored vectors.\n3. Results are re-ranked by chunk type and returned.",
  },
  {
    id: "consumers",
    title: "Consumers",
    purpose: "Who depends on this module and what they rely on it for",
    shape: "bulleted list of external modules with 1-line usage note each",
    exampleBody: "- **`tools/`** — calls `search()` for the MCP endpoint.\n- **`cli/`** — uses the same entry points, plus `indexFiles` for the `index` subcommand.",
  },
  {
    id: "design-rationale",
    title: "Why it's built this way",
    purpose: "Explain non-obvious structural decisions and the alternatives rejected",
    shape: "short prose, one paragraph per decision, leading with the decision and following with the reason",
    exampleBody: "**Louvain over directory layout.** Directories reflect authorship, not cohesion. Louvain clusters by import structure, which matches how the code actually couples at runtime.",
  },
  {
    id: "per-file-breakdown",
    title: "Per-file breakdown",
    purpose:
      "Give each load-bearing file its own prose section — role, key exports, constants worth citing, and the non-obvious behavior a reader would miss from signatures alone. This is what distinguishes a wiki from a signature dump. When the link map ships sub-pages for big members, SKIP those files here (the sub-page covers them) — cover only the members that don't have a sub-page.",
    shape:
      "One `### path/to/file.ts — <short role label>` heading per member file that does NOT have a sub-page in the link map (order by per-file PageRank). Each section: 2-6 sentences of prose naming the file's role in the community, the 2-4 most important exports with what they do (not just signatures), any named constants with their values (e.g. `DEFAULT_HYBRID_WEIGHT = 0.7`), and one or two gotchas worth knowing. No redundant signature tables — the prose carries the information.",
    exampleBody:
      "### `src/search/hybrid.ts` — the search runtime\n\nBiggest file in the community. Owns `search`, `searchChunks`, and the internal `matchesFilter` used for symbol-expanded hits (mirrors `buildPathFilter` in `src/db/search.ts`). Every ranking adjustment lives here: `applyPathBoost` (×1.1 source / ×0.85 test), `applyFilenameBoost`, `applyGraphBoost` (+0.05 × log2(importers+1)), `expandForDocs`, `groupByParent`. Constants: `DEFAULT_HYBRID_WEIGHT = 0.7`, `GENERATED_DEMOTION = 0.75`, `BOILERPLATE_BASENAMES` (types.ts, index.d.ts, constants.go...), `STOP_WORDS`.\n\n### `src/search/usages.ts` — find_usages helpers\n\nTiny — two exports. `escapeRegex` is the standard regex-metachar escape. `sanitizeFTS` quotes every token so FTS5 operators (`+ - * AND OR NOT NEAR`) are treated as literals. Design choice: `find_usages` works at query time rather than pre-indexing call sites.",
  },
  {
    id: "internals",
    title: "Internals",
    purpose:
      "Surface the insider knowledge that's not obvious from signatures — tuning knobs masquerading as constants, silent fallbacks, guards against conditions that can't occur, heuristics with blind spots. This is where someone who wrote the code would drop hints a reader would otherwise have to hit a bug to learn.",
    shape:
      "Bulleted list. Each bullet leads with a bold claim (usually a named symbol or behavior), then 1-3 sentences of elaboration citing the specific file and line or constant. Prefer concrete numbers over generic prose.",
    exampleBody:
      "- **`hybridWeight` is a tuning knob, not a constant.** The default 0.7 is in `hybrid.ts` AND in `DEFAULT_CONFIG`; benchmark runs override it at the call site. Raise toward 1.0 for semantic queries, lower for keyword-heavy.\n- **FTS failures are non-fatal.** `db.textSearch` throwing (malformed query, escape bug) logs at debug level and falls back to vector-only. Users don't see the error.\n- **`PathFilter` is enforced twice.** Vector and FTS SQL both apply it, but symbol expansion bypasses those queries, so `matchesFilter` re-checks each symbol hit in memory before merging.\n- **The `×1.3` boost in `mergeSymbolResults` uses `Math.max`.** Guards against a regression where the new score could be lower — but `r.score * 1.3 < r.score` is impossible for positive scores. Dead defensive logic.",
  },
  {
    id: "known-issues",
    title: "Known issues",
    purpose:
      "Call out genuine bugs, heuristics with blind spots, or fragile assumptions — sourced from annotations or from the top-member body. Do not fabricate. Omit the section entirely when nothing warrants it.",
    shape:
      "Bulleted list. Each bullet: bold issue title, then 1-2 sentences on symptom, cause (if known), and where it's tracked (file:line or annotation). No generic warnings like 'OOM possible' — only real issues grounded in code.",
    exampleBody:
      "- **`STOP_WORDS` is English-specific and aggressive.** Includes generic code words like `file`, `function`, `class`, `error`, `query`, `search`. Non-English queries lose most candidate words; English queries lose words that are valid identifiers in the codebase. Tracked at `src/search/hybrid.ts:STOP_WORDS`.\n- **Identifier heuristic rejects lowercase names.** `extractIdentifiers` only keeps tokens with mixed case, `_`, or `.`. A query like `render parser` won't symbol-expand either word.\n- **`applyGraphBoost` probes the DB once per result.** For a `topK * 4`-sized pool that's up to 20 `getFileByPath` + `getImportersOf` calls per search. Indexed but visible on large repos.",
  },
  {
    id: "trade-offs",
    title: "Trade-offs",
    purpose:
      "Name the gains and costs of the current design so a future maintainer can tell whether a constraint is load-bearing. Different from `design-rationale` in framing: rationale explains why the alternative was rejected; trade-offs explain what the current choice gives up. Use for communities where multiple reasonable designs exist and the chosen one commits to one set of properties at the expense of another.",
    shape:
      "Bulleted list. Each bullet opens with the chosen property in bold, then a `Cost:` clause naming what was given up and why it's acceptable here.",
    exampleBody:
      "- **Hybrid vector + FTS ranking.** Cost: two queries per search instead of one; we accept the latency to recover keyword matches the embedding alone loses.\n- **Louvain over directory layout.** Cost: community labels drift if the import graph changes meaningfully between runs. Directory names are stable but encode authorship, not cohesion.\n- **Per-query symbol expansion.** Cost: up to 20 extra `getFileByPath` calls on a `topK * 4` pool. Indexing call sites would be faster but doubles storage.",
  },
  {
    id: "common-gotchas",
    title: "Common gotchas",
    purpose:
      "Things a first-time reader of this community will get wrong. Shorter and more pragmatic than `known-issues`: these aren't bugs, they're counter-intuitive facts about how the code behaves. Think: \"I spent two hours on X before realising Y.\" Required for deep/high-LOC communities where the signatures don't reveal the whole story.",
    shape:
      "Bulleted list. Each bullet: short bold claim (often a symbol or behavior), then 1–2 sentences of elaboration. Cite file:line or constant. Keep each gotcha under three sentences.",
    exampleBody:
      "- **Paths in the DB are project-relative, not absolute.** Callers that pass `resolve(...)` results silently miss every lookup. Normalise with `relative(projectDir, path)` at the boundary.\n- **`search()` returns an empty array, not an error, when the index is missing.** Check `db.indexExists()` first if empty results would confuse the user.\n- **The `<=` in `embedBatchMerged` is intentional.** Off-by-one boundary was the cause of the 2025-10 silent-skip bug; do not `<`.",
  },

  // ─── Backend-service shapes (Phase 2: backend-service wiki) ───
  // Each fires when the per-community `serviceRole` matches; the writer
  // gets the role tag in the bundle so injection is one switch in the
  // selection prompt, not framework-specific code.
  {
    id: "endpoint-catalog",
    title: "Endpoints",
    purpose:
      "Enumerate every HTTP route this community owns so a reader scanning the page can locate the handler in one jump. Required when community role is `http` — empty section is worse than no section, so omit if `bundle.serviceSignals.routes` is empty.",
    shape:
      "Markdown table with columns: `Method | Path | Handler | File:line | Auth | Summary`. Order rows by path, then method. Cite file:line from `bundle.serviceSignals.routes` verbatim — do not paraphrase. `Auth` column may say `none` when middleware doesn't gate the route.",
    exampleBody:
      "| Method | Path | Handler | File:line | Auth | Summary |\n|--------|------|---------|-----------|------|---------|\n| `GET` | `/users/:id` | `UsersController.findOne` | `src/users/users.controller.ts:42` | `JwtAuthGuard` | Lookup by id, 404 if missing |\n| `POST` | `/users` | `UsersController.create` | `src/users/users.controller.ts:58` | `JwtAuthGuard` | Validates against `CreateUserDto`, returns 201 |\n| `DELETE` | `/users/:id` | `UsersController.remove` | `src/users/users.controller.ts:71` | `JwtAuthGuard` + `RolesGuard('admin')` | Soft-delete, idempotent |",
  },
  {
    id: "request-flow",
    title: "Request flow",
    purpose:
      "Trace a representative endpoint from handler to data store, surfacing every hop a debugger would need to set breakpoints on. Pick the top 1-3 endpoints by call-depth or LOC — not every route. Same shape rules as `lifecycle-flow`; this section is the service-flavored variant scoped to one request lifecycle.",
    shape:
      "One `sequenceDiagram` Mermaid block per representative endpoint, followed by a numbered prose list citing file:line for each hop. Use real participant names (controller class, service class, repo/DAO, external client) — no placeholders. Skip when `bundle.serviceSignals.routes` has no entries with traceable internal calls.",
    exampleBody:
      "**`POST /orders` — place an order**\n\n```mermaid\nsequenceDiagram\n  participant client as HTTP client\n  participant ctl as OrdersController\n  participant svc as OrdersService\n  participant repo as OrdersRepository\n  participant kafka as Kafka producer\n  client->>ctl: POST /orders\n  ctl->>svc: create(dto)\n  svc->>repo: insert(order)\n  repo-->>svc: order\n  svc->>kafka: emit OrderCreated\n  ctl-->>client: 201 + order\n```\n\n1. **Handler** — `OrdersController.create` (`src/orders/orders.controller.ts:48`) parses `CreateOrderDto`, calls the service.\n2. **Service** — `OrdersService.create` (`src/orders/orders.service.ts:33`) wraps the insert + emit in a transaction.\n3. **Repository** — `OrdersRepository.insert` (`src/orders/orders.repository.ts:27`) executes the INSERT via TypeORM.\n4. **Event** — `KafkaProducer.emit` (`src/messaging/producer.ts:18`) publishes `OrderCreated` to topic `orders.v1`.",
  },
  {
    id: "queue-topology",
    title: "Queue topology",
    purpose:
      "Show every topic this community produces to or consumes from, with the file:line of each producer/consumer. Required when community role is `messaging`. Renders as a bipartite-ish flowchart so readers see the topology at a glance.",
    shape:
      "Mermaid `flowchart LR` with three subgraphs: `Producers`, `Topics`, `Consumers`. Edges go producer → topic → consumer. Follow with a bullet list of `topic — producer file:line / consumer file:line`. Pull data from `bundle.serviceSignals.queueOps` verbatim. Skip when no queue ops in bundle.",
    exampleBody:
      "```mermaid\nflowchart LR\n  subgraph Producers\n    ord[orders.service.ts]\n  end\n  subgraph Topics\n    t1[orders.v1]\n  end\n  subgraph Consumers\n    bill[billing.consumer.ts]\n    notif[notifications.consumer.ts]\n  end\n  ord --> t1\n  t1 --> bill\n  t1 --> notif\n```\n\n- **`orders.v1`** — produced by `src/orders/orders.service.ts:51`; consumed by `src/billing/billing.consumer.ts:14` and `src/notifications/notifications.consumer.ts:9`.",
  },
  {
    id: "message-shapes",
    title: "Message shapes",
    purpose:
      "Define the payload schema for each topic in `queue-topology`. Lets a downstream consumer team understand what they'll receive without reading every producer. Adjacent to `queue-topology` — pair them.",
    shape:
      "Per topic: a fenced code block of the type/schema definition (TypeScript `interface`, Python TypedDict, JSON Schema, Avro — whatever the codebase uses), then 1-2 sentences of intent. Cite the file where the type is defined.",
    exampleBody:
      "**`orders.v1`** (`src/orders/events.ts:8`)\n```ts\ninterface OrderCreated {\n  orderId: string;\n  userId: string;\n  totalCents: number;\n  createdAt: string; // ISO 8601\n}\n```\nEmitted exactly once per successful checkout. `totalCents` is integer cents — no floating point.",
  },
  {
    id: "data-stores",
    title: "Data stores",
    purpose:
      "Show which tables / collections / caches this community reads from and writes to, plus the transaction boundary if one exists. Required when community role is `data-access`. Lets readers reason about consistency without grepping for ORM calls.",
    shape:
      "Markdown table: `Store | Model/Table | Reads | Writes | Tx boundary`. One row per (store, model) pair. Reads/Writes columns name the symbols (e.g. `findOne`, `update`). Tx boundary names the wrapping function or `none` for non-transactional access.",
    exampleBody:
      "| Store | Model/Table | Reads | Writes | Tx boundary |\n|-------|-------------|-------|--------|-------------|\n| Postgres | `orders` | `findById`, `listByUser` | `insert`, `markPaid` | `OrdersService.create` |\n| Postgres | `payments` | `findByOrder` | `insert` | `OrdersService.create` |\n| Redis | `order:idempotency` | `get` | `setex(60)` | none |",
  },
  {
    id: "external-services",
    title: "External services",
    purpose:
      "List every external service or vendor SDK this community talks to, where the call lives, and how it's configured (timeout, retry, circuit breaker). Helps reviewers spot cascade-failure surfaces.",
    shape:
      "Bulleted list grouped by host or SDK. Each bullet: `**Service / SDK** — client file (file:line). Purpose. Retry/timeout config (or 'defaults').` Cite from `bundle.serviceSignals.externalCalls` and any visible config.",
    exampleBody:
      "- **Stripe** — `src/billing/stripe-client.ts:14`. Charges and refunds. 3 retries with exponential backoff on 5xx; 5s timeout per call.\n- **SendGrid** — `src/notifications/email.ts:9`. Transactional email. Default SDK retries; no custom timeout.\n- **Internal user-service** — `src/clients/users-client.ts:22`. JWT-validated REST. 1s timeout; circuit breaker opens after 5 consecutive failures.",
  },
  {
    id: "scheduled-jobs",
    title: "Scheduled jobs",
    purpose:
      "Document every cron job, scheduled task, or recurring background job this community owns. Required when community role is `scheduler`. Covers cron-expression jobs, Celery beat schedules, Quartz triggers, BullMQ repeatables — anything that fires on its own.",
    shape:
      "Markdown table: `Job | Schedule | Handler | What it does | Failure behavior`. Order by schedule frequency (most frequent first). Schedule column uses the framework's native syntax (cron, interval, named).",
    exampleBody:
      "| Job | Schedule | Handler | What it does | Failure behavior |\n|-----|----------|---------|--------------|------------------|\n| `expireSessions` | `*/5 * * * *` | `SessionsService.sweep` (`src/sessions/sessions.service.ts:41`) | Marks sessions older than 24h as expired | Logs error, retries next tick |\n| `nightlyDigest` | `0 7 * * *` | `DigestJob.run` (`src/jobs/digest.job.ts:18`) | Sends per-user activity summary email | 3 retries, then alerts via PagerDuty |\n| `reconcileBilling` | `@daily` | `BillingJob.reconcile` (`src/billing/billing.job.ts:55`) | Compares Stripe charges vs internal ledger | Halts on mismatch, requires manual intervention |",
  },
  {
    id: "auth-and-middleware",
    title: "Auth and middleware",
    purpose:
      "List the middleware chain this community installs or relies on, in request-lifecycle order. Lets readers understand what runs before a handler executes — auth, rate limit, logging, etc.",
    shape:
      "Markdown table: `Name | File:line | Applies to | Effect`. Order rows by execution order in the request lifecycle (outermost first). `Applies to` column names route prefix or 'global'.",
    exampleBody:
      "| Name | File:line | Applies to | Effect |\n|------|-----------|------------|--------|\n| `requestId` | `src/middleware/request-id.ts:8` | global | Attaches `x-request-id` header, populates AsyncLocalStorage |\n| `rateLimit` | `src/middleware/rate-limit.ts:14` | `/api/*` | Token bucket per IP — 100 req/min |\n| `JwtAuthGuard` | `src/auth/jwt.guard.ts:19` | `/api/*` (except `/api/login`) | Verifies JWT, attaches `req.user` |\n| `RolesGuard` | `src/auth/roles.guard.ts:22` | routes with `@Roles(...)` | Enforces role allowlist after JWT |",
  },
  {
    id: "config-and-secrets",
    title: "Configuration and secrets",
    purpose:
      "Document every env var this community reads, including required-vs-optional, defaults, and the failure mode when missing. Lets ops set up a new environment without chasing `process.env` references.",
    shape:
      "Markdown table: `Name | Required | Default | Consumer | What breaks if missing`. Rows ordered alphabetically. `Consumer` column cites the file:line that reads the var.",
    exampleBody:
      "| Name | Required | Default | Consumer | What breaks if missing |\n|------|----------|---------|----------|------------------------|\n| `DATABASE_URL` | yes | — | `src/db/index.ts:12` | Service refuses to start |\n| `KAFKA_BROKERS` | yes | — | `src/messaging/kafka.ts:8` | Producer + consumers fail to connect |\n| `STRIPE_API_KEY` | yes | — | `src/billing/stripe-client.ts:6` | All billing endpoints return 503 |\n| `LOG_LEVEL` | no | `info` | `src/logging/logger.ts:10` | Verbose logging — no functional break |\n| `RATE_LIMIT_RPM` | no | `100` | `src/middleware/rate-limit.ts:11` | Falls back to default — ops may not notice abuse |",
  },
];

/**
 * Evergreen palette — entries that are useful as optional additions for
 * almost any community, independent of its size/shape signals. These ship
 * in every synthesis prompt so the LLM has concrete non-required patterns
 * to pick from, even when a community's bundle didn't trigger a big
 * mandatory section list.
 *
 * Kept deliberately small — the prompt also ships the `REQUIRED sections`
 * block with predicate-matched catalog entries (with example bodies), so
 * the palette only needs to cover the common "what else should I include?"
 * gap without re-inlining what the REQUIRED block already covers.
 */
const CATALOG_PALETTE_IDS = [
  "entry-points",
  "failure-modes",
  "consumers",
  "data-shapes",
  "key-invariants",
] as const;

/**
 * Render a catalog subset as markdown for injection into the step-4
 * prompt. When `entries` is omitted, the output is the evergreen palette
 * only — the 5 entries above. Callers that want the full catalog (e.g.
 * dev tooling, tests) pass `SECTION_CATALOG` explicitly.
 *
 * Per entry, `includeExample` controls whether the `exampleBody` is
 * inlined. Defaults to `false` to keep the prompt compact — the REQUIRED
 * block re-renders matched entries with bodies, so the palette rarely
 * needs them duplicated.
 */
export function renderCatalog(
  entries: SectionCatalogEntry[] = paletteEntries(),
  includeExample: boolean = false,
): string {
  const lines: string[] = ["# Section shape palette", ""];
  lines.push(
    "Optional patterns you may adapt, combine, or invent around. The REQUIRED block above already lists shapes you must ship; use this list only to add colour beyond those.",
  );
  lines.push("");
  for (const e of entries) {
    lines.push(`## ${e.id}`);
    lines.push(`**Title:** ${e.title}`);
    lines.push(`**Purpose:** ${e.purpose}`);
    lines.push(`**Shape:** ${e.shape}`);
    if (includeExample) {
      lines.push("**Example:**");
      lines.push(e.exampleBody);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Evergreen palette materialized from CATALOG_PALETTE_IDS. */
export function paletteEntries(): SectionCatalogEntry[] {
  const out: SectionCatalogEntry[] = [];
  for (const id of CATALOG_PALETTE_IDS) {
    const entry = SECTION_CATALOG.find((e) => e.id === id);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Palette for a specific synthesis run: evergreen entries minus anything
 * already in the REQUIRED block (which ships the full entry with example
 * body). Avoids duplicating the same shape twice in the prompt.
 */
export function paletteForRequired(
  requiredIds: readonly string[],
): SectionCatalogEntry[] {
  const skip = new Set(requiredIds);
  return paletteEntries().filter((e) => !skip.has(e.id));
}

/** Look up an entry by id for shape-inlining during step 4. */
export function catalogEntry(id: string): SectionCatalogEntry | undefined {
  return SECTION_CATALOG.find((e) => e.id === id);
}
