# Day update pipeline qualification

Source audit at `f896e1831529b8059fc80adf1b819a8d683a0c9c`. This is not native or live update acceptance.
Day has no production update entry or packaged release yet. The subsequently delivered
[released JSON bridge](day-public-bridge.md) now binds the canonical native `DayRoot` through the existing
worker and public `AppOptions.host`; use that implementation, not a second adapter or root. Do not register, install, restart or activate a
service as part of this qualification.

## Reuse, not replacement

The existing independent `apps/desktop/updater` crate owns signed manifests, staged payload verification,
native process watches, profile leases, registration, daemon replacement and GUI helper handoff. Its
`lifecycle::DaemonLifecycle` is already independent of GPUI and Swift. Keep that controller and the daemon's
signed interrupt reservation. Do not adopt NSH's separate installer or add a service manager.

| Boundary | Existing implementation | Remaining Day seam |
| --- | --- | --- |
| Profile and daemon | `app_update::Connection`, `coordination::Location`, native owner proof | Construct only from explicit trusted root selection. Never accept a path, PID, credential or grant from TSX. |
| Register | `daemon_upgrade::register` | Explicit one-use confirmation, journal before entry, exact lookup after uncertainty. Startup does not register. |
| Daemon update | `DaemonLifecycle::needed/upgrade/upgrade_coordinated` | Worker-thread adapter; immutable published capsule; preserve exact operation/target binding. |
| Agent checkpoint | `SessionManager.checkpointLifecycle`, kernel close, per-session manifest | Durable update notice, direct-job cleanup before registry detachment, refusal without descendant-exit proof. |
| GUI update | `Updater<Worker>`, `ExitGuard::prepare_external`, helper READY/COMMIT | Root-owned all-form save/restore, fresh flush generations, joined native close and executable packaging. |
| Startup | `ExitGuard::external_startup/acknowledge_startup`, `coordinated::startup` | Restore state before exact native startup ACK. Launch or hello alone is not success. |
| Shutdown | `NativeHost::close` joins HTTP/WS/journal worker; `Worker::close` joins updater work | Call both off the UI thread. Helper handoff has separate lifetime; neither join proves a committed helper exited. |

`Safety.active_work` means entered **client** work, not unrelated daemon agents. App-only updates use
`Runtime::Independent` and an external guard. They must not acquire daemon reservations, pause its agents
or stop its service. Nonempty saved drafts are supported. Save failures, uncommitted preedit and in-flight
mutations require real capture/drain, not discarding state or optimistic ACKs.

### Current job descendant limit

The pinned jobs provider does **not** supply a trustworthy descendant-exit receipt. A cancelled job's
`endedAt` is not one: the shell can exit while a SIGTERM-resistant child keeps running, its inherited
pipes are disposed, and the child is reparented outside the worker's later direct-child census. An
executed regression reproduced continued file writes after both the job wait and an empty census.
A pre-stop PID snapshot is also not a closed process-tree proof against fork/reparent races.

The shared registered jobs definition now saves and fsyncs monotonic **admission history before any
start delegate runs**, for direct, nested and native calls. Stop, `stopJob`, natural leader exit,
terminal-row pruning and reload/reopen never clear that record. `checkpointJobs` joins direct-job
waits as cleanup but refuses lifecycle quiescence whenever historical subtree exit is unconfirmed,
even when its first registry read is already empty. The daemon saves the failed checkpoint as durable `unknown`, without
`quiescent`, and refuses both old and fresh replacement attempts until inspection. Job cancellation
does not acknowledge descendant exit, user Stop does not supply that proof, and no command is replayed.
Clean history can be initialized only by the owner proving that no durable root conversation exists,
before SDK initialization. A missing or malformed legacy history is Unknown, not proof that no job ran.
Admission storage failure prevents the job delegate from running. Existing Unknown never resets even
when a fresh flag is supplied. The content-free private record stays beside `native.session` and is
independent of the provider's limited recent-job list.

Daemon replacement after any unproven job admission remains **unqualified on this provider**, not a
passed D41 case. A future qualified descendant owner/exit contract is needed to remove this safety
refusal. Proven clean new/no-job histories and independent app-only updates remain unaffected.

## Trusted packaging blockers

The initial audit read unmodified NSH `530b73170f61e5bf16380959de9e622f8ce130cd`, which is **not**
tagged-release evidence. Day now uses verified longbridge/nsh `v0.4.0` at
`e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`, with matching CLI/runtime/testing versions. Requalify the
following packaging and root APIs on that release before any native acceptance claim. Do not mix old
snapshot caches or substitute the unrelated crates.io `nsh` command shell.

Read-only inspection of release `e626a8dd` confirms that `EngineConfig.context` and mixed-host
`runtime::file` delegation exist. However, `nsh-platform-macos/src/app.rs` has no context field in
`AppOptions`, and `AppView::load` sets `context: Default::default()`. Direct headless engine injection
does not prove that the packaged native GUI receives `DayRoot`. The delivered public JSON bridge
solves native root selection without typed context injection. Do not add a global root, modify NSH or
quietly retain the snapshot. A production packaged entry remains unqualified.

### Public macOS constructor and runner audit

At release `e626a8dd` the exact limits are:

| Public API/source | Observed behavior |
| --- | --- |
| `nsh-platform-macos/src/app.rs:264`, `AppView::new(mtm, AppOptions)` | Creates a private `Surface`; no `EngineConfig` or typed context argument. |
| `app.rs:332`, `AppView::load(App)` | Constructs its own engine configuration and defaults the typed context at line 353. `App` is `Rust(Root)` or `Js(Bundle)`, not a configured engine. |
| `app.rs:661`, `run_app(AppSource, AppOptions)` | Creates an `AppView` and calls the same `load` path. There is no engine-configuration callback. |
| `nsh-macos-app/src/lib.rs:13`, `main()` | Reads its own signed bundle resources through private `setup()`, then calls `run_app`. No app-specific bootstrap callback. |
| `nsh-core/src/element/component.rs:535`, `Root::new` | Can capture typed props for a Rust root. It does not wrap a JS bundle or inject `EngineContext` for a TSX app. Switching the app to a Rust UI is not a fix for this seam. |
| `nsh-platform-macos/src/surface.rs`, `Surface::start` | Accepts `EngineConfig`, but the module, surface accessor and start method are crate-private. Not an application extension point. |

The platform's registration functions (`set_ui_sets`, `set_components`, development `set_root`) register
process-wide factories. They are not per-engine typed root injection, and must not hold Day's host or
credentials globally. Entering `EngineContext` on the launching thread also does not inject it into the
separate engine thread.

There **is** a public same-process JSON host route: `AppOptions.host: nsh_engine::HostChannel`, also
available through `AppView::host()`. A trusted native owner can create the channel, install exact named
`HostChannel::handle` closures that capture its sole `DayRoot`, pass that channel in `AppOptions`, and
run `AppSource::Bundle` through the public `run_app` or embedded `AppView` constructor. The release
copies that channel into `EngineConfig.host`; handlers run on the engine thread, and replies/events use
JSON. This does not require an NSH patch, a global Day host or another process.

That is now the delivered transport in `bridge.rs`, **not** a drop-in route for the
`TodayFeed::connected`/`PlanFeed::connected` typed-context constructors. `nsh/host` calls require explicit
exact-name capabilities; the restricted connected bundle grants only `bridge::METHODS`. The delivered
adapter keeps the existing typed read models/intents and one serialized worker, without credentials,
raw daemon paths, arbitrary host calls or mutation replay. The existing stock runner exposes neither
caller-supplied `AppOptions` nor a handler-registration
hook; an application-owned entry using those public constructors would still need qualification as the
same trusted packaged executable. Native acceptance remains blocked, not certified by headless injection.

The audited snapshot's `runtime::file` delegates to
the generated mixed Rust host, so native exports can ship without an NSH fork. Stock `package_macos`, however,
derives `Pilot Day.app/Contents/MacOS/PilotDay` from `nsh.json`, uses `dev.pilot.day` and ad-hoc sealing, and
does not assemble Pilot's daemon capsule, updater helper, compiled trust or source/input receipts.

The existing verifier expects `Pilot Next.app/Contents/MacOS/pilot-desktop`, a separately compiled helper,
matching app/helper trust, the signed desktop manifest and the bundled runtime inventory. `Trust::validate`,
`layout::running_root`, helper self-verification and installer verification all participate. Existing
`bundle_runtime.py` additionally requires the GPUI visual-worker receipt. Renaming a binary alone does not
qualify the package. Do not weaken any verifier to accept an arbitrary NSH runner.

The minimal packaging route is an app-owned assembly adapter around the generated, unmodified native host:
keep the existing verified distribution layout and compiled trust, add NSH bytecode/assets to its inventory,
and remove GPUI-only payload requirements only after auditing their consumers. This is a source proposal,
not permission to change the installed app identity or release/sign a build. An isolated fixture must prove
that the actual generated host and helper use the same configuration and startup transaction arguments.
macOS arm64 is the current qualification target. Linux registration/update has a separate systemd/native
path and signed inventory; macOS evidence cannot qualify Linux.

`bundle_runtime.assemble(..., gui_resources=...)` now accepts the optional NSH resource closure without
changing the native layout or app/helper trust. The explicit input must be a real directory named `nsh`.
`executables/gui-resources.json` binds schema 1, kind `nsh-ui-resources`, the same immutable Pilot
source/arm64 target, the exact tagged NSH release, and the compiled `pilot-desktop` bytes/digest. Its
`files` must match the complete resource inventory, including `bundle.nshc`, `capabilities.json` and
`app.json`. The assembler rechecks the copied closure before signing and saves the checked receipt
snapshot, not a later reread. Both resources and receipt enter the existing signed bundle inventory.
This closes resource assembly, not generation of trustworthy compiler evidence, GUI startup/capture,
signature acceptance or production update qualification. A stock `PilotDay` runner is still refused.

## Typed host contract for UI integration

Keep native registration/update authority out of the VM. Reuse native `Connection`, `Trust`,
`UpgradeMode`, `Safety`, `Flush`, `Candidate`, `State`, `Outcome`, `Recovery` and `Failure`, not JSON
commands supplied by TSX. The root owns these objects, the current operation and its worker lifetime.

The Day-facing adapter should expose the following narrow intents (integration contract, not implemented
VM exports yet):

- `snapshot()` returns availability, the displayed revision, target build and one operation's phase.
  Registration, GUI version, daemon runtime version and recovery are distinct fields.
- `prepare(kind, displayedRevision)` resolves `register`, `app`, `daemon` or `appAndDaemon` against the
  root's trusted selection. It returns an opaque one-use confirmation. It never mutates or authorizes itself.
- `confirm(confirmation)` durably records exact profile/target/operation ownership before native entry.
  Duplicate confirmation is refused. No raw paths, service names, tokens or process identities are VM inputs.
- `check(operation)` reads retained exact evidence only. Missing, interrupted or ambiguous evidence remains
  Unknown. It never registers, restarts, resends COMMIT or retries a cancelled/uncertain job.
- `close()` fences admission immediately and returns an awaitable joined result. Dropping a controller or
  receiving a pause ACK is not that result. Successful post-exit helper handoff is distinct from abort/join.

All-form capture/restore and controls belong to the native UI owner. The save barrier must cover interview
answers, New goal/detail, attention answers/questions/notes, review drafts, navigation and selection. Pin
the exact source/revision/digest for every saved form. Flush acknowledgements must match requested
generations; successful HTTP or status reads are not persistence receipts. Do not replay restored intents.
The canonical Day root is `DayRoot`, bound by the delivered public JSON bridge for macOS. Typed
engine-context factories remain an embedding/headless route only. Attach lifecycle hooks to that same
root and bridge, not a second owner. Request capture/flush while the engine and native editors are still alive;
in particular, reach `planCommands.saveNow` before disposal loses TSX-only answer text. Then stop the
engine, let feeds queue their remaining owned drafts, and await `DayRoot::close`. Drop-queued saves alone
are not an all-form capture receipt.

The opt-in `macos_host::WindowOwner` embeds the released public `AppView`, not stock `run_app`.
Its `begin_close` fences effects without emitting an early flush event, snapshots attached editable
`NSTextField`/`NSTextView` values, reports ChangeText before committing marked text, freezes editing,
then emits the engine's all-form barrier. Input and host events use the same released engine queue.
Cancellation restores editability, the original owned responder and UTF-16 selection in that same
engine. The native snapshot is size-limited by refusal, never truncation.

After the exact worker ACK, `finish_close` rechecks attachment, editor inventory and exact bytes. It
atomically seals the generation and last admitted save sequence, refusing all later bridge calls
before `AppView::stop`, then returns the existing root's joined-close receiver. A save admitted after
an older ACK invalidates it. A failed/missing ACK leaves the old engine alive and can be cancelled.
The native wakeup only schedules the embedding owner's main-thread check; it must not wait on the
host worker. The embedding window still owns quit/reload/menu/navigation fences and a cancellable
deadline. This opt-in boundary is not a complete production app delegate or an update authorization.

## Day update controls

`apps/day` now has the TSX controls and the screen-state half of all-form restore. They run on mock
rules only. `UpdateFeed` (`native/src/update_feed.rs`) follows the typed contract above:

- `snapshot()`/`onChange` give one `ServiceView`: registration state (registered, absent, offline,
  incompatible, unknown), app and service versions, the offer, why it cannot start, the agents an
  update touches, the waiting confirmation, the latest run and a pending restore.
- `prepare({kind, revision})` returns a one-use `Confirmation` with exact versions, pause and keep
  counts and whether the app restarts. `confirm({confirmation, view})` uses it once. A forged,
  reused or stale confirmation starts nothing. `cancel` drops it. `check()` only reads.
- `SavedView` is exact (`#[prop(exact)]`) and limited to 64 KiB of text, refused whole when larger.
  It holds what has no store of its own: the screen under the update page, New's unsent goal, the
  Today item in front and each interview's question. Today's drafts and interview answers are
  saved to their own stores first (`updateView.saveForms`); a refused save stops before any pause.
- `restored({id})` acknowledges a restore once. Only then do upgrade-paused agents resume; agents
  the user paused stay held. An app-only update pauses nothing.

The mock worlds cover: up to date; app and service update with drafts, working and user-held agents;
stale target; lost answer settled only by Check; failed save; unproven job exit (durable refusal,
never shown as updated); unverified signature; absent, lost and macOS-denied registration; offline;
and an app-only update for a newer service. The UI says "Updated" only after Rust reports the new
version running, and "Update not confirmed" with Check again for any lost answer.

Not built, and owned by the native host work:

- `UpdateFeed::from_host`: a root-worker adapter over `DaemonLifecycle`, `daemon_upgrade::register`
  and `ExitGuard::prepare_external`. `apps/day/native/Cargo.toml` does not link
  `pilot-desktop-updater` yet ("Day never links the shipping app").
- Bridge methods for these intents. `bridge::METHODS` has no update names, so the connected entry
  shows no update control.
- Durable `SavedView` storage in the host journal before COMMIT, and its startup read in the new
  window, tied to the exact transaction and flush generation. The mock keeps it in memory.
- Mapping native `Failure`/`Outcome` values and affected-session manifests to `ServiceView` without
  inventing state. A jobful checkpoint refusal stays "Not updated".
- Restoring a ritual, scroll position and open help panels. A restored window returns to Today
  from a ritual and restores scroll to the top.

## Joined GUI and daemon sequence

1. Resolve and verify the exact signed GUI target and daemon capsule before interrupting work.
2. Fence new GUI intents. Capture native editors/preedit and save every form plus view state durably.
   A failed save leaves the old GUI and daemon running; no helper COMMIT or service stop follows.
3. For daemon replacement only, freeze daemon admissions through the signed explicit reservation. Save
   affected-session ownership, prior holds/generations and an operation-bound agent notice. Checkpoint
   model/tools/children and stop owned jobs. Preserve interrupted job output; never reconstruct commands.
4. Prove final attached-registry census, close ACK and actual worker exit separately. Then prove daemon
   OS exit and released profile lease before changing the service definition. A pause ACK is insufficient.
5. Start the exact daemon capsule and verify its new boot, native executable, profile, lineage and runtime
   build. Selective recovery may resume only matching upgrade-owned work. User Stop, later input, mission
   control changes, sleep/quota and prior user holds still win. A ready ACK is not model progress.
6. Prepare the GUI's independent exit guard against that verified daemon. Persist the common sequence's
   stage and exact target binding before GUI COMMIT. Recheck all flush generations and await native host
   close. The helper waits for actual GUI process exit, then swaps and launches the verified target.
7. The new GUI restores forms/view state without sending them, verifies its actual executable/build and
   exact transaction, then acknowledges startup. A daemon update already completed before a GUI failure
   remains completed; recovery must not replay it.

This sequence needs durable cross-boundary stage ownership in the existing updater transaction/host
journal, not a second update database. A joined app-and-daemon attempt is not implemented merely because
both individual controllers are callable. An alternative order requires explicit compatibility evidence.

## Recovery and acceptance gaps

The updater retains old bytes and exact transaction phases. That is not tested rollback compatibility.
An interrupted/lost COMMIT ACK stays Unknown and startup discovery is lookup-only. Before rollback can
restore execution, prove storage/runtime/app compatibility, the exact old executable and its startup ACK,
while keeping newer user holds and uncertain jobs. Do not reset the transaction or retry a native write.

Required isolated evidence, with real controllers and owned processes:

| Case | Required proof |
| --- | --- |
| Target/profile/signature substitution | Rejection before native mutation; unchanged package and profile. |
| Running and queued tools/jobs/children | Durable notice, admission fence, exact final census and joined exits; effect counts do not increase on recovery. |
| Active and already-held agents | Only upgrade-owned matching generations resume; Stop/holds remain effective. |
| Draft or native capture failure | Exact unsaved bytes remain available; no COMMIT or daemon stop. |
| Lost reply and stage interruption | Retained exact operation recovers by lookup; no duplicate registration/launch/job. |
| GUI plus daemon | Both actual resulting executable versions and startup ACKs, restored forms and selective resume. |
| Rollback | Verified compatible old startup and preserved data, not just a retained directory. |
| Close | Entered HTTP, journal, updater worker and precommit helper drained; committed helper ownership explicitly transferred. |

Existing daemon/kernel fixtures cover independent census, Stop races, target-bound recovery and real child
effects. Existing updater fixtures cover signed native packages, atomic swaps and startup ACKs. These are
independent dependencies for the joined fixture, not Day E2E acceptance. No stock NSH mock status can fill
the packaging, all-form restore, rollback or joined-stage gaps.

The reviewed dependency repair landed separately. Private frozen/ignore-scripts setup passes with
pnpm 12.18.0, package-manager dispatch disabled, private HOME/store/cache/state and unchanged repaired
inputs. The old 12.16.1 suggestion and old-donor workaround no longer apply.

Focused Node checks pass: daemon upgrade/jobs 43, lifecycle recovery/diagnostics 25, real adapter and
owned-process lifecycle 8, subagent pause/drain/recovery 24, full model/bundled-extension suites 91,
and typechecking. The parallel faux-response fixture now explicitly enters its first response before
admitting its second while keeping both request lifetimes overlapping; preparation completion order
is not a request-order guarantee. The negative lifecycle fixture checks that uncertain exit leaves close
failed on later calls, rather than treating an expected refusal as successful cleanup.

Unmodified NSH v0.4.0 native library 48 and public bridge 11 tests pass with the macOS-host feature.
The existing updater passes 178 native-macos tests (five explicit launchd/mounted-volume qualification
cases remain ignored) and 72 generic-native tests, including the new entered-work join, blocked-result
sender and sticky panic/refusal cases. Neither set is a production Day package/update qualification.
The hidden attached-editor probe exercises actual marked Unicode input, cancellation, recapture,
the engine generation ACK, atomic seal, stop and awaited root close. It never orders a window front,
activates a service or sends a provider request. Its form handler is an isolated fixture, not proof
that every production TSX form is saved/restored. The test binary links with local toolchain warnings
about compact unwind size and a missing rust-objcopy libLLVM; execution passes, not release packaging.

Portable assembler tests pass 35 with two platform/manual skips; the separate clang/universal-binary
compile is excluded after the native slot was released. These use mocked native/signing commands.
No signed native package, production
Day GUI/daemon sequence, startup restoration or rollback acceptance is claimed from those checks.

The current `73d111af` pinned jobs source was also read directly at its immutable GitHub URL. It still
saves cancellation before exit and detaches the registry during `session_shutdown`, supporting the
stop/wait-before-final-census change. Reading that source is not installing or testing the dependency.
