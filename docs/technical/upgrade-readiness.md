# Upgrade readiness audit

Source audit, 2026-11-06. This describes the Rust desktop implementation, not the
installed app or permission to operate a real service. App replacement and daemon
replacement have different readiness boundaries. An unresolved delivery is not
unsaved data, and a daemon's active job is not GUI-owned work.
Desktop source paths below are relative to `apps/desktop`; daemon paths name the
full package path.

## Ranked findings and changes

1. **Historical uncertainty vetoed GUI replacement. Fixed.**
   `Book::gui_restart_safe` rejected a saved `draft.last` Unknown, an intent without
   an operation envelope, any saved model attempt, and mission-conversion Unknown.
   `ChatEditor::update_checkpoint_problem` then asked for manual recovery.
   Store already validates and preserves these records. Cold-open does not submit
   them. GUI admission now depends on exact saved input, a fresh FIFO checkpoint,
   and no in-flight/volatile work, not on settling historical outcomes. Unknown
   remains Unknown. No record, envelope, retry policy or receipt is changed.
   Empty legacy Unknown summaries also cannot be automatically retired on
   cold-open. Both the editor and Store keep them, even when no text remains.
2. **Warm visual helpers turned settling into a retry chore. Fixed.**
   `visual_runtime::fence_for_restart` asks idle helpers to yield when occupied,
   but the install caller immediately refused. Install now waits within its
   existing deadline, while saving input, and rechecks the same exclusive fence
   before handoff. Failed/unconfirmed teardown still cannot grant exit. No helper
   is killed or slot released on a timer.
3. **The historical four-runtime refusal is not the current macOS upgrade path.**
   Current `runtime_service::publish_service` uses a separate two-root service
   store, retires only qualified unused roots, and preserves uncertain users.
   Ordinary GUI reconnect publishes nothing. Legacy four-root evidence is not
   counted against this namespace. This audit does not certify any real root unused.
4. **Slow verification is not a recovery failure.** Two full extractions and
   repeated closure/native checks remain. Disposable macOS extractions no longer
   fsync every file; final copy, archive, exchange parents and journal remain
   durable. Temporary cleanup follows relaunch. These improvements already exist
   in source. No new production speed claim follows from this audit.
5. **Some real gaps remain.** Unsent secondary forms without draft storage and
   session-only secrets cannot silently survive replacement. Actual disk/import
   failures, uncertain native COMMIT/service effects and unverified ownership
   must remain actionable. They cannot be solved by relabeling them Saved.
   The existing 15-second save/helper-settling and 45-second runtime-publication
   budgets can still expire on slow storage. No new full-payload timing or deadline
   change is claimed here.

## App update, end to end

1. **Check/download/stage.** `updater/src/transport.rs`, `manifest.rs`, `archive.rs`
   and `installer.rs::{finish_stage,extract_payload}` authenticate release metadata,
   exact archive bytes/size, bounded ZIP contents, native signature and source
   closure. The retained archive is durable; macOS preview payload is disposable.
   A full progress bar is not verification or installation authority.
2. **Capture and wait.** `src/update_lifecycle.rs::{begin_update_restart,safety}`
   fences input and captures composer/question input, including existing IME text.
   Ordinary app preferences are saved. Already-admitted secondary operations can
   settle under the same fence; unsavable secondary input still names its owner.
   `ChatEditor::advance_update_checkpoint` joins attachment import before queuing
   the checkpoint. No draft is sent to make installation possible.
3. **FIFO persistence.** `src/interaction.rs::{run,flush,checkpoint}` serializes
   writes and HTTP work. A checkpoint flushes the edit mailbox and unsaved delivery
   observations before acknowledging its exact generation. Volatile known
   acceptance is saved as observed, not inferred from a GET. Failed writes, stale
   callbacks, unmatched input/cache revisions and stale ACKs cannot grant exit.
4. **Prepare/COMMIT/close.** `updater/src/worker.rs` and `helper.rs::run_native`
   verify the candidate, Local identity/independent runtime and matching helper.
   The helper re-extracts/revalidates before READY on macOS. Fresh client receipts
   are required again before COMMIT. Only ExitAuthorized requests courier Close.
   `Interaction::run` drops Store and input lanes before Flushed. Native quit
   still requires the exact current close/checkpoint authorization.
5. **Exit/swap/relaunch.** `helper::ParentWatch` proves actual OS parent exit.
   `installer::Staged::apply_with_payload_after_exit_checked` re-authenticates the
   archive, prepared closure, native signature, original inode and exit guard.
   macOS makes a fully synced same-volume candidate before atomic exchange.
   The old app remains in the rollback entry. Relaunch intent is durable before
   launching; launch success is not startup success or automatic rollback authority.
6. **Restore/acknowledge.** `src/update_lifecycle.rs::{restore_update_navigation,
   acknowledge_update_startup}` restores receipt-bound identity and saved state.
   `installer::{startup_receipt,acknowledge_startup}` checks the exact installed
   target. App-only updates reconnect without stopping the independent daemon.
   Missing startup proof stays incomplete, not falsely successful.

## Daemon upgrade, end to end

`src/daemon_upgrade_lifecycle.rs` keeps the GUI, forms and drafts alive. It does
not run the GUI checkpoint or require settling saved delivery uncertainty.
`bundled_runtime::{daemon_upgrade_needed,upgrade_daemon}` verifies the complete
bundled runtime and publishes a service candidate only when needed.

`updater/src/daemon_upgrade.rs::execute` owns this order:
verify service/profile/runtime and watch the old process; prepare/drain; reserve;
revalidate receipt and service; journal stopping; stop; prove process exit and
released profile lease; replace the verified definition; start once; verify a new
boot, exact executable/build/profile and live service; journal complete.

Explicit Upgrade uses signed `interrupt:true`. In
`packages/daemon/src/server.ts`, recovery intent is durable before
`SessionManager::checkpointLifecycle` and terminal checkpoint/close. Workers save
unfinished durable input, acknowledge checkpoint and join exit. Jobs/PTYs are
interrupted, not replayed. `update-reservation.ts` freezes admissions and inspects
the complete resource set; a Stop ACK or an empty chat list is not that proof.
Automatic startup remains noninterrupting, waits for safe tool boundaries and
never downgrades. The GUI remains usable if that automatic attempt defers.

After verified handoff, cleanup is best-effort and cannot undo success. The new
service store holds at most active plus candidate. Scoped native executable/cwd/
descriptor/mapping inspection, permanent locks and private root validation protect
retirement. Unknown users keep roots. Legacy stores, completed GUI rollback trees
and incomplete handoff journals are distinct; do not delete them to pass a gate.
`runtime_path` replaces prior injected bundle paths instead of accumulating PATH
entries. External/custom/unsupported service owners do not gain management rights.

## Blocking predicates

Classes: **safety** must retain positive proof; **wait** should settle within the
explicit action; **history** must not veto an unrelated GUI replacement.

| Predicate                                                                                                      | Class and behavior                                                               | Source owner                                                                  |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Unsigned/mismatched manifest, archive, helper, native signature, source/closure                                | Safety, refuse                                                                   | updater `manifest`, `transport`, `archive`, `installer`, `helper`             |
| Unsafe target/parents/ACL, lock, original inode changed, incomplete transaction                                | Safety, refuse or inspect exact evidence                                         | `installer::{validate_target,reconcile_recovery}`, `installer_cleanup`        |
| Legacy delivery summary Unknown                                                                                | History, keep without Check                                                      | `delivery_store::Book`, `ChatEditor::checkpoint_receipt`                      |
| Saved pending/Unknown intent, including missing envelope                                                       | History, keep identity and automatic opt-in unchanged                            | Store validation, `interaction::run`, `interaction_delivery::check`           |
| Saved model attempt or mission Unknown                                                                         | History, keep exact request; never submit/acknowledge on reopen                  | `chat_models`, `mission_conversion`, `interaction::run`                       |
| `draft.last.state = pending` in a file                                                                         | Safety, invalid persisted schema, not an admissible legacy row                   | `Book::validate`                                                              |
| Current send/model/mission HTTP, queued removal, unsaved volatile ACK                                          | Wait for FIFO completion/persistence; no new send                                | `ChatEditor`, `Interaction`, `DeliveryOwner`                                  |
| Draft/question text or attachment import not saved                                                             | Wait, capture exact input/import; actual failure refuses                         | `ChatEditor::{begin_checkpoint,advance_update_checkpoint,checkpoint_receipt}` |
| Ordinary app preference dirty/saving/unconfirmed                                                               | Wait, persist within Install                                                     | `restart_blocker`, `SettingsPreferences::persist_update_checkpoint`           |
| Missing/stale checkpoint, late edits, changed settings token                                                   | Safety, await exact current ACK, never use timeout as success                    | `safety`, `checkpoint_receipt`                                                |
| Secondary request in progress                                                                                  | Wait under input fence                                                           | `Blocker::settling`, `advance_update_restart`                                 |
| Unsent secondary forms, queued-message edits, open creation sheets/palette, secondary IME, session-only access | Safety/current limitation, identify owner; no auto-submit/discard                | `secondary_blocker`, feature `update_hold` methods, `Updates::unsaved_access` |
| Active/warm visual helper                                                                                      | Wait for exclusive capacity in same Install; failed/unconfirmed teardown refuses | `visual_runtime::{fence_for_restart,TEARDOWN_FAILED}`, `safety`               |
| Independent daemon agent/job/terminal during GUI swap                                                          | Not a GUI blocker                                                                | `app_update::ExitGuard`, read-only retained inspection                        |
| Daemon active work during explicit upgrade                                                                     | Wait for interrupt checkpoint and full census                                    | daemon `UpdateReservation`, `SessionManager::checkpointLifecycle`             |
| Busy work during automatic startup handoff                                                                     | Wait bounded safe boundary, then defer without stopping                          | `daemon_upgrade_macos::Host::drained`                                         |
| Wrong service/profile/boot, singleton lease live, stale reservation, failed checkpoint/resource inspection     | Safety, refuse before stop                                                       | `daemon_native`, `daemon_reservation`, `coordination`, `runtime-admission.ts` |
| Legacy four-root capacity                                                                                      | Not counted by new macOS service namespace; preserve legacy evidence             | `runtime::{legacy_admission,publish_service}`                                 |
| Two uncertain/live service roots, unsafe stage or copier lease                                                 | Safety, automatic retirement only with native no-use proof                       | `runtime_service::publish_checked`, `runtime_cleanup`                         |
| Lost COMMIT, service stop/start or new-boot verification                                                       | Safety, Unknown/no replay; passive status is not an effect receipt               | updater controller, `daemon_upgrade::execute`, native journal                 |
| Failed relaunch or missing exact startup ACK                                                                   | Safety, retain rollback and journal; do not repeat install                       | `installer`, `update_lifecycle`                                               |

## Evidence and limits

The initial Rust regressions failed on both the saved-uncertainty predicate and
the real headless GPUI editor admission. The old screenshot text comes from that
predicate path, but does not identify which live row caused it. No real operation
or installed state was read, edited, replayed or used as current proof.

Regression coverage includes cold Store/courier reopen with byte-identical legacy,
model and mission records; no HTTP from checkpoint/Close; delayed/lost replies;
failed writes and stale callbacks; IME, attachments and question drafts; hidden
native Install click through existing installer handoff, Store release and actual
native exit. Installer and daemon fixtures cover refusal/partial-effect boundaries
separately. A synthetic installer handoff is not a real signed installation.

Focused results: 37 editor, 44 Store, 9 courier-retention and 9 visual-runtime
tests; all 18 hidden native exit/update scenarios; 174 installer/runtime/handoff
tests; and 37 Node reservation tests pass. Seven unrelated/opt-in Rust observations
are ignored, not accepted as qualified. Scoped strict Clippy, leaf rustfmt and
documentation formatting pass. A broader editor run also found three unchanged
slash-command regressions expecting the removed Changes command. They are a
separate follow-up, not fixed or hidden by these scoped results.

Historical investigations 458/459/461 explain earlier costs/capacity and their
evidence limits. Task 460 was an opacity change, not updater evidence. The current
source supersedes those installed-state descriptions. See [timing evidence](../../apps/desktop/docs/update-timings.md),
[app exit](../../apps/desktop/docs/application-quit.md),
[app updates](../../apps/desktop/docs/updates.md) and
[daemon upgrades](../../apps/desktop/docs/daemon-upgrades.md).
No Linux native qualification, full-payload speed measurement, hardware IME matrix,
installed availability or user acceptance is claimed here.
