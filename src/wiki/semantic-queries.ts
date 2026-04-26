/**
 * Kind-specific semantic queries shipped on every `PagePayload`. The writer
 * runs each one with `read_relevant` before drafting the matching section,
 * surfacing dimensions the community bundle may have missed (error paths,
 * internal constants, call sites, etc.).
 *
 * Kept deliberately short — three queries per kind is enough to cover the
 * gaps the review flagged without drowning the writer in follow-up calls.
 */

export const SEMANTIC_QUERIES: Record<string, string[]> = {
  architecture: [
    "system entry points and module boundaries",
    "cross-cutting dependencies and shared hubs",
    "module-level invariants and design rationale comments",
  ],
  community: [
    "public API and exported function signatures",
    "tunable constants thresholds and magic numbers exported",
    "error paths fallback handling and try/catch comments",
  ],
  "community-file": [
    "every export const and tunable literal in this file",
    "function signatures and their direct call sites",
    "TODO FIXME workaround and known-bug comments inline",
  ],
  "getting-started": [
    "first-run setup and prerequisites",
    "CLI commands and flags",
    "known issues and troubleshooting",
  ],
  guide: [
    "first-run setup and prerequisites",
    "CLI commands and flags",
    "known issues and troubleshooting",
  ],
  "data-flows": [
    "request entry points and call paths",
    "background job triggers and workers",
    "error retry and fallback handling",
  ],
  endpoints: [
    "HTTP route handlers and controller methods",
    "auth middleware guards and role decorators",
    "request validation and DTO schemas",
  ],
  queues: [
    "message producers and consumers",
    "topic names and queue configuration",
    "retry policies dead-letter and idempotency keys",
  ],
  "runtime-config": [
    "process env os getenv environment variable reads",
    "config file loaders and parsers",
    "secrets vault and credential retrieval",
  ],
};

export function semanticQueriesFor(kind: string): string[] {
  return SEMANTIC_QUERIES[kind] ?? [];
}
