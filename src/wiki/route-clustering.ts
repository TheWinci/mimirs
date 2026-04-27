import type { ServiceAggregateBundle } from "./types";

/**
 * Phase 2: Path-prefix clustering for HTTP-route folder split.
 *
 * Groups routes by their first N path segments so a service with 60+
 * endpoints can fan out into per-prefix sub-pages instead of producing
 * one unreadable 60-row table. Algorithm is deterministic + pure: given
 * the same input route list, it always produces the same group output.
 *
 * See `plans/aggregate-page-sharding.md` Phase 2 for the algorithm
 * narrative and rationale. The constants below mirror that spec.
 */

/** Smallest subtree size that becomes its own group. */
const MIN_GROUP_SIZE = 3;
/** Subtree size above which the parent forces splitting children out. */
const MAX_GROUP_FOR_INLINE = 8;
/** Hard cap on emitted group count — protects against pathological repos. */
const MAX_GROUPS = 12;
/** Trie depth past which we stop creating clusters. */
const MAX_TRIE_DEPTH = 3;

export interface RouteGroup {
  /** Slug used in `endpoints/<slug>.md` page path. */
  slug: string;
  /** Human-readable prefix (`/api/users`). */
  pathPrefix: string;
  routes: ServiceAggregateBundle["routes"];
}

export interface ClusterResult {
  groups: RouteGroup[];
  /** Routes that didn't make it into any group. Caller decides whether
   *  to inline these on the TOC or emit a `misc` group page. */
  misc: ServiceAggregateBundle["routes"];
}

interface TrieNode {
  segment: string;
  children: Map<string, TrieNode>;
  routes: ServiceAggregateBundle["routes"];
  /** Cumulative route count under this subtree (including own + descendants). */
  subtreeSize: number;
}

/**
 * Cluster a flat route list into prefix-keyed groups + a misc bucket.
 * Pure function — no I/O, no graph access — so it's safe to unit-test
 * with synthetic inputs and use deterministically across regens.
 */
export function clusterRoutes(
  routes: ServiceAggregateBundle["routes"],
): ClusterResult {
  if (routes.length === 0) return { groups: [], misc: [] };

  const root: TrieNode = newNode("");
  for (const r of routes) addRoute(root, r);

  // Greedy descent: pick groups at the highest level where the parent
  // is too big to keep flat. Single-level (no nested groups).
  const groups: { node: TrieNode; pathSegments: string[] }[] = [];
  const claimed = new Set<TrieNode>();

  const descend = (node: TrieNode, pathSegments: string[], depth: number): void => {
    if (depth >= MAX_TRIE_DEPTH) return;
    for (const [seg, child] of node.children) {
      const childSegments = [...pathSegments, seg];
      if (
        child.subtreeSize >= MIN_GROUP_SIZE &&
        node.subtreeSize > MAX_GROUP_FOR_INLINE
      ) {
        groups.push({ node: child, pathSegments: childSegments });
        claimed.add(child);
      } else {
        descend(child, childSegments, depth + 1);
      }
    }
  };
  descend(root, [], 0);

  // Cap at MAX_GROUPS — keep the largest subtrees, drop the rest into misc.
  groups.sort((a, b) => b.node.subtreeSize - a.node.subtreeSize);
  const kept = groups.slice(0, MAX_GROUPS);
  const dropped = groups.slice(MAX_GROUPS);
  const droppedNodes = new Set(dropped.map((g) => g.node));

  // Collect routes that fall into kept groups.
  const groupResults: RouteGroup[] = kept.map(({ node, pathSegments }) => ({
    slug: pathSegmentsToSlug(pathSegments),
    pathPrefix: "/" + pathSegments.join("/"),
    routes: collectRoutes(node).sort(routeOrder),
  }));

  // Misc bucket: every route not under a kept group's subtree (including
  // those that fell out of the MAX_GROUPS cap).
  const keptNodes = new Set(kept.map((g) => g.node));
  const misc: ServiceAggregateBundle["routes"] = [];
  for (const r of routes) {
    if (!isUnderAny(r, keptNodes, droppedNodes)) misc.push(r);
  }
  // Routes in *dropped* group nodes also belong to misc.
  for (const node of droppedNodes) misc.push(...collectRoutes(node));

  // Deterministic order
  misc.sort(routeOrder);

  // Resolve slug collisions with monotonic numeric suffix.
  const used = new Set<string>();
  for (const g of groupResults) {
    let candidate = g.slug;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${g.slug}-${suffix++}`;
    g.slug = candidate;
    used.add(candidate);
  }

  return { groups: groupResults, misc };
}

function newNode(segment: string): TrieNode {
  return { segment, children: new Map(), routes: [], subtreeSize: 0 };
}

/**
 * Insert a route into the trie. Path parameters are normalised to
 * `<param>` so Express `:id`, FastAPI `{user_id}`, and Spring
 * `{id:[0-9]+}` cluster together.
 */
function addRoute(
  root: TrieNode,
  route: ServiceAggregateBundle["routes"][number],
): void {
  const segments = normalisePathSegments(route.path);
  let node = root;
  node.subtreeSize++;
  for (let i = 0; i < segments.length && i < MAX_TRIE_DEPTH; i++) {
    const seg = segments[i];
    let child = node.children.get(seg);
    if (!child) {
      child = newNode(seg);
      node.children.set(seg, child);
    }
    node = child;
    node.subtreeSize++;
  }
  node.routes.push(route);
}

/**
 * Normalise a path string into segments for trie keying:
 * - Drop leading slash.
 * - Replace any param token (`:id`, `{x}`, `{x:re}`, `*`) with
 *   `<param>` so frameworks cluster together.
 */
export function normalisePathSegments(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      if (s.startsWith(":")) return "<param>";
      if (s.startsWith("{") && s.endsWith("}")) return "<param>";
      if (s === "*") return "<param>";
      return s;
    });
}

/** Walk a subtree and collect every route at or below a node. */
function collectRoutes(
  node: TrieNode,
): ServiceAggregateBundle["routes"] {
  const out: ServiceAggregateBundle["routes"] = [...node.routes];
  for (const child of node.children.values()) out.push(...collectRoutes(child));
  return out;
}

/**
 * Determine if a route belongs to any kept-group subtree (vs the misc
 * bucket). Used to filter misc — routes that fell into a dropped group
 * (from the MAX_GROUPS cap) are explicitly *not* under any kept node.
 */
function isUnderAny(
  route: ServiceAggregateBundle["routes"][number],
  keptNodes: Set<TrieNode>,
  droppedNodes: Set<TrieNode>,
): boolean {
  for (const node of keptNodes) {
    if (containsRoute(node, route)) return true;
  }
  // Dropped nodes' routes are explicitly *not* claimed by kept groups.
  void droppedNodes;
  return false;
}

function containsRoute(
  node: TrieNode,
  route: ServiceAggregateBundle["routes"][number],
): boolean {
  if (node.routes.includes(route)) return true;
  for (const child of node.children.values()) {
    if (containsRoute(child, route)) return true;
  }
  return false;
}

function routeOrder(
  a: ServiceAggregateBundle["routes"][number],
  b: ServiceAggregateBundle["routes"][number],
): number {
  return a.path.localeCompare(b.path) || a.method.localeCompare(b.method);
}

/** Slug = path segments joined with `-`, lowercase, alphanumeric only. */
function pathSegmentsToSlug(segments: string[]): string {
  const raw = segments.join("-").toLowerCase();
  return raw.replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "group";
}
