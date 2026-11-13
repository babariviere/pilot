# Coding standards

## Simplicity

Review complexity against the requested behavior and concrete risks. Prefer existing tools and direct code.
Flag speculative abstractions, redundant validation and recovery machinery for unsupported scenarios.
Name the simpler alternative and explain why it meets the same requirements.

Use existing contracts for trusted internal data. Add defensive checks where inputs or failure modes require them,
not at every layer. Keep safeguards that protect security or user data.

Keep feature runtime checks separate from distribution, signing and release checks unless the feature actually
depends on them. Prefer a small working end-to-end path over infrastructure that leaves the requested behavior missing.
