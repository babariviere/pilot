# Coding standards

## Simplicity

Review complexity against the requested behavior and concrete risks. Prefer existing tools and direct code.
Flag speculative abstractions, redundant validation and recovery machinery for unsupported scenarios.
Name the simpler alternative and explain why it meets the same requirements.

Use existing contracts for trusted internal data. Add defensive checks where inputs or failure modes require them,
not at every layer. Keep safeguards that protect security or user data.

Keep feature runtime checks separate from distribution, signing and release checks unless the feature actually
depends on them. Prefer a small working end-to-end path over infrastructure that leaves the requested behavior missing.

## Limits

Add a limit (a count, a size or a time) only for a cost you can name: disk, memory, daemon or UI blocking, model
tokens, or abuse. Next to it, say what it protects and how you chose the number, from a measurement or a real
case. Do not copy a number from another feature. A refusal names the limit, the value it got and what to change:
"the map holds at most 40 questions and this save has 42", not "Invalid planning list". Check that long-lived
data (a mission, a chat, a history) cannot grow into the limit with no way out, such as items that must be kept.
