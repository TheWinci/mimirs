# Tool: trace

`trace` answers a directional question about the call graph: *how does one symbol reach another?* You name a `from` function and a `to` function, and it returns the reachable call sub-graph between them — every function that lies on some path from the source to the target — with the shortest path highlighted as a "spine." Branches that wander off and never reach the target are pruned away, so what you see is only the routes that actually connect the two.

This is the tool for "I know `handleRequest` eventually triggers `writeAudit`, but through what?" — onboarding into an unfamiliar call chain, confirming a refactor didn't sever a path, or understanding why a change in one place shows up in another. It is the directional counterpart to [`impact`](impact.md), which walks *all* callers of a single symbol regardless of destination. For raw textual references see [`usages`](usages.md).

## What runs when you call it

```mermaid
sequenceDiagram
    autonumber
    participant Caller as Caller (agent)
    participant Tool as trace handler
    participant Resolve as resolveSymbol (×2)
    participant Path as tracePath
    participant Render as renderTrace / traceToJson

    Caller->>Tool: { from, to, from_file?, to_file?, max_depth?, format? }
    Tool->>Resolve: resolve `from`
    Tool->>Resolve: resolve `to`
    alt either not ok
        Resolve-->>Tool: not_found / ambiguous
        Tool-->>Caller: error or "pass a file" message
    else both ok
        Resolve-->>Tool: from + to CallNodes
        Tool->>Path: tracePath(db, from, to, { maxDepth })
        Path->>Path: forward BFS from `from` (callees)
        Path->>Path: backward BFS from `to` (callers)
        Path->>Path: intersect → reachable sub-graph
        alt from or to not in intersection
            Path-->>Tool: found=false + frontiers
            Tool-->>Caller: "No call path" + dynamic-dispatch note
        else connected
            Path-->>Tool: tree + shortest-path spine
            Tool-->>Caller: sub-graph tree + spine
        end
    end
```

1. The caller invokes the tool with required `from` and `to` names plus optional `from_file`, `to_file`, `max_depth`, `directory`, and `format`. The handler is registered inside `registerGraphTools` (`src/tools/graph-tools.ts:252-291`).
2. Each endpoint is resolved with `resolveSymbol`, optionally disambiguated by its `_file` argument. If either fails to resolve to a single callable, the tool returns an error or a "pass a file" message and stops (`src/tools/graph-tools.ts:276-283`).
3. With both endpoints resolved, `tracePath` runs a forward breadth-first search from `from` over *callees* and a backward one from `to` over *callers*, then intersects them (`src/graph/trace.ts:391-396`).
4. If the intersection does not contain both endpoints, there is no path within the search bounds: the tool reports `found: false` and a pair of frontiers to help the caller find the gap (`src/graph/trace.ts:398-414`).
5. Otherwise it builds a forward tree over the sub-graph and computes the shortest path (the spine), returned as readable text by `renderTrace` or as JSON by `traceToJson` (`src/graph/trace.ts:416-443`, `src/tools/graph-tools.ts:285-289`).

## The reachable sub-graph: forward ∩ backward

The core idea is a set intersection. A function lies on *some* path from `from` to `to` if and only if two things are true at once: `from` can reach it (it is forward-reachable along callee edges), and it can reach `to` (it is backward-reachable along caller edges from the target). Nodes that satisfy only one of those are dead ends — reachable from the source but going nowhere useful, or feeding the target but not from this source — and have no business in the answer.

`tracePath` computes this with two breadth-first searches sharing one `CallGraph` view (`src/graph/trace.ts:372`). The forward search walks `callees` outward from `from`; the backward search walks `callers` outward from `to` (`src/graph/trace.ts:391-392`). The callee and caller edges come from the resolved symbol-ref graph — `getCalleeRefsForExport` / `getCalleeRefsForLocalSymbol` forward, `getCallersOfExport` / `getCallersOfLocalSymbol` backward — with unresolved or non-callable refs dropped as leaves (`src/graph/trace.ts:81-150`). The reachable sub-graph is the set of keys present in *both* searches (`src/graph/trace.ts:395-396`). This is what "branches that don't reach the target are pruned" means concretely: a node only survives if it appears in both directions.

Each search is bounded by `maxDepth` (default 6) and a node `budget` (default 300); hitting either sets a `truncated` flag so a capped search can say a longer path might exist beyond the bound (`src/graph/trace.ts:345-361`, `src/graph/trace.ts:370-371`). A trivial case short-circuits first: if `from` and `to` resolve to the same node, the trace is a single node with nothing to walk (`src/graph/trace.ts:376-387`).

## The forward tree and the shortest-path spine

Once the sub-graph is known, the tool presents it two ways. First it restricts the forward adjacency to sub-graph members only, then builds a tree rooted at `from`, where each node's children are its sub-graph callees; the target is treated as a leaf, and a node reached a second time is shown once and marked seen so diamonds don't duplicate (`src/graph/trace.ts:419-441`). This tree is the full picture of how the source fans out toward the target.

Second, it computes the **spine** — the shortest path from `from` to `to` — with a breadth-first search over the restricted adjacency that records each node's predecessor, then walks the predecessor chain back from the target (`src/graph/trace.ts:426`, `src/graph/trace.ts:446-474`). The renderer prints it as `from → … → to (N hops)`, the at-a-glance route through what may be a wide sub-graph (`src/graph/trace.ts:683-684`).

## When there is no path: frontiers and the static-resolution limit

If the intersection is missing either endpoint, the two functions are not connected within the search bounds, and the tool says so plainly. To make the gap diagnosable rather than a dead "not found," it returns two frontiers: the deepest nodes the forward search reached from `from`, and the direct callers of `to` — each capped at 8 entries (`src/graph/trace.ts:398-413`). Read together, they show where the forward reach stopped and what feeds the target, so you can spot the missing hop.

That missing hop is usually the same thing: **resolution is static name-match.** The walk follows edges only where a callee or caller resolves to an indexed callable. A dynamic-dispatch hop — a callback passed as a value, an interface method dispatched to an implementation, a dependency-injected service — has no statically resolvable edge, so the chain ends there (`src/graph/trace.ts:11-14`). The no-path message states this explicitly and points the reader at `read_relevant` to inspect the gap manually (`src/graph/trace.ts:658-672`). This is a real limitation, not a bug: a "no path" result means *no statically resolvable path*, and a genuine runtime path may still exist across a dynamic boundary.

## Inputs

| name | type | required | description |
| --- | --- | --- | --- |
| `from` | string (1–200 chars) | yes | Source symbol (function/method) the path starts at (`src/tools/graph-tools.ts:256`). |
| `to` | string (1–200 chars) | yes | Target symbol the path should reach (`src/tools/graph-tools.ts:257`). |
| `from_file` | string | no | Project-relative path to disambiguate `from` when defined in several places (`src/tools/graph-tools.ts:258`). |
| `to_file` | string | no | Project-relative path to disambiguate `to` (`src/tools/graph-tools.ts:259`). |
| `max_depth` | integer 1–12 | no | Max hops searched in *each* direction. Defaults to 6 (`src/tools/graph-tools.ts:260-266`, `src/graph/trace.ts:370`). |
| `directory` | string | no | Project whose index to query. Defaults to `RAG_PROJECT_DIR` or the current working directory (`src/tools/index.ts:26`). |
| `format` | `"text"` \| `"json"` | no | Output shape. Defaults to `"text"`; `"json"` returns the object from `traceToJson` (`src/tools/graph-tools.ts:271`, `src/tools/graph-tools.ts:286-288`). |

## Outputs

| output | where it lands / shape / description |
| --- | --- |
| Reachable sub-graph tree | On success, a text tree rooted at `from`, indented, with the target marked `◀ target` and revisited nodes marked `(↑ seen above)`; the header states the sub-graph node count (`src/graph/trace.ts:675-682`). |
| Shortest-path spine | A `spine (shortest): from → … → to (N hops)` line below the tree (`src/graph/trace.ts:683-684`). |
| No-path frontier | When unconnected, text: a "No call path …" line, the static-resolution note, the deepest forward-reached nodes, and the direct callers of `to` (`src/graph/trace.ts:658-672`). |

For `format: "json"`, the structured object carries `from`, `to`, `found`, `maxDepth`, `subgraphSize`, `truncated`, the `spine`, the `tree`, and (when not found) `forwardFrontier` / `backwardFrontier` (`src/graph/trace.ts:719-731`).

This tool only reads the index; it writes nothing back, so it produces no persistent state changes.

## Branches and failure cases

- **`from` unresolved.** If `from` resolves to `not_found` or `ambiguous`, the tool returns the resolve error for the `from` role and stops before resolving `to` (`src/tools/graph-tools.ts:276-279`).
- **`to` unresolved.** Same handling for the `to` role (`src/tools/graph-tools.ts:280-283`). The error names whether the symbol was missing or defined in multiple places and reminds the caller that `trace` tracks functions and methods, not classes/constants/types (`src/tools/graph-tools.ts:33-42`).
- **Same symbol.** When `from` and `to` resolve to the same node, the trace short-circuits to a one-node result, and the renderer reports "resolve to the same symbol — nothing to trace" (`src/graph/trace.ts:376-387`, `src/graph/trace.ts:655-657`).
- **No path within bounds.** When the forward/backward intersection misses an endpoint, `found` is false and the frontier report is returned (`src/graph/trace.ts:398-414`, `src/graph/trace.ts:658-672`).
- **Search truncated.** Hitting `maxDepth` or the 300-node budget in either direction sets `truncated`; the renderer adds a note that a longer path may exist beyond the bound — both on the no-path branch and below a found sub-graph (`src/graph/trace.ts:352-354`, `src/graph/trace.ts:671`, `src/graph/trace.ts:685`).
- **Dynamic-dispatch gap.** A callback, interface→impl, or DI hop has no static edge and ends the chain; this commonly produces the no-path branch and is called out in its message (`src/graph/trace.ts:11-14`, `src/graph/trace.ts:661`).
- **Missing directory.** A non-existent `directory` makes `resolveProject` throw before any search runs (`src/tools/index.ts:30-32`).

## Example

Trace how one function reaches another, allowing deeper hops:

```json
{
  "from": "handleSearch",
  "to": "logQuery",
  "max_depth": 8
}
```

Illustrative text output (names and line numbers are synthetic):

```
Trace  handleSearch ⇒ logQuery  (reachable sub-graph: 4 nodes)

handleSearch  src/example/search.ts:30
  runHybrid  src/example/hybrid.ts:120
    rankResults  src/example/hybrid.ts:200
      logQuery  src/example/analytics.ts:18  ◀ target

spine (shortest): handleSearch → runHybrid → rankResults → logQuery  (3 hops)
```

A disconnected pair instead returns:

```
No call path from handleSearch to logQuery within 8 hops.
Resolution is static — a dynamic-dispatch hop (callback, interface→impl, DI) breaks the chain. Try read_relevant around the gap.

From handleSearch, deepest reached:
  runHybrid  src/example/hybrid.ts:120

Direct callers of logQuery:
  rankResults  src/example/hybrid.ts:200
```

## Key source files

- `src/tools/graph-tools.ts` — registers the `trace` MCP tool, resolves both endpoints, dispatches to `tracePath`, and renders text or JSON (`src/tools/graph-tools.ts:252-291`).
- `src/graph/trace.ts` — the engine: `tracePath` (dual BFS, intersection, tree build), `bfs`, `shortestPath` (the spine), the `CallGraph` edge view, and the `renderTrace`/`traceToJson` renderers.
- `src/db/graph.ts` — the store: `getCalleeRefsForExport`/`getCalleeRefsForLocalSymbol` (forward edges), `getCallersOfExport`/`getCallersOfLocalSymbol` (backward edges), `getCallablesByName` (endpoint resolution).
- `src/tools/index.ts` — `resolveProject`, which opens the project index before the search.
