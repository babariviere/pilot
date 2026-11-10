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
`day.today.read` and the selected `day.plan.snapshot` on invalidation, not a
polling loop or a new network read for every event.

The isolated connected entry needs an asynchronous JSON mirror adapter,
owned by the root UI, rather than calling the context-only feed factories.
Substantive TSX integration belongs with the UI owner. The default mock
entry and its deny-all capabilities are unchanged.

Launch parameters expose only:

```json
{"day":{"version":1,"window":"opaque native window ID"}}
```

Every call uses `{version:1, window, args}` with exact fields. The window ID
binds a call to this root; it grants no authority. Native methods still build
their own exact operation, authority and revision fences. The request limit
is 64 KiB including the envelope. Complete replies are limited to 16 MiB;
oversized containers are refused, never truncated. No raw native source,
home, request, receipt payload, transport port, selection path or credential
is a response. User-facing file/link provenance stays in the existing models.

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
| `day.today.read` | `{}` | `Today` |
| `day.mission.read` | `MissionRef` | `MissionPage` or null |
| `day.mission.pause` | `PauseIntent` | null; inspect outcome, then read |
| `day.mission.resume` | `ResumeIntent` | null; inspect outcome, then read |
| `day.mission.check` | `MissionRef` | null; exact saved lookup only |
| `day.plan.read` | `MissionRef` | `PlanPage` |
| `day.plan.snapshot` | `MissionRef` | cached `PlanPage`, with freshness |
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
| `day.flush.ack` | `{generation}` | `{generation}` |

Mutation delivery and returned view freshness are separate. A timeout,
aborted consumer, disconnected engine or lost reply is not a refusal and
does not cancel an entered effect. Do not replay it. Retained host operations
remain Unknown and use exact lookup. Reads do not enroll, submit, start,
approve, pause or resume anything. Starting work, budget grants, attention
continuation, help and navigation remain unavailable through this bridge.

## Lifecycle seam, not update acceptance

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

## Verification limits

Isolated released-runtime checks are hidden proof, not visible/native
acceptance. No live home, model, agent, service, installer or default-app
selection may be used. The matching Node dependency tree is unavailable;
daemon-backed lanes remain unrun, not replaced by a mismatched donor.

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
