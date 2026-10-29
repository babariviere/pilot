# Structured question replies

The Local composer renders ordinary `ask_user` entries as real single-choice
radio groups or multiple-choice checkboxes, with suggested answers, details and
a separate own-words field. Selection alone never sends. Reply or Return in that
field explicitly confirms. Shift-Return keeps a newline. Kit owns native
Tab/Space behavior. Its radio group supplies semantics only; the app owns one
scoped single-choice keyboard stop. Arrows change selection; group Space/Enter
select but never send. No global digit or letter shortcuts are installed.

The existing ordinary message entity and private draft remain separate. Replying
cannot clear or settle that message's revision. An unsent reply to a replaced
question must be kept in private recovery before editing the next reply.
Unknown deliveries keep their original envelope; restart never looks up or
executes automatically. Check cannot execute. Explicit Retry retains the exact
operation, destination, target, hash, payload and question-purpose metadata.
Accepted replies stay guarded until canonical metadata says that question has
gone away, rather than enabling a duplicate confirmation.

## Contract and authority

Swift's `AgentQuestion.reply` formats the selected labels in source order,
bullets for multiple answers, then trimmed own words. The existing daemon
contract receives this as an ordinary `chat-send` steering message. There is
**no atomic question-CAS endpoint**. The UI checks the current selected Local
chat, pinned source generation, full question identity, permission, snapshot,
prefix, queue, run and summary state before confirming. The worker rechecks
Local identity, target eligibility and turn state before admission/retry.
These checks do not claim atomic server-side question settlement.

Database-access questions use a different grant/request authority. They are
explicitly unavailable here, with no generic allow/deny/message fallback.
Use the current macOS app for those decisions. No backend, permissions or host
capabilities are expanded.

`pi.compaction` user-role summaries do not answer a question. Later actual
user input, including automatic input, does. Background jobs alone do not hide
a question; a live turn or queued input does. Malformed identity/question
metadata fails closed. The parser deliberately mirrors Foundation reply
whitespace, including U+200B and U+0085 but not U+FEFF.

An awaited ask (`blocking: true`) is the exception to hiding during a live
turn: its run waits for the reply, so it presents and accepts a reply while that
run works, with Stop beside it. The reply is still an ordinary steering message
and its user entry closes the question. Absent or false is the legacy
turn-ending ask; a malformed marker is invalid; access requests never await a
message. The marker is part of the question identity, while legacy identities
are unchanged. After its run ends, the ask reads like a legacy question and a
later run never presents it again. Explicit Retry of an Unknown reply accepts a
working turn only with the exact fresh awaited question it answered, so a lost
first reply cannot answer a newer question.

## Ownership, bounds and recovery

- `question.rs`: bounded typed metadata, exact entry ID plus canonical-content
  SHA-256, two canonical markers, Foundation trimming and reply formatting.
- `local_model.rs`: snapshot/prefix/run/user boundaries, head-qualified history
  restoration and metadata observed even when visual row admission is full.
- `local_client.rs`: one coalesced, fenced question projection.
- `local_view.rs`: one final source-scoped composer sync beside activity.
- `chat_questions.rs` and `chat_editor.rs`: retained input/focus owner,
  source-scoped controls, preedit/unsaved deferral and explicit confirmation.
- `delivery_store.rs` and `interaction.rs`: optional legacy-default purpose
  and reply draft in the existing private Book, unchanged immutable operations,
  ordinary-draft-independent adoption and revision-fenced private recovery.

One admitted question is at most 20 KiB, with conservative 300/600/120/240
UTF-16 admission bounds and at most nine choices. Oversized/legacy metadata
is explicitly unavailable, never silently truncated. The UI retains only current and
coalesced deferred question handles, one reply input, and a bounded 280pt
question scroll region. Own words/reply admission stays at 32 KiB. Saved reply
drafts retain only identity, selection, bounded captured labels and exact own
words, not full question source. Existing 32 pending, 128 draft, eight recovery
entries per draft and 16 MiB private snapshot bounds remain unchanged.

No worker, filesystem/network access, timer or provider work is added to render.
Ordinary Discard keeps its published behavior, but refuses separate saved,
pending, live or composing question input. It neither captures that reply nor
changes its original operation identity. No question-discard workflow is added.
Question state does not change the transcript's reading anchor. Preedit or
unsaved input defers context replacement. Unmark without a Change event leaves
a guarded Show current question action. Copy/recovery preserves original text;
unsupported or uncertain state is never labelled accepted.

## Scoped verification

`scripts/check-scoped.py --unit question --test questions --native-probes --lint`
covers this feature's pure/reducer/private-store/faux-courier/mounted cases and
four actual offscreen native 680/1100 light/dark cases. The native target has
no LocalOptions or real worker; it uses an isolated temporary private Book and
command recorder. Set `PILOT_NEXT_QUESTIONS_DIR` for synthetic captures.

See [evidence](../evidence/questions.md) for exact sources and results.
Offscreen GPUI evidence does not establish OS IME/accessibility, visible motion,
performance, Linux/Wayland, full Swift parity or user acceptance. Existing
ordinary Follow-up/Stop controls are unchanged; their separately requested
rework is not part of this feature.
