# Native crash, hang and devbox setup diagnostics

The macOS app subscribes to Apple's MetricKit diagnostic delivery. MetricKit owns crash and hang collection; Pilot
does not install a signal handler, exception handler, watchdog, process sampler or third-party crash SDK. The app
extracts only the payload window end and length, incident kind, a current-vs-other release relation and finite hang
duration. It never reads or serializes MetricKit
call-stack trees, exception fields, termination descriptions, signpost data, paths or report bodies.

The app also records the user-authorized devbox setup attempt as a closed stage timeline: configuration, package,
SSH transport, remote bootstrap, verified remote handshake, enrollment and adoption. Each stage has only a start,
success, failure or cancellation outcome, a bounded per-attempt sequence and a small allowlisted reason. The attempt and evidence refs are random
opaque values, not hashes of the SSH alias, hostname or host identity. Raw SSH output, commands, paths, package
plans, aliases, credentials and arbitrary error text are discarded. This covers failures before a host is
registered, when there is not yet a remote daemon from which to request diagnostics.

The app keeps at most 32 observations for seven days in
`~/Library/Application Support/Pilot/NativeDiagnostics/native-diagnostics.json`. The directory and file use private
permissions. Records use stable opaque `diagnostic:v1:native:…` refs and the closed `native.crash` / `native.hang`
schema. A malformed, symlinked or oversized archive fails closed and is not replaced automatically.
Setup records use the closed `devbox.setup` schema and share the same bound and retention.

After the local daemon's verified handshake, the app replaces pilotd's private copy through the loopback API.
pilotd validates every field before writing at most 32 KiB, rejects unknown fields and merges the OS source into the
same 128-item, 64-KiB read-only diagnostic projection. Native evidence is host-level context. It is not attributed
to the selected chat merely because it appears in that chat's diagnostic snapshot. It can be selected in the same
explicit bounded repair handoff as lifecycle and timing evidence.

The projection reports app setup evidence separately from OS and daemon evidence. A healthy local daemon therefore
does not imply that SSH setup or the remote handshake succeeded. `ssh_transport` proves only bounded SSH execution,
`remote_bootstrap` is the structured remote setup result, and `remote_handshake` succeeds only after the owned
forward and compatible daemon identity are verified. Missing and observations older than 30 seconds are shown as
unavailable and stale rather than guessed. Reading the timeline never starts SSH, retries bootstrap, reconnects,
wakes a chat or probes a remote machine.

Local diagnostic consent controls collection and synchronization. Turning it off stops new native records but keeps
the existing archive. **Clear local diagnostics** clears both the app archive and pilotd's copy. Native evidence is
not sent to an OTLP collector and there is no crash-vendor upload, disk export queue or background retry. This also
keeps devbox setup evidence local regardless of remote-export consent.

## Delivery and symbolication limits

MetricKit delivers diagnostics after the OS has processed them, not at crash or hang time. The `at` field is the end
of the reported observation window, whose length is `windowMs`, rather than an exact incident timestamp. Delivery may be delayed,
coalesced or absent, especially for development builds and incidents below Apple's reporting thresholds. A hang
record is historical evidence, not a live liveness check. Pilot does not automatically restart, retry, replay or
sample an unresponsive process.

Pilot intentionally cannot symbolicate its bounded records because they contain no addresses or stack. For a manual
investigation, use the original Apple diagnostic report from Console or `~/Library/Logs/DiagnosticReports` and the
exact archived release dSYM/build. A diagnostics specialist can inventory and read only Pilot-named reports in that
user directory through the fixed, bounded, sanitized `diagnostic_logs` catalogue; missing reports remain unknown, not
proof that no crash occurred. Xcode Organizer can symbolicate a matching archive; `atos` requires the matching
architecture, load address and dSYM. Raw report text, paths and excerpts stay outside Pilot's diagnostic evidence,
telemetry and repair handoff because they can contain symbols and other private process data.
