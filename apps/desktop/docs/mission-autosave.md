# Draft autosaves during chat conversion

## Boundary and preserved behavior

The conversion `WriteCommand::Mission` adapter borrowed the private Store across
hello, exact source/project admission, its one-shot POST and inspection reads.
The seeded production-writer regression failed on the original owner while
waiting for newer draft bytes to become durable before held faux HTTP release.

Conversion now uses the established `DeliveryOwner::effect` seam. Admission,
request/response HTTP and membership inspection borrow no Store. The same sole
writer services the existing edit mailbox and debounce/ceiling, prepares the
captured attempt locally, and records a validated response locally. No second
writer, new executor, operation envelope, retry or conversion policy is added.
Mutation commands and checkpoints remain FIFO. Close interrupts the owned wait,
flushes edits and releases Store before its update lane disconnects. This does
not prove the remote request was cancelled.

- The captured source, project, generation, attempt ID, title/goal and explicit
  coordinator/drafting choices are unchanged. Edits and a later selected chat
  cannot replace the captured request or retarget its reply.
- The existing guarded-conversion capability, hello identity, writable ordinary
  unlinked source, project admission and private intent journal remain required.
  Unknown is recorded before the sole POST. Unsafe-contract refusals remain.
- HTTP201 with a valid mission ID and matching project is the existing ACK.
  It does not echo the attempt UUID, source or immutable request bytes; it is
  not mutation CAS, a client receipt lookup, or proof of drafting delivery.
  Tests compare the actual POST bytes, not an invented response envelope.
- Lost, malformed, mismatched and all non-201 responses stay Unknown. Inspection
  reads current membership only. GET/title/association never proves that the
  original request created a mission, and absence never authorizes resubmission.
- A known accepted ID survives private receipt-write failure in the existing
  source/project/attempt-qualified volatile evidence. The writer still reports
  the disk fault. This is not restart-durable evidence. Conversion has no separate
  user local-acknowledgment/retirement command; this slice adds none.
- Independent question answers and Pending configuration remain frozen while
  ordinary text stays editable. Draft identity, conversion target ownership,
  exact late-result fences and existing form behavior are unchanged.

Task/phase writes, standalone mission creation, project registration/default
model, backend/kernel/protocol and mission authority are outside this change.

## Verification scope

`interaction_mission_tests.rs` exercises the production writer with seeded
source draft/configuration and an independent answer Pending. Owned held faux
hello/source/project/POST and inspection responses check actual disk text before
release, immutable intent and request bytes, success/refusal/lost/malformed/
mismatched ACK, no replay, FIFO, disk-fault accepted evidence, Close and immediate
reopen. Existing transport and mounted conversion-form regressions remain
separate coverage of admission, choices, source fences and receipt access.

`mission_wait_probe.rs` mounts the real ChatEditor and writer in hidden
680/1100pt light/dark scenes, for accepted and lost responses. It edits ordinary
drafts through native input while conversion is held, checks disk bytes and
`shown_text`, synthetic preedit, focus, bounds and a late target switch. There
is no presentation redesign. Existing conversion/native-owner probes are rerun.

Checks use pinned Rust1.98.1/mbx1.26, serial CPU2/4GiB admission, private targets
and synthetic temporary state. Results and exact delivered source are recorded
with the task, not inferred from these test descriptions. No live conversions,
providers, installed apps/daemon/services or Swift builds are used. These checks
do not qualify product acceptance, OS IME, Wayland, live latency, crash/power-loss
durability or complete app-close/Quit behavior.

Scoped commands (run serially):

```sh
python3 apps/desktop/scripts/check-scoped.py --unit interaction::tests --test composer_controls --test mission --lint
python3 apps/desktop/scripts/check-scoped.py --unit mission_transport --native-probes
python3 apps/desktop/scripts/check-scoped.py --unit delivery_store::tests --native-probes
python3 apps/desktop/scripts/check-scoped.py --unit mission_view::tests --test chat_actions
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-desktop
```

Observed on macOS arm64: 95 Interaction passes (one existing opt-in workload
ignored), nine transport passes, 39 Store passes (two existing opt-in workloads
ignored), nine form passes, all eight new conversion-wait scenes and the 20
existing full-view conversion scenes. The existing composer owner-wait and
chat-action native regressions also passed. Matching scoped production/native
Clippy, changed-file rustfmt, documentation links, whitespace and the plain locked
build passed. Checks ran serially with at least87GiB observed free disk. The
existing `block 0.1.6` future-incompatibility warning remains.

The first negative-control build was discarded because fixture input changed
during compilation, not counted as test evidence. The frozen original-owner
rerun failed waiting for durable draft publication while HTTP was held. The
fixed-source five-test writer census then passed, followed by the broader checks
above. No source files changed during those final checks.
