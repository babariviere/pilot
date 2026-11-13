# Global update preparation

The current update direction is pause-first for **every** app or daemon update.
The earlier app-only/agents-running guidance in the historical pipeline audit no
longer describes the required NSH flow. This document describes the implemented
backend increment, not signed production or native acceptance.

## Implemented boundary

`packages/daemon/src/global-update-preparation.ts` reuses `OperationJournal`,
`RuntimeResources` and `SessionManager` lifecycle checkpoints. It is preparation,
not another installer or service manager.

- Its startup `load()` freezes contributors synchronously, before reading the
  retained operation and before session/queued-work recovery. It never re-enters
  a retained operation. An unfinished operation keeps its fence across reopen.
- A native-owned immutable operation pins the exact app source/build, a digest
  of the already-durable native capture in normal mode, and an optional verified replacement
  runtime identity. A digest alone is not proof of capture or signature checking.
- The fence covers all supplied contributors, including sessions, queued work,
  schedules and automation. No coordinator exception exists. Dormant/stopped
  chats do not need to open a model to be covered by the global pause notice.
- Every live kernel gets the existing exact-operation durable update notice and
  checkpoint request. The host allows one second for cooperation, then closes
  the exact kernel. Production close escalates to SIGKILL after eight seconds;
  preparation reports a genuine exit failure after twelve seconds, not success.
  Late startup and pending-input dispatch are fenced too.
- Unresponsive, errored and incomplete replies do not veto **preparation**.
  Their records say `interrupted`, `unknown`, and whether the host joined that
  exact kernel's exit. They do not claim a durable kernel close or descendant
  exit, and they never automatically resume uncertain effects.
- Durable ownership is saved before interruption. Save failures remain pending
  with an actionable reason. Actual exit failures remain pending too. Neither
  failure permits resending, changing the target, or starting a fresh operation.
- Release is a separate immutable operation bound to the preparation ID and
  payload hash. Its native verifier must prove the exact successor/rollback or
  prove installation was not entered. Authorization is durable before thawing.
  Preexisting update/input/sleep/subscription holds, mission controls and later
  Stop still win. A lost release reply is original-operation lookup only.
- During an admitted update, failed executor-free metadata (`failure` or
  `inputError`) gets an operation-owned `updateRecovery` record. Recovery clears
  stale working/initializing/preparing flags, keeps the clone recipe as data,
  and preserves errors, queued intent, history, Stop, holds and old checkpoints.
  A retained native hold binds this recovery before cold metadata loading.
  Reconciliation is storage-only, never a provider call, workspace recreation,
  model restart, canceled-job retry or repeat of the original update effect.
- A historical failed checkpoint alone is work uncertainty, not a live process
  census. Its exact record stays saved, but does not create a permanent process
  veto after update-owned reconciliation. Live executors still require a fresh
  checkpoint/exit, with prior uncertain ownership saved first. Current-operation
  unproven shutdown, independent jobs/children and other resource blockers remain
  blockers. State reconciliation never supplies the missing process proof.
- Normal recovery also handles recognized old updater lifecycle records without
  a provider error string. It preserves the exact checkpoint and queued intent,
  records `persisted-lifecycle` provenance, clears stale working/setup flags, and
  keeps uncertain work held through cold reopen and release. It does not require
  Force or a model response. Current-operation uncertainty, mismatched session
  or host identity and mission-owned checkpoints are not relabeled this way.
  Unreadable/truncated storage and failed writes remain real failures. Force
  cannot waive them or authorize manual repair/deletion of durable history.

### Explicit Force consent

Normal remains the default. The established update card offers **Force update…**
only when its native root reports that it can enforce accepted-loss close. It
prepares a separate one-use confirmation naming the exact version. Confirmation
warns about both unsaved UI state and unfinished agent work. Cancel starts
nothing. A failed normal save never selects or confirms Force automatically.

Force uses `forceConfirm`, not `confirm` with an empty saved view. Native
`update_loss::Offer` is constructed only from verified official app inputs. Its
consumption writes the exact operation, confirmation, source, window and target
to the existing fsynced host journal before granting an opaque `Accepted` handle.
The current verified native app rechecks the complete target and journal before
that write. The same version with different signed archive bytes is stale too.
Raw JSON and retained records cannot reconstruct this handle. A separate native
close capability still seals admissions, joins entered host work, and disposes
the exact engine before installer entry. It claims no normal form/capture ACK.
Reopen distinguishes accepted consent from confirmed window close. Neither is
proof of install, safe daemon shutdown or successor startup.

The global preparation payload uses **either** `captureHash` (normal) **or**
`acceptedLoss` (Force), never both. Accepted loss names the original preparation
operation and one-use native confirmation, with both loss scopes explicitly true.
The immutable payload also pins the exact signed app target and optional verified
runtime. Loss acceptance is checkpointed before session interruption. Canceled
unfinished executors retain loss provenance and cannot automatically resume,
advance flows or rerun setup/post-run work. Already durable history/queued intent
is not erased. Broken peers still get host-owned close. Unproven process exit,
signature/trust failure, storage failure, holds and permission gates remain real
failures. Check/reopen reads only the original operation. It cannot replay,
retarget, reset or silently replace the accepted loss.

The daemon exposes prepare/lookup/fresh verification through its authenticated native
runtime-owner channel (`/__pilot_runtime_update/v1`, `receipt.globalUpdate`).
There is no agent/session or TSX route and no new credential. The native verified
release binding is deliberately not configured yet. `verify` reads fresh
resource evidence under the original hold; it does not pause, cancel, install
or release anything. `cancel` cannot manufacture release authority. Legacy
reservations cannot supersede a global hold. No current app entry invokes this
new preparation automatically.

## Official app adapter

`apps/day/native/src/host/official_update.rs` uses the public unmodified 0.5.0
`Config::check`, `Download`, `Installation::install` and NSH restart APIs. No
local code swaps the app. Fresh legacy-helper app effects are disabled;
historical capture/recovery readers stay.

Its exact inputs come from the trusted native owner, not TSX or a path/JSON hint:

- The running code-sealed NSH `.app`, compiled existing `Trust`, and its own
  `Contents/Resources/nsh/assets/nsh-updater.json`. Its public key must equal
  the compiled key, even for GitHub updates. The candidate cannot silently
  change the key or update source.
- Official signed NSH `latest.json` and detached signature. A signed
  `pilot: { source, build }` extension pins the exact commit and numeric GUI
  build in addition to NSH semver. The platform asset needs a hash and size,
  limited here to 1 GiB.
- The matching ZIP app archive. ZIP is the initial app distribution format so
  existing limited, link-safe extraction can preflight it before the official
  installer runs. Preflight checks native code policy, source stamps, GUI
  build, semver and unchanged NSH source/key. A private checked copy protects
  against replacing the incoming path after verification.
- The original signed NSH manifest/signature and ZIP for the **actual running**
  version. `VerifiedRollback` checks source/build/version, original config,
  code seal and signature independently. Before any pause/install effect it
  fsyncs the archive and signed inputs outside the `.app` and OS-temp preflight
  storage, beside the existing native command journal. It never overwrites a
  prior backup operation.
- An opaque `ClosedWindow`, created only by the native `WindowOwner` after
  exact attached-input/preedit capture, current-generation form save, seal,
  host join and engine disposal. Stored JSON, a VM acknowledgement and a quit
  callback cannot construct it. This is close evidence, not user update consent;
  explicit target confirmation and operation binding still belong to the root.
- Force instead requires an opaque `ForcedClosedWindow`. Its exact target loss
  acceptance is already durable, and its native host has joined before engine
  disposal. It carries no saved view or normal flush receipt. The same verified
  app/runtime, rollback, fresh resource observation and independent process
  verifier guard both modes through one installer path.

Only then can the adapter journal an immutable operation, enter global pause,
obtain fresh boot/HMAC-bound resource evidence and enter the official installer.
An additional native-only verifier must independently qualify process safety
for that exact fresh observation. Empty blockers, a root/group exit or a pause
ACK cannot implement it. An owner without that evidence must return unavailable.
It saves `install-entered` before the swap and checks the installed target
afterwards. All native work runs off AppKit. The
[app-relative handoff](day-bundled-service.md) now consumes the verified bundled
runtime and original preparation: it stops the existing selected service before
the swap, then starts and verifies that app's exact runtime once. This is not
capsule publication or a second daemon. The native process-safety verifier is
still mandatory; root PID/lease exit is not descendant proof.

Restart consumes a fresh in-memory result once. A fresh pre-exit rollback uses
the same official installer and independently verified old archive, checks the
old app and requests its restart. A confirmed bundled-daemon completion is also
consumed once for rollback: stop that exact successor, restore the signed app,
and start the exact original runtime. An uncertain start cannot supply that
capability. Saved records cannot reconstruct these
execution handles. Backups survive lost replies and process exit. Startup,
cold recovery execution and selective global release still need the verified
native binding below. Installed/restart-requested does **not** mean the successor
started or chats resumed. The ordinary root can preflight an explicitly selected
official target and rollback through this adapter, but cannot enter installation.
No actual app was updated by these checks.

### Native root preflight (installation unavailable)

The native executable accepts the optional `--official-update-inputs` absolute
directory. It contains `target/` and `rollback/`, each with `latest.json`,
`latest.json.sig` and `app.zip`. This is a native path hint, not a trusted
selection or consent. Relative paths, duplicate flags and a mixture with legacy
`--update-transaction/source/build` inputs refuse parsing. No TSX method accepts
these paths. There is no automatic download or registration.

Bootstrap joins a worker-thread preflight before opening the host. It calls the
existing `VerifiedRollback::prepare` and `VerifiedApp::prepare`, including signed
official NSH manifests, actual code-sealed running bundle/config/compiled key,
exact archive bytes, and verified GUI-bundled runtime inventories. It checks
that the rollback belongs to that same running app. Preflight drops its private
archive copies and execution handles. Only a diagnostic exact-target pin remains.
It writes no consent, update operation, durable backup or preparation request.
No inputs, or failed verification, leave the ordinary window usable with updates
unavailable. Ordinary read-only startup still needs no update distribution.

Even successful preflight cannot offer a normal or Force install: the native root
has **no independent job/descendant shutdown verifier**. Its existing update
status explains this precise failure; both modes refuse before confirmation,
loss acceptance, capture, pause or close. Force is not advertised, and legacy
staged inputs cannot provide a fallback installer. These are fail-closed input
and root-routing seams, not a completed production update flow. A future qualified
root must reverify immutable inputs and bind exact consent, capture/loss and the
same mandatory process verifier before calling the existing official installer.

The official adapter now supplies `NormalOffer` and `NormalConsent` for that
future root binding. A normal offer pins the complete verified artifact
(including archive digest, size and updater-config digest), source/profile,
journal and native window. Explicit confirmation consumes the offer against
the same open native host. It cannot authorize Force or record accepted loss.
Consent dispatches capture only to that window and remembers the generation
returned by `WindowOwner::begin_close`. Installation now consumes both that
one-use consent and the opaque joined/disposed `ClosedWindow`; an arbitrary
operation UUID, an old capture, another window or a same-build different
artifact cannot substitute for them. The latest journaled capture must still
match before backup/preparation or any daemon effect.

Normal consent is transient and has no external or loss effect. Dropping it,
canceling capture or reopening cannot recreate it. Durable capture remains
passive saved state; install entry keeps the original confirmation UUID as its
operation identity. Retained-operation lookup grants neither consent nor a new
capture attempt. This adds native consent/capture dispatch, not executable-root
activation: root authorization still refuses both modes before any of it runs.
Force continues to require its separate warned, durable exact-target loss
acceptance and opaque forced close. Its native close dispatch now goes through
`VerifiedApp::begin_force_close`, which rechecks the accepted target and journal
before any window is sealed or disposed. The low-level window method is
crate-private. A changed selection refuses without marking the window closed;
the original accepted-loss record stays lookup-only, not transferable consent
for another update. No journal schema or recovery authority is expanded.

An unsettled saved operation takes precedence over fresh target offers in host
Read/Check. It keeps its original identity and Unknown outcome, offers no
replacement target and reconstructs no capture or Force authority. Existing
official normal/Force startup readers still verify the retained exact image;
normal requires its fresh display observation, and Force never supplies a view.

### Native successor observation

The ordinary native root now recognizes official NSH successor records through
the existing serialized host startup, without reconstructing a legacy helper
transaction. `host/official_startup.rs` checks the current signed candidate's
exact source/build/version and full image identity against the native service
handoff. It also checks the original operation, payload digest, receipt, target,
runtime location and selected profile. A same-build image with different bytes,
an incomplete install or a rollback record cannot pass as that successor.

Normal mode offers the exact saved view only when its capture digest and latest
durable window still match. A newer close capture wins. The existing fresh
display acknowledgement then wakes the native application owner, which checks
the signed image again and durably records a startup **observation**. Cold
reopen never repeats that observation. The update stays Unknown: this is not
a global release receipt, service-start capability or permission to resume work.
Force can report an observed signed target, but provides no saved view, fake
display acknowledgement or startup/resume grant. Signature failure leaves the
retained operation lookup-only. Ordinary startup without an official record
does not gain full-distribution prerequisites.

## Separate evidence and remaining work

The preparation receipt includes resource blockers separately. **Accepted pause
preparation is not permission or proof that replacement is safe.** Root process
exit, job cancellation, an empty registry and process-group exit are not complete
descendant proof. The unchanged jobs adapter performs cancellation/group cleanup;
its monotonic uncertain history remains intact. Missing independent process
evidence must not be relabeled as a broken-chat veto or silently cleared.

The following native/distribution gates remain:

1. Bind executable-root selection to the official adapter's normal consent and
   separate Force loss capabilities above. Keep actual all-form capture,
   preedit, global pause/cancellation and close **before** installation.
2. Qualify native successor observation with actual signed distributions and
   finish operation-bound selective release. The normal native verification and
   fresh restored-view observation path above is connected; it does not release
   anything. Hello, GET, cached status and opening
   an app never release work. No global CLI replacement, cache patch or NSH fork.
3. Qualify interruption and cold rollback with actual signed distributions.
   Install entry is durable before the official swap. Reopen only
   looks up that original operation; it never downloads/installs/resets/retargets
   from a retained hint. Verify actual successor versions and startup/capture
   restoration. A saved backup is recovery data, not authority to re-enter an
   uncertain rollback/install. Qualify recovery separately from a rename.
4. Supply verified GUI-bundled daemon executable/runtime identity and existing
   service/profile ownership through the daemon-handoff adapter. That adapter
   owns exact old-process/lease exit, one successor start, target verification
   and rollback. This preparation supplies neither a GPUI capsule nor authority
   to reconstruct one from paths/JSON.
5. Qualify host-owned process evidence for broken kernels independently of
   cooperative replies. The present interruption record proves only exact root
   exit. Keep descendant limitations explicit; do not add a VM or privileged
   containment system or call an unproven subtree safe.
6. Run joined app-only/combined native scenarios, with real saved drafts/preedit,
   active/coordinator/queued/already-held/stopped work, jobs, broken peers, target
   versions, lost replies, durable cold reopen and selective resume. Unconfigured
   DEVELOPMENT inputs are not a signed distribution or production acceptance.
7. Qualify Force's native root selection, accepted-loss close and cold startup
   using actual signed inputs. The separate confirmation/journal/installer
   capabilities are implemented; the current unqualified official root does not
   advertise or enter Force. Normal capture stays mandatory for normal updates.
   No ordinary confirmation, save failure or retained loss record grants Force
   or waives signature/trust, shutdown, permissions or Unknown/no-replay rules.

### Native process-safety limit

The isolated macOS regression forks a disposable child which calls `setsid`,
closes the parent's output pipe and remains responsive on an owned control
socket after the parent has been reaped and its process group is empty. That
is a counterexample to using parent exit, pipe EOF or group cleanup as complete
descendant proof. The fixture is credential-free, bounded and unrelated to live
chats. A released daemon lease adds root ownership evidence, not missing child
custody.

No simple native process snapshot can rule out children that already escaped
and reparented before the snapshot. The current native root therefore still
cannot enable automatic replacement for such work. The smallest practical
proposal is to keep that case unavailable and require explicit manual recovery
after OS restart, with a fresh signed update confirmation and no canceled-work
replay. This is a proposal, not implemented reboot/install authority or a claim
that it satisfies seamless-update acceptance. A general uninterrupted-work
guarantee needs stronger process custody; no VM, privileged helper or new realm
has been added to obtain it.

## Tagged NSH API verification

On 2026-11-12, the annotated `longbridge/nsh` release `v0.5.0` resolved to
`f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1`. Its official macOS arm64 archive
is `nsh-macos-arm64.tar.gz`, published SHA-256
`e6722427b391b00cf7ec13137db9366e78d1e7a045f2933cf00b340365309d9d`.
App dependencies, generated runner seed, engine/testing/platform and tooling
now pin 0.5.0 together. The global CLI was not replaced. Checks used the actual
verified official distribution in an OS-temporary directory.

The tag's [updater flow][updater] uses `nsh-updater::Installation::install`, then
NSH restart. It swaps **before** quit. The tag's quit cleanup cannot veto exit
and waits only 200 ms total. It cannot own draft saving or agent draining.
Its rename rollback is not a verified-successor startup rollback. Use its
official app update machinery; keep Pilot's operation/capture/recovery evidence
around it, not a parallel swapper.

## Checks

`global-update-preparation.test.ts` uses the production SessionManager, real
forked credential-free IPC peers, real OS exit and durable operation records.
It covers healthy work beside unresponsive/errored/incomplete peers, exact-byte
capture-surrogate preservation, fences, lost replies, lookup-only reopen,
native-verifier failure, actual ownership-save/exit failures and selective
recovery. The surrogate is **not** a native IME/preedit test. Official adapter
unit tests exercise actual NSH signature/download rules, durable backup I/O,
and real official install/rollback on harmless temporary **directories**, not
code-signed `.app` payloads. Existing lifecycle, pause, reservation, mission-control,
power and session tests remain relevant. Headless UI tests do not prove native
appearance, input, IME or production update acceptance.

NSH 0.5 headless presses now honor actual occlusion. Delivery tests explicitly
scroll the page before pressing its lower controls, rather than pressing through
the fixture's diagnostic toolbar. Production layout and assertions are unchanged.

[updater]: https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/docs/dev/updater.md
