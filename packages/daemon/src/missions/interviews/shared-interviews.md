# Shared interviews

The agent-facing `interview` tool authors complete saved question rounds. Its
interface is `read`, `questions` and `check`. Only native human actions save or
submit answers. The tool never waits inside a live invocation for a person.

## Shared module and adapters

`packages/kernel/src/missions/interview-round.ts` owns question validation, stable question
digests, exact option checks and explicit-answer completeness. Mission interviews
adapt validation errors to their existing conflict contract. Their stored fences,
agreement mapping, approvals and continuation operations stay unchanged.

`packages/kernel/src/missions/interview-tool.ts` exposes the same tool through two adapters:

- Mission planning adapts the existing admitted planning port. Its opaque expected
  token names the exact mission interview revision. `mission_plan` keeps maps,
  research, review and publication; its old question action remains compatible.
- Standalone chats bind the tool to their own durable conversation. No mission is
  created. Ask and Build use the same interview interface without changing their
  tool permissions.

Both reads return `expected`, `questions`, `answers` and `submission`. Agents copy
the opaque expected token rather than construct scope or revision identities.

## Standalone durability

Question publication atomically appends the immutable full round as
`pilot.question`, saves the latest round in `StandaloneInterviewDoc`, and holds
automatic inputs. The tool returns, and the turn ends. Both Harness tool hooks
and native nested-call checks refuse subsequent tools while the round waits.

Day uses the existing native attention transport and exact operation receipts.
It keeps round drafts in the local native journal, not daemon-shared drafts.
Recommendations remain separate from selected answers. One explicit Submit names
the question entry, current attention scope, round ID, question digests, complete
answers and exact selected option meanings.

The daemon validates the structured submission. Kernel input admission validates
it again on the mutation line. Ordinary messages, coordinator answers and partial
submissions cannot release an interview. Admission atomically saves a
`pilot.interview-submission` record with the complete questions and answers,
updates the latest-round document, and admits deterministic human-answer context.
An exact retry finds the existing input instead of running the turn again.

A worker restart keeps the saved hold and never replays a tool stack. Stop cancels
the pending admission without accepting suggestions as answers. Submission changes
neither permissions nor mission approvals. Requiring an interview at a particular
start source remains agent guidance, not a new pre-start authorization gate.

## Single questions

`ask_user` saves one ordinary question and ends the turn. It does not suspend a
live tool invocation. A human reply starts the next turn; automatic input stays
held. Historical blocking-question records remain readable for crash recovery,
but new calls never create them. Interview rounds use `interview`, not `ask_user`.

## Checks

`interview-tool.test.ts` covers the shared interface and mission adapter.
`interview-state.test.ts` covers atomic publication/submission, invalid and stale
answers, dedupe, automatic input and Stop. `interview.integration.test.ts` exercises
the real kernel, direct and nested calls, explicit submission and reopening.
`native-interview.test.ts` covers authenticated Ask/Build ingress. Native and TSX
attention tests cover saved drafts, review and exact submission.

A synthetic in-memory check measured the extra question-gate snapshot over 500
reads: p95 0.0032 ms empty and 0.0019 ms with 5,000 4-KiB entries plus streaming
writes. This isolates the added document read, not end-to-end SQLite or provider
latency. Real large-session responsiveness remains a separate acceptance check.

The shared interview declaration adds about 592 estimated toolbox tokens in the
model-rebuild fixture. Its smaller destination uses 18K rather than 16K so the
scenario still has the required 1K transcript budget after tool declarations.
Production admission still refuses a model whose remaining budget is too small.

## One interview UI

`apps/day/missions/interviews/InterviewRenderer.tsx` is the shared presentation module. It keeps the
mission form's one-question navigation, number keys, free text, See all questions,
review page and explicit Submit. It knows no mission transport or standalone
attention transport.

Its interface is a reactive `read()` plus `dispatch(command)`. The read contains
the current interview, displayed answers, save/submit state, scoped identity and
continuation wording. Commands describe user actions; adapters own persistence
and exact submission checks. Optional help and round-notes slots keep those
mission capabilities outside the shared implementation.

`InterviewDoc.tsx` adapts mission planning and keeps its existing draft saves,
proposal/revisit checks, help and planning-only continuation. `InterviewCard.tsx`
adapts standalone native attention drafts, exact structured submission and receipt
lookup. It is a wrapper around the same renderer, not another question layout.
Navigation and kept fields use scope, round and question identity. Standalone
shortcuts belong only to the active attention card.
