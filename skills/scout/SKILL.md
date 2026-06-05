---
name: scout
description: Research the web for solutions, competitors, alternatives, or prior art for a decision facing this project — then store the findings in project memory so they survive the session. Use when choosing a library or approach, comparing tools, checking what others do, or evaluating whether to build vs adopt.
---

# Scout

Goal: a sourced recommendation for a project decision — and it persists. Web research evaporates; the point of this skill is that the comparison and the *why* land in mimirs memory, so a later session recalls "we evaluated X vs Y and picked Y" instead of re-researching. Where `research` answers a question from the codebase and `deep-research` writes a generic report, scout weighs external options against *this* project and records the verdict.

1. **Frame the decision** — name what's being chosen and the constraints. Ground it in the project: `search`/`read_relevant` for what we already use (stack, existing deps, conventions) so the recommendation actually fits. A fast option that doesn't match the stack is not a real option.
2. **Search the web** — `WebSearch` for solutions, competitors, alternatives, and prior art. Cast wide first, then narrow to the serious contenders.
3. **Dig into contenders** — `WebFetch` the primary sources (docs, repos, release notes) for the specifics that decide it: features, tradeoffs, maturity, license, last release / activity, and known issues. Prefer source over summaries.
4. **Test fit** — for each contender, check it against the project from step 1: does it match the stack, the constraints, the conventions? `read_relevant` the code it would touch.
5. **Compare** — a short table: option, key tradeoffs, maturity/license, fit for this project. Pick one, with the reason.
6. **Persist** — `create_checkpoint` (type `decision`) with the comparison, the choice, and why — this is the durable record; stamp the date and the versions you checked, since web facts go stale. `annotate` a file **only** when a finding pins to specific code (a CVE on the import site, a deprecated API on the call site) — not for general option notes, which have no file to anchor to.

Finish: the recommendation with its tradeoffs and source links, and confirm it's saved as a checkpoint (with date + versions) so a future session can recall the decision. Flag findings likely to age out.
