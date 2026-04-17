---
name: cross-cutting-inventory
useWhen: The page's prefetched `crossCuttingSymbols` list has ≥1 entry — typically architecture, data-flows, and module pages that host a cross-cutting symbol.
format: Each row's "Used in" column is the comma-joined `referenceModules` list. Cap at 8 module names; if `referenceModules.length > 8`, render the first 8 then `+N more` (e.g. `db, search, cli, commands, indexing, tools, utils, wiki (+3 more)`).
---

## Cross-Cutting Symbols

Symbols referenced from 3+ modules. These are the project's shared
vocabulary — renaming or reshaping one ripples across the codebase.

| Symbol | Type | Defined in | Used in |
|--------|------|------------|---------|
| `<Name>` | <class/interface/type> | `<path>` | `<mod>`, `<mod>`, `<mod>` (+N more) |
