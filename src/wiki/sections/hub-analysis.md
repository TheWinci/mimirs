---
name: hub-analysis
useWhen: The page's prefetched `hubs` list has ≥1 entry. Architecture and full-depth module pages are the common hosts.
---

## Hubs

Files that many others depend on — changes here ripple widely.

| File | Fan-in | Fan-out | What it exposes |
|------|--------|---------|-----------------|
| `<path>` | <n> | <n> | <bridges list or short summary> |

<Optional prose: call out the top-1 hub and why it matters architecturally
(entry point? shared type surface? orchestrator?).>
