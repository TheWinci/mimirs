---
name: dependency-graph
useWhen: The page has both upstream and downstream edges (dependencies AND dependents), or ≥5 total edges worth visualising. Skip for leaf files with 0-1 edges.
---

## Dependencies and Dependents

```mermaid
flowchart LR
  subgraph Upstream[Depends On]
    <upstream_a[upstream name]>
    <upstream_b[upstream name]>
  end
  self[<This Page>]
  subgraph Downstream[Depended On By]
    <downstream_a[downstream name]>
    <downstream_b[downstream name]>
  end

  upstream_a --> self
  upstream_b --> self
  self --> downstream_a
  self --> downstream_b
```

- **Depends on:** <short list, linked to wiki pages where they exist>
- **Depended on by:** <short list, linked where pages exist>
