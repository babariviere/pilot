# Host-owned workspace terminals and maintenance barriers

Workspace shells run in the selected daemon, rendered by libghostty on the Mac. The existing
SSH loopback HTTP forward carries the dedicated terminal WebSocket. No additional SSH shell,
editor integration, preview forwarding or local interpretation of remote paths is involved.
The daemon derives cwd from the writable session workspace and passes it as a PTY option,
never an interpolated `cd` command. Ask/coordinator workspace guards still apply.

## Identity and lifetime

`HostClients.attachTerminal` takes a session `HostResourceRef`. Surface, exit, retention and
callback keys include host/daemon/lineage, even when IDs and paths collide. Endpoint replacement
detaches transport and retains the original terminal intent. It reattaches after the new forward
is verified, without switching to Local. `HostedWorkspaceTerminal` is the hosted inspector entry
point; MainWindow also routes an explicitly selected hosted chat to it, independently of Local
daemon availability. Full unified chat/navigation presentation remains the devbox UI task.

`GET /api/hello` advertises `capabilities.workspaceTerminalProtocol: 2`. The new client refuses
terminal transport on older runtimes without that capability, before opening a socket that could
start a legacy shell. The terminal URL requires `protocol=2`; clients without it are explicitly
refused without starting a PTY. Other API protocol-1 features remain unchanged.

Each connection receives `terminal.hello` with daemon boot identity and any existing terminal ID.
The client then sends `terminal.open` with a stable request UUID and boot identity. Create/restart
receipts are daemon-memory tombstones, capped at 512, never evicted to admit a duplicate mutation.
Lost replies reuse the same request. Reattaching to an already identified shell does not consume
another receipt. Capacity refusal happens before retiring or starting a shell. A changed daemon
boot or terminal instance refuses the old intent; opening a new shell then requires explicit action.
Keystrokes are neither persisted nor replayed. A daemon restart cannot resurrect a live shell.

Disconnect, surface eviction, app quit and tunnel closure detach listeners, not remote shells.
Explicit **Close shell** signals termination and waits for an actual PTY exit event. Retiring shells
continue to block workspace reclamation and maintenance. SIGHUP-resistant shells receive SIGKILL
after one second. A stale socket cannot input, resize or close a replacement terminal instance.

## Bounds

- At most 16 live/retiring workspace PTYs, 32 retained session slots, four listeners per shell,
  64 terminal sockets including pre-handshake connections, and a ten-second open deadline.
- Each shell retains at most 2 MiB actual UTF-8 scrollback and 4096 chunks. Oversized individual
  chunks are trimmed at code-point boundaries.
- `node-pty` is exactly pinned to 1.1.0. `pty-input.ts` audits Unix `_writeStream._writeQueue`, pins
  stream and queue identity, validates Buffer/offset tasks and synchronously admits input before
  `IPty.write`. Limits are 16 KiB per chunk, 256 KiB retained native buffers and 64 native tasks.
  Partial writes still retain their full buffer allocation. Unknown versions/platforms/shapes
  fail closed; a spawned shell whose adapter fails is still tracked and terminated/reaped.
  Setup helpers retain their separate stricter cumulative lifetime input cap.
- Terminal frames are at most 128 KiB, including JSON escaping. Replay encodes lazily in 16 KiB
  UTF-8 chunks, with one native send outstanding and a 2.5 MiB raw queue / 256-entry cap. A slow
  consumer is disconnected, then forcibly detached after a bounded close grace, not silently dropped.
- The Mac bounds renderer callback input before dispatch (256 KiB/64 chunks), coalesces resizes,
  and bounds outgoing encoded sends (256 KiB/64 frames). Disconnection discards pending sends.
  Terminal reads cross the main actor one frame at a time. The renderer's asynchronous parser
  applies event-driven read backpressure at 512 KiB, resuming below 128 KiB, with at most one
  additional 16 KiB output chunk. Other chat streams retain their existing snapshot limits.

## Interface consumed by safe remote updates

`createDaemonServer(...).runtimeResources` composes workspace PTYs, `SetupService`,
`AttachmentStore` and `SessionManager`. It owns no updater transaction or restart policy.

1. Call `freezeAdmissions()` **before the first await** and retain its idempotent release handle.
   Independent owners nest safely. This stops terminal create/restart, setup helpers, transfers
   and session admissions, including work queued before asynchronous filesystem operations.
2. Drive the existing `SessionManager.pauseForUpdate()` parent/child tool drain to acknowledgment.
   A maintenance freeze prevents the legacy 30-second app lease from resuming those tools.
3. Await `runtimeResources.blockers()`. Any blocker, inspection failure, overflow or unknown
   process state defers restart. Recheck while retaining the freeze immediately before the updater's
   own PID/boot-fenced restart. Release on cancellation; updater crash/recovery uses its own journal.

Transfer blockers cover accepted bodies, queued metadata, fsync/finalization and temporary-file
cleanup, not just socket ownership. Completed stored attachments are not live-transfer blockers.
Setup cancellation also waits for broker-fence settlement and actual helper exit.

`SessionManager.blockers()` is deliberately not the display `jobs()` API (which may return an empty
list for unavailable workers). Safety inspection requires a current acknowledged tool-drain generation,
fresh parent job lists and actual OS child inspection. `Worker.hasChildren()` calls kernel
`activity.ts:inspectChildren`, using bounded `pgrep -P`, not durable subagent summaries. Only exact
idle SDK-owned MCP roots without descendants are exempt. Live subagent kernel processes, child jobs,
unrecognized children and process-list failure conservatively block. A quiesced durable subagent
record without an OS process does not. A real idle child kernel may need explicit closure before
maintenance; this interface never guesses that killing it is safe. No Stop response or socket close
is process-exit proof.

Inspection is coalesced, with four workers in flight, at most 128 inspected workers and 1024 returned
blockers. Overflow retains an explicit unknown sentinel. Worker/drain replacement invalidates the
snapshot. Retiring/parking and unsettled admissions remain blockers until their actual cleanup ends.

## Verification boundaries

Focused Node fixtures cover literal cwd/metacharacters, host-ID collisions, replay, stable lost-reply
reattachment, wrong boot, stale instances, closure, freeze races, native stalled input and resource
caps. Swift tests cover qualified registrations/surfaces and real disposable loopback WebSocket
reconnect/lost-reply/boot-change behavior. Linux headless and Darwin native lanes explicitly select
the PTY tests. Full Swift, packaging, sustained GUI performance and deployment checks run in CI or
separately authorized manual validation, not against a personal devbox.

Local ring-only comparison (Node 24.21.0, seven samples, 10,000 reused 16 KiB chunks/sample):
ASCII median 0.67 ms before / 25.98 ms after, Unicode 0.49 ms / 52.40 ms. Actual retained UTF-8
bytes are now 2 MiB for both; the old Unicode ring retained 4 MiB. The additional 2.6–5.2 µs/chunk
is byte accounting, not main-thread work. This deliberately narrow microbenchmark does not verify
end-to-end GUI responsiveness, sustained producer load, or process-wide memory under many terminals.
Those remain CI/manual performance checks. `docs/mockups/workspace-terminal.swift` is self-contained
SwiftUI artifact source with static data, not a screenshot or verification of the actual views;
it has been rendered separately as a static mock, not as verification of the application views.
