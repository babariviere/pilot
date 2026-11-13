# Day daemon handoff and isolated checks

Day's executable now has a windowless entry for changing an **existing managed
daemon service** to an already installed, verified full Day bundle. It uses the
existing launch-agent ownership, permanent profile lease and native boot proof.
It does not use GPUI orchestration, register a second daemon, close a GUI or swap
an app. App replacement still belongs to the unmodified NSH updater.

## Installer interface

Run the new signed Day bundle's own executable, not an old helper:

```sh
"/absolute/full/Pilot Next.app/Contents/MacOS/pilot-desktop" \
  --daemon-handoff preflight \
  --profile /absolute/existing/profile --port 7433 \
  --daemon-id DAEMON --lineage-id LINEAGE \
  --operation-id UUID --source FULL_COMMIT --build NUMERIC_BUILD \
  --saved-state /absolute/private/saved-window.json
```

The same flags accept `apply` or `inspect` instead of `preflight`. All flags are
required. `preflight` is read-only and does not read the saved-state file.
`apply` requires the caller to have saved and closed its GUI through its existing
supported owner. The private saved-state file (0600, at most 1 MiB) is fsynced and
hashed before preparation. This file is caller-owned preservation, **not** a
fabricated native capture/close acknowledgement. The CLI never closes a running
GUI or accepts Force loss. Do not invoke it as a
replacement for saving live drafts.

The installer passes an explicit `--old-app /absolute/old/Pilot Next.app`.
Apply records that app's exact byte identity and refuses if native inspection
finds known users or cannot establish no observed use. The separate optional
`retire` action uses the same flags and original UUID. It requires the original
completed successor/release, fresh exact boot/PID/runtime proof, unchanged old
app bytes/seal and native no-use inspection. It removes only that explicit app,
then calls the existing limited obsolete-runtime cleanup for both known stores.
It never removes profile data, local settings/drafts, unknown/live/other-profile
users or permanent locks. Entered retirement is one-shot; completed repeats
return observation. See [installer commands and limits](day-install.md).

The executable resolves its own signed app and fixed Node/daemon runtime paths.
The selected source/build must match its compiled trust and verified runtime.
No arbitrary runtime executable or unverified path can be supplied.

`apply` exclusively journals the exact operation under the selected profile,
fences admission, requests host-owned pause/notification of every chat, and joins
known kernel exits without waiting for models. It stops the verified existing
service, waits for that exact daemon and lease release, changes only its existing
definition and starts once. It verifies actual build/protocol, boot, daemon and
lineage, executable, profile lease and HMAC hello. A separate durable release
operation resumes only eligible update-owned work. Broken/uncertain effects and
later user Stop/holds stay held. Neither cancellation nor root exit is described
as containment or quiescence.

For personal dogfood, residual `unknown-process` evidence for an exact lifecycle
whose kernel **has exited** is kept in the receipt but no longer blocks handoff.
Live jobs/processes, failed known shutdown, storage/admission failures and unknown
contributors still block. Nothing kills an unrelated PID or retries canceled work.

A separately installed target can roll back a confirmed owned replacement to
the unchanged, still-signed original service definition. A changed service,
unproven replacement shutdown or uncertain start stays Unknown. In particular,
an older rollback daemon without the new native release route stays safely held;
it is not reported resumed. App-in-place rollback continues to use the official
NSH installer and its verified rollback archive, not this CLI's service rollback.

Output is JSON. `ready` is preflight only. `complete` requires the accepted release
receipt too; check `completion.role` for successor versus rollback. `observed` is
lookup only, never permission to remove old files. A failure exits nonzero with
Unknown/recovery information. After any entered/lost reply, use **the same** UUID
with `inspect`, never a fresh apply. Lookup reads the original service and release
evidence without reconstructing a stop/start/release capability. Missing or
corrupt evidence is an error, not an empty successful recovery.

## Reusable isolated driver

From the repository root with the locked Node dependencies installed:

```sh
node --test packages/daemon/src/day-daemon-handoff.test.ts
```

This starts disposable daemon **service graphs in real child processes**, using
the real profile lease, daemon HTTP server, HMAC native channel, operation journals
and SessionManager. Only model/kernel IPC is a deterministic credential-free peer.
It uses a fresh OS temporary profile and loopback port, never the current daemon,
live providers, schedules or native windows. It joins its owned processes and
removes only its temporary directory.

The driver covers healthy/broken chats, saved draft bytes, cancellation uncertainty,
no duplicate profile owner, exact hello/build checks, failed executable launch,
wrong-build stop/rollback, interrupted cold startup, selective recovery and durable
user Stop. It is not a launchd or signed app qualification claim.

The directly affected deterministic native checks are:

```sh
apps/day/scripts/cargo test --locked --manifest-path apps/day/native/Cargo.toml \
  --features macos-host --lib daemon_handoff::tests
apps/day/scripts/cargo test --locked --manifest-path apps/day/native/Cargo.toml \
  --features macos-host --lib host::official_root::tests
apps/day/scripts/cargo test --locked --manifest-path apps/desktop/updater/Cargo.toml \
  --features native-macos --lib daemon_upgrade::macos::bundled_service
```

These reuse supported MBX tooling. Faux code seals and injected native transitions
are deterministic fixtures, not signed-distribution evidence. Real launchd/app
handoff still requires a genuine configured, signed full Day bundle and, for an
app swap, matching official signed target/rollback distributions. The existing
`day-qualification.yml` already builds and inventories a **full unsigned** bundle
with Node, daemon and helpers. Its unsigned/unconfigured output cannot be used
by this entry. The lightweight `candidate.py` preview intentionally lacks a runtime.
Use the existing full-bundle assembly with configured release-profile trust and
genuine signing; do not invent another assembler or weaken signature checks.
