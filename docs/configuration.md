# Configuration

Create `.rag/config.json` in your project root, or run `bunx @winci/local-rag init` to generate one automatically.

## Options

| Option | Default | Description |
|---|---|---|
| `include` | see [Supported file types](../README.md#supported-file-types) | Glob patterns for files to index |
| `exclude` | `["node_modules/**", ...]` | Glob patterns to skip |
| `chunkSize` | `512` | Max tokens per chunk |
| `chunkOverlap` | `50` | Overlap tokens between chunks |
| `hybridWeight` | `0.7` | Blend ratio: 1.0 = vector only, 0.0 = BM25 only |
| `embeddingMerge` | `true` | Merge windowed embeddings for oversized chunks (see [below](#embedding-merge)) |
| `embeddingModel` | _(default)_ | Override the embedding model (HuggingFace model ID). Must have ONNX weights. Requires re-index |
| `embeddingDim` | _(default)_ | Embedding dimension to match the model (e.g. 384 for bge-small-en-v1.5) |
| `searchTopK` | `10` | Default number of search results |
| `incrementalChunks` | `false` | When enabled, only re-embeds chunks whose content hash changed. Falls back to full re-index if >50% of chunks differ |

## Examples

### Minimal — just markdown and TypeScript

```json
{
  "include": ["**/*.md", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules/**", ".git/**", "dist/**", ".rag/**"]
}
```

### Full-stack project

```json
{
  "include": ["**/*.md", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.py", "**/*.go", "**/*.rs"],
  "exclude": ["node_modules/**", ".git/**", "dist/**", "build/**", ".rag/**"]
}
```

### Index everything (exclude binaries explicitly)

```json
{
  "include": ["**/*"],
  "exclude": [
    "node_modules/**", ".git/**", "dist/**", "build/**", "out/**", ".rag/**",
    "**/*.lock", "**/package-lock.json", "**/*.min.js", "**/*.map",
    "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.webp", "**/*.ico", "**/*.svg",
    "**/*.pdf", "**/*.zip", "**/*.tar", "**/*.gz",
    "**/*.wasm", "**/*.bin", "**/*.exe", "**/*.dylib", "**/*.so",
    "**/*.db", "**/*.sqlite",
    "**/*.ttf", "**/*.woff", "**/*.woff2", "**/*.eot"
  ]
}
```

### Large codebase (Kubernetes-scale)

For repos with thousands of files, exclude tests and generated code to keep results focused:

```json
{
  "include": ["**/*.go", "**/*.md", "**/*.yaml"],
  "exclude": [
    "vendor/**", ".git/**", "**/*_test.go", "**/*.generated.go",
    "**/zz_generated.*", "**/testdata/**", ".rag/**"
  ],
  "searchTopK": 15
}
```

### Tuning search balance

Adjust `hybridWeight` to shift between semantic and keyword matching:

```json
{
  "hybridWeight": 0.5
}
```

- `1.0` = pure vector (semantic only) — better for natural-language questions
- `0.0` = pure BM25 (keyword only) — better for exact symbol/term lookups
- `0.7` (default) — works well for most codebases

## Environment variables

| Variable | Description |
|---|---|
| `RAG_PROJECT_DIR` | Override the project directory (useful for editors like Cursor/Windsurf that don't set cwd) |
| `RAG_DB_DIR` | Redirect the `.rag/` index to a different path (useful for read-only project directories) |

## Embedding merge

The default embedding model (all-MiniLM-L6-v2) has a hard 256-token sequence limit. Input beyond that is silently truncated. AST-aware chunking preserves whole functions, and ~23% of those exceed 256 tokens.

When `embeddingMerge` is enabled (default), oversized chunks are split into overlapping 256-token windows, embedded separately, then averaged and L2-normalized into a single embedding. The chunk text stays intact — only the vector changes. This recovers ~45% of content that would otherwise be lost from the embedding, with zero query-time overhead.
