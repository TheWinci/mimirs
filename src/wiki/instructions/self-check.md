Source-first self-check:

1. For every paragraph, ask whether it explains code behavior or only repeats discovery text. Rewrite repeated discovery text from source.
2. For every `mustCover` item, confirm the page answers: what is it, where does it happen, why does it matter, and what source proves it?
3. For every input, output, state change, failure case, and example, confirm it matches source behavior and not an assumption.
4. If a section feels compact or dry, do not add filler. Reopen the relevant source and add the missing why, data movement, branch, state change, or user-visible result.
5. Scan the whole page for pipeline vocabulary: the words `mustCover`, `discovery`, `packet`, `flowId`, and any `flow-...` slug. If any appears, rewrite that sentence to state the behavior or link plainly. None of these may reach the reader.
6. Confirm every section heading matches what the body and the source actually deliver. Do not promise `ranked`, `line ranges`, `annotations`, or any field the code does not produce; rename the heading to match reality.
