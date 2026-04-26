import Graph from "graphology";

/**
 * PageRank via power iteration on a graphology Graph.
 *
 * Used to rank file importance inside a community (for ordering bundle
 * contents) and globally across the whole file graph (to replace the ad-hoc
 * `isHub` threshold in categorization).
 *
 * Deterministic given a deterministic input graph. Nodes are iterated in
 * insertion order, so callers should sort node inserts for stability.
 */
export function computePageRank(
  graph: Graph,
  opts: { damping?: number; tolerance?: number; maxIterations?: number } = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const tolerance = opts.tolerance ?? 1e-6;
  const maxIterations = opts.maxIterations ?? 100;

  const nodes = graph.nodes();
  const n = nodes.length;
  if (n === 0) return new Map();

  const initial = 1 / n;
  let rank = new Map<string, number>();
  for (const node of nodes) rank.set(node, initial);

  // Precompute out-degree (sum of edge weights) per node.
  const outWeight = new Map<string, number>();
  for (const node of nodes) {
    let w = 0;
    graph.forEachEdge(node, (_edge, attrs) => {
      w += (attrs.weight as number | undefined) ?? 1;
    });
    outWeight.set(node, w);
  }

  const teleport = (1 - damping) / n;

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Map<string, number>();
    for (const node of nodes) next.set(node, teleport);

    // Distribute dangling-node rank uniformly (nodes with no out-edges).
    let danglingSum = 0;
    for (const node of nodes) {
      if ((outWeight.get(node) ?? 0) === 0) danglingSum += rank.get(node) ?? 0;
    }
    const danglingShare = (damping * danglingSum) / n;
    if (danglingShare > 0) {
      for (const node of nodes) {
        next.set(node, (next.get(node) ?? 0) + danglingShare);
      }
    }

    for (const node of nodes) {
      const out = outWeight.get(node) ?? 0;
      if (out === 0) continue;
      const r = rank.get(node) ?? 0;
      graph.forEachEdge(node, (_edge, attrs, _source, target) => {
        const w = (attrs.weight as number | undefined) ?? 1;
        const contribution = damping * r * (w / out);
        next.set(target, (next.get(target) ?? 0) + contribution);
      });
    }

    let delta = 0;
    for (const node of nodes) {
      delta += Math.abs((next.get(node) ?? 0) - (rank.get(node) ?? 0));
    }
    rank = next;
    if (delta < tolerance) break;
  }

  return rank;
}

/** Return nodes sorted by PageRank descending. */
export function rankedNodes(ranks: Map<string, number>): string[] {
  return [...ranks.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([node]) => node);
}

/** Top-K nodes by PageRank. Ties broken by node id for determinism. */
export function topKByPageRank(ranks: Map<string, number>, k: number): string[] {
  return rankedNodes(ranks).slice(0, k);
}
