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
  of the already-durable native capture, and an optional verified replacement
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

The daemon exposes prepare/lookup through its existing authenticated native
runtime-owner channel (`/__pilot_runtime_update/v1`, `receipt.globalUpdate`).
There is no agent/session or TSX route and no new credential. The native verified
release/install binding is deliberately not configured yet; `cancel`/`verify`
cannot manufacture one. Legacy reservations cannot supersede a global hold.
No current app entry invokes this new preparation.

## Separate evidence and remaining work

The preparation receipt includes resource blockers separately. **Accepted pause
preparation is not permission or proof that replacement is safe.** Root process
exit, job cancellation, an empty registry and process-group exit are not complete
descendant proof. The unchanged jobs adapter performs cancellation/group cleanup;
its monotonic uncertain history remains intact. Missing independent process
evidence must not be relabeled as a broken-chat veto or silently cleared.

The following native/distribution gates remain:

1. Wire actual all-form capture, including preedit, through the existing fresh
   flush generation, exact-source SavedWindow journal, seal and awaited close.
   Finish capture, global pause/cancellation and close **before** NSH installation.
2. Integrate the official tagged unmodified NSH app installer, with matching
   CLI, core, platform, engine and testing versions and verified archive/crate
   checksums. No global CLI replacement, cache patch or NSH fork.
3. Retain an install-entered operation before the official swap. Reopen only
   looks up that original operation; it never downloads/installs/resets/retargets
   from a retained hint. Verify actual successor versions and startup/capture
   restoration. Qualify interruption and rollback separately from a rename.
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

## Tagged NSH API verification

On 2026-11-12, the annotated `longbridge/nsh` release `v0.5.0` resolved to
`f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1`. Its official macOS arm64 archive
is `nsh-macos-arm64.tar.gz`, published SHA-256
`e6722427b391b00cf7ec13137db9366e78d1e7a045f2933cf00b340365309d9d`.
Current app dependencies and installed CLI remain 0.4.0 until checked migration.

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
recovery. The surrogate is **not** a native IME/preedit test. Existing lifecycle,
pause, reservation, mission-control, power and session tests remain relevant.

[updater]: https://github.com/longbridge/nsh/blob/f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1/docs/dev/updater.md
