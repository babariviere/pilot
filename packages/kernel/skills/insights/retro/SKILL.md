---
name: retro
description: Review coding sessions for changes that help future agents.
disable-model-invocation: true
---

# /retro

Use only the current report's sampled chat excerpts as primary sources.

1. Look for observed friction an environment change would prevent. Check navigation, automated checks, reviewer guidance, extra instructions, tool cost and missing information.
2. For mechanical mistakes, favor a deterministic check over another instruction. Look for evidence of an existing check before proposing a new one. If the sample cannot show whether it exists or runs, say so. Reserve reviewer guidance for judgment calls.
3. Rank candidates by observed impact and recurrence. A concrete single event can support a low-confidence finding; do not infer repetition. Propose each supported change in the backlog with an exact citation. If evidence supports none, explain the gap in the report.
