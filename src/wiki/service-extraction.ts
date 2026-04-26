import type { ServiceProfile, ServiceRole, ServiceSignalsBundle } from "./types";

/**
 * Phase 3: Best-effort regex extraction of route/queue/data/external/cron
 * signals from member-file source. Runs per community; output goes into
 * `CommunityBundle.serviceSignals` so the writer LLM doesn't need to grep.
 *
 * Patterns are deliberately permissive and language-agnostic — multi-pass
 * regex over each file's text. False positives are bounded by the per-list
 * caps (MAX_PER_LIST), and the writer is told to drop entries that don't
 * resolve to real handlers when it cross-references with `bundle.exports`.
 *
 * Adding a new framework's route/queue syntax = one row in the relevant
 * table below. No language-specific parsers — tree-sitter parsing would
 * give better fidelity but the byte budget for a community bundle wins out.
 */

const MAX_PER_LIST = 30;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const HTTP_METHODS_SET = new Set(HTTP_METHODS);

/** Coarse language tag derived from file extension. */
type LanguageTag = "js" | "py" | "go" | "java" | "rb" | "rs" | "cs" | "php" | "other";

interface Pattern {
  /** Regex matched against each line of a file. Capture group 1 is primary payload. */
  re: RegExp;
  /** How to interpret captured groups for this pattern. */
  kind: "route" | "decorated-route" | "rust-route" | "queue" | "scheduled" | "external" | "data";
  /** Method override or extra metadata for the kind. */
  meta?: {
    method?: string;
    queueKind?: "produce" | "consume";
    sdk?: string;
    store?: string;
    op?: "read" | "write";
    /** When set, pattern only applies to files matching one of these language tags. */
    langs?: LanguageTag[];
  };
}

/**
 * Route patterns. Two flavors: call-site (Express, chi, Fastify) where the
 * method is in the call name, and decorator-style (NestJS, Spring) where
 * the method is in the decorator. Decorator routes are paired with the
 * next function name on a following line during extraction.
 */
const ROUTE_PATTERNS: Pattern[] = [
  // Call-site: express, koa, fastify, hono, vapor, fiber, gin, echo, chi
  // Match `app.get(`, `router.post(`, `r.GET(`, `e.POST(`, etc. Language-
  // agnostic — works on `r.GET(` (Go), `app.get(` (JS/Vapor), etc.
  ...HTTP_METHODS.map((m) => ({
    re: new RegExp(`\\b\\w+\\.${m}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, "i"),
    kind: "route" as const,
    meta: { method: m.toUpperCase() },
  })),
  // FastAPI / Flask call-site decorators: `@app.route('/x', methods=['GET'])`
  // Python-specific to keep `@app.route` patterns off TS files where they
  // could match decorators with the same shape but different semantics.
  { re: /@\w+\.route\s*\(\s*['"]([^'"]+)['"]/, kind: "route", meta: { method: "ANY", langs: ["py"] } },

  // Decorator-style: NestJS, Java Spring, FastAPI, .NET
  // Applies to JS (NestJS), Python (FastAPI), Java (Spring annotations).
  ...["Get", "Post", "Put", "Patch", "Delete", "Head", "Options"].map((m) => ({
    re: new RegExp(`@${m}(?:Mapping)?\\s*\\(\\s*['"]([^'"]+)['"]`),
    kind: "decorated-route" as const,
    meta: { method: m.toUpperCase(), langs: ["js", "py", "java"] as LanguageTag[] },
  })),
  // Decorator without explicit path: `@Get()` — empty path, still a route
  ...["Get", "Post", "Put", "Patch", "Delete"].map((m) => ({
    re: new RegExp(`@${m}(?:Mapping)?\\s*\\(\\s*\\)`),
    kind: "decorated-route" as const,
    meta: { method: m.toUpperCase(), langs: ["js", "py", "java"] as LanguageTag[] },
  })),
  // .NET attribute style: `[HttpGet("/x")]`
  ...HTTP_METHODS.map((m) => ({
    re: new RegExp(`\\[Http${m.charAt(0).toUpperCase() + m.slice(1)}\\s*\\(\\s*['"]([^'"]+)['"]`, "i"),
    kind: "decorated-route" as const,
    meta: { method: m.toUpperCase(), langs: ["cs"] as LanguageTag[] },
  })),
  // Rust axum / actix: `#[get("/x")]`. Captures method from group 1, path from group 2.
  { re: /#\[(get|post|put|patch|delete)\s*\(\s*"([^"]+)"/, kind: "rust-route", meta: { langs: ["rs"] } },
];

/**
 * Queue patterns. Producer = sends/publishes; Consumer = subscribes/listens.
 * Topic capture is best-effort — many SDKs embed topic in object args, which
 * regex can only catch when the literal sits on the same line.
 */
const QUEUE_PATTERNS: Pattern[] = [
  // Kafka — kafkajs / confluent / sarama: `producer.send({ topic: 'x' })`
  { re: /\b(?:producer|kafka)\.send\s*\(\s*\{[^}]*topic:\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "produce" } },
  { re: /\bconsumer\.subscribe\s*\(\s*\{[^}]*topic:\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "consume" } },
  // NestJS @MessagePattern / @EventPattern (JS only — keep off Python files)
  { re: /@MessagePattern\s*\(\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "consume", langs: ["js"] } },
  { re: /@EventPattern\s*\(\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "consume", langs: ["js"] } },
  // Spring @KafkaListener / @RabbitListener (Java only)
  { re: /@KafkaListener\s*\([^)]*topics\s*=\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "consume", langs: ["java"] } },
  { re: /@RabbitListener\s*\([^)]*queues?\s*=\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "consume", langs: ["java"] } },
  // RabbitMQ — channel.publish(exchange, routingKey, ...)
  { re: /\bchannel\.publish\s*\(\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "produce" } },
  { re: /\bchannel\.consume\s*\(\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "consume" } },
  // AWS SDK v3 — JS/TS specific shape with object args
  { re: /SendMessageCommand\s*\(\s*\{[^}]*QueueUrl:\s*[^,}]+/, kind: "queue", meta: { queueKind: "produce", langs: ["js"] } },
  { re: /ReceiveMessageCommand\s*\(\s*\{[^}]*QueueUrl:\s*[^,}]+/, kind: "queue", meta: { queueKind: "consume", langs: ["js"] } },
  { re: /PublishCommand\s*\(\s*\{[^}]*TopicArn:\s*[^,}]+/, kind: "queue", meta: { queueKind: "produce", langs: ["js"] } },
  // NATS — language-agnostic call shape
  { re: /\bnc\.publish\s*\(\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "produce" } },
  { re: /\bnc\.subscribe\s*\(\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "consume" } },
  // Generic: topic.publish('x'), subscription.receive('x')
  { re: /\btopic\.publish\s*\(\s*['"]([^'"]+)['"]/, kind: "queue", meta: { queueKind: "produce" } },
];

/**
 * Scheduled-job patterns. Schedule capture is best-effort — most frameworks
 * put the cron expression in the decorator/call literal.
 */
const SCHEDULED_PATTERNS: Pattern[] = [
  { re: /@Cron\s*\(\s*['"]([^'"]+)['"]/, kind: "scheduled", meta: { langs: ["js", "java"] } }, // NestJS, Spring
  { re: /@Scheduled\s*\([^)]*cron\s*=\s*['"]([^'"]+)['"]/, kind: "scheduled", meta: { langs: ["java"] } },
  { re: /cron\.schedule\s*\(\s*['"]([^'"]+)['"]/, kind: "scheduled", meta: { langs: ["js"] } }, // node-cron
  { re: /CronJob\s*\(\s*['"]([^'"]+)['"]/, kind: "scheduled", meta: { langs: ["js"] } },
  { re: /@shared_task\b/, kind: "scheduled", meta: { langs: ["py"] } }, // Celery
  { re: /@app\.task\b/, kind: "scheduled", meta: { langs: ["py"] } }, // Celery alternative
];

/**
 * External-call patterns. SDK column is enriched from the regex name; host
 * column captured when a literal URL is on the same line.
 */
const EXTERNAL_PATTERNS: Pattern[] = [
  { re: /\baxios\.(?:get|post|put|patch|delete)\s*\(\s*['"`]https?:\/\/([^\/'"`]+)/, kind: "external", meta: { sdk: "axios" } },
  { re: /\bfetch\s*\(\s*['"`]https?:\/\/([^\/'"`]+)/, kind: "external", meta: { sdk: "fetch" } },
  { re: /\bgot\s*\(\s*['"`]https?:\/\/([^\/'"`]+)/, kind: "external", meta: { sdk: "got" } },
  { re: /\brequests\.(?:get|post|put|patch|delete)\s*\(\s*['"`]https?:\/\/([^\/'"`]+)/, kind: "external", meta: { sdk: "requests" } },
  { re: /\bhttpx\.(?:get|post|put|patch|delete)\s*\(\s*['"`]https?:\/\/([^\/'"`]+)/, kind: "external", meta: { sdk: "httpx" } },
  { re: /\bnew Stripe\b/, kind: "external", meta: { sdk: "Stripe" } },
  { re: /\bsendgrid\.send\b/, kind: "external", meta: { sdk: "SendGrid" } },
  { re: /\btwilio\.\w+\b/, kind: "external", meta: { sdk: "Twilio" } },
];

/**
 * Data-access patterns. Two tiers:
 *
 * - **Strict** (always counted): explicit ORM/SQL surface that can't false-
 *   positive on generic JS — `prisma.X.method`, raw `SELECT FROM table`,
 *   etc.
 * - **Generic** (gated by ORM import in the same file): repository-style
 *   calls like `.findOne()`, `.save()`, `.update()`, `.delete()` which
 *   match every Map/Array/utility/D3/jQuery call. Only counted when the
 *   file imports a known ORM, so noise stays bounded.
 *
 * `session.add/commit/merge` is intentionally dropped — `req.session.X` in
 * any Express app trips it, and SQLAlchemy users still get coverage via
 * `session.query/execute`.
 */
const STRICT_DATA_PATTERNS: Pattern[] = [
  { re: /prisma\.\w+\.(findUnique|findMany|findFirst)/, kind: "data", meta: { op: "read", store: "Prisma" } },
  { re: /prisma\.\w+\.(create|update|upsert|delete)/, kind: "data", meta: { op: "write", store: "Prisma" } },
  { re: /SELECT\s+[\w*,\s]+FROM\s+(\w+)/i, kind: "data", meta: { op: "read", store: "SQL" } },
  { re: /INSERT\s+INTO\s+(\w+)/i, kind: "data", meta: { op: "write", store: "SQL" } },
  { re: /UPDATE\s+(\w+)\s+SET/i, kind: "data", meta: { op: "write", store: "SQL" } },
  { re: /\bsession\.(query|execute)\s*\(/, kind: "data", meta: { op: "read", store: "SQLAlchemy" } },
];
const GENERIC_DATA_PATTERNS: Pattern[] = [
  { re: /\.findOne(?:By)?\s*\(/, kind: "data", meta: { op: "read", store: "ORM" } },
  { re: /\.findMany\s*\(/, kind: "data", meta: { op: "read", store: "ORM" } },
  { re: /\.findAll\s*\(/, kind: "data", meta: { op: "read", store: "ORM" } },
  { re: /\.save\s*\(/, kind: "data", meta: { op: "write", store: "ORM" } },
  { re: /\.insert\s*\(/, kind: "data", meta: { op: "write", store: "ORM" } },
  { re: /\.update\s*\(/, kind: "data", meta: { op: "write", store: "ORM" } },
  { re: /\.delete\s*\(/, kind: "data", meta: { op: "write", store: "ORM" } },
];

/** Imports that gate the GENERIC_DATA_PATTERNS tier. */
const ORM_IMPORT_RE = /\b(?:from|import|require)\s*\(?\s*['"`](?:typeorm|mongoose|sequelize|@prisma\/client|kysely|@mikro-orm|sqlalchemy|gorm|gorm\.io|django\.db|peewee)\b/;

/**
 * Extract service signals from a community's member files. Returns
 * undefined when the project isn't a service or the community's role is
 * `shared` / `other` — saves the per-file scan entirely.
 *
 * `memberContent` is the synthesis-stage content cache; passing it
 * avoids a second readFileSync per member file (synthesis already reads
 * each one for LOC + previews). Files missing from the cache are
 * silently skipped — this is best-effort detection, not a correctness-
 * critical pass.
 */
export function extractServiceSignals(
  memberFiles: string[],
  serviceProfile: ServiceProfile | undefined,
  modulePath: string,
  memberContent: Map<string, string>,
): ServiceSignalsBundle | undefined {
  if (!serviceProfile || (serviceProfile.kind !== "service" && serviceProfile.kind !== "mixed")) {
    return undefined;
  }

  const role = roleForCommunity(serviceProfile, modulePath);
  if (role === "shared" || role === "other") return undefined;

  const bundle: ServiceSignalsBundle = {
    routes: [],
    queueOps: [],
    dataOps: [],
    externalCalls: [],
    scheduledJobs: [],
    role,
  };

  for (const file of memberFiles) {
    if (!isExtractableFile(file)) continue;
    const text = memberContent.get(file);
    if (text === undefined) continue;
    const lines = text.split("\n");
    const hasOrmImport = ORM_IMPORT_RE.test(text);
    const langTag = languageOf(file);
    extractFromLines(lines, file, bundle, hasOrmImport, langTag);
  }

  // Cap each list and record total counts so renderers can emit
  // "… N more" overflow indicators when truncated. Files iterated in
  // member-file order (alphabetical) so the cap keeps the lowest-path
  // matches first — deterministic across runs.
  bundle.totals = {
    routes: bundle.routes.length,
    queueOps: bundle.queueOps.length,
    dataOps: bundle.dataOps.length,
    externalCalls: bundle.externalCalls.length,
    scheduledJobs: bundle.scheduledJobs.length,
  };
  bundle.routes = bundle.routes.slice(0, MAX_PER_LIST);
  bundle.queueOps = bundle.queueOps.slice(0, MAX_PER_LIST);
  bundle.dataOps = bundle.dataOps.slice(0, MAX_PER_LIST);
  bundle.externalCalls = bundle.externalCalls.slice(0, MAX_PER_LIST);
  bundle.scheduledJobs = bundle.scheduledJobs.slice(0, MAX_PER_LIST);

  // Suppress empty bundle (no signals matched in any file) — caller treats
  // undefined as "no service evidence", matching the role=shared path.
  const total =
    bundle.totals.routes +
    bundle.totals.queueOps +
    bundle.totals.dataOps +
    bundle.totals.externalCalls +
    bundle.totals.scheduledJobs;
  if (total === 0) return undefined;

  return bundle;
}

function roleForCommunity(profile: ServiceProfile, modulePath: string): ServiceRole {
  const tag = profile.communityRoles.find((r) => r.modulePath === modulePath);
  return tag?.primary ?? "shared";
}

/**
 * Single-pass scan over a file's lines, applying every pattern table.
 * Decorator-style routes need lookahead to find the handler symbol on a
 * following line — handled inline rather than with a second AST pass.
 *
 * `hasOrmImport` gates the generic data-pattern tier — `.findOne()` /
 * `.save()` matches only emit when an ORM is in scope, otherwise they'd
 * trip on every Map/Array/jQuery call. `langTag` skips patterns that
 * don't apply to the file's language.
 */
function extractFromLines(
  lines: string[],
  file: string,
  bundle: ServiceSignalsBundle,
  hasOrmImport: boolean,
  langTag: LanguageTag,
): void {
  const dataPatterns = hasOrmImport
    ? [...STRICT_DATA_PATTERNS, ...GENERIC_DATA_PATTERNS]
    : STRICT_DATA_PATTERNS;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Routes — try call-site first, then decorator (decorators need lookahead).
    let routeMatched = false;
    for (const p of ROUTE_PATTERNS) {
      if (!languageMatches(p, langTag)) continue;
      const m = line.match(p.re);
      if (!m) continue;
      let method: string;
      let path: string;
      if (p.kind === "rust-route") {
        // Rust patterns capture method (group 1) + path (group 2).
        method = (m[1] ?? "").toUpperCase();
        path = m[2] ?? "";
      } else {
        method = p.meta?.method ?? "GET";
        path = m[1] ?? "";
      }
      const handlerSymbol =
        p.kind === "decorated-route" || p.kind === "rust-route"
          ? findHandlerAfter(lines, i)
          : findInlineHandler(line);
      bundle.routes.push({ method, path, handlerSymbol, file, line: lineNo });
      routeMatched = true;
      break;
    }
    if (routeMatched) continue;

    // Queues
    for (const p of QUEUE_PATTERNS) {
      if (!languageMatches(p, langTag)) continue;
      const m = line.match(p.re);
      if (!m) continue;
      const topic = m[1] ?? "<dynamic>";
      bundle.queueOps.push({
        kind: p.meta?.queueKind ?? "consume",
        topic,
        file,
        line: lineNo,
      });
      break;
    }

    // Scheduled
    for (const p of SCHEDULED_PATTERNS) {
      if (!languageMatches(p, langTag)) continue;
      const m = line.match(p.re);
      if (!m) continue;
      const schedule = m[1] ?? "on-demand";
      const handler = findHandlerAfter(lines, i);
      bundle.scheduledJobs.push({ schedule, handler, file, line: lineNo });
      break;
    }

    // External
    for (const p of EXTERNAL_PATTERNS) {
      if (!languageMatches(p, langTag)) continue;
      const m = line.match(p.re);
      if (!m) continue;
      bundle.externalCalls.push({
        host: m[1],
        sdk: p.meta?.sdk,
        file,
        line: lineNo,
      });
      break;
    }

    // Data
    for (const p of dataPatterns) {
      if (!languageMatches(p, langTag)) continue;
      const m = line.match(p.re);
      if (!m) continue;
      bundle.dataOps.push({
        store: p.meta?.store ?? "DB",
        model: m[1] ?? null,
        op: p.meta?.op ?? "read",
        file,
        line: lineNo,
      });
      break;
    }
  }
}

const LANG_BY_EXT: Record<string, LanguageTag> = {
  ts: "js",
  tsx: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  pyi: "py",
  go: "go",
  java: "java",
  kt: "java",
  kts: "java",
  scala: "java",
  rb: "rb",
  erb: "rb",
  rs: "rs",
  cs: "cs",
  fs: "cs",
  vb: "cs",
  php: "php",
};

function languageOf(file: string): LanguageTag {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "other";
}

/**
 * Skip files that aren't source code — extraction reads bytes blindly,
 * which would otherwise pull binary blobs (`.png`, `.lock`, `.sqlite`)
 * into regex matchers. Cheap up-front filter.
 */
function isExtractableFile(file: string): boolean {
  return languageOf(file) !== "other" || /\.(yml|yaml|toml|json|sh|sql)$/i.test(file);
}

/**
 * Per-pattern language gate. Patterns without `meta.langs` apply
 * everywhere (default for cross-language signals like raw SQL or generic
 * HTTP-client URLs). Patterns with `meta.langs` only run on matching
 * files — keeps Python-specific decorators off TypeScript files and vice
 * versa.
 */
function languageMatches(pattern: Pattern, lang: LanguageTag): boolean {
  const langs = pattern.meta?.langs;
  if (!langs || langs.length === 0) return true;
  return langs.includes(lang);
}

/**
 * Find the function/method symbol on the next 1-3 non-blank lines after a
 * decorator. Handles common shapes: `function name(`, `async name(`,
 * `name = (` (arrow), `def name(` (Python), `fn name(` (Rust).
 */
function findHandlerAfter(lines: string[], decoratorLine: number): string | null {
  const HANDLER_RE = /(?:function|async|def|fn|public|private|protected|static)?\s*(\w+)\s*[(=:]/;
  for (let j = decoratorLine + 1; j < Math.min(decoratorLine + 4, lines.length); j++) {
    const candidate = lines[j].trim();
    if (!candidate || candidate.startsWith("//") || candidate.startsWith("#") || candidate.startsWith("@")) {
      continue;
    }
    const m = candidate.match(HANDLER_RE);
    if (m && !HTTP_METHODS_SET.has(m[1].toLowerCase())) {
      return m[1];
    }
  }
  return null;
}

/**
 * Inline handler extraction for call-site routes: `app.get('/x', handler)`.
 * Returns the second argument when it's a bare identifier; null otherwise.
 */
function findInlineHandler(line: string): string | null {
  const m = line.match(/\.(?:get|post|put|patch|delete|head|options)\s*\([^,]+,\s*(\w+)/i);
  return m ? m[1] : null;
}
