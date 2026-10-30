# Draft autosaves during child-message sends

## Audited boundary

The existing subagent `WriteCommand::Submit` branch used a separate adapter that
borrowed the private Store across hello, parent/generation preflight and the
one-shot messages POST. The new production-writer regression first failed waiting
for newer durable draft bytes while the faux POST remained held. The established
`DeliveryOwner::effect` already services the same edit mailbox during other sends.

Child sends now use that owner too. The existing preflight and request encoder are
unchanged; the request effect borrows no Store. The sole writer saves newer text
using its existing debounce/ceiling and atomic snapshot path. It flushes preflight
edits before reserving the captured intent, refuses admission after a disk fault,
and retains the original one-shot target, message, mode and request ID. No second
writer, new queue, receipt framework or additional send policy is introduced.
Commands, including Check and checkpoints, remain FIFO behind the held effect.
Close cancels the owned wait, flushes remaining edits and releases Store before
the update lane disconnects. A response arriving later cannot settle a reopened
Store. None of this proves a request was cancelled at the daemon.

## Preserved limits and recovery

- The draft/journal identity includes exact parent ID, child name and spawn
  fingerprint. Preflight checks the reported generation and retirement state.
  The existing POST addresses parent/name only, not a server-side generation CAS.
  An intervening child replacement remains an existing adapter limitation.
- The unchanged ACK is HTTP202 with `{ok:true}`. It does not echo the captured
  request ID, generation, immutable payload or a durability receipt. Tests bind
  observation to the actual captured request, not an invented response envelope.
- Lost, refused, malformed or nonconfirming ACK stays Unknown. No automatic or
  explicit retry or receipt lookup is added. Internal Check can only retain that
  uncertainty or finish local cleanup from the exact in-memory accepted report.
  The child recovery UI still offers copy/discard, not Check/Send again or a new
  Inspect/local-ACK workflow. There is no separate subagent Inspect HTTP adapter.
- An accepted ACK survives a failed private cleanup in the existing volatile
  report. That report is not restart-durable proof. Reopening trusts only the
  validated private snapshot and never replays the child message.
- Child drafts cannot own question replies. Fixtures seed real parent Q&A,
  ReplyIdentity, configuration and immutable answer Pending separately, and edit
  them while a child wait is held. Existing Pending freezes reply/config metadata,
  not ordinary text. Parent questions, model controls and Stop do not leak into
  the child. Existing child conversation/history access remains in the composer;
  actual subagent sidebar rows stay intentionally hidden.

No backend/kernel/protocol, child authority, navigation, project/mission adapter,
provider, service or installed-app change is part of this slice.

## Focused verification

`interaction_subagent_tests.rs` uses the production worker, owned loopback gates
and UUID temporary durable snapshots. It covers held hello/parent/POST, success,
generation/Pending refusal, lost/malformed/nonconfirming ACK, exact request bytes,
parent answer/config freeze, FIFO checkpoints, no replay, disk faults, Close and
immediate reopen with a late response. Existing subagent transport coverage
retains retired-child refusal and lost-ACK restart behavior.

`subagent_wait_probe.rs` mounts the real ChatEditor and writer in hidden
680/1100pt light/dark scenes. It edits through native input while POST is held,
checks actual disk bytes before release, compares the textarea with `shown_text`,
and checks synthetic preedit/focus and same-name/different-generation selection
across the late result. Existing Stop/model/subscription wait probes remain in
the same `composer_controls` target. There is no presentation redesign.

Serial commands, pinned Rust1.98.1/mbx1.26, CPU2/4GiB admission and private target:

```sh
python3 apps/desktop/scripts/check-scoped.py --unit interaction::tests --test composer_controls --lint
python3 apps/desktop/scripts/check-scoped.py --unit interaction::subagent_tests --native-probes
python3 apps/desktop/scripts/check-scoped.py --unit delivery_store::tests --native-probes
python3 apps/desktop/scripts/check-scoped.py --test session_subagents
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-desktop
```

Observed on macOS arm64: 90 Interaction passes (one existing opt-in workload
ignored), one child transport pass, 39 Store passes (two existing opt-in workloads
ignored), and four existing child-conversation/history scenes. The mounted
composer passed all eight child-wait scenes plus eight Stop, 16 model and
16 subscription wait scenes. Matching scoped production/native Clippy, pinned
changed-file rustfmt, whitespace/link checks and the plain locked build passed.
The first complete mounted run observed child edit-to-durable times of
287.3–290.6ms before HTTP release, single-run synthetic observations only.
The final source adjustment was rustfmt's test-module ordering, followed by
another focused child/composer/lint and locked-build pass. Checks ran serially
with the pinned admission above; disk checks observed at least90GiB free before
the final batch. The existing `block 0.1.6` future-incompatibility warning remains.

These are isolated transport/writer and mounted native regressions, not live
subagent sends, provider latency, OS IME, Wayland, complete app-close/Quit/crash/
power-loss qualification, production rollout or product acceptance. Edit timing
includes temporary disk and frame pumping, not a live latency guarantee.
