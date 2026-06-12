import { describe, test, expect } from "bun:test";
import { chunkText } from "../../src/indexing/chunker";

// Format-specific heuristic splitters (Dockerfile, Makefile, SQL, Bru, JSON).
// All fixtures keep each logical section >100 chars (the mergeTinyParts
// threshold) and the whole text above chunkSize, so the splitter — not the
// small-file early return or tiny-part merging — decides the boundaries.
const CHUNK_SIZE = 200;

describe("splitDockerfile", () => {
  const dockerfile = `FROM node:20 AS build
WORKDIR /app
COPY package.json ./
RUN npm install --production --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "dist/main.js"]`;

  test("splits multi-stage builds on FROM instructions", async () => {
    const { chunks } = await chunkText(dockerfile, ".dockerfile", CHUNK_SIZE, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toStartWith("FROM node:20 AS build");
    expect(chunks[1].text).toStartWith("FROM node:20-slim AS runtime");
  });

  test("stage chunks get line numbers from the original source", async () => {
    const { chunks } = await chunkText(dockerfile, ".dockerfile", CHUNK_SIZE, 0);
    expect(chunks[0].startLine).toBe(1);
    // Second stage starts on line 8 (after the blank separator line)
    expect(chunks[1].startLine).toBe(8);
  });
});

describe("splitMakefile", () => {
  test("splits on target lines, keeping each recipe with its target", async () => {
    const makefile = `build: src/main.ts
\tbun build src/main.ts --outdir dist --target node --minify
\techo "build finished successfully for distribution"

test: build
\tbun test tests/unit --coverage --bail
\techo "test run finished, coverage written to coverage directory"`;

    const { chunks } = await chunkText(makefile, ".makefile", CHUNK_SIZE, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toStartWith("build:");
    expect(chunks[0].text).toContain("--outdir dist");
    expect(chunks[1].text).toStartWith("test:");
  });

  test("does not treat := variable assignments as targets", async () => {
    const makefile = `CFLAGS := -Wall -Wextra -O2 -g -fsanitize=address -fno-omit-frame-pointer -std=c11 -pedantic-errors

compile: main.c helpers.c
\tgcc $(CFLAGS) -o build/output main.c helpers.c && echo "compilation finished without warnings or errors"`;

    const { chunks } = await chunkText(makefile, ".makefile", CHUNK_SIZE, 0);
    // The CFLAGS assignment must not start its own chunk
    expect(chunks[0].text).toStartWith("CFLAGS :=");
    expect(chunks.some((c) => c.text.startsWith("compile:"))).toBe(true);
  });
});

describe("splitSQL", () => {
  test("splits on statement-terminating semicolons and keeps them", async () => {
    const sql = `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL AND display_name IS NOT NULL AND created_at IS NOT NULL;`;

    const { chunks } = await chunkText(sql, ".sql", CHUNK_SIZE, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toContain("CREATE TABLE users");
    expect(chunks[0].text).toEndWith(";");
    expect(chunks[1].text).toContain("CREATE INDEX idx_users_email");
    expect(chunks[1].text).toEndWith(";");
  });
});

describe("splitBru", () => {
  test("splits on top-level blocks, including colon-named ones", async () => {
    const bru = `meta {
  name: Get user by identifier endpoint check
  type: http
  seq: 1
  description: fetches a single user record by id
}

body:json {
  "userId": 12345,
  "includeProfile": true,
  "includeSettings": true,
  "responseFormat": "detailed"
}`;

    const { chunks } = await chunkText(bru, ".bru", CHUNK_SIZE, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toStartWith("meta {");
    expect(chunks[1].text).toStartWith("body:json {");
  });
});

describe("splitJSON", () => {
  test("object: one chunk per top-level key", async () => {
    const json = JSON.stringify({
      server: { host: "localhost", port: 8080, timeoutMs: 30000, retries: 3, keepAlive: true, basePath: "/api/v2" },
      logging: { level: "debug", destination: "/var/log/app.log", rotation: "daily", maxFiles: 14, format: "json" },
    });
    expect(json.length).toBeGreaterThan(CHUNK_SIZE);

    const { chunks } = await chunkText(json, ".json", CHUNK_SIZE, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toStartWith('"server":');
    expect(chunks[1].text).toStartWith('"logging":');
  });

  test("reformatted JSON chunks carry no line numbers (not verbatim substrings)", async () => {
    const json = JSON.stringify({
      server: { host: "localhost", port: 8080, timeoutMs: 30000, retries: 3, keepAlive: true, basePath: "/api/v2" },
      logging: { level: "debug", destination: "/var/log/app.log", rotation: "daily", maxFiles: 14, format: "json" },
    });
    const { chunks } = await chunkText(json, ".json", CHUNK_SIZE, 0);
    for (const c of chunks) {
      expect(c.startLine).toBeUndefined();
    }
  });

  test("array: one chunk per item, labeled with its index", async () => {
    const json = JSON.stringify([
      { id: 1, name: "first fixture item", description: "a sufficiently long description to avoid tiny-part merging", active: true },
      { id: 2, name: "second fixture item", description: "another long enough description so the parts stay separate", active: false },
    ]);

    const { chunks } = await chunkText(json, ".json", CHUNK_SIZE, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toStartWith("[0]:");
    expect(chunks[1].text).toStartWith("[1]:");
  });

  test("OpenAPI: paths get one chunk per path entry", async () => {
    const json = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/users": { get: { summary: "List all registered users with paging", responses: { "200": { description: "ok" } } } },
        "/orders": { post: { summary: "Create a new order for the current user", responses: { "201": { description: "created" } } } },
      },
    });

    const { chunks } = await chunkText(json, ".json", CHUNK_SIZE, 0);
    expect(chunks.some((c) => c.text.includes('paths["/users"]:'))).toBe(true);
    expect(chunks.some((c) => c.text.includes('paths["/orders"]:'))).toBe(true);
  });

  test("invalid JSON falls back to paragraph splitting", async () => {
    const broken = `{ this is not valid json but it is long enough to exceed the chunk size limit for the first paragraph block

and here is a second paragraph block that should become its own chunk because paragraph splitting splits on blank lines }`;

    const { chunks } = await chunkText(broken, ".json", CHUNK_SIZE, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toContain("not valid json");
    expect(chunks[1].text).toContain("second paragraph");
  });

  test("JSON primitive falls back to size-based splitting", async () => {
    const json = JSON.stringify("x".repeat(500));
    const { chunks } = await chunkText(json, ".json", CHUNK_SIZE, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});
