# Released Day host boundary

## Release audit

Audited unmodified `longbridge/nsh` v0.4.0, peeled commit
`e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`. This is not the unrelated
`nuta/nsh` shell. No CLI build, upstream patch or cache edit is needed.

The released source is authoritative for these observations:

- `nsh-platform-macos/src/app.rs`: `AppOptions.host`, `AppView::host`, and
  `AppView::load` pass a channel to `EngineConfig.host`. `load` supplies an
  empty `EngineConfig.context`. A context-only connected factory does not
  connect the packaged macOS app.
- `nsh-engine/src/host_channel.rs`: `HostChannel::handle` registers an exact
  name. It calls the handler on the engine thread. The handler is synchronous,
  `Send + Sync`, and must not block. `HostCall`/`HostReply` can reply later,
  from another thread. An unanswered dropped call fails. Replies target the
  calling engine, not the channel's next attachment.
- `nsh-js/src/host_channel.rs`: native handlers run inside the QuickJS call,
  not as a native class's asynchronous op. The JSON result cannot return a
  Rust `Instance<T>`. Existing `TodayFeed.connected()` and
  `PlanFeed.connected()` are **not** drop-in consumers of this channel.
- `nsh-core/src/host_channel.rs` and `access.rs`: runtime host calls have
  capability checks. With Day's current `capabilities: {}`, they are denied.
  Events do not grant calls. A host must validate payloads independently.
- `nsh-platform-macos/src/app.rs`: `run_app(AppSource::Bundle, options)` is a
  public standalone runner. It stops the engine before returning. Its stock
  close/Quit delegate has no app-owned pre-disposal capture/veto hook.
  Cleanup after it returns is too late to capture form signals or preedit.

See the release's `website/modules/nsh.md` host section and
`website/docs/sandbox-and-capabilities.md`. Paths above are relative to the
[release tree](https://github.com/longbridge/nsh/tree/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates).

## Consumer seam

`apps/day/native/src/root.rs` is the canonical DayRoot from the parked UI
work, not a second owner. `Bridge` owns that root and a fresh channel for
one engine/window. Root selection stays native. It is not a JSON parameter.
Handlers validate and enqueue to the **existing** NativeHost queue (capacity
16). That same worker executes the existing native host, planning and
attention services, then replies. There is no new thread, process, transport,
store, credential registry or global root. Coalesced `day.changed` events
invalidate UI mirrors. They carry no data or authority. Read
`day.today.read`, `day.plan.inventorySnapshot` and the selected
`day.plan.snapshot` on invalidation, not a polling loop or a new network read
for every event.

`apps/day/bridge.ts` is that asynchronous JSON mirror adapter, used by
`apps/day/Connected.tsx` through `connection.ts`. `ConnectedToday` and
`ConnectedPlans` fit the `DayFeed`/`PlanningFeed` shapes the screens use
(`apps/day/feeds.ts`), so no screen knows which feed it has. They first ask
`day.attention.read`, then `day.today.read` and `day.plan.prepare`; a failed
first read shows why, never mock data. Each intent is sent once with
`timeout: 0`: a lost reply is Unknown and only the matching check method
looks it up. Decision Later reorders this run only. Help, link opening,
direct chat start, budget and dependent-work continuation say they are unavailable
in those existing screen adapters. The separate project-pinned standalone host
seam is documented in [day-new-chat.md](day-new-chat.md); its UI hookup is separate.
Published planning uses `day.plan.startWork` with the displayed revision/digest/task/context and a
separate confirmation. `day.plan.checkWork` reads the retained exact operation only. Both use the
same native worker, ledger, close fence and saved-form barrier as existing planning commands.
On `day.flush` the adapter saves every waiting answer and Today draft, and
acknowledges only when each save was answered and none was refused.
`native/tests/connected.rs` runs the entry on a real `Bridge`. The default
mock entry and its deny-all capabilities are unchanged.

Launch parameters expose only:

```json
{"day":{"version":1,"window":"opaque native window ID"}}
```

Every call uses `{version:1, window, args}` with exact fields. The window ID
binds a call to this root; it grants no authority. Native methods still build
their own exact operation, authority and revision fences. The request limit
is 64 KiB including the envelope. Complete replies are limited to 16 MiB;
oversized containers are refused, never truncated. No raw native source,
home, transport port or credential is a response. Standalone New exposes only
canonical project IDs/roots, its saved choice and exact creation receipt, not a
generic daemon request or a replaceable native root. User-facing file/link
provenance stays in the existing models.

Responses are discriminated envelopes:

```ts
type Reply<T> =
  | { version: 1; value: { snapshot: T; outcome: IntentOutcome | null } }
  | { version: 1; error:
      "identity" | "offline" | "unavailable" | "invalid" | "stale" |
      "storage" | "unknown" | "closed" | "busy" | "capacity" };
```

Each name in `bridge::METHODS` is a separate capability. Never grant
`day.*`, a generic `request`, HTTP, shell or file capabilities. `host.post`
does not execute these methods. Arguments use the existing exact native
intent types, not daemon request envelopes:

| Name | Args | Snapshot |
| --- | --- | --- |
| `day.projects.read` | `{}` | complete canonical project inventory and saved standalone operations |
| `day.chat.select` | `{projectId,contextDigest,mode}` | passive `ChatChoice`; no session starts |
| `day.chat.create` | `{choice:ChatChoice,message}` | null; exact creation outcome and operation ID |
| `day.chat.check` | `{operationId}` | null; exact receipt lookup, never creation |
| `day.today.read` | `{}` | `Today` |
| `day.window.read` | `{}` | exact-source `SavedView` or null when no capture exists; no update ACK |
| `day.mission.read` | `MissionRef` | `MissionPage` or null |
| `day.mission.pause` | `PauseIntent` | null; inspect outcome, then read |
| `day.mission.resume` | `ResumeIntent` | null; inspect outcome, then read |
| `day.mission.check` | `MissionRef` | null; exact saved lookup only |
| `day.plan.read` | `MissionRef` | `PlanPage` |
| `day.plan.snapshot` | `MissionRef` | cached `PlanPage`, with freshness |
| `day.plan.source` | `{missionId,planRevision,area,recordId,kind,id}` | passive canonical source detail; unavailable/changed scope rejects without content |
| `day.plan.inventory` | `{}` | complete passive `Planning` inventory; failures reject, never imply empty |
| `day.plan.inventorySnapshot` | `{}` | cached `Planning` inventory, using the same `PlanRow` identities and availability |
| `day.plan.prepare` | `{}` | `Setup` or null; lookup only |
| `day.plan.create` | `NewIntent` | `{missionId,page}` or null |
| `day.plan.save` | `{missionId,intent:AnswerIntent}` | `PlanPage` |
| `day.plan.submit` | `{missionId,intent:SubmitIntent}` | `PlanPage` |
| `day.plan.check` | `{missionId,intent:InterviewRef}` | `PlanPage` or null; host selects exact saved operation |
| `day.plan.checkNew` | `{}` | `{missionId,page}` or null; host selects saved enrollment |
| `day.attention.read` | `{}` | `Today` |
| `day.attention.reply` | `ReplyIntent` | `Today` |
| `day.attention.action` | `{action:ActionRef,ask:ActionAsk,text}` | `Today` |
| `day.attention.check` | `{id,action:boolean}` | `Today` |
| `day.attention.draft` | `DraftIntent` | `Today` |
| `day.update.read` | `{}` | `ServiceView` |
| `day.update.prepare` | `PrepareIntent` | `ServiceView`, including one opaque confirmation |
| `day.update.confirm` | `ConfirmIntent` | `ServiceView`; durable capture request, not native entry |
| `day.update.cancel` | `UpdateRef` | `ServiceView`; cancels only a prepared confirmation |
| `day.update.check` | `{}` | `ServiceView`; lookup only, never a retry |
| `day.update.restored` | `UpdateRef` | `ServiceView`; display ACK only, no execution authority |
| `day.flush.ack` | `{generation,view?:SavedView}` | `{generation}`; an update capture requires the final view |
| `day.ritual.read` | `{}` | `RitualSnapshot`; samples the root's clock, writes nothing |
| `day.ritual.snapshot` | `{}` | cached `RitualSnapshot`, `outcome: null`; no clock sample, I/O or notice |
| `day.ritual.results` | `{}` | `RitualSnapshot` with kept-change results or results unavailable |
| `day.ritual.visit` | `RitualVisit` | `RitualSnapshot`; exact context and revision |
| `day.ritual.save` | `RitualWrite` | `RitualSnapshot`; one explicit step, Done or Skip |

Mutation delivery and returned view freshness are separate. A timeout,
aborted consumer, disconnected engine or lost reply is not a refusal and
does not cancel an entered effect. Do not replay it. Retained host operations
remain Unknown and use exact lookup. Reads do not enroll, submit, start,
approve, pause or resume anything. Starting work, budget grants, attention
continuation, help and navigation remain unavailable through this bridge.

Use `day.plan.inventory` on open or explicit Read again to refresh the native
inventory. Use `day.plan.inventorySnapshot` on `day.changed`: it only projects
the current native cache on the existing worker, with `outcome: null`. It does
not run a GET, mark inventory as wanted, write the journal, reset notices or
emit another change. Native WS invalidation and authenticated refresh remain
the cache's owners. Missing, invalidated, disconnected, refused or oversized
inventories stay unavailable, never a successful empty list or a partial page.
Cached row identities and displayed capability fields are not live permission
to save, submit, approve or start work. Existing native currentness and intent
checks still apply. Like other passive snapshots, this read is allowed during
form flushing but not after the bridge closes; it does not acknowledge a flush.

`day.plan.source` resolves only a Decision or Knowledge reference on the named
saved map revision, question or fog area. It reuses authenticated planning reads
before and after the canonical source read, and refuses changed membership,
project, owner or source context. Decisions come from existing mission detail,
including replaced/withdrawn history. Knowledge uses its exact cited revision.
No source body is cached on disk, copied into a tracker, observed, checked or
accepted. The inline detail keeps surrounding native views mounted; Back to map
and Escape close only that detail and restore its trigger's focus. A newer
planning read hides earlier source content until an explicit read succeeds.
Cold reopen returns to canonical reads, not a cached source-body grant.

The ritual calls share the native `RitualFeed`'s rules
([saved ritual progress](day-ritual-progress.md)). Use `day.ritual.read` at
open, on focus and on Read again; on `day.changed` use `day.ritual.snapshot`,
because a fresh read samples the clock and emits another change. A visit or
save needs the last confirmed context and revision; another day, time zone,
profile or user answers `stale` or `identity`. `unknown` means the write may
have entered the journal: do not resend it. The reads are allowed during form
flushing; a visit or save answers `busy` then. Ritual refusals stay with the
ritual and never mark Today's service read failed. A root opened without a
native clock answers `unavailable`.

## Lifecycle seam, not update acceptance

Ordinary cold startup reads `day.window.read` once before admitting screens or
answering a queued close barrier. It reuses the journal's latest `SavedWindow`,
keyed by the full native source (profile, home, port, project ID and path).
Native checks the current home and project before returning saved content.
Missing state returns null; an unreadable capture prevents opening forms, so a
later close cannot overwrite recoverable drafts with an empty view. Invalid
journals still refuse to open. There is no alternate store or fallback source.

`restoreView` restores the same page, selected Linear issue, offsets, selection
and unsent text as update recovery. Each page uses its existing scoped passive
read and unavailable state. Saved answers remain in their canonical draft store.
No restored text is sent and no work starts. A verified updater successor keeps
its separate display acknowledgement; ordinary reopening never calls it or
treats a historical update receipt as current startup authority. A capture is
saved-form evidence, not proof that a close or update completed.

`request_flush()` fences new effects and sends `day.flush` with the exact
window and generation while the engine is alive. The native lifecycle owner
must first capture attached native inputs/preedit for that generation. The
UI must flush **every** form (including planning's delayed save), await its
saved outcome, and only then call `day.flush.ack`. That ACK runs as a FIFO
worker barrier and syncs the existing journal. It cannot itself prove that
all forms participated or native capture happened.
The native adapter pins the save sequence when it admits the ACK. Any later
save invalidates both a queued ACK and an already recorded saved-form ACK.

Native capture and form-save acknowledgements are separate. Neither alone
makes `flush_ready` true. A stale/forged/unsolicited ACK is rejected. A caller
must keep editing frozen for the captured generation. Only then may it stop
the engine and await `Bridge::close`/`DayRoot::close`, which joins entered
I/O, WS shutdown, journal writes and the existing worker. Drop is only
best-effort fencing, not capture or safe-close evidence. A partial load still
requires explicit joined close. It must never fall back to mock success.

The public stock runner can qualify channel wiring, but cannot be the
production update/quit lifecycle until an app-owned AppView/window delegate
implements this pre-disposal protocol. That integration needs native input
and lifecycle acceptance, not an invented upstream hook or a Drop flush.

`native/src/macos_host.rs` is the actual public wiring, behind the opt-in
`macos-host` feature, not a default executable. `options()` supplies the
root's channel through `AppOptions.host`; `run_qualification()` uses the
release's `run_app(AppSource::Bundle, options)` and then awaits root close.
The native grant intersects the bundle's declared capabilities and does
not widen them. In particular, the current deny-all mock bundle stays
denied. This function reports only shutdown, not successful load or native
capture. No default entry calls it, and hidden tests never open its window.
The feature gates only this module. `nsh-platform-macos` is a plain
macOS-only dependency: the NSH CLI resolves every nsh crate's source from
Cargo's resolve, and an inactive optional dependency is missing there, so
`nsh check` refused the earlier optional form as "from crates.io".

## Verification limits

Isolated released-runtime checks are hidden proof, not visible/native
acceptance. No live home, model, agent, service, installer or default-app
selection may be used. Daemon-backed lanes previously lacked matching dependencies.
The exact repaired frozen dependencies
are now installed privately, without scripts or changed inputs; real-daemon native
host lanes execute. This does not qualify a signed production Day app.

### Executed isolated checks

- Released-runtime fixtures pass (10): valid projected reads; deny-all and
  exact-name grants; forged root/version/extra field/type/ID refusal; stale
  mutation refusal; bounded payloads and no-effect posts; prior native grant
  preservation; real engine disposal during entered synthetic HTTP; joined
  close and partial-load failure; flush ACK versus native capture; coalesced
  invalidations; JSON parity with existing native types, including Large.
- Native library tests pass (48), including a late-save/queued-flush-ACK
  race. Exported native declaration boundary tests pass (2).
- The actual macOS `AppOptions.host`/`run_app` wiring passes an offline
  `macos-host` library check and Clippy with warnings denied. It is compiled,
  not opened. Source review kept source-wide identity/storage failures
  distinct from item errors, and preserved an entered write's outcome even
  when a subsequent planning view is unavailable.
- Rust 1.99.1, mbx 1.26, debug zero, one Cargo job, offline/private inputs.
  The guard checks actual rustc output paths and profile arguments and joins
  each process group. An initial guard refusal found mbx's learned
  incremental override. The rerun explicitly disables
  `MBX_LEARNED_INCREMENTAL`, `MBX_EAGER_INCREMENTAL`, `MBX_SEED_INCREMENTAL`
  and `MBX_INCREMENTAL`; `CARGO_INCREMENTAL=0` alone is insufficient.

Still unrun: production daemon/worker integration (no qualified Node tree),
substantive Connected TSX adaptation, visible macOS/IME acceptance, large
streaming performance and the app-owned close/update capture lifecycle.
No live activation, update, release, default switch or legacy removal occurred.
