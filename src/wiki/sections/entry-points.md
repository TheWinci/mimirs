---
name: entry-points
useWhen: The page's prefetched `entryPoints` list has ≥1 entry AND the entries are genuine runtime entry points (not README.md, test fixtures, or benchmark scripts). Filter manually when the list is noisy.
---

## Entry Points

| File | What it exports |
|------|-----------------|
| `<path>` | <short summary of the surface> |

<One-sentence prose per entry point: where it's invoked from (CLI? test
harness? library consumer?). Skip entries that are not runtime entry points
even if they appear in the prefetched list.>
