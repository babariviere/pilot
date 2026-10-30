# Convert an existing Local chat into a mission

Use **Make a mission…** in an eligible Local chat. Review the prefilled title,
optional goal and two explicit choices, then confirm with **Cmd-Return** or the
button. Return in the goal inserts a newline. Coordination defaults on, matching
Swift. Drafting defaults off (Swift defaults it on) because it sends a message
and may start agent work, so it is an explicit choice:

- **Use this chat as coordinator** assigns the existing mission role. It does not
  promote the chat's permissions or start a separate coordinator session.
- **Ask this chat to draft the mission** sends the existing follow-up request and
  may start a reply. Creating a mission does not independently acknowledge that
  message's delivery.

The source chat, composer/draft entities and reader stay mounted. The sheet's
outcome and copyable mission ID are pinned outside its scrolling fields. Title
and goal are trimmed before capture, and the exact outbound payload is checked
against the daemon’s raw UTF-16 limits (200/4,000) before preparing an attempt.
Whitespace follows the daemon’s ECMAScript semantics, including BOM removal and
NEL preservation. See `mission-whitespace.md`. Closing
the sheet does not cancel a submitted request. Mission management remains in
Swift; this feature is not a dashboard, new-chat wizard or replacement approval.

## Authority and atomic admission

The payload uses only existing `POST /api/missions`: `projectId`, `fromSessionId`,
title, goal and explicit `coordinator`/`draft` booleans. No `startCoordinator`,
new-session action, cwd inference, permission elevation or new host power.

The same loopback-only, identity/protocol-pinned Local courier rechecks the exact
source and project before submission. A missing/false/malformed
`hello.capabilities.guardedMissionConversion` refuses mutation. This optional
capability is advertised only with the guarded mission service and mirrored by
Swift Core. An older live daemon must be updated separately; the app does not
install, start or upgrade it. Loopback/Origin checks and identity pinning are not
cryptographic authentication.

Client preflight alone cannot prevent another writer assigning the chat before
POST. The service therefore checks source continuation/project/archive/control/
ordinary role/mode, retained delegation and both authoritative membership reads
inside the existing synchronous `MissionStore.batchChanges` transaction. Create,
attachment and coordinator assignment commit together, without an await or
notification between admission and attachment. A refused conversion preserves the
previous mission, coordinator and assigned tasks and creates no orphan. Ordinary
explicit join/move semantics are unchanged. No database schema changed.

Nested batching reuses an outer transaction, not savepoints. The qualified caller
is the existing top-level HTTP route, not an async create wrapped inside another
transaction/catch. SQL rollback is not rollback of exceptions after COMMIT.

## One transmission, truthful outcomes

The existing private writer flushes chat edits and durably records the exact
conversion attempt before its sole POST. A local attempt UUID is **not** a daemon
idempotency key. HTTP retries are disabled. Double confirmation, sheet reopen,
navigation, interrupted close and restart never resend an unknown attempt.

Conversion admission, POST and inspection now use the existing sole-writer
effect seam so ordinary draft autosaves can progress while HTTP waits. See
[conversion autosaves](mission-autosave.md) for the bounded synthetic evidence
and preserved ACK/Unknown limits, not a new endpoint or replay contract.

- A validated durable HTTP201 identifies the created mission, not drafting
  delivery. A private receipt-write failure retains the known ID while exposing
  the write fault, not claiming rollback or a saved local receipt. The existing
  writer retains bounded, source/project/attempt-qualified live 201 evidence
  independently of the sheet’s transient request/result. It accepts that evidence
  while closed. The source chat’s receipt action remains read-only and copyable
  even when the editor/writer is not ready; it never authorizes resubmission.
  This live evidence is not a promise of restart durability after a private write
  failure. Copy the known ID and unsaved input before restarting.
- Lost/invalid replies and **all non-201 responses remain uncertain**. In
  particular, observer or response durability errors can happen after COMMIT and
  may map to a generic HTTP400. Non2xx is not generic proof of non-creation.
- **Check again** reads the exact source and its mission detail. It shows latest
  observed membership only. GET/WS membership is not a durable creation receipt
  or attribution to an unknown request. An unknown attempt remains non-retriable
  even when no current association is found.

The bounded ledger retains at most 32 attempts, under the existing 16 MiB private
snapshot/owner-lock/atomic-write limits. Capacity refuses new conversion rather
than evicting uncertain records. No Swift preferences/drafts are imported. The
existing interaction worker and managed close/quit path are reused, not a new
thread, database or execution authority.

## Completed verification and exact source mapping

Checks use only synthetic data, owned faux loopback HTTP and private temporary
state. No real create/send/Stop/approval, accounts or daemon reconfiguration.

| Check | Exact completed source | Result |
| --- | --- | --- |
| Guard typecheck and six focused service/HTTP cases | `d0c55a09a53e6eb62bfd84fba4ad7b2f1e3b4e63` | pass |
| Private intent store and original draft-store cases | `cc452bded58a7d5d955e4fdee04488d0921b4e1a` | 15 pass, 1 existing ignored workload |
| Mounted form keyboard/IME/source cases and original composer | `b3275978a2d0f7f9a7a3fb1dfeeb3f73a284abce` | 4+9 pass |
| Full native viewer→courier→faux HTTP/private store | `8afa602c43097818134d579eb65ceabcf324d8a9` | 16 cases and 32 PNGs; 16 focused library cases pass |

These are dated 2026-10-23 receipts, with command/source/tree/tracked-diff and
relevant file hashes emitted before and after. They are not transferred to a
later head. Final regression receipts belong to the exact source reported with
the change, including any subsequent test-only strengthening.

The reviewed guard pin was `ac232d0715fb83bfaab97b5f227434b1345f01e2`, tree
`4576446212fc56e3bdee6c292b894aca1a75ab99`. Its delegation test used an invalid
`sharing.membership()=>({})` fixture and failed in the real session summary bridge
before admission. The tested pin `d0c55a09…`, tree
`8ac6a9a9752439468d0ab05461e0e41342e9c03c`, changes **only that test file** to an
accepted record with `grant.task.mission.missionId`. It exercises the real
`SessionManager.get→summary→missionSummary` bridge before asserting the delegation
refusal. The test-file SHA256 changed `15c8d603…`→`b9d5c61d…`; production service
SHA256 stayed `161878ca2c24336d356cf14d75456c1e8a9458c578296ee068582e1880f92db9`,
and the other five paths stayed identical. The failed receipt is retained, not
relabeled as passing.

The native matrix constructs actual 680/1100×760 windows in light/dark, asserts
viewport/root/sheet bounds and exercises controlled pending→201, lost-before,
lost-after and unsupported-runtime outcomes. It confirms exact source/project/
choice payloads, one POST, pending close/reopen, copyable ID, honest current
membership, unchanged draft/reader entities and pixel anchor, and actual native
Stop→faux acknowledgement with the unsent draft intact. Captures are actual
offscreen GPUI, not SwiftUI/HTML mocks. They do not establish visible smoothness,
OS IME/AX, Linux desktop acceptance or full parity. Native preedit injection is
component verification, not an OS-input-method certification.

## Final correction and regression receipts

Completed source `6105a8eb7a786f7850397556a771642160a3b9e0`, tree
`ebd7ca2f48213cf7d83e5288c73dc551b1cee728`:

- `03c788ad-ad27-4189-82d0-7bf6fc1a0c9d`: strict all-target Clippy with
  `native-probes`, all 20 native mission cases and 44 actual captures passed.
- `65143248-9b96-45de-9dd2-851d6741cdcf`: visual worker build, formatting,
  full library **189 pass / 3 explicitly ignored workloads**, Settings-state
  **17 pass**, and original `shell`, `navigation`, `workbench`, `settings`
  native targets passed. The ignored ledger I/O observation was run separately
  in that same completed chain and passed.
- Both jobs admitted through the actual serial verification slot, with the same
  33 source/lock/hash and tracked-diff receipts before and after. Publication
  folds source, tests and this documentation into the one feature commit; the
  final publication mapping is reported with the PR, not inferred from a title.

The expanded native matrix covers close-before-201 and 201/private-write-fault
while closed, followed by editor-not-ready, read-only header access, copy ID,
close/reopen/copy again, and exactly one POST in every size/appearance. It also
checks actual mounted text/viewport containment before a native drag **after**
conversion, then retains its exact source range/entity and reader anchor across
stream projection. Kit’s normal outside-pointer selection clearing is unchanged;
this is not a claim that dialog clicks preserve a previous text selection.

The original CI failure tried to drag arbitrary row 100 without checking its
visible text bounds. The correction retains the real pointer gesture and
selection/stream assertions, using a mounted, viewport-contained text row. No
probe was skipped or reduced to a synthetic selection setter. An added
fault-case teardown initially timed out because GPUI retained fixture sender
entities; the final test-only disconnect withdraws those senders after window
removal, joins publication closure and explicitly refuses a false durable-flush
acknowledgement. Production close/disconnect semantics are unchanged.

### SDK fixture environment classification

The earlier 187/188 Node result is not a conversion regression. Job
`538be3d0-7427-4468-8015-0ac82e1743d0` ran only the exact failing task-model
selection case on immutable accepted `5a43350a7353737caf3d7ee9591d2c08c6038e4d`
and published `d0faf073616efb3c4e072a96ebbdaafa5d067d4e` snapshots under the
actual Node slot. Both used Node 24.21.0 and the same patched SDK 1.3.0,
lockfile, credential hook, model catalog and minimal auth-fake bytes. All
inherited `PILOT_*` and `NODE_OPTIONS` were removed. An owned faux Unix broker
accepted only `pi/list` and returned an empty list, without accessing real auth.
**Both** snapshots reproduced `credential-hooks.ts:71` `undefined.bind`: that
minimal mocked ModelRuntime lacks `login` when broker hooks wrap it. This is a
baseline test/environment interaction, not permission to change SDK authority.
Job `2202528a-01d9-4d77-983b-135e9834d8ec` passed the same exact case with the
broker environment absent. No production auth or SDK behavior was changed.
The published `d0faf073…` Node CI job also passed; its TypeScript/protocol inputs
are unchanged by the subsequent Rust corrections.

### Bounded snapshot cost, not a GUI performance claim

The same final chain measured ten atomic updates over 128 synthetic 32 KiB
drafts, first with no ledger, then with 32 maximum-sized retained attempts:

| Retained attempts | Snapshot bytes | Ten updates |
| --- | ---: | ---: |
| 0 | 4,216,528 | 665.019 ms |
| 32 | 4,626,111 | 741.709 ms |

That is 409,583 additional bytes (9.7%) and 11.5% longer in this single ordered
synthetic sample. Work stays on the existing off-UI writer; the extra bounded
serialization/disk cost is real. These timings do not establish typing/scrolling
smoothness, event-loop latency or performance acceptance. No production content,
credentials or live actions were used.

## Reproduce bounded checks

Do not start a second build alongside an existing frozen check.
`scripts/cargo.sh` owns the bounded mbx/cache setup. Relevant commands:

```sh
./node_modules/.bin/tsgo --noEmit
node --test --test-force-exit --test-concurrency=2 \
  packages/daemon/src/mission-service.test.ts packages/daemon/src/missions.test.ts
cd apps/desktop
bash scripts/cargo.sh clippy --locked --all-targets --features native-probes -- -D warnings
bash scripts/cargo.sh test --locked --lib -- --test-threads=1
PILOT_NEXT_MISSION_DIR="$PWD/target/mission-captures" \
  bash scripts/cargo.sh test --locked --features native-probes --test mission
bash scripts/cargo.sh test --locked --lib \
  delivery_store::tests::mission_ledger_snapshot_cost_observation -- --exact --ignored --nocapture
```

Native registration is included in the existing check/CI probe lists. Lack of a
Metal device remains explicitly unsupported execution, not a native pass. No new
workflow/job/runner, production publishing or install behavior is introduced.
