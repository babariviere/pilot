# Day JSON bridge

## Consumer seam

[App.tsx](../App.tsx) is the connected entry. [MockApp.tsx](../MockApp.tsx)
is test-only. The [TSX adapter](bridge.ts) sends calls through NSH to the
[Rust bridge](../native/src/bridge.rs), which binds one native root to one
window and enqueues work on the existing NativeHost worker. Root, service
and authority selection stay native. Coalesced `day.changed` messages
invalidate views; they carry no data or authority.

Launch parameters expose only:

```json
{ "day": { "version": 1, "window": "opaque native window ID" } }
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
	| {
			version: 1;
			error:
				| "identity"
				| "offline"
				| "unavailable"
				| "invalid"
				| "stale"
				| "storage"
				| "unknown"
				| "closed"
				| "busy"
				| "capacity";
	  };
```

Each name in [`METHODS`](../native/src/bridge.rs) is a separate capability.
Use the Rust decoder and the feature's TSX source adapter for arguments and
replies. Do not grant a wildcard, generic request, HTTP, shell or file access.
`host.post` does not execute these methods.

A lost reply is Unknown, not a refusal or a cancellation. Look up the exact
receipt and never replay an entered effect. Reads do not grant write authority.

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
([saved ritual progress](../native/src/ritual/day-ritual-progress.md)). Use `day.ritual.read` at
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

`native/src/window/macos_host.rs` is the actual public wiring, behind the opt-in
`macos-host` feature, not a default executable. `options()` supplies the
root's channel through `AppOptions.host`; `run_qualification()` uses the
release's `run_app(AppSource::Bundle, options)` and then awaits root close.
The native grant intersects the bundle's declared capabilities and does
not widen them. A bundle without the exact capability stays denied. This function reports only shutdown, not successful load or native
capture. No default entry calls it, and hidden tests never open its window.
The feature gates only this module. `nsh-platform-macos` is a plain
macOS-only dependency: the NSH CLI resolves every nsh crate's source from
Cargo's resolve, and an inactive optional dependency is missing there, so
`nsh check` refused the earlier optional form as "from crates.io".
