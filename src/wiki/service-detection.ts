import { createHash } from "crypto";
import { existsSync, readdirSync } from "fs";
import { basename } from "path";
import type { RagDB } from "../db";
import type {
  CommunityRoleTag,
  DiscoveryModule,
  FileLevelGraph,
  ServiceKind,
  ServiceProfile,
  ServiceRole,
  ServiceSignal,
} from "./types";

/**
 * Phase 1: Service-detection probe.
 *
 * Heuristic-only classification of a project as
 * `library | cli | service | mixed`, plus per-community service-role tagging
 * (`http | messaging | data-access | scheduler | shared | other`). No LLM
 * call — patterns below are matched via FTS (`db.textSearch`) and symbol
 * lookup (`db.searchSymbols`). Ambiguous classifications are surfaced as
 * `mixed`; the synthesis-stage LLM (Claude) picks sections role-by-role
 * downstream so an unclassified community still gets a reasonable page.
 *
 * Adding a new framework = one row in the relevant pattern table. No
 * code-path branching per framework.
 */

interface PatternEntry {
  category: ServiceSignal["category"];
  name: string;
  /**
   * FTS queries — any match counts as a hit on the file. Multiple queries
   * are OR'd: a file matching any of them contributes one hit toward this
   * pattern. Keep queries short and specific to avoid false positives.
   */
  queries: string[];
  /**
   * Repo-root file globs / paths that count as zero-search signals — e.g.
   * `manage.py` for Django, `Gemfile` for Ruby. Listed by basename.
   */
  rootFiles?: string[];
  /**
   * File extensions this pattern applies to. When set, FTS hits in files
   * with other extensions are dropped — keeps Python `@router.get(` from
   * tripping the Express literal-match (both share the substring), and
   * Java `@Controller` from tripping NestJS, etc. When omitted, the
   * pattern applies to all files (used for cross-language signals like
   * Kafka library names that are imported the same way everywhere).
   */
  exts?: readonly string[];
}

const JS_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs"] as const;
const PY_EXTS = ["py", "pyi"] as const;
const GO_EXTS = ["go"] as const;
const JVM_EXTS = ["java", "kt", "kts", "scala"] as const;
const RB_EXTS = ["rb", "erb"] as const;
const PHP_EXTS = ["php"] as const;
const CS_EXTS = ["cs", "fs", "vb"] as const;
const RS_EXTS = ["rs"] as const;
const SWIFT_EXTS = ["swift"] as const;
const ELIXIR_EXTS = ["ex", "exs"] as const;

/**
 * Patterns covering ~60 frameworks across HTTP, RPC, brokers, schedulers,
 * ORMs, and cloud SDKs. The plan in `plans/backend-service-wiki.md` lists
 * every entry; deviations from the plan are documented inline.
 */
const PATTERNS: PatternEntry[] = [
  // HTTP — JS/TS
  { category: "http", name: "Express", queries: ["express", "app.get(", "router.post(", "router.get("], exts: JS_EXTS },
  { category: "http", name: "Fastify", queries: ["fastify", "fastify.route(", "fastify.get("], exts: JS_EXTS },
  { category: "http", name: "Koa", queries: ["koa", "ctx.body"], exts: JS_EXTS },
  { category: "http", name: "Hono", queries: ["hono", "Hono()"], exts: JS_EXTS },
  { category: "http", name: "NestJS", queries: ["@Controller", "@MessagePattern", "@EventPattern", "@nestjs/common"], exts: JS_EXTS },
  { category: "http", name: "tRPC", queries: ["t.router(", "publicProcedure", "@trpc/server"], exts: JS_EXTS },
  { category: "http", name: "Next.js", queries: ["next/server", "NextRequest", "NextResponse"], exts: JS_EXTS },
  { category: "http", name: "Remix", queries: ["@remix-run", "loader =", "action ="], exts: JS_EXTS },
  // HTTP — Python
  { category: "http", name: "Flask", queries: ["@app.route", "Blueprint(", "from flask"], exts: PY_EXTS },
  { category: "http", name: "FastAPI", queries: ["@app.get", "@router.post", "APIRouter(", "from fastapi"], exts: PY_EXTS },
  { category: "http", name: "Django", queries: ["urls.py", "from django", "@api_view"], exts: PY_EXTS, rootFiles: ["manage.py"] },
  { category: "http", name: "Starlette", queries: ["from starlette"], exts: PY_EXTS },
  { category: "http", name: "Sanic", queries: ["from sanic"], exts: PY_EXTS },
  { category: "http", name: "Tornado", queries: ["tornado.web", "RequestHandler"], exts: PY_EXTS },
  // HTTP — Go. `net/http` is the language stdlib — when a higher-level
  // router (chi, gin, echo, fiber) fires, prefer it over net/http for
  // framework counting. See classification logic below.
  { category: "http", name: "net/http", queries: ["http.HandleFunc", "http.ListenAndServe"], exts: GO_EXTS },
  { category: "http", name: "chi", queries: ["go-chi/chi", "r.Get(", "r.Post("], exts: GO_EXTS },
  { category: "http", name: "gin", queries: ["gin-gonic/gin", "gin.Default()"], exts: GO_EXTS },
  { category: "http", name: "echo", queries: ["labstack/echo", "e.GET(", "e.POST("], exts: GO_EXTS },
  { category: "http", name: "fiber", queries: ["gofiber/fiber", "app.Get(", "app.Post("], exts: GO_EXTS },
  // HTTP — JVM
  { category: "http", name: "Spring", queries: ["@RestController", "@RequestMapping", "@GetMapping", "@PostMapping"], exts: JVM_EXTS },
  { category: "http", name: "JAX-RS", queries: ["@Path", "javax.ws.rs", "jakarta.ws.rs"], exts: JVM_EXTS },
  { category: "http", name: "Quarkus", queries: ["io.quarkus", "@QuarkusTest"], exts: JVM_EXTS },
  { category: "http", name: "Micronaut", queries: ["io.micronaut", "@MicronautTest"], exts: JVM_EXTS },
  { category: "http", name: "Ktor", queries: ["io.ktor", "routing {"], exts: JVM_EXTS },
  // HTTP — others
  { category: "http", name: "Rails", queries: ["Rails.application", "ActionController"], exts: RB_EXTS, rootFiles: ["Gemfile", "config.ru"] },
  { category: "http", name: "Sinatra", queries: ["Sinatra::Base", "require 'sinatra'"], exts: RB_EXTS },
  { category: "http", name: "Laravel", queries: ["Illuminate\\", "Route::get", "Route::post"], exts: PHP_EXTS },
  { category: "http", name: "Symfony", queries: ["Symfony\\Component", "#[Route("], exts: PHP_EXTS },
  { category: "http", name: "ASP.NET Core", queries: ["[ApiController]", "[HttpGet]", "app.MapGet(", "Microsoft.AspNetCore"], exts: CS_EXTS },
  { category: "http", name: "Axum", queries: ["axum::Router", "Router::new()"], exts: RS_EXTS },
  { category: "http", name: "Actix", queries: ["actix_web", "App::new()"], exts: RS_EXTS },
  { category: "http", name: "Rocket", queries: ["rocket::", "#[get(", "#[post("], exts: RS_EXTS },
  { category: "http", name: "Phoenix", queries: ["Phoenix.Router", "use Phoenix"], exts: ELIXIR_EXTS },
  { category: "http", name: "Vapor", queries: ["import Vapor", "app.get(", "RouteCollection"], exts: SWIFT_EXTS },

  // RPC / contract
  { category: "rpc", name: "gRPC", queries: ["grpc", "ServerInterceptor", "_pb2_grpc"] },
  { category: "rpc", name: "GraphQL", queries: ["graphql", "@Resolver", "buildSchema(", "type Query"] },
  { category: "rpc", name: "OpenAPI", queries: ["openapi:", "swagger:"], rootFiles: ["openapi.yaml", "openapi.json", "swagger.json", "swagger.yaml"] },

  // Brokers
  { category: "broker", name: "Kafka", queries: ["kafkajs", "confluent_kafka", "sarama", "@KafkaListener", "consumer.subscribe", "producer.send"] },
  { category: "broker", name: "RabbitMQ", queries: ["amqplib", "import pika", "channel.publish", "channel.consume", "@RabbitListener"] },
  { category: "broker", name: "NATS", queries: ["nats.connect", "nats-py", "nats.go", "js.publish"] },
  { category: "broker", name: "AWS SQS", queries: ["@aws-sdk/client-sqs", "SendMessageCommand", "ReceiveMessageCommand", "boto3.client('sqs')"] },
  { category: "broker", name: "AWS SNS", queries: ["@aws-sdk/client-sns", "PublishCommand", "boto3.client('sns')"] },
  { category: "broker", name: "AWS EventBridge", queries: ["@aws-sdk/client-eventbridge", "PutEventsCommand"] },
  { category: "broker", name: "AWS Kinesis", queries: ["@aws-sdk/client-kinesis", "kinesis.put_records"] },
  { category: "broker", name: "GCP Pub/Sub", queries: ["@google-cloud/pubsub", "google.cloud.pubsub_v1"] },
  { category: "broker", name: "Azure Service Bus", queries: ["@azure/service-bus", "ServiceBusClient", "azure.servicebus"] },
  { category: "broker", name: "Redis pub/sub", queries: ["XADD", "XREADGROUP", "psubscribe", "ioredis", "redis-py"] },
  { category: "broker", name: "MQTT", queries: ["mqtt.connect", "paho-mqtt"] },
  { category: "broker", name: "Pulsar", queries: ["pulsar-client", "consumer.receive"] },

  // Schedulers
  { category: "scheduler", name: "node-cron / BullMQ", queries: ["node-cron", "bullmq", "import Bull", "@nestjs/schedule", "@Cron("] },
  { category: "scheduler", name: "Celery", queries: ["from celery", "@shared_task", "celery.Celery"] },
  { category: "scheduler", name: "APScheduler", queries: ["apscheduler", "BackgroundScheduler"] },
  { category: "scheduler", name: "Sidekiq / Resque", queries: ["sidekiq", "resque", "include Sidekiq"] },
  { category: "scheduler", name: "Quartz / Hangfire", queries: ["@Scheduled", "Quartz", "Hangfire"] },
  { category: "scheduler", name: "Airflow", queries: ["airflow", "DAG(", "from airflow"] },

  // ORMs
  { category: "orm", name: "Prisma", queries: ["@prisma/client", "PrismaClient"] },
  { category: "orm", name: "TypeORM", queries: ["typeorm", "@Entity", "@Column"] },
  { category: "orm", name: "Drizzle", queries: ["drizzle-orm", "pgTable("] },
  { category: "orm", name: "Mongoose", queries: ["mongoose", "Schema("] },
  { category: "orm", name: "Sequelize", queries: ["sequelize", "DataTypes."] },
  { category: "orm", name: "SQLAlchemy", queries: ["sqlalchemy", "declarative_base", "Column("] },
  { category: "orm", name: "Django ORM", queries: ["models.Model", "from django.db"] },
  { category: "orm", name: "GORM", queries: ["gorm.io", "gorm.Open"] },
  { category: "orm", name: "sqlx", queries: ["jmoiron/sqlx", "sqlx.Connect", "sqlx::query"] },
  { category: "orm", name: "JPA / Hibernate", queries: ["@Entity", "javax.persistence", "jakarta.persistence", "Hibernate"] },
  { category: "orm", name: "Active Record", queries: ["< ApplicationRecord", "ActiveRecord::Base"] },
  { category: "orm", name: "Entity Framework", queries: ["DbContext", "EntityFrameworkCore"] },
  { category: "orm", name: "Diesel", queries: ["diesel::", "table!"] },

  // SDKs / external
  { category: "sdk", name: "AWS SDK", queries: ["@aws-sdk/", "aws-sdk", "import boto3"] },
  { category: "sdk", name: "GCP SDK", queries: ["@google-cloud/", "google-cloud-"] },
  { category: "sdk", name: "Azure SDK", queries: ["@azure/", "azure.identity"] },
  { category: "sdk", name: "HTTP client (axios/got/requests/httpx)", queries: ["import axios", "node-fetch", "import requests", "import httpx", "got("] },
  { category: "sdk", name: "Stripe", queries: ["stripe", "Stripe("] },
  { category: "sdk", name: "Twilio / SendGrid", queries: ["twilio", "@sendgrid/mail"] },

  // Infra
  { category: "infra", name: "Docker / containers", queries: [], rootFiles: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml"] },
  { category: "infra", name: "Kubernetes / Helm", queries: [], rootFiles: ["k8s", "helm", "Chart.yaml"] },
  { category: "infra", name: "Serverless", queries: [], rootFiles: ["serverless.yml", "wrangler.toml", "fly.toml", "vercel.json", "netlify.toml"] },
  { category: "infra", name: "Procfile / PaaS", queries: [], rootFiles: ["Procfile", "app.json"] },
];

/**
 * Minimum non-test-file hits required to count a signal. Test fixtures
 * commonly import frameworks for assertion (e.g., `tests/fixtures/server.ts`
 * importing Express); without the test exclusion, a single such fixture
 * flips a library project to "service".
 */
const MIN_HITS_FOR_SIGNAL = 1;
/**
 * SDK / HTTP client signals get a higher minimum because importing axios
 * once doesn't make a project a service. False-positive risk called out in
 * `plans/backend-service-wiki.md` Risks.
 */
const MIN_HITS_FOR_SDK_SIGNAL = 3;

const FTS_TOP_K = 50;

/**
 * Path prefixes / segments treated as tests. Hits in these paths still
 * appear in `topFiles` (so the LLM can see the evidence) but don't count
 * toward the signal-hit threshold that drives project classification.
 */
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|examples?|e2e|benchmarks?)\//i;
const TEST_FILE_RE = /\.(test|spec)\.[a-z]+$/i;

function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path) || TEST_FILE_RE.test(path);
}

function matchesExt(path: string, exts: readonly string[]): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return exts.includes(ext);
}

/**
 * Project shape probe: heuristic detection over indexed files. Returns the
 * `ServiceProfile` consumers attach to `DiscoveryResult.serviceProfile`.
 *
 * Skipped (returns library-shape profile) when fewer than 5 files are
 * indexed — too sparse to classify without false positives.
 */
export function runServiceDetection(
  db: RagDB,
  projectDir: string,
  modules: DiscoveryModule[],
  fileGraph: FileLevelGraph,
): ServiceProfile {
  const status = db.getStatus();
  if (status.totalFiles < 5) {
    return libraryProfile([], "");
  }

  const rootFileSet = listRootFiles(projectDir);

  // Collect signals. FTS is candidate retrieval only — its tokenizer drops
  // `.`, `@`, `(`, etc., so a query like `@app.get` matches any chunk where
  // tokens `app` and `get` appear consecutively. Post-filter every candidate
  // hit by checking the literal query string is in the chunk snippet, which
  // recovers strict-match precision without losing FTS speed.
  const signals: ServiceSignal[] = [];
  for (const pattern of PATTERNS) {
    const fileHits = new Set<string>();

    for (const query of pattern.queries) {
      let results;
      try {
        results = db.textSearch(query, FTS_TOP_K);
      } catch {
        continue; // Some queries trip FTS escaping; skip rather than abort.
      }
      for (const hit of results) {
        if (!hit.snippet || !hit.snippet.includes(query)) continue;
        if (pattern.exts && !matchesExt(hit.path, pattern.exts)) continue;
        fileHits.add(hit.path);
      }
    }
    for (const root of pattern.rootFiles ?? []) {
      if (rootFileSet.has(root) || rootFileSet.has(basename(root))) {
        fileHits.add(`<root>/${root}`);
      }
    }

    // Score uses non-test hits only — a library project with a test fixture
    // importing Express shouldn't classify as a service. Test hits stay in
    // `topFiles` so the writer can still see them.
    const nonTestHits = [...fileHits].filter((p) => !isTestPath(p));
    const minHits = pattern.category === "sdk" ? MIN_HITS_FOR_SDK_SIGNAL : MIN_HITS_FOR_SIGNAL;
    if (nonTestHits.length < minHits) continue;

    // Synthetic `<root>/...` paths sort last and the prefix is purely
    // internal; strip it before storing so consumers see plain
    // `Dockerfile` / `manage.py` instead of leaking the marker syntax.
    const topFiles = rankFilesByPageRank([...fileHits], fileGraph)
      .slice(0, 10)
      .map((p) => (p.startsWith("<root>/") ? p.slice("<root>/".length) : p));

    signals.push({
      category: pattern.category,
      name: pattern.name,
      hitCount: nonTestHits.length,
      topFiles,
    });
  }

  // Determine project kind from signal categories
  const categoriesPresent = new Set(signals.map((s) => s.category));
  const hasService =
    categoriesPresent.has("http") ||
    categoriesPresent.has("rpc") ||
    categoriesPresent.has("broker") ||
    categoriesPresent.has("scheduler");

  const hasInfra = categoriesPresent.has("infra");
  const hasOrm = categoriesPresent.has("orm");

  let kind: ServiceKind;
  if (hasService) {
    // Demote `net/http` when a higher-level Go router fires. chi/gin/echo/
    // fiber wrap net/http; counting both as separate frameworks would
    // misclassify a chi project as `mixed`. Same logic doesn't apply to
    // other ecosystems — Express + Fastify is genuine mixing.
    const goRouters = new Set(["chi", "gin", "echo", "fiber"]);
    const hasHigherGoRouter = signals.some((s) => goRouters.has(s.name));
    const httpFrameworks = signals.filter(
      (s) => s.category === "http" && !(hasHigherGoRouter && s.name === "net/http"),
    );
    kind = httpFrameworks.length >= 2 ? "mixed" : "service";
  } else if (hasOrm && hasInfra) {
    // Data pipeline / worker without HTTP — still a service.
    kind = "service";
  } else {
    kind = "library";
  }

  const framework = pickPrimaryFramework(signals);
  const summary = buildSummary(kind, framework, signals);

  const communityRoles =
    kind === "service" || kind === "mixed"
      ? classifyCommunities(modules, signals)
      : [];

  const fingerprint = buildFingerprint(signals, fileGraph);

  return {
    kind,
    framework,
    signals,
    communityRoles,
    summary,
    fingerprint,
  };
}

/**
 * Rank a set of file paths by their global PageRank (using fanIn as a cheap
 * proxy when PageRank isn't yet computed at this stage). Synthetic paths
 * (`<root>/...`) sort last.
 */
function rankFilesByPageRank(paths: string[], fileGraph: FileLevelGraph): string[] {
  const nodeMap = new Map(fileGraph.nodes.map((n) => [n.path, n]));
  return [...paths].sort((a, b) => {
    if (a.startsWith("<root>/") && !b.startsWith("<root>/")) return 1;
    if (!a.startsWith("<root>/") && b.startsWith("<root>/")) return -1;
    const fa = nodeMap.get(a);
    const fb = nodeMap.get(b);
    const sa = fa ? fa.fanIn + fa.fanOut : 0;
    const sb = fb ? fb.fanIn + fb.fanOut : 0;
    if (sa !== sb) return sb - sa;
    return a.localeCompare(b);
  });
}

/**
 * Primary framework = the highest-hitcount HTTP signal, falling back to RPC,
 * then broker, then scheduler. Returns null for library-shape projects.
 */
function pickPrimaryFramework(signals: ServiceSignal[]): string | null {
  const order: ServiceSignal["category"][] = ["http", "rpc", "broker", "scheduler"];
  for (const cat of order) {
    const inCat = signals.filter((s) => s.category === cat);
    if (inCat.length === 0) continue;
    inCat.sort((a, b) => b.hitCount - a.hitCount);
    return inCat[0].name;
  }
  return null;
}

function buildSummary(
  kind: ServiceKind,
  framework: string | null,
  signals: ServiceSignal[],
): string {
  if (kind === "library") return "Library / CLI project — no backend-service signals detected.";
  const orm = signals.find((s) => s.category === "orm")?.name;
  const broker = signals.find((s) => s.category === "broker")?.name;
  const parts: string[] = [];
  if (framework) parts.push(framework);
  if (orm) parts.push(orm);
  if (broker) parts.push(broker);
  const tail = parts.length > 0 ? ` (${parts.join(" + ")})` : "";
  return `Backend service${tail}.`;
}

/**
 * Per-community role tagging. A community is `http` if any member file
 * appears in an HTTP signal's `topFiles`, `messaging` for broker, etc.
 * Communities can carry multiple roles; `primary` picks by precedence
 * (http > messaging > scheduler > data-access > shared > other) so
 * downstream section-injection has a single label to switch on.
 */
function classifyCommunities(
  modules: DiscoveryModule[],
  signals: ServiceSignal[],
): CommunityRoleTag[] {
  const fileToRoles = new Map<string, Set<ServiceRole>>();
  for (const sig of signals) {
    const role = categoryToRole(sig.category);
    if (!role) continue;
    for (const f of sig.topFiles) {
      if (f.startsWith("<root>/")) continue;
      if (!fileToRoles.has(f)) fileToRoles.set(f, new Set());
      fileToRoles.get(f)!.add(role);
    }
  }

  const tags: CommunityRoleTag[] = [];
  walkModules(modules, (m) => {
    const roles = new Set<ServiceRole>();
    for (const f of m.files) {
      const fileRoles = fileToRoles.get(f);
      if (fileRoles) for (const r of fileRoles) roles.add(r);
    }
    if (roles.size === 0) {
      tags.push({ modulePath: m.path, primary: "shared", all: ["shared"] });
      return;
    }
    const all = [...roles];
    const primary = pickPrimaryRole(roles);
    tags.push({ modulePath: m.path, primary, all });
  });
  return tags;
}

function walkModules(modules: DiscoveryModule[], fn: (m: DiscoveryModule) => void): void {
  for (const m of modules) {
    fn(m);
    if (m.children) walkModules(m.children, fn);
  }
}

function categoryToRole(cat: ServiceSignal["category"]): ServiceRole | null {
  switch (cat) {
    case "http":
    case "rpc":
      return "http";
    case "broker":
      return "messaging";
    case "scheduler":
      return "scheduler";
    case "orm":
      return "data-access";
    case "sdk":
    case "infra":
      return null;
  }
}

const ROLE_PRECEDENCE: ServiceRole[] = [
  "http",
  "messaging",
  "scheduler",
  "data-access",
  "shared",
  "other",
];

function pickPrimaryRole(roles: Set<ServiceRole>): ServiceRole {
  for (const r of ROLE_PRECEDENCE) if (roles.has(r)) return r;
  return "other";
}

/**
 * Build a stable fingerprint over the detection input so persistence can
 * reuse the profile across regens without re-running the heuristic. Hash
 * combines the top-degree (fanIn + fanOut) file set with the signal name
 * set; either shifting invalidates the cache.
 *
 * Note: degree, not full PageRank — categorization runs PR after discovery,
 * so we don't have the real PR scores at probe time. Degree-sum is a cheap
 * proxy that drifts more than PR but is stable enough for the fingerprint
 * use case (cache invalidation, not ranking).
 */
function buildFingerprint(signals: ServiceSignal[], fileGraph: FileLevelGraph): string {
  const topPaths = [...fileGraph.nodes]
    .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut))
    .slice(0, 30)
    .map((n) => n.path)
    .sort();
  const sigKey = [...signals]
    .map((s) => `${s.category}:${s.name}:${s.hitCount}`)
    .sort()
    .join("|");
  const hash = createHash("sha256");
  hash.update(topPaths.join("\n"));
  hash.update("\n--\n");
  hash.update(sigKey);
  return hash.digest("hex").slice(0, 16);
}

/**
 * Enumerate top-level entries in `projectDir`. Used as a zero-search signal
 * for infrastructure files (`Dockerfile`, `manage.py`, `Gemfile`, etc.)
 * that live at the repo root. Returns a Set of basenames; missing/
 * unreadable directory yields an empty set rather than throwing — service
 * detection should never break the wiki pipeline.
 */
function listRootFiles(projectDir: string): Set<string> {
  if (!existsSync(projectDir)) return new Set();
  try {
    return new Set(readdirSync(projectDir));
  } catch {
    return new Set();
  }
}

function libraryProfile(signals: ServiceSignal[], fingerprint: string): ServiceProfile {
  return {
    kind: "library",
    framework: null,
    signals,
    communityRoles: [],
    summary: "Library / CLI project — no backend-service signals detected.",
    fingerprint,
  };
}
