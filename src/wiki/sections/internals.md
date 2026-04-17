---
name: internals
useWhen: Module page at full depth with ≥10 files OR ≥15 exports, AND the prefetched overview reveals distinct internal layers worth describing. Skip when per-file-breakdown already covers the structure.
---

## Internals

<Describe the internal organization — not a file list, but the layers,
boundaries, and invariants. Name the split: "storage → query → ranking",
"parser / resolver / emitter", etc. Call out any non-obvious invariants
(e.g. "every writer holds a checkpoint; readers never block writers").>

### <Layer or internal concept>

<Short paragraph. Cite the file where the boundary lives.>

### <Another layer>

<Short paragraph.>
