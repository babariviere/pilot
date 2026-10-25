# Composer model and thinking selection

## Scope and interaction

The composer's two quiet native Select controls answer which model and supported
thinking level this chat/draft will use. They share the existing controls row, semantic
colors and retained native input, preserving the 76 pt empty tray / 34 pt editor.
Search accepts model name or exact provider-qualified ID. Popup rows name the model and
show its provider-qualified ID, with native checked state, keyboard navigation, Escape
and focus return. Refresh is a secondary menu choice, not another permanent toolbar.
Errors and retained uncertainty stay visible beside explicit recovery actions.

The existing chat's actual model/thinking remains visible when no longer in scope;
it is not replaced by the first catalog entry. Fixed levels are marked fixed and
disabled; unreported/unsupported levels do not become invented choices. Selecting
the already-checked model does nothing. A different model omits `thinking`, so the
server selects that new model's scoped/per-model default. Explicit thinking choices
must be reported for the same current model and require at least two supported levels.

For new drafts, Project/pi default omits both overrides. Explicit model/thinking choices
are saved privately with the exact project ID and canonical path. A changed project/path
retains the old choice as unavailable until the user explicitly chooses for the new
scope, not a guessed path or silent default. A scoped-catalog failure/removal disables
Create for an explicit choice; recovery is derived from current data, not a latched input
error. Scope refresh never changes the native message, permission, draft source or reader.

## Audited contracts and authority

Audited Swift ChatModelPicker/ChatThinkingPicker, Composer/HomeView, protocol ModelList/
SpawnRequest/ChangeModelRequest, daemon model route/catalog and Sessions.changeModel.
The actual model response is SessionSummary, despite an older protocol comment naming
ChangeModelResponse. No new endpoint, backend change, permission or capability is added.

- Read only `GET /api/models?cwd=<exact canonical directory>`, plus pinned Local hello
  and selected-chat GET. No cwd-less, unscoped or remote fallback. Project overrides and
  global enabledModels remain daemon/pi authority.
- Existing changes use exactly one explicit `POST /api/sessions/:id/model` with `model`
  and optional supported `thinking`. Fresh selected-chat identity/directory/model/state
  and scoped-catalog preflight precede durable private admission. The daemon's atomic
  idle/no-queued-work guard remains authoritative. The existing endpoint has no CAS;
  preflight is not misrepresented as an atomic model-version condition.
- Continued, archived, diagnostic, Control, failed, paused, running/queued, private-write
  fenced, pending-delivery and marked-input contexts do not admit a selection. Subscription
  continuation is unavailable here: no continue-model, replacement chat or message/start.
- A successful, matching SessionSummary acknowledges the model change. Lost, malformed
  or rejected responses after attempted delivery retain the exact immutable choice in a
  bounded Unknown journal. No automatic retry, restart replay or GET-as-receipt inference.
  Explicit Inspect reads current metadata only. Separate two-step local acknowledgment
  verifies the exact source with another GET and removes only the matching attempt, without
  POST or claiming the original switch did not happen.
- New choices affect only a subsequently explicit new chat-create payload. Omitted/default
  choices keep the previous payload shape. Retained legacy payload strings, hashes, IDs,
  revisions and destinations are never reconstructed from current UI choices on retry.

The existing private interaction worker serializes model actions with delivery and draft
writes. Unknown model switches fence Send and further model changes for that chat, not
Stop. A known acknowledgment remains in memory if private receipt cleanup fails, while
the private I/O fence prevents further writes. Optional new fields load older private
records without migration; older binaries deny unknown fields rather than dropping new
uncertainty. No Swift state, sign-in, credential file or global/default model is written.

## Ownership and limits

- Retained Select/InputState entities belong to ChatEditor, not render callbacks.
  Context + widget epochs reject stale model/thinking callbacks, including navigating away
  and back. Native queries/preedit defer catalog application without losing message input.
  Metadata/read generations fence older responses and model acknowledgments are handled
  once, not replayed by later autosave publications.
- One lazy catalog-reader thread/runtime, one coalesced request and one result slot.
  No proxy, redirect or retry. Two-second connect and five-second read deadlines; all I/O,
  JSON decode and catalog search-key preparation are off the UI thread.
- At most 2,048 unique qualified models, 16 unique reported levels per model, bounded
  IDs/names/levels, 2 MiB predecode body cap including chunked responses. Search matching
  is bounded to 256 query bytes. No per-row entities, polling or added animation clock.
- Up to 32 durable unconfirmed model attempts. No Unknown eviction/overwrite. Original
  delivery ownership prevents a competing model admission. Pending/created draft edits
  retain their original model choice and operation envelope.

## Scoped verification plan and limits

D46 uses only relevant targets. `chat_models::` covers catalog/qualified IDs, supported
levels, actual model-only default, scope/idle/pause/stale/identity refusal, lost/403/409
outcomes, restart/no replay, inspect/local acknowledgment, exact encoded cwd and malformed/
oversized/chunked bounds with owned synthetic HTTP. Private-store tests cover the changed
prepare/save-edits boundary, bounded Unknown journal and byte-identical legacy envelopes.
Picker unit tests cover old widget/context callbacks, actual choice semantics, busy/read-only/
pending/IME guards, query deferral, per-project draft choices and native input retention.
Existing editor unit tests cover affected Send/Stop, capture and draft guards.

The existing `project_creation` native executable additionally runs four actual LocalViewer/
composer model cases at 680/1100 logical pixels in asserted light/dark. It retains its eight
affected project-creation regressions. The model cases exercise actual pointer/keyboard
menus, measured tray/editor/contained popup bounds, supported thinking, preedit, scope
invalidation, unknown/no resend/explicit recovery, native text/selection and reader anchors,
then new-project model/thinking choices, scope removal/recovery and private restart, with no
model/create POST from draft selection. Owned readers/writers are drained before cleanup.

This is synthetic/offscreen GPUI evidence, not OS IME/AX, visible motion, performance,
Wayland, full Swift parity or release/user-acceptance proof. No production authorization,
model change, real create/send/Stop, daemon/profile mutation or service action is used.
Initial syntax/trait and deterministic-test scheduler failures remain failed receipts.
Real-thread I/O belongs to the headless native/transport fixtures; deterministic GPUI unit
tests inject an owned recording mailbox rather than suppressing scheduler assertions.

## Verification receipt

Final source `b9f8d104e28907feb1af4d48657b9c448ec3a7a3`, tree
`dc94a886c4c2ae9c9b31b406a218f4e4f574a731`, based on
`e81833c39015eaa57009938162ebdb176f28ab7b`. Normal shared serial Rust admission,
owned bounded process watchdogs, identical 26-input PRE/POST snapshot and diff digest
`59898cfe8a7f89538bbf015ce0162a01fa63b58149b530fe338e2f6c3a4ca5ae`.

- `a525a366-7ff4-4079-aef8-ebc4ca0152f7`, EXIT 0: strict Clippy only
  `--features native-probes --lib --test project_creation`; seven model pure/transport
  tests and six picker tests; all eight existing project-creation and four new model
  native cases. No full-wrapper/all-native/all-target sweep. Empty-catalog visibility,
  retained selection and recovery also exercised in the real root, with explicit pure
  2,049-model / 17-level / duplicate-level refusal assertions.
- Reused `4cdac895-9a19-4f96-96b3-6052b69afe78`, EXIT 0, frozen source
  `1685c7f4b35ae8b77acb3cea3e74a8f3548dce38`: 22 private-store tests passed, two
  existing ignored, nine editor input/SendStop tests passed. Their implementation/test
  and interaction-writer files remain byte-identical. The five earlier picker cases and
  single eligibility case also passed there, but the current picker/core claims above
  use the final source rerun, not stale receipts.
- `8be55a32-1dce-4654-8392-5b51dc446285` failed after all 12 native cases passed
  on one collapsible-if Clippy warning. It was corrected without weakening lint or
  assertions. `0d6472bb-26f6-41d8-b7c1-1d9661d578d1` then passed matching lint,
  seven core/five picker and all 12 native cases, before explicit empty-state coverage.
  Earlier syntax/compile/scheduler failures are retained, not counted as passes.

Actual screenshots in `/tmp/models104-final9` were captured only from owned synthetic
data, with the production appearance preference pinned and asserted for each theme.
Inspected light normal/empty and light/dark new-draft frames plus dark uncertain state;
four updated comparison artifacts and an empty-state artifact are attached to the task.
These are actual offscreen GPUI frames, not SwiftUI/web mockups. PNG filenames are not
theme proof. Existing native source IDs/menu bounds and 76/34 geometry are asserted.

This receipt is the only post-check document change; executable source, tests, dependency
and wrapper inputs are unchanged. It does not claim release acceptance, OS IME/AX,
visible animation smoothness, Linux or a measured performance improvement.
