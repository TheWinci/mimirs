import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { resolveImports } from "../../src/graph/resolver";
import { runDiscovery } from "../../src/wiki/discovery";
import { runServiceDetection } from "../../src/wiki/service-detection";
import { extractServiceSignals } from "../../src/wiki/service-extraction";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";

/** Read an on-disk fixture into the content cache shape extraction expects. */
function loadContent(files: string[], dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    try {
      out.set(f, readFileSync(join(dir, f), "utf-8"));
    } catch {
      // missing files left out — extraction skips them
    }
  }
  return out;
}

let tempDir: string;
let db: RagDB;

beforeAll(async () => {
  await getEmbedder();
});

beforeEach(async () => {
  tempDir = await createTempDir();
  db = new RagDB(tempDir);
});

afterEach(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

/**
 * Seed a file with both real on-disk content (so service-extraction reads
 * it) and indexed chunks/graph metadata (so heuristic FTS matches it).
 * Mirrors the discovery test's seedFile but ships actual content.
 */
async function seedSourceFile(
  relativePath: string,
  content: string,
  imports: { name: string; source: string }[],
  exports: { name: string; type: string }[],
): Promise<void> {
  await writeFixture(tempDir, relativePath, content);
  const fullPath = join(tempDir, relativePath);
  const emb = await embed(content.slice(0, 200));
  db.upsertFile(fullPath, `hash-${relativePath}`, [
    { snippet: content, embedding: emb, startLine: 1, endLine: content.split("\n").length },
  ]);
  const file = db.getFileByPath(fullPath)!;
  db.upsertFileGraph(file.id, imports, exports);
}

describe("runServiceDetection — fixture matrix", () => {
  test("nestjs fixture — decorator-heavy TS, easy-mode baseline", async () => {
    // Five files: controller, service, repository, kafka consumer, module wire-up
    await seedSourceFile(
      "src/users/users.controller.ts",
      `import { Controller, Get, Post } from '@nestjs/common';
@Controller('users')
export class UsersController {
  constructor(private svc: UsersService) {}
  @Get(':id') findOne(@Param('id') id: string) { return this.svc.findOne(id); }
  @Post() create(@Body() dto: CreateUserDto) { return this.svc.create(dto); }
}`,
      [{ name: "Controller", source: "@nestjs/common" }],
      [{ name: "UsersController", type: "class" }],
    );
    await seedSourceFile(
      "src/users/users.service.ts",
      `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private repo: Repository<User>) {}
  findOne(id: string) { return this.repo.findOne({ where: { id } }); }
  create(dto: any) { return this.repo.save(dto); }
}`,
      [{ name: "Injectable", source: "@nestjs/common" }],
      [{ name: "UsersService", type: "class" }],
    );
    await seedSourceFile(
      "src/users/user.entity.ts",
      `import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
@Entity()
export class User {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() email: string;
}`,
      [{ name: "Entity", source: "typeorm" }],
      [{ name: "User", type: "class" }],
    );
    await seedSourceFile(
      "src/orders/orders.consumer.ts",
      `import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
@Controller()
export class OrdersConsumer {
  @MessagePattern('orders.v1') handle(payload: any) { return payload; }
}`,
      [{ name: "Controller", source: "@nestjs/common" }],
      [{ name: "OrdersConsumer", type: "class" }],
    );
    await seedSourceFile(
      "src/app.module.ts",
      `import { Module } from '@nestjs/common';
@Module({}) export class AppModule {}`,
      [],
      [{ name: "AppModule", type: "class" }],
    );

    resolveImports(db, tempDir);
    const discovery = runDiscovery(db, tempDir);
    const profile = runServiceDetection(db, tempDir, discovery.modules, discovery.graphData.fileLevel);

    expect(profile.kind).toBe("service");
    expect(profile.framework).toBe("NestJS");
    const sigNames = profile.signals.map((s) => s.name);
    expect(sigNames).toContain("NestJS");
    expect(sigNames).toContain("TypeORM");
  });

  test("express fixture — function-call TS routing, BullMQ", async () => {
    await seedSourceFile(
      "src/server.ts",
      `import express from 'express';
import { router } from './routes';
const app = express();
app.use('/api', router);
app.listen(3000);`,
      [{ name: "express", source: "express" }],
      [{ name: "app", type: "variable" }],
    );
    await seedSourceFile(
      "src/routes.ts",
      `import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export const router = Router();
router.get('/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  res.json(user);
});
router.post('/users', async (req, res) => {
  const user = await prisma.user.create({ data: req.body });
  res.status(201).json(user);
});`,
      [{ name: "Router", source: "express" }],
      [{ name: "router", type: "variable" }],
    );
    await seedSourceFile(
      "src/jobs/email.job.ts",
      `import { Queue, Worker } from 'bullmq';
const queue = new Queue('email');
new Worker('email', async (job) => { return job.data; });`,
      [{ name: "Queue", source: "bullmq" }],
      [{ name: "queue", type: "variable" }],
    );
    await seedSourceFile(
      "src/index.ts",
      `import './server';`,
      [],
      [],
    );
    await seedSourceFile("src/util.ts", `export const x = 1;`, [], [{ name: "x", type: "variable" }]);

    resolveImports(db, tempDir);
    const discovery = runDiscovery(db, tempDir);
    const profile = runServiceDetection(db, tempDir, discovery.modules, discovery.graphData.fileLevel);

    expect(profile.kind).toBe("service");
    expect(profile.framework).toBe("Express");
    const names = profile.signals.map((s) => s.name);
    expect(names).toContain("Express");
    expect(names).toContain("Prisma");
    expect(names).toContain("node-cron / BullMQ");
  });

  test("library negative — no service signals", async () => {
    await seedSourceFile(
      "src/index.ts",
      `export function add(a: number, b: number) { return a + b; }
export function multiply(a: number, b: number) { return a * b; }`,
      [],
      [
        { name: "add", type: "function" },
        { name: "multiply", type: "function" },
      ],
    );
    await seedSourceFile(
      "src/utils.ts",
      `export function format(n: number): string { return n.toFixed(2); }`,
      [],
      [{ name: "format", type: "function" }],
    );
    await seedSourceFile(
      "src/types.ts",
      `export interface Point { x: number; y: number; }`,
      [],
      [{ name: "Point", type: "interface" }],
    );
    await seedSourceFile(
      "src/parser.ts",
      `import { Point } from './types';
export function parse(s: string): Point { return { x: 0, y: 0 }; }`,
      [{ name: "Point", source: "./types" }],
      [{ name: "parse", type: "function" }],
    );
    await seedSourceFile(
      "src/serialize.ts",
      `import { Point } from './types';
export function serialize(p: Point): string { return JSON.stringify(p); }`,
      [{ name: "Point", source: "./types" }],
      [{ name: "serialize", type: "function" }],
    );

    resolveImports(db, tempDir);
    const discovery = runDiscovery(db, tempDir);
    const profile = runServiceDetection(db, tempDir, discovery.modules, discovery.graphData.fileLevel);

    expect(profile.kind).toBe("library");
    expect(profile.framework).toBe(null);
    expect(profile.communityRoles).toHaveLength(0);
  });

  test("Dockerfile + serverless detected as infra zero-search signals", async () => {
    // Library code so no HTTP/broker hits, but root files imply deployment.
    await seedSourceFile(
      "src/lib.ts",
      `export const x = 1;`,
      [],
      [{ name: "x", type: "variable" }],
    );
    // Need 5+ files to clear MIN_FILES gate.
    for (let i = 0; i < 5; i++) {
      await seedSourceFile(`src/m${i}.ts`, `export const m${i} = ${i};`, [], [{ name: `m${i}`, type: "variable" }]);
    }
    await writeFixture(tempDir, "Dockerfile", "FROM node:20\n");
    await writeFixture(tempDir, "serverless.yml", "service: foo\n");

    resolveImports(db, tempDir);
    const discovery = runDiscovery(db, tempDir);
    const profile = runServiceDetection(db, tempDir, discovery.modules, discovery.graphData.fileLevel);

    const names = profile.signals.map((s) => s.name);
    expect(names).toContain("Docker / containers");
    expect(names).toContain("Serverless");
  });

  test("fastapi fixture — Python decorator + SQLAlchemy + Celery", async () => {
    await seedSourceFile(
      "src/main.py",
      `from fastapi import FastAPI, APIRouter
from .database import session
from .models import User
app = FastAPI()
router = APIRouter()
@router.get("/users/{user_id}")
def get_user(user_id: str):
    return session.query(User).filter(User.id == user_id).first()
@router.post("/users")
def create_user(payload: dict):
    user = User(**payload)
    session.add(user)
    session.commit()
    return user
app.include_router(router)`,
      [{ name: "FastAPI", source: "fastapi" }],
      [{ name: "app", type: "variable" }],
    );
    await seedSourceFile(
      "src/models.py",
      `from sqlalchemy import Column, String
from sqlalchemy.ext.declarative import declarative_base
Base = declarative_base()
class User(Base):
    __tablename__ = "users"
    id = Column(String, primary_key=True)
    email = Column(String)`,
      [{ name: "Column", source: "sqlalchemy" }],
      [{ name: "User", type: "class" }],
    );
    await seedSourceFile(
      "src/tasks.py",
      `from celery import Celery
celery_app = Celery("worker")
@shared_task
def send_welcome_email(user_id: str):
    return user_id
@app.task
def reconcile_billing():
    pass`,
      [{ name: "Celery", source: "celery" }],
      [{ name: "celery_app", type: "variable" }],
    );
    await seedSourceFile(
      "src/database.py",
      `from sqlalchemy.orm import sessionmaker
session = sessionmaker()()`,
      [{ name: "sessionmaker", source: "sqlalchemy.orm" }],
      [{ name: "session", type: "variable" }],
    );
    await seedSourceFile(
      "src/__init__.py",
      `from .main import app`,
      [],
      [],
    );

    resolveImports(db, tempDir);
    const discovery = runDiscovery(db, tempDir);
    const profile = runServiceDetection(db, tempDir, discovery.modules, discovery.graphData.fileLevel);
    expect(profile.kind).toBe("service");
    expect(profile.framework).toBe("FastAPI");
    const names = profile.signals.map((s) => s.name);
    expect(names).toContain("FastAPI");
    expect(names).toContain("SQLAlchemy");
    expect(names).toContain("Celery");
  });

  test("go-chi fixture — function-call routing + sqlx + NATS", async () => {
    await seedSourceFile(
      "cmd/server/main.go",
      `package main
import (
  "github.com/go-chi/chi/v5"
  "net/http"
)
func main() {
  r := chi.NewRouter()
  r.Get("/users/{id}", getUser)
  r.Post("/users", createUser)
  http.ListenAndServe(":8080", r)
}`,
      [],
      [{ name: "main", type: "function" }],
    );
    await seedSourceFile(
      "internal/users/repo.go",
      `package users
import "github.com/jmoiron/sqlx"
type Repo struct { db *sqlx.DB }
func (r *Repo) FindOne(id string) (User, error) {
  var u User
  err := r.db.Get(&u, "SELECT id, email FROM users WHERE id = $1", id)
  return u, err
}`,
      [],
      [{ name: "Repo", type: "type" }],
    );
    await seedSourceFile(
      "internal/events/consumer.go",
      `package events
import "github.com/nats-io/nats.go"
func Subscribe(nc *nats.Conn) {
  nc.Subscribe("orders.v1", func(m *nats.Msg) {})
}`,
      [],
      [{ name: "Subscribe", type: "function" }],
    );
    await seedSourceFile("internal/util/log.go", `package util\nfunc Log() {}`, [], [{ name: "Log", type: "function" }]);
    await seedSourceFile("go.mod", `module example.com/foo\n`, [], []);

    resolveImports(db, tempDir);
    const discovery = runDiscovery(db, tempDir);
    const profile = runServiceDetection(db, tempDir, discovery.modules, discovery.graphData.fileLevel);
    expect(profile.kind).toBe("service");
    const names = profile.signals.map((s) => s.name);
    expect(names).toContain("chi");
    expect(names).toContain("sqlx");
    expect(names).toContain("NATS");
  });

  test("test-only fixtures don't flip library to service", async () => {
    // Source is pure library code; tests/ has Express usage that should NOT
    // tip the kind. Without test-path exclusion this would classify as service.
    await seedSourceFile("src/lib.ts", `export function add(a: number, b: number) { return a + b; }`, [], [{ name: "add", type: "function" }]);
    await seedSourceFile("src/parse.ts", `export function parse(s: string) { return s.length; }`, [], [{ name: "parse", type: "function" }]);
    await seedSourceFile("src/types.ts", `export type Point = { x: number; y: number };`, [], [{ name: "Point", type: "type" }]);
    await seedSourceFile("src/format.ts", `export function format(n: number) { return n.toFixed(2); }`, [], [{ name: "format", type: "function" }]);
    await seedSourceFile(
      "tests/server.test.ts",
      `import express from 'express';
import request from 'supertest';
const app = express();
app.get('/health', (req, res) => res.send('ok'));
test('health', async () => { await request(app).get('/health').expect(200); });`,
      [{ name: "express", source: "express" }],
      [{ name: "app", type: "variable" }],
    );

    resolveImports(db, tempDir);
    const discovery = runDiscovery(db, tempDir);
    const profile = runServiceDetection(db, tempDir, discovery.modules, discovery.graphData.fileLevel);

    expect(profile.kind).toBe("library");
  });

  test("fingerprint stable across detection runs", async () => {
    await seedSourceFile(
      "src/server.ts",
      `import express from 'express';
const app = express();
app.get('/x', (req, res) => res.send('ok'));`,
      [{ name: "express", source: "express" }],
      [{ name: "app", type: "variable" }],
    );
    for (let i = 0; i < 5; i++) {
      await seedSourceFile(`src/m${i}.ts`, `export const m${i} = ${i};`, [], [{ name: `m${i}`, type: "variable" }]);
    }
    resolveImports(db, tempDir);
    const discovery = runDiscovery(db, tempDir);
    const a = runServiceDetection(db, tempDir, discovery.modules, discovery.graphData.fileLevel);
    const b = runServiceDetection(db, tempDir, discovery.modules, discovery.graphData.fileLevel);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("extractServiceSignals — pattern coverage", () => {
  test("Express call-site routes extracted with method + path", async () => {
    await writeFixture(
      tempDir,
      "src/routes.ts",
      `import { Router } from 'express';
const router = Router();
router.get('/users/:id', findUser);
router.post('/users', createUser);
router.delete('/users/:id', removeUser);`,
    );
    const profile = {
      kind: "service" as const,
      framework: "Express",
      signals: [],
      communityRoles: [{ modulePath: "src", primary: "http" as const, all: ["http" as const] }],
      summary: "test",
      fingerprint: "test",
    };
    const ss = extractServiceSignals(["src/routes.ts"], profile, "src", loadContent(["src/routes.ts"], tempDir));
    expect(ss).not.toBeUndefined();
    const methods = ss!.routes.map((r) => r.method);
    expect(methods).toEqual(expect.arrayContaining(["GET", "POST", "DELETE"]));
    const paths = ss!.routes.map((r) => r.path);
    expect(paths).toContain("/users/:id");
    expect(paths).toContain("/users");
  });

  test("NestJS decorator routes pair with handler symbol", async () => {
    await writeFixture(
      tempDir,
      "src/users.controller.ts",
      `import { Controller, Get, Post } from '@nestjs/common';
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(id: string) { return id; }

  @Post()
  create(dto: any) { return dto; }
}`,
    );
    const profile = {
      kind: "service" as const,
      framework: "NestJS",
      signals: [],
      communityRoles: [{ modulePath: "src", primary: "http" as const, all: ["http" as const] }],
      summary: "test",
      fingerprint: "test",
    };
    const ss = extractServiceSignals(["src/users.controller.ts"], profile, "src", loadContent(["src/users.controller.ts"], tempDir));
    expect(ss).not.toBeUndefined();
    const handlers = ss!.routes.map((r) => r.handlerSymbol);
    expect(handlers).toContain("findOne");
    expect(handlers).toContain("create");
  });

  test("Kafka consumer.subscribe extracted as consume op", async () => {
    await writeFixture(
      tempDir,
      "src/consumer.ts",
      `import { Kafka } from 'kafkajs';
const kafka = new Kafka({ brokers: ['localhost'] });
const consumer = kafka.consumer({ groupId: 'g1' });
await consumer.subscribe({ topic: 'orders.v1' });`,
    );
    const profile = {
      kind: "service" as const,
      framework: "Kafka",
      signals: [],
      communityRoles: [{ modulePath: "src", primary: "messaging" as const, all: ["messaging" as const] }],
      summary: "test",
      fingerprint: "test",
    };
    const ss = extractServiceSignals(["src/consumer.ts"], profile, "src", loadContent(["src/consumer.ts"], tempDir));
    expect(ss).not.toBeUndefined();
    expect(ss!.queueOps).toHaveLength(1);
    expect(ss!.queueOps[0].kind).toBe("consume");
    expect(ss!.queueOps[0].topic).toBe("orders.v1");
  });

  test("library project returns undefined regardless of file content", async () => {
    await writeFixture(
      tempDir,
      "src/anything.ts",
      `app.get('/x', (req, res) => res.send('ok'));`,
    );
    const profile = {
      kind: "library" as const,
      framework: null,
      signals: [],
      communityRoles: [],
      summary: "test",
      fingerprint: "test",
    };
    const ss = extractServiceSignals(["src/anything.ts"], profile, "src", loadContent(["src/anything.ts"], tempDir));
    expect(ss).toBeUndefined();
  });

  test("shared-role community returns undefined even on a service project", async () => {
    await writeFixture(
      tempDir,
      "src/util.ts",
      `app.get('/x', (req, res) => res.send('ok'));`,
    );
    const profile = {
      kind: "service" as const,
      framework: "Express",
      signals: [],
      communityRoles: [{ modulePath: "src", primary: "shared" as const, all: ["shared" as const] }],
      summary: "test",
      fingerprint: "test",
    };
    const ss = extractServiceSignals(["src/util.ts"], profile, "src", loadContent(["src/util.ts"], tempDir));
    expect(ss).toBeUndefined();
  });

  test("generic data patterns gated by ORM import — no false positives without import", async () => {
    // No ORM import — generic .findOne() / .save() should be ignored.
    await writeFixture(
      tempDir,
      "src/cache.ts",
      `class LRU {
  findOne(key: string) { return this.map.get(key); }
  save(key: string, val: any) { this.map.set(key, val); }
  delete(key: string) { this.map.delete(key); }
}`,
    );
    const profile = {
      kind: "service" as const,
      framework: "Express",
      signals: [],
      communityRoles: [{ modulePath: "src", primary: "data-access" as const, all: ["data-access" as const] }],
      summary: "test",
      fingerprint: "test",
    };
    const ss = extractServiceSignals(["src/cache.ts"], profile, "src", loadContent(["src/cache.ts"], tempDir));
    expect(ss).toBeUndefined(); // No data ops counted without ORM import
  });

  test("generic data patterns counted when ORM import present", async () => {
    await writeFixture(
      tempDir,
      "src/repo.ts",
      `import { Repository } from 'typeorm';
class UsersRepo {
  constructor(private repo: Repository<any>) {}
  findOne(id: string) { return this.repo.findOne({ where: { id } }); }
  save(user: any) { return this.repo.save(user); }
}`,
    );
    const profile = {
      kind: "service" as const,
      framework: "NestJS",
      signals: [],
      communityRoles: [{ modulePath: "src", primary: "data-access" as const, all: ["data-access" as const] }],
      summary: "test",
      fingerprint: "test",
    };
    const ss = extractServiceSignals(["src/repo.ts"], profile, "src", loadContent(["src/repo.ts"], tempDir));
    expect(ss).not.toBeUndefined();
    expect(ss!.dataOps.length).toBeGreaterThanOrEqual(2);
  });

  test("language scoping — Python @app.task ignored on TS file", async () => {
    await writeFixture(
      tempDir,
      "src/wrong-ext.ts",
      `// Even with Python decorator syntax, this is a TS file:
@app.task
function notACeleryTask() {}`,
    );
    const profile = {
      kind: "service" as const,
      framework: "Celery",
      signals: [],
      communityRoles: [{ modulePath: "src", primary: "scheduler" as const, all: ["scheduler" as const] }],
      summary: "test",
      fingerprint: "test",
    };
    const ss = extractServiceSignals(["src/wrong-ext.ts"], profile, "src", loadContent(["src/wrong-ext.ts"], tempDir));
    expect(ss).toBeUndefined(); // Celery pattern is py-only; nothing extracted.
  });
});

describe("requiredSectionsFor — role-aware injection", () => {
  test("http role with routes triggers endpoint-catalog + request-flow", () => {
    const { requiredSectionsFor } = require("../../src/wiki/community-synthesis");
    const bundle = makeBundle({
      serviceSignals: {
        role: "http",
        routes: [
          { method: "GET", path: "/x", handlerSymbol: "h1", file: "src/a.ts", line: 10 },
          { method: "POST", path: "/y", handlerSymbol: "h2", file: "src/a.ts", line: 20 },
        ],
        queueOps: [],
        dataOps: [],
        externalCalls: [],
        scheduledJobs: [],
      },
    });
    const required = requiredSectionsFor(bundle);
    const ids = required.map((r: { entry: { id: string } }) => r.entry.id);
    expect(ids).toContain("endpoint-catalog");
    expect(ids).toContain("request-flow"); // Triggered when ≥2 routes
  });

  test("messaging role with produce ops triggers queue-topology + message-shapes", () => {
    const { requiredSectionsFor } = require("../../src/wiki/community-synthesis");
    const bundle = makeBundle({
      serviceSignals: {
        role: "messaging",
        routes: [],
        queueOps: [
          { kind: "produce", topic: "orders.v1", file: "src/p.ts", line: 5 },
        ],
        dataOps: [],
        externalCalls: [],
        scheduledJobs: [],
      },
    });
    const ids = requiredSectionsFor(bundle).map((r: { entry: { id: string } }) => r.entry.id);
    expect(ids).toContain("queue-topology");
    expect(ids).toContain("message-shapes");
  });

  test("library bundle (no serviceSignals) emits no role-injected sections", () => {
    const { requiredSectionsFor } = require("../../src/wiki/community-synthesis");
    const bundle = makeBundle({});
    const ids = requiredSectionsFor(bundle).map((r: { entry: { id: string } }) => r.entry.id);
    expect(ids).not.toContain("endpoint-catalog");
    expect(ids).not.toContain("queue-topology");
    expect(ids).not.toContain("data-stores");
    expect(ids).not.toContain("scheduled-jobs");
  });
});

/** Minimal CommunityBundle factory for requiredSectionsFor tests. */
function makeBundle(overrides: Record<string, unknown>): import("../../src/wiki/types").CommunityBundle {
  return {
    communityId: "test",
    memberFiles: ["src/a.ts"],
    exports: [],
    tunables: [],
    topMemberLoc: 50,
    memberLoc: { "src/a.ts": 50 },
    tunableCount: 0,
    exportCount: 0,
    externalConsumers: [],
    externalDependencies: [],
    consumersByFile: {},
    dependenciesByFile: {},
    recentCommits: [],
    annotations: [],
    topRankedFile: "src/a.ts",
    memberPreviews: [],
    pageRank: { "src/a.ts": 1 },
    cohesion: 1,
    nearbyDocs: [],
    ...overrides,
  } as import("../../src/wiki/types").CommunityBundle;
}
