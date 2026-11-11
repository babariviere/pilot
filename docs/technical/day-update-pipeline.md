# Day update pipeline qualification

The tagged-runner [executable handoff audit](day-executable-handoff.md) identifies
the remaining production bootstrap, delegate, helper and startup-ACK ownership.
It distinguishes executed layout/native-exit checks from signed Day acceptance.

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

### Group-only cleanup hardening

Pilot now wraps the unchanged pinned jobs provider with a project-owned JS group adapter
(`job-group-extension.ts`, `job-groups.ts`, `job-group-worker.mjs`). This is **not** a
subtree-containment mechanism and does not remove the update refusal above. The provider still
owns handles, logs, completion claims and notifications. Its sandbox wraps the original command
before Pilot adds supervision. No updater, service manager, dependency pin or native helper changes.

Before direct or nested provider entry, the existing history latch becomes durable Unknown. A
separate private record saves admission, kernel incarnation and tool-call identity. The adapter
binds the returned job ID and the new anchor's process group durably **before releasing the command**.
Records use `scope: "process-group"`, never a subtree-safe flag. They contain no command, credentials
or control token. The provider's bounded recent-job list can finish or lose a row without erasing
group ownership or the independent historical Unknown latch.

The provider controls a client; a separate JS anchor keeps its own detached group alive. The anchor
handles Stop and natural shell completion, sends TERM to its own group, then keeps the full three-second
KILL escalation even after the provider leader or its pipes close. Only that still-live anchor
self-signals the group. The kernel never kills a saved numeric PID/PGID. After the control connection
closes, the kernel uses only a null group signal and saves `group-empty` only after actual ESRCH.
EPERM, timeout, missing ownership and incomplete results are not exit proof. Admission fences join
entered starts before drain. Ordinary close still joins group cleanup; lifecycle checkpoint still
fails because group cleanup is not subtree proof.

On kernel interruption, loss of the private connection makes the live anchor self-clean its group.
That best-effort action produces no recovered exit receipt. Reopen reads records but never reconnects
or signals their old group IDs, and never reruns commands. Unfinished, malformed, missing or legacy
ownership remains Unknown. Proven group-only records also leave the historical latch Unknown.

The remaining prerequisite is independently enforced **complete descendant containment**, with a
matching authoritative exit contract. The audited provider/sandbox bridge supplies no such contract.
In particular, unrestricted macOS commands can use `setsid`/`setpgid` to escape an original group;
absence of an observed escape cannot prove that no escape occurred. Darwin's public kqueue fork
tracking flags have been unsupported since 10.5. Linux group supervision likewise is not cgroup or
subreaper containment. Other platforms are not qualified by this POSIX adapter.

Real harmless process regressions cover resistant reparented same-group children, direct and nested
starts, native/tool Stop, natural completion, admission races, lost results and kernel interruption.
An actual Node `detached: true` (`setsid`) child continues writing after the original group is proven
empty; checkpoint and reopen **still refuse**. Its private cooperative stop and exact group-exit
join clean up the fixture. These checks prove same-group termination and continued fail-closed
behavior, not D10/D41 jobful-update acceptance or a successful replacement.

### Descendant-containment design (research, not implemented)

Read-only audit on 2026-11-11, against Pilot `619590faa821b54a635a46658c811d36f24c53f3`
and the locked extensions source below. **No drop-in, documented macOS host-shell containment
facility was established.** The smallest enforceable route identified is a restricted execution
realm, not stronger group bookkeeping. This proposal needs a user scope decision before any
implementation. It does not clear the self-update or joined-update acceptance blockers.

#### What the existing boundaries actually provide

- `packages/kernel/src/native-adapter.ts` shares the jobs definition across direct, codemode-nested
  and native calls. `JobHistory.admit()` runs before start; `checkpointJobs()` still refuses historical
  uncertainty. `job-groups.ts` binds admission/job/incarnation before releasing the shell. Neither
  schema has a complete-subtree receipt. Close/reopen must not reinterpret those records as one.
- Locked [pi-extensions `46eddf8a`][containment-extensions] uses `sandboxWrapCommand` before
  `JobsProvider.invoke` starts `bash -c` with `detached: true`. Its sandbox controller returns the
  command unchanged in non-enforcing modes. Enforcing modes use macOS Seatbelt; initialization failure
  refuses execution. `seatbelt/base.sbpl` allows fork/exec and inherits filesystem restrictions;
  `seatbelt-profile.ts` deliberately allows network access. This is filesystem policy, not membership,
  revocation or exit accounting. A shell wrapped by Seatbelt can still change session/group.
- The same dependency's `sandbox/supervised-spawn.ts` uses group signalling for ordinary shell/argv
  execution. Its comments claiming whole-tree cleanup are not an OS guarantee. A job-only adapter
  cannot certify a session if ordinary bash, custom extensions, subagents or other spawn paths can
  leave work outside it. Admission coverage is part of the eventual qualification, not assumed here.
- `packages/daemon/src/linux-coordinator.ts::argumentsFor` already uses bubblewrap user/PID/IPC
  namespaces, dropped capabilities, `--disable-userns`, `--new-session` and `--die-with-parent`.
  This is a **coordinator-worker** boundary, not a per-job executor or durable exit protocol for all
  Build workers. Linux service generation in `pilot-service-journal.ts` uses `KillMode=mixed` but
  does not request cgroup delegation. Stopping the whole service is too late to prove the prior
  per-session checkpoint, and cannot implement selective mission/job Stop.
- macOS `apps/desktop/updater/src/daemon_upgrade_macos.rs` manages one launch agent and verifies the
  daemon identity/profile lease. No per-job lifetime enclosure is supplied. launchd's documented
  `AbandonProcessGroup` default kills remaining **same-PGID** processes, not escaped descendants.
  A daemon exit watch or profile-lease release is not their exit receipt.

#### Options and platform costs

| Option | Enforcement and exit claim | Compatibility, permission and delivery cost | Verdict |
| --- | --- | --- | --- |
| More group/census tracking, PID handles, launchd/XPC or coalition ownership | Groups are mutable; handles name individual processes; observations are not closed membership. launchd group cleanup does not cover `setsid`. No documented coalition-wide job enclosure/drain contract was established. | Ordinary shells work; a user launch agent needs no new root helper. Better cleanup does not solve this prerequisite. | Keep current cleanup, never promote it to subtree proof. |
| Tighten Seatbelt/App Sandbox, deny fork, interpose `setsid` | Inherited resource restrictions are useful, but do not supply a documented kill-all-and-join primitive. Denying fork breaks normal shell/build execution; library interposition does not constrain arbitrary executables/direct syscalls. | App Sandbox changes filesystem/service entitlements and host-tool access. `sandbox-exec` is deprecated. A shell-text allowlist is not syscall enforcement. | Not an arbitrary-job lifetime solution. |
| Endpoint Security custody on macOS 27+ | `es_new_descendants_client` observes recursive descendants, with auth for supported operations. Fork/exit are notifications, with possible drops. Fail-closed AUTH_EXEC does not stop a running process from forking without exec. No kernel-owned final-owner-loss termination or atomic subtree-empty receipt is documented. | Preserves host toolchains better, but needs Apple's restricted ES entitlement and a new signed custody component. The 27+ descendant client needs **neither root nor TCC approval**, unlike a full system-wide client. Its non-root setuid/setgid execution restriction changes compatibility. A full client adds root/Full Disk Access and broader monitoring authority. | A conditional monitoring/custody design, not qualified containment. Do not request entitlement/privileges as this task's side effect. |
| Linux per-job PID namespace plus cgroup v2 | Namespace init exit causes kernel termination of namespace processes, including detached sessions. A protected cgroup inherits descendants; `cgroup.kill` handles concurrent forks/migrations, then `cgroup.events: populated=0` reports no live subtree processes. Neither a kill write nor freezer ACK alone is final exit. | Native Linux shell/toolchain support, but background daemons cannot outlive the job. Requires usable namespaces and a supervisor-owned cgroup subtree. Existing bubblewrap is reusable on Linux only; per-job ownership/receipts are new. User-service delegation can avoid a root host helper where supported, but jobs must not inherit its control authority. | Feasible Linux adapter, not shipped/qualified by current coordinator isolation. |
| macOS VM execution realm (Linux guest, or separately scoped macOS guest) | Put all payload processes inside an OS boundary they cannot leave. Linux guest can use the same per-job namespace/cgroup owner. Successful **actual VM stop completion**, followed by host broker/I/O drain, is an outer fallback for that VM, not proof of command success. `requestStop`, pause, saved VM state or owner disappearance are not stop receipts. | Virtualization.framework requires a signed executable with `com.apple.security.virtualization`, not a system-wide ES/root helper. Linux guest changes OS paths/toolchains; host Xcode/Keychain/GUI tools do not transfer. macOS guest is Apple-silicon-only in Apple's documented path, with OS image/provisioning, licensing and larger resource costs. Both need explicit file/network/credential grants and new package/update support. | Documented enforceable route on Mac, but a material product/execution change requiring approval. |

Apple DTS explicitly distinguishes ES custody from a kernel-owned lifetime boundary in the
[current platform discussion][containment-dts]. Its suggested two-level custodians improve a live
owner's protection; they do not create enforcement after loss of every custodian. This is platform
guidance, not a Pilot experiment or proof that an ES-based alternative can never be developed.
The audited SDK also exposes audit-token signalling and `proc_terminate_all_rsr`; neither is a
job-subtree enclosure. XNU's latter implementation iterates processes marked `P_RSR`, not descendants
of a job. Private coalition/task APIs, DTrace/SIP changes and privileged kernel extensions are not a
supported small fix. See the source/API references below.

#### Recommendation and explicit scope question

**Recommend a project-owned execution-realm owner with Linux namespace/cgroup enforcement, using
a dedicated Linux VM per session on macOS if the user approves guest execution.** This is the
smallest identified design with documented enforcement, not the smallest code diff. A per-session
outer VM avoids killing unrelated sessions when a guest owner fails; jobs inside it retain separate
cgroups for individual Stop. VM memory/boot/disk costs may make this unacceptable. Measure before
choosing pooling; a shared VM fallback must never stop work outside the exact operation's ownership.
Do not build a privileged host scanner or claim an ES monitor is equivalent.

Scope question for the user: **May update-qualified work on macOS run in an explicitly granted VM
execution environment (Linux first), accepting guest toolchain/path differences and a new signed
realm owner, or must it keep unchanged unrestricted macOS host-shell behavior?** If host-native
macOS tools are required, separately scope a macOS guest and its provisioning/resource costs, or
return for a different architecture decision. Do not silently convert existing sessions or treat
continued host-mode refusal as D10/D41 acceptance. Host-mode historical Unknown remains unresolved;
a new realm cannot retroactively prove that an old escaped process exited.

Approval must define which work moves: jobs alone cannot close the session-wide proof gap. At minimum,
all agent-controlled process creation (bash/argv, nested jobs, descendant agents and custom executable
tools) must enter an owned realm or be explicitly unavailable in qualified mode. In-process extensions
with unrestricted host spawn authority are outside that mode until isolated. Keep model/daemon/NSH
credentials outside payloads. Preserve read/write policy; do not replace it with broader VM shares.
No implicit SSH-agent, Keychain, Docker socket, launchd/systemd bus, host-exec RPC or host home mount.
Such brokers can create work outside the realm. Remote/HTTP effects remain separately permissioned
and possibly Unknown even after every local process exits; containment is not rollback.

#### Minimum owner and receipt contract (proposal)

1. Keep the owner outside the disposable kernel worker and TSX VM. Bind a private authenticated
   channel to profile/session, kernel and realm incarnations, admission/tool-call/job IDs, enforced
   policy/image identity and operation generation. Persist intent before entering any launch. The
   payload cannot modify the owner journal, signal/control the owner, access its cgroup descriptors,
   ptrace it or ask a host broker to spawn elsewhere. Same host UID or a writable delegated cgroup
   alone is not this separation.
2. Create an empty per-job boundary, durably bind it, then release the first payload instruction
   **inside** it. On Linux use `clone3(CLONE_INTO_CGROUP)` where supported or a trusted gated launcher
   moved before payload exec, with no earlier untrusted code/fork. Hide writable cgroupfs, ancestor
   namespace handles, user-manager sockets and inherited control FDs; drop privilege gains. Payloads
   cannot migrate out or create work via an external service. Linux policy must enforce those
   exclusions, not just rely on a cgroup name. Namespace/cgroup absence means unavailable, not fallback.
3. Preserve provider job IDs, output paths, logs, notifications and command-result semantics. Keep
   **shell result** separate from **realm drained**. The current provider has a command-string wrap,
   not a pluggable executor/receipt API. A host `sandbox-exec` string cannot be sent to Linux unchanged:
   a future project-owned adapter must translate the resolved permission policy before launch and
   bind its real result. This needs a scoped integration design; no dependency update is approved.
4. Stop/Pause/update fence new direct/nested admissions synchronously, await admitted starts, mark
   draining durably, then terminate all owned processes with bounded grace/escalation. Natural shell
   completion must also settle descendants before final drain, even after provider pruning. For Linux,
   keep the exact cgroup object under exclusive owner control, disallow repopulation, join namespace
   init and final recursive empty state, then drain outputs/broker operations and persist the receipt.
   Never signal a recovered numeric PID/PGID or infer emptiness from a missing directory/unit.
5. On Mac, a lost guest channel cannot certify individual jobs. Where the operation owns the entire
   session realm, the still-live native owner can stop that exact VM and await the documented callback,
   then join host-side work and persist an incarnation-bound outer-exit receipt. Guest commands may
   remain interrupted/Unknown. No VM reboot, snapshot resume or command retry follows an uncertain
   launch/stop. Loss of the native owner/receipt is Unknown until exact retained authority can settle
   it; framework disposal or a missing process is not recovery proof.
6. Ordinary worker close/reopen must retain unresolved realm ownership, not delete it with provider
   rows. Reopen looks up existing receipts through the independently owned authority only. A missing
   or replaced owner, OS boot mismatch, storage failure or lost reply never authorizes a resend.
   Introduce a versioned per-admission ledger; do not clear or reinterpret the old monotonic
   `JobHistory` latch. Migration/recovery for legacy host histories requires its own explicit design.
7. Feed a durable aggregate of every affected admission into the existing checkpoint before its
   close ACK; keep final registry census, kernel exit, daemon exit and profile lease as separate gates.
   A realm receipt says local execution ended, not that its side effects succeeded. Resume only the
   agents owned by the update/Pause operation, preserving later Stop/holds; never restart killed jobs.
   App-only updates do not stop realms or pause daemon work. GUI close must not discard owner state.

The native owner/guest image, policy compiler and receipt schema become trusted package inputs. They
need immutable source/image digests, licensing/attribution, verified signatures/entitlements, existing
signed inventory coverage, protocol compatibility across daemon upgrades and rollback, and their own
safe update/exit policy. The owner must not be replaced before its receipts are durable. Keep NSH
at unmodified tagged `v0.4.0`; the typed host bridge reports sanitized status only, never executable
paths, cgroup names, VM controls or new capabilities to TSX. Linux needs its own signed capsule and
delegation/preflight qualification; macOS arm64 packaging evidence does not qualify Linux or Intel.

#### Isolated verification plan (not run or authorized here)

After scope approval, first prove the OS boundary in a disposable, credential-free environment,
then integrate the provider and finally run the existing joined-update matrix:

- Admission races: direct/nested starts, queued work, instant shell exit and provider row pruning;
  fail storage before intent/bind/release and prove no unowned first instruction. Hold a fork barrier
  during drain and test `setsid`, `setpgid`, double-fork, `posix_spawn`, closed/inherited stdio and
  TERM-resistant children. Assert actual boundary drain plus stopped fixture writes, not writes alone.
- Escape/security: attempt cgroup migration, namespace escape, inherited-FD/control-socket access,
  owner signalling/ptrace and host service delegation. Denial must precede outside execution. Exercise
  unsupported kernels, disabled user namespaces, denied delegation/entitlement and VM start/stop errors.
  A denied capability must never select unsupervised host execution.
- Custody/recovery: interrupt worker, guest supervisor and native realm owner separately at every
  journal stage; also lose all owners, output channel and receipt ACKs. Reopen reads only; no launch,
  stop resend or snapshot resume. Missing authority stays Unknown. Reused IDs/paths and prior OS boots
  cannot satisfy another admission. Prove unrelated sessions and user-held work remain untouched.
- Semantics/package: ordinary shell pipelines, Node/Python subprocesses, Git/build tools, cwd/env,
  exact logs/status/notification delivery, policy grants and denied host integrations; measure guest
  startup, idle RSS/disk and output backpressure. Test exact signed owner/image/protocol versions and
  rollback compatibility, without weakening package trust. macOS guest/Intel/Linux are separate lanes.
- Lifecycle: open drafts, active/already-paused/stopped agents, jobs finished before checkpoint, Stop
  and mission Pause races, worker close/reopen, daemon-only, app-only and joined updates. Inject lost
  receipts and teardown failures; require automatic save/selective agent resume, no replay and actual
  target-version/startup receipts. Realm drain alone cannot pass signed replacement/GUI acceptance.

This task only checked source, platform documentation and the document diff/links. It ran no native
build, install, sandbox/VM experiment, job payload or live service action. Implementation, privileges,
guest provisioning, native tests, signing/release and activation need their existing approvals.

#### Source and platform references

Accessed 2026-11-11. SDK statements were cross-checked against installed
`MacOSX27.2.sdk/usr/include/{EndpointSecurity,libproc.h,sys/event.h}` and shipped
`launchd.plist(5)` / `sandbox-exec(1)` manuals, without executing their APIs.

- [Locked extensions source][containment-extensions]: `extensions/jobs/{index.ts,jobs-provider.ts}`,
  `extensions/sandbox/{controller.ts,manager.ts,supervised-spawn.ts,seatbelt-profile.ts,seatbelt/base.sbpl}`.
- [cgroup v2][containment-cgroups]: Process migration, Delegation containment, Unpopulated Notification,
  `cgroup.freeze` and `cgroup.kill`. [clone(2)][containment-clone] documents `CLONE_INTO_CGROUP`;
  [pid_namespaces(7)][containment-pidns] documents namespace-init death and SIGKILL of members.
  [systemd resource control][containment-systemd] documents delegation, not a pre-existing Pilot grant.
- [ES descendant client][containment-es], [restricted entitlement][containment-es-entitlement],
  [message loss sequence][containment-es-loss] and [Apple DTS response][containment-dts]. The installed
  SDK's `ESClient.h:799-852` supplies the macOS 27 availability, root/TCC and fail-closed distinctions.
- [App Sandbox][containment-app-sandbox] specifies resource access, not an all-descendant exit API.
  Public XNU snapshot [`f6217f89`][containment-xnu] implements `setsid`/`setpgid` in
  `bsd/kern/kern_prot.c` and `proc_terminate_all_rsr` in `bsd/kern/proc_info.c`; it is source evidence,
  not qualification of the installed kernel. SDK `sys/event.h:357` marks fork-following
  `NOTE_TRACK`/`NOTE_CHILD` unsupported since 10.5.
- [Virtualization.framework][containment-vz], [virtualization entitlement][containment-vz-entitlement],
  [actual stop completion][containment-vz-stop] and [macOS guest requirements][containment-macos-guest].
  No claim is made that owner crash automatically yields a durable stop receipt.

[containment-extensions]: https://github.com/babariviere/pi-extensions/tree/46eddf8ac376a395b3534af70fa5c7ec8eb0ee6f
[containment-cgroups]: https://docs.kernel.org/admin-guide/cgroup-v2.html
[containment-clone]: https://man7.org/linux/man-pages/man2/clone3.2.html
[containment-pidns]: https://man7.org/linux/man-pages/man7/pid_namespaces.7.html
[containment-systemd]: https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html
[containment-es]: https://developer.apple.com/documentation/endpointsecurity/es_new_descendants_client(_:_:)
[containment-es-entitlement]: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client
[containment-es-loss]: https://developer.apple.com/documentation/endpointsecurity/es_message_t/global_seq_num
[containment-dts]: https://developer.apple.com/forums/thread/851230
[containment-app-sandbox]: https://developer.apple.com/documentation/security/app-sandbox
[containment-xnu]: https://github.com/apple-oss-distributions/xnu/tree/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea
[containment-vz]: https://developer.apple.com/documentation/virtualization
[containment-vz-entitlement]: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.virtualization
[containment-vz-stop]: https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop(completionhandler:)
[containment-macos-guest]: https://developer.apple.com/documentation/virtualization/running-macos-in-a-virtual-machine-on-apple-silicon

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
`bundle_runtime.py` additionally requires the existing visual-worker receipt. Renaming a binary alone does not
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

The [Day input builder](day-package-inputs.md) now compiles the Day-owned
bootstrap and separate helper from immutable source, reads their real compiled
evidence, builds the existing visual worker without GPUI, and generates the
exact released connected resource closure. It does not run the signing
assembler or supply a signed production payload. Unconfigured inputs remain
unavailable for real updates.

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

`apps/day` has the TSX controls and the screen-state half of all-form restore. The default entry
uses mock rules; the connected native path is described below. `UpdateFeed`
(`native/src/update_feed.rs`) follows the typed contract above:

- `snapshot()`/`onChange` give one `ServiceView`: registration state (registered, absent, offline,
  incompatible, unknown), app and service versions, the offer, why it cannot start, the agents an
  update touches, the waiting confirmation, the latest run and a pending restore.
- `prepare({kind, revision})` returns a one-use `Confirmation` with exact versions, pause and keep
  counts and whether the app restarts. A count is `null` when it was not taken: the native root
  never counts affected agents, so the page says Pilot cannot count them, never zero. An app-only
  native confirmation pauses 0 by construction. `confirm({confirmation, view})` uses it once. A
  forged, reused or stale confirmation starts nothing. `cancel` drops it. `check()` only reads.
- `SavedView` is exact (`#[prop(exact)]`), limited to 64 KiB of text and 1024 list entries, and
  refused whole when larger. It holds what has no store of its own: the screen under the update
  page, New's unsent goal, the Today item in front, each interview's question and See all, open help
  on Today's cards, the ritual on screen (with its date and the start of day's step), the open
  change's tab, Today's scroll offset and the row that opened the screen, that screen's own scroll
  offset, and the last focused text field with its UTF-16 selection. Fields after `questions` are
  optional, so views saved before them still read. Today's drafts and interview answers are saved to
  their own stores first (`updateView.saveForms`); a refused save stops before any pause.
- `restored({id})` acknowledges a restore once. It only says the view was shown, in the mock rules
  too: the mock service resumes the agents it paused as its own step before the window restarts.
  A lost or refused acknowledgement is not sent again. An app-only update pauses nothing.

The mock worlds cover: up to date; app and service update with drafts, working and user-held agents;
stale target; lost answer settled only by Check; failed save; unproven job exit (durable refusal,
never shown as updated); unverified signature; absent, lost and macOS-denied registration; offline;
and an app-only update for a newer service. The UI says "Updated" only after Rust reports the new
version running, and "Update not confirmed" with Check again for any lost answer.

The connected entry now uses `connectedUpdates.ts`, not the mock feed. The independent
`pilot-desktop-updater` crate is linked directly; neither shipping desktop app is linked.
`UpdateFeed::from_host(bridge.update_window())` supports native embedding on that same root
and uses the same capture gate and notification as JSON confirmation. Root-only
`host::updates::Selection` supplies the profile, trust, immutable capsule/proposal and existing
app transaction. There is no usable production default or VM-selected path, credential or PID.

`connectedUpdates.ts` answers `prepare` and `cancel` asynchronously with the root's real result. A
refused prepare says why and starts nothing; a combined update the root reports unavailable stays
unavailable until Check reads the service again. A confirmation refused before entry (stale,
identity, capacity, busy, closed, offline) shows the page as it was, without the used confirmation;
only a lost, unknown, storage or malformed answer leaves the run Unknown and Check-only. A flush
request replaced by a newer generation while its saves run is not answered.

The exact public methods are `day.update.read`, `prepare`, `confirm`, `cancel`, `check` and
`restored` (each with the `day.update.` prefix). Each needs its own declared capability;
the default mock bundle remains deny-all. Confirmation consumes one opaque token and fsyncs
the view/selection/credential binding in the existing journal. It requests native capture,
not an update effect. `day.flush.ack` then saves the final `SavedView` after all form saves.
Only the native owner can seal that exact capture generation/save sequence and call
`Bridge::commit_update`. The entered record is fsynced before the existing controller runs.
All native work is awaited on the serialized host lane, including during joined root close.
There is no detached service manager or second update database.

The controller uses `DaemonLifecycle::needed/upgrade_coordinated_report`,
`daemon_upgrade::register`, and `ExitGuard::prepare_external`. App guard preparation is
**not** app replacement or success: it stays unconfirmed until the separately owned native
READY/COMMIT/startup lifecycle exists. App-only never reserves or pauses daemon work.
Combined app-and-daemon execution is explicitly unavailable, not two independent calls.

Native failures are mapped without copying raw errors. Job/checkpoint refusal is "Not updated";
uncertain entry stays Unknown. The updater treats lost, malformed, mismatched or
unauthenticated signed-prepare replies as Unknown,
not a preflight refusal. Only an explicit conflict is a known checkpoint refusal. The native
POST has retries disabled. Restart preserves the Check-only fence.
The existing updater can report the exact attempted reservation
and its matched retained `.daemon-lifecycle.json` manifest, including a durable refused manifest.
Only sanitized session IDs and checkpoint observations reach TSX, never child storage paths.
A saved checkpoint does not prove current resume. Missing inventories are not zero-work proof.
Day never resumes from a restore ACK; exact selective recovery remains owned by the existing
daemon lifecycle. Check never registers, replaces, retries a native mutation or resends COMMIT.

The journal binds saved view bytes to the root, transaction, operation, window and sealed flush
proof. Cold restore only displays data. A verified successor app may read the exact external
startup guard, but does not acknowledge startup or recover execution here. The live old window
does not consume its own pending restore. `ServiceView.operation` prevents a previous run's
success from settling a lost confirmation. Failed form saves keep the old engine alive.

Restoration limits, from upstream NSH 0.4.0: scroll offsets come back through `contentOffset` when a
screen mounts or `scrollTo` for a Today already on screen, so a screen whose content arrives after
its first read can start nearer the top. Selection comes back through `setSelection` and focus;
headless tests check the captured selection, not the restored one. An input method's unfinished
composition (preedit) is not kept: NSH reports it but cannot set it again, so the native owner must
commit or cancel it before the flush. The update page's own scroll, collapsed sections (fog of war,
earlier rounds, snapshot details), a ritual's done/skipped marks and the Changes diff's scroll are
not kept. Pause and start confirmations are never restored.

Still unqualified: signed production Day identity/packaging, app delegate/menu lifecycle,
native READY/COMMIT ownership, visible native restoration and joined GUI/daemon
update/rollback acceptance. Those remain the self-update/joined acceptance work. No live
registration, update, restart, visible test, release or default switch is enabled by this seam.

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
