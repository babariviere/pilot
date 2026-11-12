# Connected Today read refresh

## Reproduction and cause

The frozen connected candidate is source `2c43b126cbb8a73b9e1e9b291e8660e6aa79ab8f`,
build 984.1, on NSH 0.4. Current source uses tagged NSH 0.5. The refresh path
in `host.rs`, `host/inventory.rs`, `connection.ts` and `bridge.ts` was unchanged
by that runtime migration. This fix does not rebuild or replace that candidate.

The real HTTP/WS regression holds an overview response while a notice advances
the native epoch. The old response correctly refuses with `Error::Stale`, but
the host's failure mapper gave it the text “Daemon read is unavailable”. The
cached planning projection also converted every epoch mismatch into unavailable,
with no rows. Its TS adapter dropped the complete earlier list. Subsequent
successful background reads removed these blocks again. No daemon outage is
needed to reproduce this cycle.

The attention empty state considered `stale` readable, so it could claim
“Nothing needs you. Pilot keeps going on its own.” beneath an invalidation
warning. Two additional adapter races let an invalidated Today reply publish
before its queued successor, or let a slow explicit inventory reply replace a
newer cached projection.

## Correction

- Keep native generation checks. A notice race says that the read changed,
  not that transport failed. Actual failures still say unavailable/offline.
- Keep complete planning rows as explicitly stale display data during refresh
  or temporary failure. Invalid data, overflow, denied access and source changes
  discard them. A stale list is never submission or Start authority.
- Age attention after a failed read even when no notice arrived. A current,
  successfully read empty list is different from unknown attention.
- Fence overlapping adapter replies. Recovery reads never resend mutations.
- Keep read status in stable locations. Planning's connected empty state stays
  present, rather than alternating between no section and an error block.
  Existing keyed cards, drafts and page owners stay in place.

HTTP 401/403 and a missing selected project are authority loss, not a transient
service outage. An inventory HTTP 409 can mean the owner or membership fence
changed and also discards its earlier rows. Network failure
and HTTP 503 can preserve earlier complete display data, with stale status.

## Checks

Fast adapter loop, with only the exact NSH host channel scripted:

```sh
node --test scripts/day-refresh.test.ts
```

Real isolated HTTP/WS host and connected QuickJS window:

```sh
apps/day/scripts/cargo test --locked --manifest-path apps/day/native/Cargo.toml \
  --test host background_refresh_does_not_turn_notice_invalidation_into_read_failure -- --exact
apps/day/scripts/cargo test --locked --manifest-path apps/day/native/Cargo.toml \
  --test connected today_refresh:: -- --nocapture
```

The connected loop checks stable status node identities and bounds, sustained
outage, recovery and an unsent Unicode draft. Its durable capture also checks
the focused field, selection and scroll offsets. It asserts zero domain writes,
provider requests and spawned workers.

The original native loop failed in 1.77 seconds with the exact unavailable text
and `FreshnessState::Stale`. All three initial adapter regressions also failed
against the frozen candidate's `bridge.ts`. These are correctness checks, not
visible AppKit input/IME/scroll acceptance. The open app, daemon and live chats
are not touched. A later checked preview refresh remains separate.
