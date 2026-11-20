---
name: retro
description: Review coding sessions for changes that help future agents.
disable-model-invocation: true
---

# /retro

Use the current report's sampled chats as primary sources. Start with user
corrections and failed actions. Use nearby replies to understand the attempted
work and outcome. Gaps in a sample do not show that a failure never happened.

1. Compare chats for the same cause of a correction, failure or workaround.
   Cite each supporting chat and separate the observed pattern from your
   explanation. Related symptoms alone do not prove a shared cause.
2. Propose a concrete change and how to check it. Consider navigation,
   automated checks, reviewer guidance, unnecessary instructions, tool
   cost and missing information. Prefer a deterministic check for a
   mechanical mistake. If you cannot tell whether a check exists or runs,
   say so instead of assuming it is absent.
3. Use `sessionCost` as a partial catalog estimate of the chat's kept usage,
   not a bill or the cost of an individual action. Keep direct requests and
   child work separate. A missing estimate is unknown. Link a cost proposal
   to an observed behavior and say how to verify savings.
4. Rank candidates by observed impact and recurrence. A concrete single
   event can support a low-confidence finding. Save each supported change
   with an exact citation. For a proposed PR, make one finding per selected
   target project. Put its ID in the single `targets` entry. Name the change
   and the check that would verify it. A finding is a draft, not a PR or
   permission to open one. If no proposal is supported, name the evidence gap.
