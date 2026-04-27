import { describe, test, expect } from "bun:test";
import { buildPageTree } from "../../src/wiki/page-tree";
import type {
  ClassifiedInventory,
  CommunityBundle,
  DiscoveryResult,
  FlowsFile,
  ServiceProfile,
  ServiceSignalsBundle,
  SynthesesFile,
  SynthesisPayload,
} from "../../src/wiki/types";

function makeDiscovery(profile?: ServiceProfile): DiscoveryResult {
  return {
    fileCount: 10,
    chunkCount: 10,
    lastIndexed: null,
    modules: [],
    graphData: {
      fileLevel: { level: "file", nodes: [], edges: [] },
      directoryLevel: { level: "directory", directories: [], edges: [] },
    },
    warnings: [],
    serviceProfile: profile,
  };
}

function makeClassified(): ClassifiedInventory {
  return { symbols: [], files: [], warnings: [] };
}

function profileService(): ServiceProfile {
  return {
    kind: "service",
    framework: "Express",
    signals: [],
    communityRoles: [],
    summary: "test",
    fingerprint: "fp",
  };
}

function bundleWith(
  id: string,
  slug: string,
  signals: Partial<ServiceSignalsBundle>,
): CommunityBundle {
  const ss: ServiceSignalsBundle = {
    routes: signals.routes ?? [],
    queueOps: signals.queueOps ?? [],
    dataOps: signals.dataOps ?? [],
    externalCalls: signals.externalCalls ?? [],
    scheduledJobs: signals.scheduledJobs ?? [],
    role: signals.role ?? "http",
  };
  return {
    communityId: id,
    memberFiles: [],
    exports: [],
    tunables: [],
    topMemberLoc: 0,
    memberLoc: {},
    tunableCount: 0,
    exportCount: 0,
    externalConsumers: [],
    externalDependencies: [],
    consumersByFile: {},
    dependenciesByFile: {},
    recentCommits: [],
    annotations: [],
    topRankedFile: null,
    memberPreviews: [],
    pageRank: {},
    cohesion: 1,
    nearbyDocs: [],
    serviceSignals: ss,
  };
}

function makeSyntheses(slugs: { id: string; slug: string }[]): SynthesesFile {
  const payloads: Record<string, SynthesisPayload> = {};
  const memberSets: Record<string, string[]> = {};
  for (const { id, slug } of slugs) {
    payloads[id] = {
      communityId: id,
      name: slug,
      slug,
      purpose: ".",
      kind: "community",
      sections: [{ title: "Overview", purpose: "." }],
    };
    memberSets[id] = [];
  }
  return { version: 1, payloads, memberSets };
}

describe("queues sharding", () => {
  test("below threshold (2 topics) → single queues.md", () => {
    const bundles = [
      bundleWith("c1", "comm-1", {
        role: "messaging",
        queueOps: [
          { kind: "produce", topic: "orders.v1", file: "x", line: 1 },
          { kind: "produce", topic: "payments.v1", file: "y", line: 1 },
        ],
      }),
    ];
    const m = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([{ id: "c1", slug: "comm-1" }]), "abc", "files", bundles);
    expect(m.pages["wiki/queues.md"]?.kind).toBe("queues");
    expect(Object.keys(m.pages).filter((p) => p.startsWith("wiki/queues/"))).toHaveLength(0);
  });

  test("at/above threshold (3 topics) → queues-toc + per-topic sub-pages", () => {
    const bundles = [
      bundleWith("c1", "comm-1", {
        role: "messaging",
        queueOps: [
          { kind: "produce", topic: "orders.v1", file: "x", line: 1 },
          { kind: "produce", topic: "payments.v1", file: "y", line: 1 },
          { kind: "consume", topic: "users.events", file: "z", line: 1 },
        ],
      }),
    ];
    const m = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([{ id: "c1", slug: "comm-1" }]), "abc", "files", bundles);
    expect(m.pages["wiki/queues.md"]?.kind).toBe("queues-toc");
    const subs = Object.keys(m.pages).filter((p) => p.startsWith("wiki/queues/"));
    expect(subs).toHaveLength(3);
    expect(subs.some((p) => p.includes("orders-v1"))).toBe(true);
    expect(subs.some((p) => p.includes("payments-v1"))).toBe(true);
    expect(subs.some((p) => p.includes("users-events"))).toBe(true);
  });

  test("library project → no queues machinery at all", () => {
    const m = buildPageTree(makeDiscovery(undefined), makeClassified(), makeSyntheses([]), "abc");
    expect(m.pages["wiki/queues.md"]).toBeUndefined();
  });
});

describe("endpoints sharding", () => {
  test("below threshold (5 routes) → single endpoints.md", () => {
    const routes = [
      { method: "GET", path: "/users", handlerSymbol: null, file: "x", line: 1 },
      { method: "POST", path: "/users", handlerSymbol: null, file: "x", line: 2 },
      { method: "DELETE", path: "/users/:id", handlerSymbol: null, file: "x", line: 3 },
      { method: "GET", path: "/health", handlerSymbol: null, file: "y", line: 1 },
      { method: "GET", path: "/version", handlerSymbol: null, file: "y", line: 2 },
    ];
    const bundles = [bundleWith("c1", "comm-1", { role: "http", routes })];
    const m = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([{ id: "c1", slug: "comm-1" }]), "abc", "files", bundles);
    expect(m.pages["wiki/endpoints.md"]?.kind).toBe("endpoints");
    expect(Object.keys(m.pages).filter((p) => p.startsWith("wiki/endpoints/"))).toHaveLength(0);
  });

  test("at/above threshold (10 routes) with diverse prefixes → endpoints-toc + group sub-pages", () => {
    const routes = [
      { method: "GET", path: "/api/users", handlerSymbol: null, file: "u", line: 1 },
      { method: "POST", path: "/api/users", handlerSymbol: null, file: "u", line: 2 },
      { method: "DELETE", path: "/api/users/:id", handlerSymbol: null, file: "u", line: 3 },
      { method: "PATCH", path: "/api/users/:id", handlerSymbol: null, file: "u", line: 4 },
      { method: "GET", path: "/api/orders", handlerSymbol: null, file: "o", line: 1 },
      { method: "POST", path: "/api/orders", handlerSymbol: null, file: "o", line: 2 },
      { method: "DELETE", path: "/api/orders/:id", handlerSymbol: null, file: "o", line: 3 },
      { method: "PUT", path: "/api/orders/:id", handlerSymbol: null, file: "o", line: 4 },
      { method: "GET", path: "/api/orders/:id/items", handlerSymbol: null, file: "o", line: 5 },
      { method: "GET", path: "/health", handlerSymbol: null, file: "h", line: 1 },
    ];
    const bundles = [bundleWith("c1", "comm-1", { role: "http", routes })];
    const m = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([{ id: "c1", slug: "comm-1" }]), "abc", "files", bundles);
    expect(m.pages["wiki/endpoints.md"]?.kind).toBe("endpoints-toc");
    const subs = Object.keys(m.pages).filter((p) => p.startsWith("wiki/endpoints/"));
    expect(subs.length).toBeGreaterThan(0);
  });

  test("library project → no endpoints machinery at all", () => {
    const m = buildPageTree(makeDiscovery(undefined), makeClassified(), makeSyntheses([]), "abc");
    expect(m.pages["wiki/endpoints.md"]).toBeUndefined();
  });
});

describe("data-flows sharding", () => {
  test("no flows file → existing single data-flows.md", () => {
    const m = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([]), "abc");
    expect(m.pages["wiki/data-flows.md"]?.kind).toBe("data-flows");
  });

  test("flows file with 3+ flows → data-flows-toc + per-flow sub-pages", () => {
    const flows: FlowsFile = {
      version: 1,
      fingerprint: "fp",
      flows: [
        { name: "Checkout", slug: "checkout", purpose: ".", trigger: { kind: "http", ref: "POST /checkout" }, memberCommunities: [] },
        { name: "Login", slug: "login", purpose: ".", trigger: { kind: "http", ref: "POST /login" }, memberCommunities: [] },
        { name: "Sync", slug: "sync", purpose: ".", trigger: { kind: "scheduled", ref: "0 * * * *" }, memberCommunities: [] },
      ],
    };
    const m = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([]), "abc", "files", [], flows);
    expect(m.pages["wiki/data-flows.md"]?.kind).toBe("data-flows-toc");
    const subs = Object.keys(m.pages).filter((p) => p.startsWith("wiki/data-flows/"));
    expect(subs).toHaveLength(3);
    expect(subs.some((p) => p.includes("checkout"))).toBe(true);
    expect(subs.some((p) => p.includes("login"))).toBe(true);
    expect(subs.some((p) => p.includes("sync"))).toBe(true);
  });

  test("flows file with < threshold → no folder, fall back to single page", () => {
    const flows: FlowsFile = {
      version: 1,
      fingerprint: "fp",
      flows: [
        { name: "Checkout", slug: "checkout", purpose: ".", trigger: { kind: "http", ref: "POST /checkout" }, memberCommunities: [] },
      ],
    };
    const m = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([]), "abc", "files", [], flows);
    expect(m.pages["wiki/data-flows.md"]?.kind).toBe("data-flows");
    expect(Object.keys(m.pages).filter((p) => p.startsWith("wiki/data-flows/"))).toHaveLength(0);
  });
});

describe("cross-link wiring", () => {
  test("queue-detail sub-page lists queues.md as a related page", () => {
    const bundles = [
      bundleWith("c1", "comm-1", {
        role: "messaging",
        queueOps: [
          { kind: "produce", topic: "orders.v1", file: "x", line: 1 },
          { kind: "produce", topic: "payments.v1", file: "y", line: 1 },
          { kind: "consume", topic: "users.events", file: "z", line: 1 },
        ],
      }),
    ];
    const m = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([{ id: "c1", slug: "comm-1" }]), "abc", "files", bundles);
    const detail = Object.entries(m.pages).find(([p]) => p.startsWith("wiki/queues/"))?.[1];
    expect(detail).toBeDefined();
    expect(detail!.relatedPages).toContain("wiki/queues.md");
  });

  test("queues-toc lists every community page as related", () => {
    const bundles = [
      bundleWith("c1", "comm-1", {
        role: "messaging",
        queueOps: [
          { kind: "produce", topic: "t1", file: "x", line: 1 },
          { kind: "produce", topic: "t2", file: "y", line: 1 },
          { kind: "produce", topic: "t3", file: "z", line: 1 },
        ],
      }),
    ];
    const m = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([{ id: "c1", slug: "comm-1" }]), "abc", "files", bundles);
    const toc = m.pages["wiki/queues.md"];
    expect(toc?.kind).toBe("queues-toc");
    expect(toc!.relatedPages).toContain("wiki/communities/comm-1.md");
  });
});

describe("idempotency", () => {
  test("same input → same manifest paths + slugs", () => {
    const bundles = [
      bundleWith("c1", "comm-1", {
        role: "messaging",
        queueOps: [
          { kind: "produce", topic: "alpha", file: "x", line: 1 },
          { kind: "produce", topic: "beta", file: "y", line: 1 },
          { kind: "produce", topic: "gamma", file: "z", line: 1 },
        ],
      }),
    ];
    const a = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([{ id: "c1", slug: "comm-1" }]), "abc", "files", bundles);
    const b = buildPageTree(makeDiscovery(profileService()), makeClassified(), makeSyntheses([{ id: "c1", slug: "comm-1" }]), "abc", "files", bundles);
    expect(Object.keys(a.pages).sort()).toEqual(Object.keys(b.pages).sort());
  });
});
