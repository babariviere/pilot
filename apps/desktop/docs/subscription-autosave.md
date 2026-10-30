# Draft autosaves during subscription recovery

## Audited boundary

Force/Pause and Continue are existing explicit composer actions on the same FIFO
Interaction writer as Send. Continue still requires the existing model choice and
confirmation. At the audited baseline, `DeliveryOwner::model` delegated these two
actions to `chat_models::execute`, borrowing Store across HTTP. A held Force POST
regression timed out waiting for newer on-disk draft bytes before release.
A separate restored-original-owner control also timed out at Continue's held
catalog read. Final owner bytes were restored exactly before recompilation.

Force now runs its unchanged fresh-session read and one-shot POST through the
existing `DeliveryOwner::effect`. Continue separates its unchanged session/catalog
preflight and immutable POST from synchronous private admission/settlement, using
that same effect loop. This adds no executor, timer, receipt or persistence format.
Autosaves use the existing edit mailbox and deadlines. Other commands, including
Stop and checkpoints, remain FIFO, not concurrent or priority operations.

## Preserved contracts

- Force retains provider-level semantics, including subagents. No limit, reset,
  resume, provider or account policy changes. It still has no durable request
  receipt or retry. An unchanged fresh GET returns Observed, not POST success.
- Continue still requires a fresh continuable session with the captured model and
  a scoped catalog admitting the captured choice, then `prepare_model_change`.
  Pending/Unknown Send or answer refuses admission without replacing its envelope.
  Newer composer text/config cannot replace the captured request target or choice.
- Same-chat and replacement-chat responses retain their existing validation.
  A 4xx refuses and settles Continue; lost, malformed or mismatched ACK stays
  Unknown. There is no replay. This slice does not strengthen the endpoint's
  response/identity contract or claim an atomic daemon model-version condition.
- Inspect is observation only. Explicit matching local acknowledgment dismisses
  uncertainty, not proof of success. Both already use the shared effect seam.
  A known response remains in memory on private cleanup failure, with writes fenced.
- Store text saves remain independent of immutable Pending answer/config metadata.
  Existing UI target/request/generation fences, confirmation and synthetic preedit
  guards remain unchanged. Close cancels held HTTP, flushes latest text and releases
  Store before update-channel disconnection. A late response cannot settle reopened
  private intent or retarget the mounted composer.

No backend/kernel/protocol, failed-chat model, project/mission/subagent adapter,
confirmation UI, live provider/account action, installed app or service change.

## Focused verification

`interaction_subscription_tests.rs` exercises the production worker with real
seeded Q&A/configuration, immutable Pending and UUID temporary Store bytes.
Owned faux HTTP gates cover Force/Pause and Continue preflight/POST, success,
refusal, lost/malformed/mismatched ACK, same/other draft text, frozen envelopes,
FIFO, Inspect/local acknowledgment, private disk failure and Close/immediate reopen.
`subscription_wait_probe.rs` mounts the real ChatEditor and writer in hidden
680/1100pt light/dark windows, retaining the existing confirmation and checking
draft bytes before HTTP release, `shown_text`, focus, synthetic preedit and late
target-switch isolation. Existing Stop/model scenes remain in `composer_controls`.

These are isolated source/transport and mounted native regressions, not real Force
or continuation, provider latency, OS IME, Wayland, full-window Quit/crash/power-loss,
installed-app, release or product acceptance. Timing includes real temporary disk
and frame pumping, not a live provider deadline or performance guarantee.

Serial scoped commands (pinned mbx CPU2/4GiB, worktree-private target):

```sh
python3 apps/desktop/scripts/check-scoped.py --unit interaction::tests --test composer_controls --lint
python3 apps/desktop/scripts/check-scoped.py --unit chat_model --test project_creation --test subscription_limits --lint
python3 apps/desktop/scripts/check-scoped.py --unit delivery_store::tests --native-probes
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-desktop
```

Observed on macOS arm64 after exact restoration/recompile: 86 Interaction passes
(one existing opt-in workload ignored), 19 model/picker passes, 39 Store passes
(two existing opt-in workloads ignored). Selected production/native Clippy,
changed-file pinned rustfmt, whitespace and the plain locked build passed. All
16 subscription wait scenes, eight existing Stop scenes and 16 existing model
wait scenes passed, as did `project_creation` and `subscription_limits`. The
16 final subscription edit-to-durable observations were 331.9–361.7 ms while
HTTP remained held, single-run synthetic observations only. Checks ran serially
under pinned mbx CPU2/4GiB with private targets; disk admission observed 94 GiB
free before the final batch. The existing `block 0.1.6` future-incompatibility
warning remains. Full suites/remote CI and live provider/OS acceptance are separate.
