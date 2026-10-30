# Draft autosaves during chat model changes

## Audited boundary

The model/thinking picker captures an exact target and choice, then queues a
`WriteCommand::Model` on the private Interaction writer. Previously
`chat_models::execute` borrowed Store across selected-session/catalog preflight
and the one-shot POST. The existing Send/answer/recovery/Stop effect loop did not
cover this adapter. A baseline held-response regression reached the model POST,
then timed out waiting for the newer draft's autosave before releasing HTTP.

Healthy idle/parked chats use `/model`. The daemon may reopen an idle worker and
apply its guarded model change; this is not a current-running-work model switch.
Failed chats use the separately capability-gated `/failed-model`, with captured
failure source, operation and daemon/lineage identity. That saves a future
`nextAttemptModel`, not a retry or change to the failed run. See
[model selection](chat-models.md) and [failed-chat contract](failed-chat-model.md).
Neither path's preflight is an atomic live model-version condition.

## Scoped ownership change

Only existing-chat selection, Inspect and explicit local acknowledgment now use
`DeliveryOwner::effect`. Pure preflight and immutable one-shot transport do not
borrow Store. Admission and matching settlement remain synchronous with the same
sole writer. Autosaves service the existing edit mailbox and deadlines while
HTTP is held; mutation/checkpoint commands remain FIFO. Close cancels the effect,
flushes latest edits and releases Store before update-lane disconnection.

Request shape, target, choice, failed-source identity, capability check and exact
ACK validation are unchanged. Rejected, malformed or lost POST responses remain
Unknown, retaining the immutable attempt without replay. Inspect is observation,
not receipt or success; local acknowledgment only dismisses matching uncertainty.
A known ACK survives a private settlement failure in memory with writes fenced.
UI target/request/epoch fences and retained input/Select owners are unchanged.

`Store::save_edits` is unchanged. Text may save while delivery is Pending or
Unknown, but its answer/config metadata and captured envelope remain frozen.
Question answers already present on an editable chat remain separate from model
selection. The model attempt itself never adopts newer composer metadata.
No Send/answer/Stop reimplementation, project default-model PATCH, project or
mission mutation, subagent adapter, subscription Force/Continue ownership,
backend, timer, executor or persistence format change is included.

## Verification and limits

`interaction_model_tests.rs` uses the production worker, UUID temporary Store,
seeded question answer/configuration and held owned faux HTTP. It deserializes
actual `state-v1.json` before response release, covering healthy/failed preflight
and POST waits, exact ACK, rejection, lost/mismatched/malformed ACK, same/other
draft text, frozen Pending/Unknown metadata/envelopes, FIFO, Close/immediate reopen
and late response isolation. Pending Send/answer refusal is tested without
replacing the original intent. Inspect/local acknowledgment do not replay POST.

`composer_controls` also mounts the real ChatEditor and Interaction writer in
hidden 680/1100pt light/dark windows with held synthetic model/thinking requests.
Theme is set and asserted after window open. Native input edits, `shown_text`,
focus, synthetic preedit, target-switch/late-response handling and private reopen
are checked. The previous held-Stop scenes remain in that executable.

Run serially after disk admission, using pinned CPU2/4GiB mbx and private targets:

```sh
python3 apps/desktop/scripts/check-scoped.py --unit interaction::tests --test composer_controls --lint
python3 apps/desktop/scripts/check-scoped.py --unit chat_model --test project_creation --lint
python3 apps/desktop/scripts/check-scoped.py --unit delivery_store::tests --native-probes
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-desktop
```

These are source/transport and hidden mounted input regressions, not real
provider latency, OS IME, full-window Close/Quit/crash/power-loss, Wayland,
installed-app or product acceptance. Edit-to-durable observations include frame
pumping and real temporary disk saves, not model completion latency or deadlines.

Observed on macOS arm64: 79 Interaction passes (one existing opt-in workload
ignored), 19 model/picker passes, 39 Store passes (two existing opt-in workloads
ignored). Both scoped native executables and their selected library/native
Clippy checks passed, along with changed-file rustfmt and the locked plain build.
All 16 held model/thinking scenes and the existing eight held-Stop scenes passed.
The 16 single-run model edit-to-durable observations were 318.7–407.1 ms with
HTTP still held, not a statistical or real-provider latency result. Checks ran
serially under pinned mbx CPU2/4GiB admission with private targets; disk admission
observed 83 GiB free before the final batch. The existing `block 0.1.6`
future-incompatibility warning remains. No broad CI/Wayland acceptance is claimed.
