---
name: large-doc
description: A large document that should be chunked
type: reference
---

## Section One

This is the first section of a large document. It contains enough text to require chunking when the chunk size is set low enough. We need to ensure that the chunking algorithm correctly splits on heading boundaries and that overlap is applied properly between chunks.

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

## Section Two

The second section covers different topics entirely. This helps verify that semantic search can distinguish between sections within the same document. Vector similarity should rank the correct section higher when queried.

Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium.

## Section Three

The third and final section wraps things up. It discusses conclusions and next steps. This section is deliberately shorter to test that the chunker handles varying section lengths correctly.

## Section Four

Another section with technical content about databases and SQL queries. This section mentions SQLite, vector search, and embedding models to provide distinct semantic content for testing search relevance.

## Section Five

The final section about deployment and infrastructure. Covers Docker containers, CI/CD pipelines, and monitoring. This diverse content helps test that search correctly differentiates between topics.
