# Diagnostic repair

A diagnostics chat (Help → Ask about Pilot) stays a read-only specialist. Its
repair row sits above the composer and is driven only by pilotd's session
summary: the persisted `role: "diagnostics"`, its admitted subject
(`diagnosticScope`/`diagnosticHost` or `diagnosticTarget`) and the structured
`diagnosticRepairProposal`. Transcript text never grants a role, a proposal or a
repair. Code: [diagnostic_repair.rs](../src/diagnostic_repair.rs) (model,
transport, retained start) and [diagnostic_repair_view.rs](../src/diagnostic_repair_view.rs).

## Flow

1. **Suggest a repair** (no proposal yet). Sends Swift's fixed request through the
   chat's own composer delivery as a queued follow-up, so it has the ordinary
   immutable operation, receipt and Unknown recovery. It is offered only when the
   composer is empty, nothing is pending and no question or preedit is open; typed
   text is never replaced. The request asks for a proposal and grants nothing.
2. **Proposal row.** Title and uncertainty, with **Review repair**. A malformed
   proposal says it can't be read; a chat without verified subject identity, or
   with another daemon/lineage, says why and offers nothing.
3. **Review** (disclosure above the composer, bounded scroll). Reads, off the UI
   thread: `POST /api/sessions/:id/diagnostics/handoff` with the proposal exactly as
   published and the subject's host query (pilotd's read-only validation of the
   proposal and its cited evidence), and `GET /api/diagnostics/repair-project`.
   Shows findings, suggested repair, regression test, cited evidence, the
   configured repair project and its scoped models (`GET /api/models?cwd=` for the
   project path). **Copy proposal** copies the readable (or edited) text.
   **Edit** turns the title, findings, uncertainty, suggested repair and regression
   test into fields, bounded as pilotd bounds them; **Revert** returns to the
   specialist's text. The published proposal never changes. **Model** offers the
   project default or a catalog model, and its thinking levels.
4. **Repair project setup**, only when missing/unavailable. Registered projects
   whose local Git origin is the Pilot source (`GET /api/projects/:id/origin`,
   first 32 projects) are offered; **Use** sends one CAS
   `PUT /api/diagnostics/repair-project` for the subject's host and then reads the
   status again, so a lost reply resolves from current state. Invalid settings are
   reported and kept. Setup sets a destination only.
5. **Start repair** (explicit). Edited text is first reviewed again by the
   handoff endpoint (pilotd validates and sanitizes it); Start continues only if
   that review succeeds for the same text, and an open IME composition is never
   captured. Builds the exact `SpawnRequest` (Build, private clone, configured
   project, pilotd's reviewed title, exact subject and binding, explicit
   `readDiagnostics` choice, reviewed handoff as context, the chosen model and
   thinking only when not the default, no path overrides). The writer rechecks the chat still carries this proposal,
   saves one immutable `repair-create` operation in private state, then POSTs it
   once with the native capability. Draft autosave continues during the request
   (`DeliveryOwner.effect`); Close leaves it unconfirmed.
6. **Check repair start.** An unconfirmed or pending start replaces every other
   action. Check looks up its receipt; only if Local has no record does it send the
   same bytes again (idempotent by operation ID). A second start for the same chat
   is refused while one is open, and pilotd refuses a second start per proposal.
   An accepted start shows **Open repair chat**. No check or send runs on open.

The diagnostics chat is not archived or changed. Receipts are adopted only when
operation ID, payload hash, target and destination echo exactly; anything else
stays Unknown.

## Known limits

- Edits live in the open review only. They are not saved as a draft, so quitting
  or switching chats discards them (as Swift's review sheet does).
- A daemon `Conflict` during admission can leave the receipt pending; the
  writer preflight narrows, not removes, that race.
- Hidden native probes cover layout, actions and payloads with synthetic data.
  No real diagnosis, setup or repair was run.

## Checks

```sh
cd apps/desktop
bash scripts/cargo.sh test --locked --lib diagnostic_repair
bash scripts/cargo.sh test --locked --features native-probes --test diagnostic_repair
```
