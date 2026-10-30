# Draft autosaves during Stop

The current-source audit found Stop still routed through the older `submit`
adapter, borrowing the sole private Store throughout hello, target preflight
and the Stop POST. The newer ordinary Send/answer/recovery owner and catalog-only
effect had not changed that path. The Store-before-update-lane teardown repair
was already present and is retained, not reimplemented.

## Ownership change

Parent-chat Stop now uses `DeliveryOwner::submit` and its existing `effect` loop.
Preflight and the immutable one-shot Stop request do not borrow Store. While
HTTP waits, the same writer services the bounded edit mailbox and existing
250 ms idle / 1 s ceiling autosave schedule. Other commands, including another
Stop, Send and Checkpoint, remain FIFO. Close still cancels the effect, flushes
latest edits and releases Store before the update lane disconnects.

The original target, UI request generation, reservation and JSON body `{}` are
unchanged. Stop has **no operation receipt envelope**. Its persisted intent is
Unknown until the original response is accepted. Existing accepted-status/JSON
validation is unchanged; lost/refused/malformed replies stay Unknown, with no
automatic replay. Check/Retry cannot retry Stop. Withdrawn text stays separate
from newer typing. An unresolved ordinary Send or question reply still refuses
Stop without replacing that original immutable envelope or Pending/Unknown state.

`Store::save_edits` is unchanged. Ordinary text revisions can save while a
delivery is pending, but existing answer/config metadata stays frozen. Completion
of Stop neither consumes the ordinary composer text nor submits its question
answer. No model/project/mission/subagent adapter, backend, protocol, lifecycle,
timer or executor change is included.

## Regression and verification

`interaction_stop_tests.rs` uses the production Interaction worker, seeded
existing Q&A/project/cwd/model metadata, UUID temporary storage and gated faux
HTTP. The first test failed against the old production source: with the Stop
response held, the autosave publication timed out after five seconds, before
response release. This was a real regression failure, not a compilation failure.
An earlier build was discarded after test-source edits overlapped compilation;
the frozen-source rerun produced that failing assertion.

The fixed tests observe and deserialize actual durable `state-v1.json` bytes
**before** releasing HTTP. They cover hello/target/Stop waits, accepted/lost/
refused/malformed responses, immutable original intent, metadata freeze, another
draft, FIFO mutation/checkpoint order, generation deduplication, Close and late
response isolation, immediate Store reopen, and existing Send/answer Pending/
Unknown refusal. No second writer opens the locked Store during the held wait.

The `composer_controls` executable additionally mounts the actual ChatEditor and
Interaction owner offscreen at 680/1100pt, light/dark, over its own held faux Stop.
It edits through native input events, compares visible text to `shown_text`,
checks focus and synthetic preedit reconciliation, switches targets before the
late response, and reopens the private snapshot after Close. The fixture sets
and asserts theme after opening the window, not merely in a filename.

Reproduce serially with the pinned mbx wrapper, CPU2/4GiB admission and private
worktree targets after checking free disk:

```sh
python3 apps/desktop/scripts/check-scoped.py --unit interaction::tests --test composer_controls --lint
python3 apps/desktop/scripts/check-scoped.py --unit delivery_store::tests --native-probes
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-desktop
```

Observed on macOS arm64: 73 courier tests passed (one opt-in workload ignored),
39 Store tests passed (two opt-in workloads ignored), selected library/native
Clippy passed with warnings denied, changed-file rustfmt and the plain locked
desktop build passed. `composer_controls` completed its existing assertions and
all eight held-Stop scenes. Those eight single-run edit-to-durable-observation
measurements ranged from 299.1 to 304.9 ms, with the HTTP response still held.
This is not a statistical latency result. Checks ran serially through pinned
mbx CPU2/4GiB admission and a private target; free disk was 89 GiB. The existing
`block 0.1.6` future-incompatibility warning remains.

These are isolated source/transport/native regression checks, not user acceptance,
OS IME, full-window close/Quit/force-quit, crash/power-loss, production provider,
Wayland, or live Stop-latency qualification. Reported edit-to-save timings include
native input, frame pumping and real temporary disk saves under a deliberately
held synthetic response. They are not Stop completion timings or hard deadlines.
