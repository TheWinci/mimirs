import { describe, test, expect } from "bun:test";
import { clusterRoutes, normalisePathSegments } from "../../src/wiki/route-clustering";
import type { ServiceAggregateBundle } from "../../src/wiki/types";

type Route = ServiceAggregateBundle["routes"][number];
const r = (method: string, path: string, slug = "c1"): Route => ({
  method,
  path,
  handlerSymbol: null,
  file: "x",
  line: 0,
  communitySlug: slug,
});

describe("normalisePathSegments", () => {
  test("Express-style :id replaced with <param>", () => {
    expect(normalisePathSegments("/users/:id")).toEqual(["users", "<param>"]);
  });

  test("FastAPI-style {user_id} replaced with <param>", () => {
    expect(normalisePathSegments("/users/{user_id}")).toEqual(["users", "<param>"]);
  });

  test("Spring constrained {id:[0-9]+} replaced with <param>", () => {
    expect(normalisePathSegments("/users/{id:[0-9]+}")).toEqual(["users", "<param>"]);
  });

  test("wildcard * replaced with <param>", () => {
    expect(normalisePathSegments("/static/*")).toEqual(["static", "<param>"]);
  });

  test("leading slash dropped", () => {
    expect(normalisePathSegments("/api/users")).toEqual(["api", "users"]);
  });
});

describe("clusterRoutes", () => {
  test("empty input → empty output", () => {
    expect(clusterRoutes([])).toEqual({ groups: [], misc: [] });
  });

  test("single route stays in misc (subtree too small)", () => {
    const result = clusterRoutes([r("GET", "/users/1")]);
    expect(result.groups).toHaveLength(0);
    expect(result.misc).toHaveLength(1);
  });

  test("3 routes under same prefix → single group when parent forces split", () => {
    // Need 9+ routes for parent to exceed MAX_GROUP_FOR_INLINE (8).
    const routes: Route[] = [
      r("GET", "/users/1"),
      r("POST", "/users"),
      r("DELETE", "/users/1"),
      r("PUT", "/users/1"),
      r("GET", "/users/2"),
      r("GET", "/orders/1"),
      r("POST", "/orders"),
      r("DELETE", "/orders/1"),
      r("GET", "/orders/2"),
    ];
    const result = clusterRoutes(routes);
    const slugs = result.groups.map((g) => g.slug).sort();
    expect(slugs).toEqual(["orders", "users"]);
  });

  test("routes that don't cluster fall into misc", () => {
    const routes: Route[] = [
      r("GET", "/users/1"),
      r("POST", "/users"),
      r("DELETE", "/users/1"),
      r("PUT", "/users/1"),
      r("GET", "/users/2"),
      r("GET", "/users/3"),
      r("GET", "/users/4"),
      r("GET", "/users/5"),
      r("GET", "/users/6"),
      r("GET", "/health"), // singleton — falls into misc
    ];
    const result = clusterRoutes(routes);
    expect(result.misc.find((m) => m.path === "/health")).toBeDefined();
  });

  test("cross-framework path-param normalisation: Express + FastAPI cluster together", () => {
    const routes: Route[] = [
      r("GET", "/users/:id", "express-comm"),
      r("POST", "/users", "express-comm"),
      r("DELETE", "/users/:id", "express-comm"),
      r("PATCH", "/users/:id", "express-comm"),
      r("GET", "/users/{user_id}", "fastapi-comm"),
      r("PUT", "/users/{user_id}", "fastapi-comm"),
      r("GET", "/orders/1"),
      r("POST", "/orders"),
      r("DELETE", "/orders/1"),
      r("PUT", "/orders/1"),
    ];
    const result = clusterRoutes(routes);
    const usersGroup = result.groups.find((g) => g.slug === "users");
    expect(usersGroup).toBeDefined();
    // Both Express and FastAPI users routes should be in the same group.
    const slugs = new Set(usersGroup!.routes.map((rt) => rt.communitySlug));
    expect(slugs.has("express-comm")).toBe(true);
    expect(slugs.has("fastapi-comm")).toBe(true);
  });

  test("idempotent: same input → same group output", () => {
    const routes: Route[] = [
      r("GET", "/api/users/1"),
      r("POST", "/api/users"),
      r("DELETE", "/api/users/1"),
      r("PUT", "/api/users/1"),
      r("GET", "/api/orders/1"),
      r("POST", "/api/orders"),
      r("DELETE", "/api/orders/1"),
      r("PUT", "/api/orders/1"),
      r("GET", "/api/orders/2"),
    ];
    const a = clusterRoutes(routes);
    const b = clusterRoutes(routes);
    expect(a.groups.map((g) => g.slug)).toEqual(b.groups.map((g) => g.slug));
    expect(a.groups.map((g) => g.routes.length)).toEqual(b.groups.map((g) => g.routes.length));
  });

  test("MAX_GROUPS cap: 14 distinct prefixes collapse to 12 groups + misc", () => {
    const routes: Route[] = [];
    for (let i = 0; i < 14; i++) {
      const prefix = `/g${i}`;
      // Need parent (root) to exceed 8 routes so children split.
      routes.push(r("GET", `${prefix}/a`));
      routes.push(r("POST", `${prefix}/b`));
      routes.push(r("DELETE", `${prefix}/c`));
    }
    const result = clusterRoutes(routes);
    expect(result.groups.length).toBeLessThanOrEqual(12);
    // Excess routes land in misc.
    expect(result.misc.length).toBeGreaterThan(0);
  });
});
