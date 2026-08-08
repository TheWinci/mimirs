<div align="center">

<img src="https://raw.githubusercontent.com/TheWinci/mimirs/e30e4b62385b827b953c00a4a283b787707018cc/mimirs-logo-2.png" width="200" alt="mimirs">

# mimirs

**Local-first RAG with persistent project memory for AI coding agents.**

</div>

---


## Why the name

In Norse myth, Odin preserved the head of Mímir and consulted it for
counsel long after Mímir died. Knowledge that outlives the moment, and
answers when asked.

That is the idea. An agent should not rediscover your codebase every
session.

## Mission

Coding agents burn most of their budget re-reading files they have
already read. `mimirs` gives them a durable, local index of a project —
semantic search over AST-aware chunks (tree-sitter), plus memory that
persists across sessions.

Everything runs on your machine. No API keys, no code leaves the repo.

## Status

`2.0.0-alpha.0` is an early Rust rewrite and is not usable yet.

The stable release is the TypeScript implementation on npm:

```sh
npm install -g mimirs
```

## License

Apache-2.0