---
name: dependency-table
useWhen: The page has non-empty dependencies or dependents but not enough to justify a diagram (<5 total edges, or one direction only).
---

## Dependencies

| Direction | Target | Why |
|-----------|--------|-----|
| imports | `<path>` | <what this page uses from it> |
| imported by | `<path>` | <what that page uses from this> |
