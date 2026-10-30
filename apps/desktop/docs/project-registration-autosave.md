# Draft autosaves during project registration

## Ownership and preserved contract

`WriteCommand::Project { path: Some(path) }` borrowed Store across read-only
hello/catalogue preflight, one-shot registration POST and the following catalogue
refresh. A seeded production-writer regression failed on that original owner:
newer draft bytes never became durable before held faux HTTP was released.

Registration now uses the established `DeliveryOwner::effect` seam. Preflight
captures the existing path-only JSON bytes without borrowing Store. The sole
writer prepares the original attempt locally before POST and records the existing
validated 201 response locally. The following catalogue also uses `effect`.
Only draft edits overlap these waits. Mutation/checkpoint commands remain FIFO;
the same edit mailbox, debounce/ceiling and writer own every private save.
Catalogue-only `Project { path: None }` was already effect-owned and is unchanged.

- Existing folder selection, explicit confirmation, absolute-path validation,
  hello identity and duplicate-catalogue admission remain unchanged. No folder is
  created by this client change. Captured path/attempt bytes cannot follow a later
  composer target or overwrite unrelated drafts, Q&A or immutable Pending config.
- The existing ACK is HTTP 201 plus a bounded, valid project row with canonical
  ID and path. The endpoint does not echo a client attempt ID or offer idempotency,
  mutation CAS or receipt lookup. The client validates the row, not equality of
  its path to the submitted path. Path normalization is not request attribution.
  Hello pinning is a loopback identity check, not authentication or an atomic
  server-side lineage precondition on the POST.
- Lost, malformed, invalid-row and every non-201 response remain Unknown. The
  daemon inserts in memory before persistence, so an error need not mean no
  mutation. A matching GET/path/name is current catalogue evidence only. Neither
  matching nor absent rows settle an Unknown or authorize resending its folder.
- The staged private attempt is retained before POST. A known 201 ID remains in
  the existing attempt-qualified volatile receipt if private settlement fails,
  including capacity refusal. The disk fault remains visible; this does not make
  the accepted evidence restart-durable. Catalogue refresh cannot erase it.
- Close cancels the owned wait, flushes edits and releases Store before the update
  lane disconnects. Admission not reached means no attempt; an admitted POST stays
  Unknown unless its ACK was observed. An ACK observed before a held catalogue
  remains retained. This is not proof of remote cancellation.
- Inspection is the existing catalogue-only command. Registration has no separate
  local acknowledge/cleanup command, and this slice adds none. Existing form
  request/epoch fences and receipt recovery are unchanged.

This closes the last known HTTP/Store-borrowing adapter in `Interaction::run`, not
all app ownership or reliability work. Project default-model PATCH remains blocked
on its unsafe mutation contract. Filesystem completion, new capabilities,
backend/kernel/protocol, live registration and other adapters are excluded.

## Focused verification

`interaction_project_tests.rs` seeds real prior registration state, ordinary
draft/configuration and an independent answer Pending. Held faux preflight,
POST, post-registration hello/catalogue and inspection check actual deserialized
`state-v1.json` before release, exact POST bytes, immutable Pending, answer/config
freeze, FIFO, admission refusal, accepted/lost/malformed/invalid/non-201 responses,
no replay, disk-fault accepted evidence, Close, immediate reopen and late response.
The original-owner test failed waiting for durable draft publication, not a
compiler/fixture error.

`project_wait_probe.rs` mounts the production ChatEditor and writer in sixteen
hidden 680/1100pt light/dark scenes: held preflight, accepted POST, post-registration
catalogue and lost POST. It checks actual disk text, `shown_text`, synthetic
preedit, focus, bounds and a different selected chat across the late response.
No visual redesign is made. Existing project-add/creation and owner-wait checks
remain separate regression coverage.

Run serially with the pinned Rust 1.98.1/mbx 1.26 wrapper, CPU2/4GiB admission,
private worktree targets and free-disk admission:

```sh
python3 apps/desktop/scripts/check-scoped.py --unit interaction::tests --test composer_controls --test project_creation --lint
python3 apps/desktop/scripts/check-scoped.py --unit project_registration --test project_add --lint
python3 apps/desktop/scripts/check-scoped.py --unit delivery_store::tests --native-probes
python3 apps/desktop/scripts/check-scoped.py --unit project_add_view::tests --native-probes
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-desktop
```

Observed results belong to the completed task, not inferred from this inventory.
Synthetic temporary stores and owned faux HTTP only. No real project registration,
project-directory creation, chats/providers/settings, installed app/daemon/service,
release or Swift build. These checks do not qualify OS IME, Wayland, live latency,
product acceptance, crash/power-loss durability or full app-close/Quit behavior.

Observed on macOS arm64: 100 Interaction passes (one existing opt-in workload
ignored), six registration passes, 39 Store passes (two existing opt-in workloads
ignored), four form passes, all sixteen new held-registration scenes and the
existing composer-owner/project-creation/project-add native regressions passed.
Matching scoped production/native Clippy, changed-file rustfmt, documentation
links, whitespace and the plain locked build passed. Checks ran serially with
at least 85GiB observed free disk. The existing `block 0.1.6` future-incompatibility
warning remains. These are synthetic checks, not live latency or acceptance.
